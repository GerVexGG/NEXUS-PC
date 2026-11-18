use crc32fast::Hasher;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use jwalk::WalkDir;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArchiveSourceItem {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub file_count: usize,
    pub parent_dir: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArchiverCapabilities {
    pub zip_available: bool,
    pub rar_available: bool,
    pub rar_path: Option<String>,
    pub default_output_dir: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArchiveCreateRequest {
    pub format: String,
    pub sources: Vec<String>,
    pub destination_dir: String,
    pub archive_name: String,
    pub compression_level: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArchiveProgressState {
    pub running: bool,
    pub phase: String,
    pub current_item: String,
    pub processed_files: usize,
    pub total_files: usize,
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub percent: f32,
}

impl Default for ArchiveProgressState {
    fn default() -> Self {
        Self {
            running: false,
            phase: "idle".to_string(),
            current_item: String::new(),
            processed_files: 0,
            total_files: 0,
            processed_bytes: 0,
            total_bytes: 0,
            percent: 0.0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArchiveCreateResult {
    pub archive_path: String,
    pub format: String,
    pub size_bytes: u64,
    pub total_files: usize,
    pub elapsed_ms: u64,
}

pub const MAX_ZIP_ENTRIES: usize = u16::MAX as usize;
pub const MAX_ZIP_SINGLE_FILE_BYTES: u64 = u32::MAX as u64;
pub const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES: u64 = u32::MAX as u64;
const RAR_EXECUTION_TIMEOUT: Duration = Duration::from_secs(1800);

static ARCHIVE_PROGRESS: LazyLock<Mutex<ArchiveProgressState>> =
    LazyLock::new(|| Mutex::new(ArchiveProgressState::default()));
static ACTIVE_OPERATION_TOKEN: LazyLock<Mutex<Option<Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(None));
static ACTIVE_RAR_CHILD: LazyLock<Mutex<Option<Arc<Mutex<Child>>>>> =
    LazyLock::new(|| Mutex::new(None));

fn set_progress(update: impl FnOnce(&mut ArchiveProgressState)) {
    if let Ok(mut guard) = ARCHIVE_PROGRESS.lock() {
        update(&mut guard);
    }
}

struct ArchiveOperationGuard {
    token: Arc<AtomicBool>,
}

impl ArchiveOperationGuard {
    fn try_acquire() -> Result<Self, String> {
        let mut guard = ACTIVE_OPERATION_TOKEN
            .lock()
            .map_err(|_| "Состояние архиватора заблокировано".to_string())?;
        if guard.is_some() {
            return Err("Дождитесь завершения или отмены текущей операции архивации".to_string());
        }
        let token = Arc::new(AtomicBool::new(false));
        *guard = Some(Arc::clone(&token));
        Ok(Self { token })
    }

    fn token(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.token)
    }
}

impl Drop for ArchiveOperationGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = ACTIVE_OPERATION_TOKEN.lock() {
            if guard
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &self.token))
            {
                *guard = None;
            }
        }
    }
}

struct TempFileCleanupGuard {
    path: Option<PathBuf>,
}

impl TempFileCleanupGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TempFileCleanupGuard {
    fn drop(&mut self) {
        if let Some(ref p) = self.path {
            let _ = fs::remove_file(p);
        }
    }
}

fn terminate_rar_child_tree(child_arc: &Arc<Mutex<Child>>) {
    if let Ok(mut child) = child_arc.lock() {
        let pid = child.id();
        #[cfg(target_os = "windows")]
        if pid > 0 {
            let mut tk = Command::new("taskkill");
            tk.args(["/F", "/T", "/PID", &pid.to_string()]);
            tk.creation_flags(CREATE_NO_WINDOW);
            let _ = tk.output();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

pub fn cancel_active_archive() {
    if let Ok(guard) = ACTIVE_OPERATION_TOKEN.lock() {
        if let Some(ref token) = *guard {
            token.store(true, Ordering::SeqCst);
        }
    }
    if let Ok(mut slot) = ACTIVE_RAR_CHILD.lock() {
        if let Some(child_arc) = slot.take() {
            terminate_rar_child_tree(&child_arc);
        }
    }
}

fn default_output_dir() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let desktop = PathBuf::from(&profile).join("Desktop");
            if desktop.is_dir() {
                return desktop.to_string_lossy().to_string();
            }
            let p = PathBuf::from(&profile);
            if p.is_dir() {
                return p.to_string_lossy().to_string();
            }
        }
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "C:\\".to_string())
}

fn find_rar_executable_from_candidates(candidates: &[PathBuf]) -> Option<PathBuf> {
    for cand in candidates {
        if cand.is_file() {
            return Some(cand.clone());
        }
    }
    None
}

pub fn find_rar_executable() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            candidates.push(dir.join("Rar.exe"));
            candidates.push(dir.join("WinRAR.exe"));
        }
    }

    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let roots = [
            RegKey::predef(HKEY_LOCAL_MACHINE),
            RegKey::predef(HKEY_CURRENT_USER),
        ];
        for root in roots {
            if let Ok(key) = root.open_subkey(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WinRAR.exe") {
                if let Ok(path_str) = key.get_value::<String, _>("") {
                    let trimmed = path_str.trim().trim_matches('"');
                    if !trimmed.is_empty() {
                        let winrar_exe = PathBuf::from(trimmed);
                        if let Some(parent) = winrar_exe.parent() {
                            candidates.push(parent.join("Rar.exe"));
                        }
                        candidates.push(winrar_exe);
                    }
                }
            }
        }

        for env_key in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
            if let Ok(base) = std::env::var(env_key) {
                let winrar_dir = PathBuf::from(base).join("WinRAR");
                candidates.push(winrar_dir.join("Rar.exe"));
                candidates.push(winrar_dir.join("WinRAR.exe"));
            }
        }
    }

    find_rar_executable_from_candidates(&candidates)
}

fn is_cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel.is_some_and(|flag| flag.load(Ordering::SeqCst))
}

fn compute_path_stats(path: &Path, cancel: Option<&AtomicBool>) -> Result<(u64, usize), String> {
    if is_cancelled(cancel) {
        return Err("Операция архивации отменена пользователем".to_string());
    }
    if !path.exists() {
        return Err(format!("Путь не найден: {}", path.display()));
    }
    if path.is_file() {
        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        return Ok((size, 1));
    }
    let mut total_size = 0u64;
    let mut file_count = 0usize;
    for entry in WalkDir::new(path).into_iter().flatten() {
        if is_cancelled(cancel) {
            return Err("Операция архивации отменена пользователем".to_string());
        }
        if entry.file_type().is_file() {
            file_count += 1;
            if let Ok(meta) = entry.metadata() {
                total_size = total_size.saturating_add(meta.len());
            }
        }
    }
    Ok((total_size, file_count))
}

#[tauri::command]
pub fn archive_get_capabilities() -> ArchiverCapabilities {
    let rar = find_rar_executable();
    ArchiverCapabilities {
        zip_available: true,
        rar_available: rar.is_some(),
        rar_path: rar.map(|p| p.to_string_lossy().to_string()),
        default_output_dir: default_output_dir(),
    }
}

#[tauri::command]
pub fn archive_get_progress() -> ArchiveProgressState {
    ARCHIVE_PROGRESS
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

#[tauri::command]
pub fn archive_cancel() -> Result<(), String> {
    cancel_active_archive();
    set_progress(|p| {
        if p.running {
            p.phase = "cancelling".to_string();
            p.current_item = "Отмена операции…".to_string();
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn archive_inspect_paths(paths: Vec<String>) -> Result<Vec<ArchiveSourceItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for raw in paths {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let p = PathBuf::from(trimmed);
            if !p.exists() {
                return Err(format!("Выбранный объект не существует: {trimmed}"));
            }
            let canon = fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
            let key = canon.to_string_lossy().to_lowercase();
            if !seen.insert(key) {
                continue;
            }
            let is_dir = p.is_dir();
            let (size_bytes, file_count) = compute_path_stats(&p, None)?;
            let name = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| trimmed.to_string());
            let parent_dir = p
                .parent()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            out.push(ArchiveSourceItem {
                path: p.to_string_lossy().to_string(),
                name,
                is_dir,
                size_bytes,
                file_count,
                parent_dir,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("Ошибка анализа путей: {e}"))?
}

#[cfg(target_os = "windows")]
fn main_window_hwnd_isize(app: &tauri::AppHandle) -> isize {
    app.get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(crate::hwnd_to_isize)
        .unwrap_or(0)
}

#[cfg(target_os = "windows")]
mod win_dialogs {
    use std::ffi::c_void;
    use std::path::PathBuf;

    const OFN_ALLOWMULTISELECT: u32 = 0x00000200;
    const OFN_PATHMUSTEXIST: u32 = 0x00000800;
    const OFN_FILEMUSTEXIST: u32 = 0x00001000;
    const OFN_NOCHANGEDIR: u32 = 0x00000008;
    const OFN_EXPLORER: u32 = 0x00080000;

    const BIF_RETURNONLYFSDIRS: u32 = 0x00000001;
    const BIF_NEWDIALOGSTYLE: u32 = 0x00000040;
    const COINIT_APARTMENTTHREADED: u32 = 0x2;
    const COINIT_DISABLE_OLE1DDE: u32 = 0x4;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct OPENFILENAMEW {
        lStructSize: u32,
        hwndOwner: isize,
        hInstance: isize,
        lpstrFilter: *const u16,
        lpstrCustomFilter: *mut u16,
        nMaxCustFilter: u32,
        nFilterIndex: u32,
        lpstrFile: *mut u16,
        nMaxFile: u32,
        lpstrFileTitle: *mut u16,
        nMaxFileTitle: u32,
        lpstrInitialDir: *const u16,
        lpstrTitle: *const u16,
        Flags: u32,
        nFileOffset: u16,
        nFileExtension: u16,
        lpstrDefExt: *const u16,
        lCustData: isize,
        lpfnHook: *const c_void,
        lpTemplateName: *const u16,
        pvReserved: *mut c_void,
        dwReserved: u32,
        FlagsEx: u32,
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    struct BROWSEINFOW {
        hwndOwner: isize,
        pidlRoot: *const c_void,
        pszDisplayName: *mut u16,
        lpszTitle: *const u16,
        ulFlags: u32,
        lpfn: *const c_void,
        lParam: isize,
        iImage: i32,
    }

    #[link(name = "comdlg32")]
    unsafe extern "system" {
        fn GetOpenFileNameW(ofn: *mut OPENFILENAMEW) -> i32;
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHBrowseForFolderW(bi: *mut BROWSEINFOW) -> *mut c_void;
        fn SHGetPathFromIDListW(pidl: *const c_void, psz_path: *mut u16) -> i32;
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(pv_reserved: *mut c_void, dw_coinit: u32) -> i32;
        fn CoUninitialize();
        fn CoTaskMemFree(pv: *mut c_void);
    }

    fn to_wide_z(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn pick_files(owner_hwnd: isize) -> Vec<String> {
        let mut buf = vec![0u16; 65536];
        let filter: Vec<u16> = "Все файлы (*.*)\0*.*\0\0".encode_utf16().collect();
        let title = to_wide_z("Выберите файлы для архива");

        let mut ofn = OPENFILENAMEW {
            lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
            hwndOwner: owner_hwnd,
            hInstance: 0,
            lpstrFilter: filter.as_ptr(),
            lpstrCustomFilter: std::ptr::null_mut(),
            nMaxCustFilter: 0,
            nFilterIndex: 1,
            lpstrFile: buf.as_mut_ptr(),
            nMaxFile: buf.len() as u32,
            lpstrFileTitle: std::ptr::null_mut(),
            nMaxFileTitle: 0,
            lpstrInitialDir: std::ptr::null(),
            lpstrTitle: title.as_ptr(),
            Flags: OFN_EXPLORER | OFN_ALLOWMULTISELECT | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR,
            nFileOffset: 0,
            nFileExtension: 0,
            lpstrDefExt: std::ptr::null(),
            lCustData: 0,
            lpfnHook: std::ptr::null(),
            lpTemplateName: std::ptr::null(),
            pvReserved: std::ptr::null_mut(),
            dwReserved: 0,
            FlagsEx: 0,
        };

        let ok = unsafe { GetOpenFileNameW(&mut ofn) };
        if ok == 0 {
            return Vec::new();
        }

        let mut parts: Vec<String> = Vec::new();
        let mut start = 0usize;
        while start < buf.len() {
            let mut end = start;
            while end < buf.len() && buf[end] != 0 {
                end += 1;
            }
            if end == start {
                break;
            }
            parts.push(String::from_utf16_lossy(&buf[start..end]));
            start = end + 1;
        }

        if parts.is_empty() {
            return Vec::new();
        }
        if parts.len() == 1 {
            return parts;
        }
        let dir = PathBuf::from(&parts[0]);
        parts[1..]
            .iter()
            .map(|name| dir.join(name).to_string_lossy().to_string())
            .collect()
    }

    pub fn pick_folder(owner_hwnd: isize, title_str: &str) -> Option<String> {
        let title = to_wide_z(title_str);
        let mut display = vec![0u16; 260];
        let mut path_buf = vec![0u16; 4096];

        unsafe {
            let hr = CoInitializeEx(
                std::ptr::null_mut(),
                COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE,
            );
            let mut bi = BROWSEINFOW {
                hwndOwner: owner_hwnd,
                pidlRoot: std::ptr::null(),
                pszDisplayName: display.as_mut_ptr(),
                lpszTitle: title.as_ptr(),
                ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
                lpfn: std::ptr::null(),
                lParam: 0,
                iImage: 0,
            };
            let pidl = SHBrowseForFolderW(&mut bi);
            let selected = if pidl.is_null() {
                None
            } else {
                let ok = SHGetPathFromIDListW(pidl, path_buf.as_mut_ptr());
                CoTaskMemFree(pidl);
                if ok != 0 {
                    let len = path_buf.iter().position(|&c| c == 0).unwrap_or(0);
                    if len > 0 {
                        Some(String::from_utf16_lossy(&path_buf[..len]))
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            if hr >= 0 {
                CoUninitialize();
            }
            selected
        }
    }
}

#[tauri::command]
pub async fn archive_pick_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = main_window_hwnd_isize(&app);
        return tauri::async_runtime::spawn_blocking(move || win_dialogs::pick_files(hwnd))
            .await
            .map_err(|e| format!("Ошибка диалога выбора файлов: {e}"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Диалог выбора файлов поддерживается только в Windows".to_string())
    }
}

#[tauri::command]
pub async fn archive_pick_folder(
    app: tauri::AppHandle,
    title: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = main_window_hwnd_isize(&app);
        let dialog_title = title.unwrap_or_else(|| "Выберите папку".to_string());
        return tauri::async_runtime::spawn_blocking(move || {
            win_dialogs::pick_folder(hwnd, &dialog_title)
        })
        .await
        .map_err(|e| format!("Ошибка диалога выбора папки: {e}"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, title);
        Err("Диалог выбора папки поддерживается только в Windows".to_string())
    }
}

fn sanitize_archive_name(raw_name: &str, ext: &str) -> Result<String, String> {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return Err("Укажите имя архива".to_string());
    }
    let invalid_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    if trimmed.chars().any(|c| invalid_chars.contains(&c) || c.is_control()) {
        return Err("Имя архива содержит недопустимые символы".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    let without_other = if lower.ends_with(".zip") {
        &trimmed[..trimmed.len() - 4]
    } else if lower.ends_with(".rar") {
        &trimmed[..trimmed.len() - 4]
    } else {
        trimmed
    };
    let stem = without_other.trim().trim_end_matches('.');
    if stem.is_empty() {
        return Err("Укажите корректное имя архива".to_string());
    }
    Ok(format!("{stem}.{ext}"))
}

fn system_time_to_dos_datetime(time: Option<SystemTime>) -> (u16, u16) {
    let secs = time
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(315_532_800); // 1980-01-01
    let days_since_epoch = (secs / 86_400) as i64;
    let sod = secs % 86_400;
    let hour = ((sod / 3600) as u16).min(23);
    let min = (((sod % 3600) / 60) as u16).min(59);
    let sec2 = (((sod % 60) / 2) as u16).min(29);

    // Howard Hinnant civil-from-days algorithm
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u16;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u16;
    let year = (y + if month <= 2 { 1 } else { 0 }).clamp(1980, 2107) as u16;

    let dos_time = (hour << 11) | (min << 5) | sec2;
    let dos_date = ((year - 1980) << 9) | (month << 5) | day;
    (dos_time, dos_date)
}

#[derive(Clone)]
struct ZipPlanEntry {
    disk_path: PathBuf,
    archive_name: String,
    is_dir: bool,
    dos_time: u16,
    dos_date: u16,
}

struct CentralDirRecord {
    name_bytes: Vec<u8>,
    is_dir: bool,
    method: u16,
    dos_time: u16,
    dos_date: u16,
    crc32: u32,
    comp_size: u32,
    uncomp_size: u32,
    local_header_offset: u32,
}

fn allocate_unique_root_name(base: &str, used: &mut HashSet<String>) -> String {
    let clean = base.trim_matches(|c| c == '/' || c == '\\');
    let seed = if clean.is_empty() { "item" } else { clean };
    if used.insert(seed.to_ascii_lowercase()) {
        return seed.to_string();
    }
    let path = Path::new(seed);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| seed.to_string());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut n = 2usize;
    loop {
        let candidate = format!("{stem}_{n}{ext}");
        if used.insert(candidate.to_ascii_lowercase()) {
            return candidate;
        }
        n += 1;
    }
}

fn validate_zip_entry_budget(
    entry_count: usize,
    file_size: u64,
    total_uncompressed: u64,
    entry_name: &str,
    max_entries: usize,
    max_single_file_bytes: u64,
    max_total_bytes: u64,
) -> Result<(), String> {
    if file_size > max_single_file_bytes {
        return Err(format!(
            "Файл «{entry_name}» превышает лимит стандартного 32-битного ZIP (4 ГБ). Используйте формат RAR."
        ));
    }
    if total_uncompressed > max_total_bytes {
        return Err(
            "Суммарный размер выбранных файлов превышает лимит стандартного 32-битного ZIP (4 ГБ). Используйте формат RAR или разделите архив."
                .to_string(),
        );
    }
    if entry_count > max_entries {
        return Err(format!(
            "Слишком много объектов для стандартного ZIP (макс. {max_entries} записей). Используйте формат RAR."
        ));
    }
    Ok(())
}

fn collect_zip_entries_with_limits(
    sources: &[PathBuf],
    output_path: Option<&Path>,
    cancel: &AtomicBool,
    max_entries: usize,
    max_single_file_bytes: u64,
    max_total_bytes: u64,
) -> Result<(Vec<ZipPlanEntry>, u64, usize), String> {
    let mut used_roots = HashSet::new();
    let mut entries = Vec::new();
    let mut total_bytes = 0u64;
    let mut total_files = 0usize;
    let output_canon = output_path.and_then(|p| fs::canonicalize(p).ok());

    for src in sources {
        if cancel.load(Ordering::SeqCst) {
            return Err("Создание архива отменено пользователем".to_string());
        }
        if !src.exists() {
            return Err(format!("Исходный путь не найден: {}", src.display()));
        }
        let raw_name = src
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "root".to_string());
        let root_name = allocate_unique_root_name(&raw_name, &mut used_roots);

        if src.is_file() {
            let meta = fs::metadata(src).map_err(|e| format!("Ошибка чтения {}: {e}", src.display()))?;
            let (dos_time, dos_date) = system_time_to_dos_datetime(meta.modified().ok());
            let sz = meta.len();
            total_bytes = total_bytes
                .checked_add(sz)
                .ok_or_else(|| "Превышен допустимый объём архива ZIP".to_string())?;
            total_files += 1;
            validate_zip_entry_budget(
                entries.len() + 1,
                sz,
                total_bytes,
                &root_name,
                max_entries,
                max_single_file_bytes,
                max_total_bytes,
            )?;
            entries.push(ZipPlanEntry {
                disk_path: src.clone(),
                archive_name: root_name,
                is_dir: false,
                dos_time,
                dos_date,
            });
            continue;
        }

        let dir_meta = fs::metadata(src).ok();
        let (dir_t, dir_d) = system_time_to_dos_datetime(dir_meta.and_then(|m| m.modified().ok()));
        validate_zip_entry_budget(
            entries.len() + 1,
            0,
            total_bytes,
            &root_name,
            max_entries,
            max_single_file_bytes,
            max_total_bytes,
        )?;
        entries.push(ZipPlanEntry {
            disk_path: src.clone(),
            archive_name: format!("{root_name}/"),
            is_dir: true,
            dos_time: dir_t,
            dos_date: dir_d,
        });

        for walk_res in WalkDir::new(src).sort(true) {
            if cancel.load(Ordering::SeqCst) {
                return Err("Создание архива отменено пользователем".to_string());
            }
            let entry = walk_res.map_err(|e| format!("Ошибка обхода {}: {e}", src.display()))?;
            let p = entry.path();
            if p == *src {
                continue;
            }
            if let Some(ref out_c) = output_canon {
                if let Ok(p_canon) = fs::canonicalize(&p) {
                    if &p_canon == out_c {
                        continue;
                    }
                }
            }
            let Ok(rel) = p.strip_prefix(src) else {
                continue;
            };
            let rel_posix = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            if rel_posix.is_empty() {
                continue;
            }
            let meta = entry.metadata().ok();
            let (dos_time, dos_date) =
                system_time_to_dos_datetime(meta.as_ref().and_then(|m| m.modified().ok()));
            if entry.file_type().is_dir() {
                let archive_name = format!("{root_name}/{rel_posix}/");
                validate_zip_entry_budget(
                    entries.len() + 1,
                    0,
                    total_bytes,
                    &archive_name,
                    max_entries,
                    max_single_file_bytes,
                    max_total_bytes,
                )?;
                entries.push(ZipPlanEntry {
                    disk_path: p,
                    archive_name,
                    is_dir: true,
                    dos_time,
                    dos_date,
                });
            } else if entry.file_type().is_file() {
                let sz = meta.map(|m| m.len()).unwrap_or(0);
                let archive_name = format!("{root_name}/{rel_posix}");
                total_bytes = total_bytes
                    .checked_add(sz)
                    .ok_or_else(|| "Превышен допустимый объём архива ZIP".to_string())?;
                total_files += 1;
                validate_zip_entry_budget(
                    entries.len() + 1,
                    sz,
                    total_bytes,
                    &archive_name,
                    max_entries,
                    max_single_file_bytes,
                    max_total_bytes,
                )?;
                entries.push(ZipPlanEntry {
                    disk_path: p,
                    archive_name,
                    is_dir: false,
                    dos_time,
                    dos_date,
                });
            }

            if entries.len() % 32 == 0 {
                set_progress(|prog| {
                    prog.total_files = total_files;
                    prog.total_bytes = total_bytes;
                    prog.current_item = format!("Сканирование ({total_files} ф.)…");
                });
            }
        }
    }

    Ok((entries, total_bytes, total_files))
}

fn create_zip_archive(
    sources: &[PathBuf],
    output_path: &Path,
    compression_level: &str,
    cancel: &AtomicBool,
) -> Result<(u64, usize), String> {
    let compression = match compression_level {
        "store" => None,
        "fast" => Some(Compression::fast()),
        "max" => Some(Compression::best()),
        _ => Some(Compression::default()),
    };

    set_progress(|p| {
        p.phase = "scanning".to_string();
        p.current_item = "Анализ структуры файлов и папок…".to_string();
    });

    let (entries, total_bytes, total_files) = collect_zip_entries_with_limits(
        sources,
        Some(output_path),
        cancel,
        MAX_ZIP_ENTRIES,
        MAX_ZIP_SINGLE_FILE_BYTES,
        MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
    )?;

    if cancel.load(Ordering::SeqCst) {
        return Err("Создание архива отменено пользователем".to_string());
    }

    set_progress(|p| {
        p.phase = "compressing".to_string();
        p.total_files = total_files;
        p.total_bytes = total_bytes;
        p.processed_files = 0;
        p.processed_bytes = 0;
        p.percent = 0.0;
    });

    let tmp_name = format!(
        ".nexus_tmp_{}_{}.zip",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let tmp_path = output_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(tmp_name);
    let mut tmp_guard = TempFileCleanupGuard::new(tmp_path.clone());

    let write_res: Result<u64, String> = (|| {
        let file = File::create(&tmp_path)
            .map_err(|e| format!("Не удалось создать временный ZIP-файл: {e}"))?;
        let mut writer = BufWriter::with_capacity(256 * 1024, file);
        let mut central_records: Vec<CentralDirRecord> = Vec::with_capacity(entries.len());
        let mut processed_files = 0usize;
        let mut processed_bytes = 0u64;
        let mut buf = vec![0u8; 64 * 1024];

        for item in &entries {
            if cancel.load(Ordering::SeqCst) {
                return Err("Создание архива отменено пользователем".to_string());
            }

            let name_bytes = item.archive_name.as_bytes().to_vec();
            if name_bytes.len() > u16::MAX as usize {
                return Err(format!("Слишком длинное имя в архиве: {}", item.archive_name));
            }
            let local_pos = writer
                .stream_position()
                .map_err(|e| format!("Ошибка позиционирования ZIP: {e}"))?;
            if local_pos > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES {
                return Err("Превышен лимит размера стандартного ZIP (4 ГБ)".to_string());
            }
            let local_header_offset = local_pos as u32;

            let use_deflate = !item.is_dir && compression.is_some();
            let method: u16 = if use_deflate { 8 } else { 0 };

            // Local file header (30 bytes)
            writer.write_all(&0x04034b50u32.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&20u16.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&0x0800u16.to_le_bytes()).map_err(|e| e.to_string())?; // UTF-8 flag
            writer.write_all(&method.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&item.dos_time.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&item.dos_date.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&0u32.to_le_bytes()).map_err(|e| e.to_string())?; // CRC placeholder
            writer.write_all(&0u32.to_le_bytes()).map_err(|e| e.to_string())?; // comp placeholder
            writer.write_all(&0u32.to_le_bytes()).map_err(|e| e.to_string())?; // uncomp placeholder
            writer
                .write_all(&(name_bytes.len() as u16).to_le_bytes())
                .map_err(|e| e.to_string())?;
            writer.write_all(&0u16.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&name_bytes).map_err(|e| e.to_string())?;

            let mut crc_value = 0u32;
            let mut comp_size_u64 = 0u64;
            let mut uncomp_size_u64 = 0u64;

            if !item.is_dir {
                set_progress(|p| {
                    p.current_item = item.archive_name.clone();
                });

                let data_start = writer
                    .stream_position()
                    .map_err(|e| format!("Ошибка потока ZIP: {e}"))?;
                let src_file = File::open(&item.disk_path)
                    .map_err(|e| format!("Не удалось прочитать файл {}: {e}", item.disk_path.display()))?;
                let mut reader = BufReader::with_capacity(64 * 1024, src_file);
                let mut hasher = Hasher::new();

                if let Some(level) = compression {
                    let mut encoder = DeflateEncoder::new(&mut writer, level);
                    loop {
                        if cancel.load(Ordering::SeqCst) {
                            return Err("Создание архива отменено пользователем".to_string());
                        }
                        let n = reader
                            .read(&mut buf)
                            .map_err(|e| format!("Ошибка чтения {}: {e}", item.disk_path.display()))?;
                        if n == 0 {
                            break;
                        }
                        hasher.update(&buf[..n]);
                        encoder
                            .write_all(&buf[..n])
                            .map_err(|e| format!("Ошибка сжатия {}: {e}", item.archive_name))?;
                        uncomp_size_u64 = uncomp_size_u64.saturating_add(n as u64);
                        if uncomp_size_u64 > MAX_ZIP_SINGLE_FILE_BYTES {
                            return Err(format!(
                                "Файл {} превышает 4 ГБ (лимит стандартного ZIP)",
                                item.archive_name
                            ));
                        }
                        processed_bytes = processed_bytes.saturating_add(n as u64);
                        set_progress(|p| {
                            p.processed_bytes = processed_bytes;
                            if total_bytes > 0 {
                                p.percent = ((processed_bytes as f64 / total_bytes as f64) * 100.0)
                                    .clamp(0.0, 99.5) as f32;
                            }
                        });
                    }
                    encoder
                        .finish()
                        .map_err(|e| format!("Ошибка завершения deflate для {}: {e}", item.archive_name))?;
                } else {
                    loop {
                        if cancel.load(Ordering::SeqCst) {
                            return Err("Создание архива отменено пользователем".to_string());
                        }
                        let n = reader
                            .read(&mut buf)
                            .map_err(|e| format!("Ошибка чтения {}: {e}", item.disk_path.display()))?;
                        if n == 0 {
                            break;
                        }
                        hasher.update(&buf[..n]);
                        writer
                            .write_all(&buf[..n])
                            .map_err(|e| format!("Ошибка записи ZIP: {e}"))?;
                        uncomp_size_u64 = uncomp_size_u64.saturating_add(n as u64);
                        if uncomp_size_u64 > MAX_ZIP_SINGLE_FILE_BYTES {
                            return Err(format!(
                                "Файл {} превышает 4 ГБ (лимит стандартного ZIP)",
                                item.archive_name
                            ));
                        }
                        processed_bytes = processed_bytes.saturating_add(n as u64);
                        set_progress(|p| {
                            p.processed_bytes = processed_bytes;
                            if total_bytes > 0 {
                                p.percent = ((processed_bytes as f64 / total_bytes as f64) * 100.0)
                                    .clamp(0.0, 99.5) as f32;
                            }
                        });
                    }
                }

                let data_end = writer
                    .stream_position()
                    .map_err(|e| format!("Ошибка потока ZIP: {e}"))?;
                comp_size_u64 = data_end.saturating_sub(data_start);
                crc_value = hasher.finalize();

                if comp_size_u64 > MAX_ZIP_SINGLE_FILE_BYTES || uncomp_size_u64 > MAX_ZIP_SINGLE_FILE_BYTES {
                    return Err(format!(
                        "Файл {} превышает 4 ГБ (лимит стандартного ZIP)",
                        item.archive_name
                    ));
                }

                // Back-patch CRC-32, compressed size and uncompressed size in Local File Header
                writer
                    .seek(SeekFrom::Start(local_pos + 14))
                    .map_err(|e| e.to_string())?;
                writer.write_all(&crc_value.to_le_bytes()).map_err(|e| e.to_string())?;
                writer
                    .write_all(&(comp_size_u64 as u32).to_le_bytes())
                    .map_err(|e| e.to_string())?;
                writer
                    .write_all(&(uncomp_size_u64 as u32).to_le_bytes())
                    .map_err(|e| e.to_string())?;
                writer.seek(SeekFrom::Start(data_end)).map_err(|e| e.to_string())?;

                processed_files += 1;
                set_progress(|p| {
                    p.processed_files = processed_files;
                    if total_bytes == 0 && total_files > 0 {
                        p.percent = ((processed_files as f64 / total_files as f64) * 100.0)
                            .clamp(0.0, 99.5) as f32;
                    }
                });
            }

            central_records.push(CentralDirRecord {
                name_bytes,
                is_dir: item.is_dir,
                method,
                dos_time: item.dos_time,
                dos_date: item.dos_date,
                crc32: crc_value,
                comp_size: comp_size_u64 as u32,
                uncomp_size: uncomp_size_u64 as u32,
                local_header_offset,
            });
        }

        if cancel.load(Ordering::SeqCst) {
            return Err("Создание архива отменено пользователем".to_string());
        }

        let cd_offset_u64 = writer
            .stream_position()
            .map_err(|e| format!("Ошибка позиции Central Directory: {e}"))?;
        if cd_offset_u64 > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES {
            return Err("Превышен лимит размера стандартного ZIP (4 ГБ)".to_string());
        }

        for rec in &central_records {
            let ext_attr: u32 = if rec.is_dir { 0x10 } else { 0x20 };
            writer.write_all(&0x02014b50u32.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&20u16.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&20u16.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&0x0800u16.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&rec.method.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&rec.dos_time.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&rec.dos_date.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&rec.crc32.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&rec.comp_size.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&rec.uncomp_size.to_le_bytes()).map_err(|e| e.to_string())?;
            writer
                .write_all(&(rec.name_bytes.len() as u16).to_le_bytes())
                .map_err(|e| e.to_string())?;
            writer.write_all(&0u16.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&0u16.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&0u16.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&0u16.to_le_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(&ext_attr.to_le_bytes()).map_err(|e| e.to_string())?;
            writer
                .write_all(&rec.local_header_offset.to_le_bytes())
                .map_err(|e| e.to_string())?;
            writer.write_all(&rec.name_bytes).map_err(|e| e.to_string())?;
        }

        let cd_end_u64 = writer
            .stream_position()
            .map_err(|e| format!("Ошибка конца Central Directory: {e}"))?;
        let cd_size_u64 = cd_end_u64.saturating_sub(cd_offset_u64);
        if cd_size_u64 > u32::MAX as u64 {
            return Err("Превышен размер оглавления ZIP".to_string());
        }
        let cd_size = cd_size_u64 as u32;
        let count = central_records.len() as u16;

        writer.write_all(&0x06054b50u32.to_le_bytes()).map_err(|e| e.to_string())?;
        writer.write_all(&0u16.to_le_bytes()).map_err(|e| e.to_string())?;
        writer.write_all(&0u16.to_le_bytes()).map_err(|e| e.to_string())?;
        writer.write_all(&count.to_le_bytes()).map_err(|e| e.to_string())?;
        writer.write_all(&count.to_le_bytes()).map_err(|e| e.to_string())?;
        writer.write_all(&cd_size.to_le_bytes()).map_err(|e| e.to_string())?;
        writer
            .write_all(&(cd_offset_u64 as u32).to_le_bytes())
            .map_err(|e| e.to_string())?;
        writer.write_all(&0u16.to_le_bytes()).map_err(|e| e.to_string())?;

        writer.flush().map_err(|e| format!("Ошибка сброса буфера ZIP: {e}"))?;
        drop(writer);

        if cancel.load(Ordering::SeqCst) {
            return Err("Создание архива отменено пользователем".to_string());
        }

        if let Err(_first_err) = fs::rename(&tmp_path, output_path) {
            if output_path.exists() {
                fs::remove_file(output_path)
                    .map_err(|e| format!("Не удалось заменить существующий файл: {e}"))?;
            }
            fs::rename(&tmp_path, output_path)
                .map_err(|e| format!("Не удалось сохранить итоговый ZIP-архив: {e}"))?;
        }
        tmp_guard.disarm();

        let final_size = fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);
        Ok(final_size)
    })();

    match write_res {
        Ok(final_size) => Ok((final_size, total_files)),
        Err(err) => Err(err),
    }
}

fn create_rar_archive_with_exe(
    rar_exe_opt: Option<PathBuf>,
    sources: &[PathBuf],
    output_path: &Path,
    compression_level: &str,
    cancel: &AtomicBool,
) -> Result<(u64, usize), String> {
    let Some(rar_exe) = rar_exe_opt else {
        return Err(
            "Архиватор WinRAR (Rar.exe / WinRAR.exe) не обнаружен в системе. Установите WinRAR для создания RAR-архивов или выберите формат ZIP."
                .to_string(),
        );
    };

    if cancel.load(Ordering::SeqCst) {
        return Err("Создание RAR-архива отменено пользователем".to_string());
    }

    let m_flag = match compression_level {
        "store" => "-m0",
        "fast" => "-m1",
        "max" => "-m5",
        _ => "-m3",
    };

    set_progress(|p| {
        p.phase = "scanning".to_string();
        p.current_item = "Подсчёт файлов для RAR…".to_string();
    });

    let mut total_bytes = 0u64;
    let mut total_files = 0usize;
    for s in sources {
        let (sz, cnt) = compute_path_stats(s, Some(cancel))?;
        total_bytes = total_bytes.saturating_add(sz);
        total_files += cnt;
    }

    if cancel.load(Ordering::SeqCst) {
        return Err("Создание RAR-архива отменено пользователем".to_string());
    }

    let tmp_name = format!(
        "nexus_tmp_{}_{}.rar",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let tmp_path = output_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(tmp_name);
    let mut tmp_guard = TempFileCleanupGuard::new(tmp_path.clone());

    set_progress(|p| {
        p.phase = "compressing".to_string();
        p.total_files = total_files;
        p.total_bytes = total_bytes;
        p.current_item = format!(
            "Упаковка через {}…",
            rar_exe
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Rar.exe".to_string())
        );
        p.percent = 12.0;
    });

    let mut cmd = Command::new(&rar_exe);
    cmd.arg("a")
        .arg("-y")
        .arg("-r")
        .arg("-ep1")
        .arg(m_flag)
        .arg("--")
        .arg(&tmp_path);
    for src in sources {
        cmd.arg(src);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Не удалось запустить {}: {e}", rar_exe.display()))?;
    let child_arc = Arc::new(Mutex::new(child));
    if let Ok(mut slot) = ACTIVE_RAR_CHILD.lock() {
        *slot = Some(Arc::clone(&child_arc));
    }

    let rar_started = Instant::now();
    let wait_res = loop {
        if cancel.load(Ordering::SeqCst) {
            terminate_rar_child_tree(&child_arc);
            break Err("Создание RAR-архива отменено пользователем".to_string());
        }
        if rar_started.elapsed() > RAR_EXECUTION_TIMEOUT {
            terminate_rar_child_tree(&child_arc);
            break Err("Превышено время ожидания процесса Rar.exe".to_string());
        }
        let status_opt = {
            let mut c = child_arc
                .lock()
                .map_err(|_| "Блокировка процесса RAR".to_string())?;
            c.try_wait()
                .map_err(|e| format!("Ошибка ожидания Rar.exe: {e}"))?
        };
        if let Some(status) = status_opt {
            if status.success() {
                break Ok(());
            }
            let code = status.code().unwrap_or(-1);
            let mut detail = String::new();
            if let Ok(mut c) = child_arc.lock() {
                if let Some(mut err_pipe) = c.stderr.take() {
                    let _ = err_pipe.read_to_string(&mut detail);
                }
            }
            let trimmed = detail.trim();
            if trimmed.is_empty() {
                break Err(format!("Архиватор завершил работу с кодом {code}"));
            }
            break Err(format!("Ошибка архиватора (код {code}): {trimmed}"));
        }
        set_progress(|p| {
            if p.percent < 92.0 {
                p.percent = (p.percent + 1.5).min(92.0);
            }
        });
        std::thread::sleep(Duration::from_millis(80));
    };

    if let Ok(mut slot) = ACTIVE_RAR_CHILD.lock() {
        *slot = None;
    }

    wait_res?;

    if !tmp_path.is_file() {
        return Err("Архиватор не создал выходной .rar файл".to_string());
    }

    if let Err(_first_err) = fs::rename(&tmp_path, output_path) {
        if output_path.exists() {
            fs::remove_file(output_path)
                .map_err(|e| format!("Не удалось заменить существующий RAR-архив: {e}"))?;
        }
        fs::rename(&tmp_path, output_path)
            .map_err(|e| format!("Не удалось сохранить итоговый RAR-архив: {e}"))?;
    }
    tmp_guard.disarm();

    let final_size = fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);
    Ok((final_size, total_files))
}

fn create_archive_sync(
    req: ArchiveCreateRequest,
    rar_override: Option<Option<PathBuf>>,
) -> Result<ArchiveCreateResult, String> {
    if req.sources.is_empty() {
        return Err("Добавьте хотя бы один файл или папку для архивации".to_string());
    }

    let format_norm = req.format.trim().to_ascii_lowercase();
    if format_norm != "zip" && format_norm != "rar" {
        return Err(format!("Неподдерживаемый формат архива: {}", req.format));
    }

    let dest_dir = PathBuf::from(req.destination_dir.trim());
    if !dest_dir.is_dir() {
        return Err(format!(
            "Папка назначения не существует: {}",
            req.destination_dir
        ));
    }

    let file_name = sanitize_archive_name(&req.archive_name, &format_norm)?;
    let output_path = dest_dir.join(file_name);

    let mut source_paths = Vec::with_capacity(req.sources.len());
    let mut seen_src = HashSet::new();
    for s in &req.sources {
        let p = PathBuf::from(s.trim());
        if !p.exists() {
            return Err(format!("Исходный объект не найден: {s}"));
        }
        let canon = fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
        let key = canon.to_string_lossy().to_lowercase();
        if !seen_src.insert(key) {
            continue;
        }
        if let Some(out_parent) = output_path.parent() {
            if let Ok(canon_parent) = fs::canonicalize(out_parent) {
                let candidate_out = canon_parent.join(output_path.file_name().unwrap_or_default());
                if candidate_out == canon {
                    return Err("Нельзя перезаписать один из исходных файлов".to_string());
                }
            }
        }
        source_paths.push(p);
    }

    let op_guard = ArchiveOperationGuard::try_acquire()?;
    let cancel_token = op_guard.token();

    set_progress(|p| {
        *p = ArchiveProgressState {
            running: true,
            phase: "preparing".to_string(),
            current_item: "Подготовка…".to_string(),
            processed_files: 0,
            total_files: 0,
            processed_bytes: 0,
            total_bytes: 0,
            percent: 0.0,
        };
    });

    let started = Instant::now();
    let res = match format_norm.as_str() {
        "zip" => create_zip_archive(
            &source_paths,
            &output_path,
            &req.compression_level,
            &cancel_token,
        ),
        "rar" => {
            let rar_exe = match rar_override {
                Some(ov) => ov,
                None => find_rar_executable(),
            };
            create_rar_archive_with_exe(
                rar_exe,
                &source_paths,
                &output_path,
                &req.compression_level,
                &cancel_token,
            )
        }
        _ => unreachable!(),
    };

    match res {
        Ok((size_bytes, total_files)) => {
            set_progress(|p| {
                p.running = false;
                p.phase = "done".to_string();
                p.current_item = output_path.to_string_lossy().to_string();
                p.processed_files = total_files;
                p.total_files = total_files;
                p.percent = 100.0;
            });
            Ok(ArchiveCreateResult {
                archive_path: output_path.to_string_lossy().to_string(),
                format: format_norm,
                size_bytes,
                total_files,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        }
        Err(err) => {
            let was_cancelled = cancel_token.load(Ordering::SeqCst);
            set_progress(|p| {
                p.running = false;
                p.phase = if was_cancelled { "cancelled" } else { "error" }.to_string();
                p.current_item = err.clone();
            });
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn archive_create(req: ArchiveCreateRequest) -> Result<ArchiveCreateResult, String> {
    tauri::async_runtime::spawn_blocking(move || create_archive_sync(req, None))
        .await
        .map_err(|e| format!("Ошибка потока архивации: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::DeflateDecoder;
    use std::io::Read;

    static TEST_ARCHIVE_SERIALIZE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn make_temp_test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nexus_archive_test_{}_{}_{}",
            tag,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[derive(Debug)]
    struct ParsedZipEntry {
        name: String,
        flags: u16,
        method: u16,
        data: Vec<u8>,
    }

    fn parse_and_verify_zip(zip_path: &Path) -> Vec<ParsedZipEntry> {
        let raw = fs::read(zip_path).expect("zip file readable");
        assert!(raw.len() >= 22, "zip must have EOCD");
        let eocd_pos = raw
            .windows(4)
            .rposition(|w| w == b"PK\x05\x06")
            .expect("EOCD signature missing");
        let total_entries = u16::from_le_bytes([raw[eocd_pos + 10], raw[eocd_pos + 11]]) as usize;
        let cd_size = u32::from_le_bytes(raw[eocd_pos + 12..eocd_pos + 16].try_into().unwrap()) as usize;
        let cd_offset = u32::from_le_bytes(raw[eocd_pos + 16..eocd_pos + 20].try_into().unwrap()) as usize;
        assert_eq!(cd_offset + cd_size, eocd_pos, "Central Directory bounds mismatch EOCD");

        let mut entries = Vec::new();
        let mut cursor = cd_offset;
        for _ in 0..total_entries {
            assert_eq!(&raw[cursor..cursor + 4], b"PK\x01\x02", "Central dir sig");
            let flags = u16::from_le_bytes([raw[cursor + 8], raw[cursor + 9]]);
            let method = u16::from_le_bytes([raw[cursor + 10], raw[cursor + 11]]);
            let crc32 = u32::from_le_bytes(raw[cursor + 16..cursor + 20].try_into().unwrap());
            let comp_size = u32::from_le_bytes(raw[cursor + 20..cursor + 24].try_into().unwrap()) as usize;
            let uncomp_size = u32::from_le_bytes(raw[cursor + 24..cursor + 28].try_into().unwrap()) as usize;
            let name_len = u16::from_le_bytes([raw[cursor + 28], raw[cursor + 29]]) as usize;
            let extra_len = u16::from_le_bytes([raw[cursor + 30], raw[cursor + 31]]) as usize;
            let comment_len = u16::from_le_bytes([raw[cursor + 32], raw[cursor + 33]]) as usize;
            let local_off = u32::from_le_bytes(raw[cursor + 42..cursor + 46].try_into().unwrap()) as usize;
            let name = String::from_utf8(raw[cursor + 46..cursor + 46 + name_len].to_vec())
                .expect("UTF-8 filename in ZIP");
            cursor += 46 + name_len + extra_len + comment_len;

            assert_eq!(&raw[local_off..local_off + 4], b"PK\x03\x04", "Local header sig");
            let l_name_len = u16::from_le_bytes([raw[local_off + 26], raw[local_off + 27]]) as usize;
            let l_extra_len = u16::from_le_bytes([raw[local_off + 28], raw[local_off + 29]]) as usize;
            let data_start = local_off + 30 + l_name_len + l_extra_len;
            let comp_slice = &raw[data_start..data_start + comp_size];

            let uncomp = match method {
                0 => comp_slice.to_vec(),
                8 => {
                    let mut dec = DeflateDecoder::new(comp_slice);
                    let mut out = Vec::new();
                    dec.read_to_end(&mut out).expect("deflate decode succeeds");
                    out
                }
                other => panic!("unexpected compression method {other}"),
            };
            assert_eq!(uncomp.len(), uncomp_size, "uncompressed size mismatch for {name}");
            let actual_crc = crc32fast::hash(&uncomp);
            assert_eq!(actual_crc, crc32, "CRC32 mismatch for {name}");

            entries.push(ParsedZipEntry {
                name,
                flags,
                method,
                data: uncomp,
            });
        }
        assert_eq!(cursor, eocd_pos);
        entries
    }

    #[test]
    fn creates_valid_zip_with_files_and_nested_folders_without_touching_sources() {
        let _guard = TEST_ARCHIVE_SERIALIZE.lock().unwrap();
        let root = make_temp_test_dir("zip");
        let src_dir = root.join("src_data");
        let folder_a = src_dir.join("configs");
        let empty_sub = folder_a.join("empty_sub");
        fs::create_dir_all(&empty_sub).unwrap();
        let file1 = src_dir.join("notes.txt");
        let file2 = folder_a.join("app.json");
        fs::write(&file1, b"hello nexus zip world 12345").unwrap();
        fs::write(&file2, br#"{"nexus":true,"mode":"cyber"}"#).unwrap();

        let out_dir = root.join("out");
        fs::create_dir_all(&out_dir).unwrap();

        let result = create_archive_sync(
            ArchiveCreateRequest {
                format: "zip".to_string(),
                sources: vec![
                    file1.to_string_lossy().to_string(),
                    folder_a.to_string_lossy().to_string(),
                ],
                destination_dir: out_dir.to_string_lossy().to_string(),
                archive_name: "backup_pack".to_string(),
                compression_level: "normal".to_string(),
            },
            None,
        )
        .expect("ZIP creation should succeed");

        let zip_path = PathBuf::from(&result.archive_path);
        assert!(zip_path.is_file());
        assert_eq!(result.total_files, 2);
        assert!(result.size_bytes > 0);
        // Исходные файлы остались нетронутыми
        assert_eq!(fs::read(&file1).unwrap(), b"hello nexus zip world 12345");
        assert_eq!(fs::read(&file2).unwrap(), br#"{"nexus":true,"mode":"cyber"}"#);

        let parsed = parse_and_verify_zip(&zip_path);
        let names: Vec<&str> = parsed.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"notes.txt"));
        assert!(names.contains(&"configs/app.json"));
        assert!(names.contains(&"configs/empty_sub/"));
        let notes = parsed.iter().find(|e| e.name == "notes.txt").unwrap();
        assert_eq!(notes.data, b"hello nexus zip world 12345");
        assert_eq!(notes.method, 8);
        assert_eq!(notes.flags & 0x0800, 0x0800);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_handles_empty_folder_duplicate_root_names_and_cyrillic_unicode() {
        let _guard = TEST_ARCHIVE_SERIALIZE.lock().unwrap();
        let root = make_temp_test_dir("unicode_dups");
        let empty_folder = root.join("Пустая Папка");
        let dir_a = root.join("Документы");
        let dir_b = root.join("Архив");
        fs::create_dir_all(&empty_folder).unwrap();
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();

        let dup_a = dir_a.join("отчёт.txt");
        let dup_b = dir_b.join("отчёт.txt");
        let payload_a = "Первый отчёт NEXUS — кириллица".as_bytes();
        let payload_b = "Второй отчёт с тем же именем файла".as_bytes();
        fs::write(&dup_a, payload_a).unwrap();
        fs::write(&dup_b, payload_b).unwrap();

        let out_dir = root.join("out");
        fs::create_dir_all(&out_dir).unwrap();

        let result = create_archive_sync(
            ArchiveCreateRequest {
                format: "zip".to_string(),
                sources: vec![
                    empty_folder.to_string_lossy().to_string(),
                    dup_a.to_string_lossy().to_string(),
                    dup_b.to_string_lossy().to_string(),
                ],
                destination_dir: out_dir.to_string_lossy().to_string(),
                archive_name: "кириллица_тест".to_string(),
                compression_level: "store".to_string(),
            },
            None,
        )
        .expect("Unicode & duplicate-root ZIP should succeed");

        let parsed = parse_and_verify_zip(Path::new(&result.archive_path));
        assert_eq!(parsed.len(), 3);
        let empty_e = parsed
            .iter()
            .find(|e| e.name == "Пустая Папка/")
            .expect("empty unicode dir present");
        assert!(empty_e.data.is_empty());
        assert_eq!(
            parsed.iter().find(|e| e.name == "отчёт.txt").unwrap().data,
            payload_a
        );
        assert_eq!(
            parsed.iter().find(|e| e.name == "отчёт_2.txt").unwrap().data,
            payload_b
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_prechecks_limits_and_cancels_during_directory_traversal() {
        let _guard = TEST_ARCHIVE_SERIALIZE.lock().unwrap();
        // Проверка граничных значений 32-битного ZIP
        assert!(validate_zip_entry_budget(
            1,
            MAX_ZIP_SINGLE_FILE_BYTES,
            MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
            "max.bin",
            MAX_ZIP_ENTRIES,
            MAX_ZIP_SINGLE_FILE_BYTES,
            MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES
        )
        .is_ok());

        let too_big_file = validate_zip_entry_budget(
            1,
            MAX_ZIP_SINGLE_FILE_BYTES + 1,
            MAX_ZIP_SINGLE_FILE_BYTES + 1,
            "huge.iso",
            MAX_ZIP_ENTRIES,
            MAX_ZIP_SINGLE_FILE_BYTES,
            MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
        )
        .unwrap_err();
        assert!(too_big_file.contains("4 ГБ"));

        let too_many_entries = validate_zip_entry_budget(
            MAX_ZIP_ENTRIES + 1,
            10,
            10,
            "f",
            MAX_ZIP_ENTRIES,
            MAX_ZIP_SINGLE_FILE_BYTES,
            MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
        )
        .unwrap_err();
        assert!(too_many_entries.contains("65535") || too_many_entries.contains("65 535"));

        // Проверка раннего прерывания обхода каталога при отмене и при лимите байт
        let root = make_temp_test_dir("limits_cancel");
        let sub = root.join("tree");
        fs::create_dir_all(&sub).unwrap();
        for i in 0..10 {
            fs::write(sub.join(format!("file_{i}.bin")), vec![42u8; 256]).unwrap();
        }
        let out_zip = root.join("out.zip");

        let cancel_pre = AtomicBool::new(true);
        let cancel_err = collect_zip_entries_with_limits(
            &[sub.clone()],
            Some(&out_zip),
            &cancel_pre,
            MAX_ZIP_ENTRIES,
            MAX_ZIP_SINGLE_FILE_BYTES,
            MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
        )
        .err()
        .expect("cancelled traversal must abort immediately");
        assert!(cancel_err.contains("отмен"));
        assert!(!out_zip.exists());

        let active_ok = AtomicBool::new(false);
        let limit_err = collect_zip_entries_with_limits(
            &[sub.clone()],
            Some(&out_zip),
            &active_ok,
            MAX_ZIP_ENTRIES,
            MAX_ZIP_SINGLE_FILE_BYTES,
            512,
        )
        .err()
        .expect("byte budget overflow during scan must fail cleanly");
        assert!(limit_err.contains("4 ГБ"));
        assert!(!out_zip.exists());

        // Проверка защиты от параллельной операции архивации
        let g1 = ArchiveOperationGuard::try_acquire().expect("first acquire works");
        let second_err = ArchiveOperationGuard::try_acquire().err().expect("second must reject");
        assert!(second_err.contains("текущей операции"));
        drop(g1);
        assert!(ArchiveOperationGuard::try_acquire().is_ok());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_winrar_returns_clear_error_without_creating_fake_rar() {
        let _guard = TEST_ARCHIVE_SERIALIZE.lock().unwrap();
        let root = make_temp_test_dir("no_rar");
        let file1 = root.join("sample.txt");
        fs::write(&file1, b"test content").unwrap();
        let out_dir = root.join("out");
        fs::create_dir_all(&out_dir).unwrap();

        let err = create_archive_sync(
            ArchiveCreateRequest {
                format: "rar".to_string(),
                sources: vec![file1.to_string_lossy().to_string()],
                destination_dir: out_dir.to_string_lossy().to_string(),
                archive_name: "should_fail".to_string(),
                compression_level: "normal".to_string(),
            },
            Some(None),
        )
        .expect_err("Missing WinRAR must return an error");

        assert!(
            err.contains("WinRAR"),
            "Expected message mentioning WinRAR, got: {err}"
        );
        assert!(!out_dir.join("should_fail.rar").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn creates_real_rar_when_archiver_installed() {
        let _guard = TEST_ARCHIVE_SERIALIZE.lock().unwrap();
        let Some(rar_exe) = find_rar_executable() else {
            println!("WinRAR not installed on test host — real RAR CLI test skipped");
            return;
        };
        let root = make_temp_test_dir("rar");
        let src_dir = root.join("payload");
        fs::create_dir_all(&src_dir).unwrap();
        let file1 = src_dir.join("readme.txt");
        fs::write(&file1, b"real rar payload check").unwrap();
        let out_dir = root.join("out");
        fs::create_dir_all(&out_dir).unwrap();

        let result = create_archive_sync(
            ArchiveCreateRequest {
                format: "rar".to_string(),
                sources: vec![src_dir.to_string_lossy().to_string()],
                destination_dir: out_dir.to_string_lossy().to_string(),
                archive_name: "real_pack".to_string(),
                compression_level: "fast".to_string(),
            },
            Some(Some(rar_exe)),
        )
        .expect("RAR creation via WinRAR CLI should succeed");

        let rar_path = PathBuf::from(&result.archive_path);
        assert!(rar_path.is_file());
        let mut head = [0u8; 6];
        File::open(&rar_path).unwrap().read_exact(&mut head).unwrap();
        // Настоящая сигнатура RAR4/RAR5: "Rar!\x1A\x07"
        assert_eq!(&head, b"Rar!\x1a\x07");

        let _ = fs::remove_dir_all(&root);
    }
}
