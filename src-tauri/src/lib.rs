use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sysinfo::{Disks, Networks, System};
mod drop_server;

use tauri::{Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use winreg::enums::*;
#[cfg(target_os = "windows")]
use winreg::RegKey;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const NEXUS_DISABLED_REG_BASE: &str = r"Software\Nexus\DisabledStartup";
const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_WOW64_KEY_PATH: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run";

// Структура данных телеметрии Dashboard
#[derive(Serialize)]
pub struct SystemMetrics {
    pub cpu_usage: f32,
    pub ram_used_gb: f32,
    pub ram_total_gb: f32,
    pub ram_percentage: f32,
    pub swap_used_gb: f32,
    pub swap_total_gb: f32,
    pub disk_free_gb: u64,
    pub disk_total_gb: u64,
    pub net_rx_kbps: f32,
    pub net_tx_kbps: f32,
    pub net_ping_ms: u32,
}

// Структура записи автозагрузки Windows
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StartupItem {
    pub id: String,         // уникальный хэш или составной ключ
    pub name: String,       // имя программы
    pub command: String,    // исходная команда запуска / путь
    pub clean_path: String, // очищенный путь до .exe / ярлыка
    pub location: String,   // "HKCU (Реестр)", "HKLM (Система)", "Папка Автозагрузка"
    pub enabled: bool,      // активна ли запись
    pub file_exists: bool,  // существует ли физический файл на диске
    pub phantom: bool,      // ключ StartupApproved без живой программы
}

// Структуры модуля Storage Analyzer (Анализатор накопителей)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub extension: String,
    pub app_label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub children: Vec<FolderNode>, // топ-10 крупнейших вложенных папок для Treemap
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScanResult {
    pub target_path: String,
    pub total_scanned_bytes: u64,
    pub total_files_count: u64,
    pub root_node: FolderNode,
    pub top_files: Vec<FileEntry>,          // ТОП-100 самых больших файлов
    pub category_sizes: Vec<(String, u64)>, // ("Видео", 12345678), ("Игры и софт", ...)
}

// Структуры модуля Hardware Monitor (Мониторинг железа через LibreHardwareMonitor sidecar)
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CoreTemp {
    pub name: String,
    pub temp_c: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CpuTelemetry {
    pub name: String,
    pub package_temp_c: Option<f32>,
    pub max_core_temp_c: Option<f32>,
    pub avg_clock_mhz: Option<f32>,
    pub power_watts: Option<f32>,
    pub voltage_v: Option<f32>,
    pub core_temps: Vec<CoreTemp>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct GpuTelemetry {
    pub name: String,
    pub core_temp_c: Option<f32>,
    pub hotspot_temp_c: Option<f32>,
    pub memory_temp_c: Option<f32>,
    pub core_clock_mhz: Option<f32>,
    pub memory_clock_mhz: Option<f32>,
    pub fan_rpm: Option<f32>,
    pub fan_percent: Option<f32>,
    pub power_watts: Option<f32>,
    pub voltage_v: Option<f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct FanSensorItem {
    pub name: String,
    pub rpm: f32,
    pub percent: Option<f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct TempSensorItem {
    pub name: String,
    pub temp_c: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct StorageTempItem {
    pub name: String,
    pub temp_c: Option<f32>,
    pub used_percent: Option<f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct HardwareTelemetry {
    pub is_admin: bool,
    pub sidecar_online: bool,
    pub timestamp_ms: u64,
    pub cpu: CpuTelemetry,
    pub gpus: Vec<GpuTelemetry>,
    pub motherboard_name: String,
    pub motherboard_temps: Vec<TempSensorItem>,
    pub system_fans: Vec<FanSensorItem>,
    pub storage_temps: Vec<StorageTempItem>,
}

// Структуры модуля Cleanup Center (Безопасная очистка накопителя)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CleanupCategory {
    pub id: String,
    pub name: String,
    pub description: String,
    pub paths_hint: String,
    pub size_bytes: u64,
    pub files_count: u64,
    pub requires_admin: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CleanupCategoryReport {
    pub id: String,
    pub name: String,
    pub deleted_files: u64,
    pub skipped_files: u64,
    pub freed_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CleanupReport {
    pub deleted_files_count: u64,
    pub skipped_files_count: u64,
    pub freed_bytes: u64,
    pub categories: Vec<CleanupCategoryReport>,
}

// Структура процесса модуля Process Explorer
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProcessItem {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub exe_path: String,
    pub cpu_usage: f32,  // процент загрузки CPU (нормализован к числу логических ядер)
    pub memory_mb: f64,  // занятая память в МБ
    pub disk_read_bytes_sec: u64,
    pub disk_write_bytes_sec: u64,
    pub run_time_sec: u64,
    pub icon_base64: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NetworkConnection {
    pub protocol: String,
    pub local_addr: String,
    pub remote_addr: String,
    pub state: String,
    pub pid: u32,
    pub process_name: String,
    pub icon_base64: Option<String>,
}

// Хранилище состояния приложения
pub struct AppState {
    pub sys: Arc<Mutex<System>>,
    pub networks: Arc<Mutex<Networks>>,
    pub disk_space: Arc<Mutex<(u64, u64)>>,
    pub ping_cache: Mutex<(u32, Option<Instant>)>,
    pub process_last_refresh: Mutex<Option<Instant>>,
    pub hw_telemetry: Arc<Mutex<Option<HardwareTelemetry>>>,
    pub hw_sidecar_child: Arc<Mutex<Option<Child>>>,
    pub icon_cache: Mutex<HashMap<String, String>>,
    pub drop_hub: Arc<drop_server::DropHub>,
    pub tray_ping_item: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
}

impl Drop for AppState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.hw_sidecar_child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

// Поиск скомпилированного бинарника nexus-hwmon.exe
fn find_hwmon_sidecar_exe() -> Option<PathBuf> {
    let candidates = [
        // Корень проекта Nexus/hwmon-sidecar (при запуске из src-tauri или из корня Nexus)
        PathBuf::from("nexus-hwmon.exe"),
        PathBuf::from("../src-tauri/nexus-hwmon.exe"),
        PathBuf::from("src-tauri/nexus-hwmon.exe"),
        PathBuf::from("../hwmon-sidecar/bin/Release/net9.0/win-x64/publish/nexus-hwmon.exe"),
        PathBuf::from("hwmon-sidecar/bin/Release/net9.0/win-x64/publish/nexus-hwmon.exe"),
        PathBuf::from("../hwmon-sidecar/bin/publish/nexus-hwmon.exe"),
        PathBuf::from("hwmon-sidecar/bin/publish/nexus-hwmon.exe"),
        PathBuf::from("../hwmon-sidecar/bin/Release/net9.0/win-x64/nexus-hwmon.exe"),
        PathBuf::from("hwmon-sidecar/bin/Release/net9.0/win-x64/nexus-hwmon.exe"),
        // Фоллбэки на случай размещения внутри src-tauri
        PathBuf::from("src-tauri/hwmon-sidecar/bin/publish/nexus-hwmon.exe"),
        PathBuf::from("src-tauri/hwmon-sidecar/bin/Release/net9.0/win-x64/nexus-hwmon.exe"),
    ];

    for cand in &candidates {
        if cand.exists() {
            return Some(cand.clone());
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let near_exe = exe_dir.join("nexus-hwmon.exe");
            if near_exe.exists() {
                return Some(near_exe);
            }
            let beside_manifest = exe_dir.join("../../nexus-hwmon.exe");
            if beside_manifest.exists() {
                return Some(beside_manifest);
            }
            // При запуске из src-tauri/target/debug поднимаемся на 3 уровня к Nexus/hwmon-sidecar
            let from_target_root = exe_dir.join("../../../hwmon-sidecar/bin/publish/nexus-hwmon.exe");
            if from_target_root.exists() {
                return Some(from_target_root);
            }
            let from_target_release =
                exe_dir.join("../../../hwmon-sidecar/bin/Release/net9.0/win-x64/nexus-hwmon.exe");
            if from_target_release.exists() {
                return Some(from_target_release);
            }
            // Фоллбэк: 2 уровня вверх (если папка внутри src-tauri)
            let from_target = exe_dir.join("../../hwmon-sidecar/bin/publish/nexus-hwmon.exe");
            if from_target.exists() {
                return Some(from_target);
            }
        }
    }

    None
}

fn spawn_hwmon_sidecar(
    telemetry_cache: Arc<Mutex<Option<HardwareTelemetry>>>,
    child_holder: Arc<Mutex<Option<Child>>>,
) {
    let Some(exe_path) = find_hwmon_sidecar_exe() else {
        return;
    };

    let mut cmd = Command::new(&exe_path);
    if let Some(parent_dir) = exe_path.parent() {
        cmd.current_dir(parent_dir);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let Ok(mut child) = cmd.spawn() else {
        return;
    };

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return;
    };

    if let Ok(mut guard) = child_holder.lock() {
        *guard = Some(child);
    }

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line_res in reader.lines() {
            let Ok(line) = line_res else {
                break;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(parsed) = serde_json::from_str::<HardwareTelemetry>(trimmed) {
                if let Ok(mut cache) = telemetry_cache.lock() {
                    *cache = Some(parsed);
                }
            }
        }
    });
}

#[tauri::command]
fn get_hardware_telemetry(state: State<'_, AppState>) -> Result<HardwareTelemetry, String> {
    // Если sidecar еще не запущен, пробуем поднять его лениво
    {
        let need_spawn = state
            .hw_sidecar_child
            .lock()
            .map(|mut g| match g.as_mut() {
                Some(child) => child.try_wait().ok().flatten().is_some(),
                None => true,
            })
            .unwrap_or(false);

        if need_spawn {
            spawn_hwmon_sidecar(
                Arc::clone(&state.hw_telemetry),
                Arc::clone(&state.hw_sidecar_child),
            );
        }
    }

    // Читаем базовые данные процессора из sysinfo для обогащения или fallback-ответа
    let (fallback_cpu_name, fallback_clock_mhz) = if let Ok(mut sys) = state.sys.lock() {
        sys.refresh_cpu_frequency();
        let cpus = sys.cpus();
        let name = cpus
            .first()
            .map(|c| c.brand().trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Процессор x64".to_string());
        let avg_freq = if !cpus.is_empty() {
            let sum: u64 = cpus.iter().map(|c| c.frequency()).sum();
            Some((sum as f32) / (cpus.len() as f32))
        } else {
            None
        };
        (name, avg_freq)
    } else {
        ("Процессор x64".to_string(), None)
    };

    if let Ok(guard) = state.hw_telemetry.lock() {
        if let Some(mut data) = guard.clone() {
            if data.cpu.name.is_empty() || data.cpu.name == "Процессор" {
                data.cpu.name = fallback_cpu_name;
            }
            if data.cpu.avg_clock_mhz.is_none() {
                data.cpu.avg_clock_mhz = fallback_clock_mhz;
            }
            return Ok(data);
        }
    }

    // Если sidecar еще инициализируется, возвращаем частичные метрики без падения
    let disks = Disks::new_with_refreshed_list();
    let storage_temps: Vec<StorageTempItem> = disks
        .iter()
        .map(|d| {
            let total = d.total_space() as f32;
            let used = total - (d.available_space() as f32);
            let used_pct = if total > 0.0 {
                Some((used / total) * 100.0)
            } else {
                None
            };
            let mount = d.mount_point().to_string_lossy().to_string();
            let disk_name = d.name().to_string_lossy().to_string();
            StorageTempItem {
                name: if disk_name.is_empty() {
                    format!("Накопитель ({})", mount)
                } else {
                    format!("{} ({})", disk_name, mount)
                },
                temp_c: None,
                used_percent: used_pct,
            }
        })
        .collect();

    Ok(HardwareTelemetry {
        is_admin: false,
        sidecar_online: false,
        timestamp_ms: 0,
        cpu: CpuTelemetry {
            name: fallback_cpu_name,
            package_temp_c: None,
            max_core_temp_c: None,
            avg_clock_mhz: fallback_clock_mhz,
            power_watts: None,
            voltage_v: None,
            core_temps: Vec::new(),
        },
        gpus: Vec::new(),
        motherboard_name: "Ожидание инициализации датчиков LibreHardwareMonitor...".to_string(),
        motherboard_temps: Vec::new(),
        system_fans: Vec::new(),
        storage_temps,
    })
}

// Раскрытие переменных окружения Windows (%APPDATA%, %LOCALAPPDATA%, %ProgramFiles% и остальных).
fn expand_environment_path(input: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn ExpandEnvironmentStringsW(src: *const u16, dst: *mut u16, size: u32) -> u32;
        }

        let wide: Vec<u16> = std::ffi::OsStr::new(input)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let needed = ExpandEnvironmentStringsW(wide.as_ptr(), std::ptr::null_mut(), 0);
            if needed > 1 {
                let mut buf = vec![0u16; needed as usize];
                let written = ExpandEnvironmentStringsW(wide.as_ptr(), buf.as_mut_ptr(), needed);
                if written > 0 {
                    let end = buf.iter().position(|unit| *unit == 0).unwrap_or(buf.len());
                    return OsString::from_wide(&buf[..end]).to_string_lossy().into_owned();
                }
            }
        }
    }
    expand_env_vars(input)
}

fn cut_executable_path(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    for ext in [".exe", ".lnk", ".bat", ".cmd", ".com", ".msc"] {
        let mut from = 0usize;
        while let Some(rel) = lower[from..].find(ext) {
            let end = from + rel + ext.len();
            let next = input[end..].chars().next();
            if next.is_none() || matches!(next, Some(' ' | '\t' | '"' | '/' | ',')) {
                return input[..end].trim().trim_matches('"').to_string();
            }
            from = end;
        }
    }
    input.trim().trim_matches('"').to_string()
}

/// Раскрывает переменные, снимает кавычки и отрезает аргументы после исполняемого файла.
fn sanitize_launch_path(raw: &str) -> String {
    let expanded = expand_environment_path(raw.trim());
    let trimmed = expanded.trim();
    let unquoted = if let Some(stripped) = trimmed.strip_prefix('"') {
        if let Some(end) = stripped.find('"') {
            stripped[..end].trim().to_string()
        } else {
            stripped.trim_matches('"').trim().to_string()
        }
    } else {
        trimmed.trim_matches('"').trim().to_string()
    };
    cut_executable_path(&unquoted)
}

// Раскрытие переменных окружения Windows вида %VAR%
fn expand_env_vars(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '%' {
            let mut var_name = String::new();
            let mut found_closing = false;
            for next_ch in chars.by_ref() {
                if next_ch == '%' {
                    found_closing = true;
                    break;
                }
                var_name.push(next_ch);
            }
            if found_closing && !var_name.is_empty() {
                if let Ok(val) = std::env::var(&var_name) {
                    result.push_str(&val);
                } else {
                    result.push('%');
                    result.push_str(&var_name);
                    result.push('%');
                }
            } else {
                result.push('%');
                result.push_str(&var_name);
            }
        } else {
            result.push(ch);
        }
    }
    result
}

fn exe_span(expanded: &str) -> Option<String> {
    let lower = expanded.to_lowercase();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(".exe") {
        let start = from + rel;
        let end = start + 4;
        let next = lower[end..].chars().next();
        if next.is_none() || !next.is_some_and(|ch| ch.is_ascii_alphanumeric()) {
            let mut head = expanded[..end].trim().to_string();
            if let Some(quote) = head.rfind('"') {
                head = head[quote + 1..].trim().to_string();
            }
            head = head.trim_matches('"').trim().to_string();
            if !head.is_empty() {
                return Some(head);
            }
        }
        from = end;
    }
    None
}

// Извлечение чистого пути к исполняемому файлу из строки команды реестра
fn extract_clean_path(raw_command: &str) -> String {
    let expanded = expand_environment_path(raw_command.trim());
    let candidate = exe_span(&expanded).unwrap_or_else(|| sanitize_launch_path(&expanded));
    if candidate.is_empty() {
        return String::new();
    }

    if !candidate.is_empty() && !candidate.contains('\\') && !candidate.contains('/') {
        if let Ok(windir) = std::env::var("WINDIR") {
            let sys32 = Path::new(&windir).join("System32").join(&candidate);
            if sys32.exists() {
                return sys32.to_string_lossy().to_string();
            }
            let win_root = Path::new(&windir).join(&candidate);
            if win_root.exists() {
                return win_root.to_string_lossy().to_string();
            }
        }
    }

    candidate
}

#[cfg(target_os = "windows")]
fn startup_approved_disabled(root: winreg::HKEY, subkey: &str, name: &str) -> bool {
    let Ok(key) = RegKey::predef(root).open_subkey_with_flags(subkey, KEY_READ) else {
        return false;
    };
    let Ok(raw) = key.get_raw_value(name) else {
        return false;
    };
    match raw.bytes.first().copied() {
        None | Some(0x02) => false,
        Some(0x03) => true,
        Some(byte) => byte % 2 == 1,
    }
}

fn read_registry_run_items(
    root: winreg::HKEY,
    subkey_path: &str,
    access: u32,
    source_tag: &str,
    location_label: &str,
    enabled: bool,
    seen_ids: &mut HashSet<String>,
    items: &mut Vec<StartupItem>,
) {
    let hive = RegKey::predef(root);
    let Ok(key) = hive.open_subkey_with_flags(subkey_path, access) else {
        return;
    };

    for value_res in key.enum_values() {
        let Ok((name, _raw_val)) = value_res else {
            continue;
        };
        if name.trim().is_empty() {
            continue;
        }
        let Ok(command) = key.get_value::<String, _>(&name) else {
            continue;
        };

        let id = format!("reg|{}|{}", source_tag, name);
        if !seen_ids.insert(id.clone()) {
            continue;
        }

        let clean_path = extract_clean_path(&command);
        let file_exists = startup_target_exists(&clean_path);
        let approved_off = enabled
            && match source_tag {
                "HKCU_RUN" => startup_approved_disabled(
                    HKEY_CURRENT_USER,
                    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
                    &name,
                ),
                "HKLM_RUN" => startup_approved_disabled(
                    HKEY_LOCAL_MACHINE,
                    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
                    &name,
                ),
                "HKLM_WOW64_RUN" => startup_approved_disabled(
                    HKEY_LOCAL_MACHINE,
                    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32",
                    &name,
                ),
                _ => false,
            };

        items.push(StartupItem {
            id,
            name,
            command,
            clean_path,
            location: location_label.to_string(),
            enabled: enabled && !approved_off,
            file_exists,
            phantom: false,
        });
    }
}

fn scan_startup_folder(
    dir_path: &Path,
    location_label: &str,
    approved_root: Option<winreg::HKEY>,
    items: &mut Vec<StartupItem>,
    seen_ids: &mut HashSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir_path) else {
        return;
    };

    for entry_res in entries {
        let Ok(entry) = entry_res else {
            continue;
        };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            continue;
        }

        let Some(file_name_os) = path.file_name() else {
            continue;
        };
        let file_name = file_name_os.to_string_lossy().to_string();

        if file_name.eq_ignore_ascii_case("desktop.ini") {
            continue;
        }

        let is_disabled = file_name.to_lowercase().ends_with(".disabled");
        let enabled = !is_disabled;

        let base_path_str = if is_disabled {
            let full = path.to_string_lossy().to_string();
            full[..full.len() - ".disabled".len()].to_string()
        } else {
            path.to_string_lossy().to_string()
        };

        let id = format!("dir|{}", base_path_str);
        if !seen_ids.insert(id.clone()) {
            continue;
        }

        let display_name = Path::new(&base_path_str)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| file_name.clone());

        let actual_path_str = path.to_string_lossy().to_string();
        let resolved_target = if actual_path_str.to_ascii_lowercase().contains(".lnk") {
            shortcut_target(Path::new(&actual_path_str))
        } else {
            None
        };
        let clean_path = resolved_target.clone().unwrap_or_else(|| actual_path_str.clone());
        let file_exists = if actual_path_str.to_ascii_lowercase().contains(".lnk") {
            resolved_target
                .as_ref()
                .is_some_and(|target| Path::new(target).exists())
        } else {
            path.exists()
        };
        let approved_off = enabled
            && approved_root
                .map(|root| {
                    startup_approved_disabled(
                        root,
                        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder",
                        &file_name,
                    )
                })
                .unwrap_or(false);

        items.push(StartupItem {
            id,
            name: display_name,
            command: actual_path_str.clone(),
            clean_path,
            location: location_label.to_string(),
            enabled: enabled && !approved_off,
            file_exists,
            phantom: false,
        });
    }
}

#[tauri::command]
fn get_startup_items() -> Result<Vec<StartupItem>, String> {
    let mut items = Vec::new();
    let mut seen_ids = HashSet::new();

    #[cfg(target_os = "windows")]
    {
        read_registry_run_items(
            HKEY_CURRENT_USER,
            RUN_KEY_PATH,
            KEY_READ,
            "HKCU_RUN",
            "HKCU (Реестр)",
            true,
            &mut seen_ids,
            &mut items,
        );
        read_registry_run_items(
            HKEY_LOCAL_MACHINE,
            RUN_KEY_PATH,
            KEY_READ | KEY_WOW64_64KEY,
            "HKLM_RUN",
            "HKLM (Система)",
            true,
            &mut seen_ids,
            &mut items,
        );
        read_registry_run_items(
            HKEY_LOCAL_MACHINE,
            RUN_WOW64_KEY_PATH,
            KEY_READ | KEY_WOW64_64KEY,
            "HKLM_WOW64_RUN",
            "HKLM (Система)",
            true,
            &mut seen_ids,
            &mut items,
        );

        let disabled_sources = [
            ("HKCU_RUN", "HKCU (Реестр)"),
            ("HKLM_RUN", "HKLM (Система)"),
            ("HKLM_WOW64_RUN", "HKLM (Система)"),
        ];
        for (source_tag, location_label) in disabled_sources {
            let subkey = format!(r"{}\{}", NEXUS_DISABLED_REG_BASE, source_tag);
            read_registry_run_items(
                HKEY_CURRENT_USER,
                &subkey,
                KEY_READ,
                source_tag,
                location_label,
                false,
                &mut seen_ids,
                &mut items,
            );
        }

        read_registry_run_items(
            HKEY_CURRENT_USER,
            NEXUS_DISABLED_REG_BASE,
            KEY_READ,
            "HKCU_RUN",
            "HKCU (Реестр)",
            false,
            &mut seen_ids,
            &mut items,
        );
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        let user_startup: PathBuf = Path::new(&appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup");
        scan_startup_folder(
            &user_startup,
            "Папка Автозагрузка",
            Some(HKEY_CURRENT_USER),
            &mut items,
            &mut seen_ids,
        );
    }

    let program_data = std::env::var("PROGRAMDATA")
        .or_else(|_| std::env::var("ALLUSERSPROFILE"))
        .ok();
    if let Some(program_data) = program_data {
        let common_startup: PathBuf = Path::new(&program_data)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup");
        scan_startup_folder(
            &common_startup,
            "Общая автозагрузка",
            Some(HKEY_LOCAL_MACHINE),
            &mut items,
            &mut seen_ids,
        );
    }

    #[cfg(target_os = "windows")]
    {
        append_msix_startup(&mut items, &mut seen_ids);
        append_orphan_approved(&mut items, &mut seen_ids);
    }

    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(items)
}

fn pretty_store_name(family: &str) -> String {
    let base = family.split('_').next().unwrap_or(family);
    let short = base.rsplit('.').next().unwrap_or(base);
    short.replace('-', " ")
}

#[allow(dead_code)]
fn name_already_listed(items: &[StartupItem], name: &str) -> bool {
    items.iter().any(|item| item.name.eq_ignore_ascii_case(name))
}

#[cfg(target_os = "windows")]
fn append_msix_startup(items: &mut Vec<StartupItem>, seen_ids: &mut HashSet<String>) {
    let base = r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData";
    let Ok(root) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(base) else {
        return;
    };
    for family in root.enum_keys().filter_map(|item| item.ok()) {
        let tasks_path = format!(r"{}\{}\StartupTasks", base, family);
        let Ok(tasks) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(&tasks_path) else {
            continue;
        };
        for task in tasks.enum_keys().filter_map(|item| item.ok()) {
            let Ok(task_key) = tasks.open_subkey(&task) else {
                continue;
            };
            let state: u32 = task_key.get_value("State").unwrap_or(2);
            let id = format!("msix|{}|{}", family, task);
            if !seen_ids.insert(id.clone()) {
                continue;
            }
            let name = pretty_store_name(&family);
            items.push(StartupItem {
                id,
                name,
                command: task,
                clean_path: String::new(),
                location: "Приложение Store".to_string(),
                enabled: state == 2 || state == 4,
                file_exists: true,
                phantom: false,
            });
        }
    }
}

fn normalize_token(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn startup_alias(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .to_lowercase()
        .trim_end_matches(".disabled")
        .trim_end_matches(".lnk")
        .trim_end_matches(".exe")
        .to_string()
}

fn remember_name(bucket: &mut HashSet<String>, value: &str) {
    let alias = startup_alias(value);
    if alias.is_empty() {
        return;
    }
    bucket.insert(alias.clone());
    let token = normalize_token(&alias);
    if token.len() >= 4 {
        bucket.insert(token);
    }
}

fn names_match(approved: &str, known: &HashSet<String>) -> bool {
    let alias = startup_alias(approved);
    if alias.is_empty() {
        return false;
    }
    if known.contains(&alias) {
        return true;
    }
    let token = normalize_token(&alias);
    if token.len() >= 4 && known.contains(&token) {
        return true;
    }
    if token.len() < 6 {
        return false;
    }
    known.iter().any(|candidate| {
        let other = if candidate.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            candidate.clone()
        } else {
            normalize_token(candidate)
        };
        other.len() >= 6 && (token.contains(&other) || other.contains(&token))
    })
}

#[cfg(target_os = "windows")]
fn collect_run_value_names() -> HashSet<String> {
    let mut names = HashSet::new();
    let keys = [
        (HKEY_CURRENT_USER, RUN_KEY_PATH, KEY_READ),
        (HKEY_LOCAL_MACHINE, RUN_KEY_PATH, KEY_READ | KEY_WOW64_64KEY),
        (HKEY_LOCAL_MACHINE, RUN_WOW64_KEY_PATH, KEY_READ | KEY_WOW64_64KEY),
    ];
    for (root, path, access) in keys {
        let Ok(key) = RegKey::predef(root).open_subkey_with_flags(path, access) else {
            continue;
        };
        for item in key.enum_values().filter_map(|entry| entry.ok()) {
            remember_name(&mut names, &item.0);
        }
    }
    names
}

#[cfg(target_os = "windows")]
fn collect_startup_file_names() -> HashSet<String> {
    let mut names = HashSet::new();
    let mut folders = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        folders.push(
            Path::new(&appdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("Startup"),
        );
    }
    if let Ok(program_data) = std::env::var("PROGRAMDATA").or_else(|_| std::env::var("ALLUSERSPROFILE")) {
        folders.push(
            Path::new(&program_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("Startup"),
        );
    }
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.eq_ignore_ascii_case("desktop.ini") {
                continue;
            }
            remember_name(&mut names, &file_name);
        }
    }
    names
}

#[cfg(target_os = "windows")]
fn walk_task_tree(key: &RegKey, names: &mut HashSet<String>, depth: u8) {
    if depth > 8 {
        return;
    }
    for subkey in key.enum_keys().filter_map(|item| item.ok()) {
        remember_name(names, &subkey);
        if let Ok(child) = key.open_subkey(&subkey) {
            walk_task_tree(&child, names, depth + 1);
        }
    }
}

#[cfg(target_os = "windows")]
fn collect_scheduled_task_names() -> HashSet<String> {
    let mut names = HashSet::new();
    if let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache\Tree",
        KEY_READ | KEY_WOW64_64KEY,
    ) {
        walk_task_tree(&root, &mut names, 0);
    }

    let mut cmd = Command::new("schtasks");
    cmd.args(["/query", "/fo", "csv"]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let text = decode_command_output(&output.stdout);
            for line in text.lines().skip(1) {
                let cells = split_csv_line(line);
                let Some(task) = cells.first() else {
                    continue;
                };
                if task.to_lowercase().contains("\\microsoft\\") {
                    continue;
                }
                let short = task.rsplit(['\\', '/']).next().unwrap_or(task);
                remember_name(&mut names, short);
            }
        }
    }
    names
}

fn collect_install_names(dir: &Path, depth: u8, names: &mut HashSet<String>) {
    if depth > 2 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        let low = file_name.to_lowercase();
        if low.starts_with('.') || low == "common files" || low == "windowsapps" {
            continue;
        }
        remember_name(names, &file_name);
        let path = entry.path();
        if path.is_dir() {
            collect_install_names(&path, depth + 1, names);
        }
    }
}

fn collect_program_names() -> HashSet<String> {
    let mut names = HashSet::new();
    let mut roots = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA"] {
        if let Ok(value) = std::env::var(var) {
            if !value.is_empty() {
                roots.push(PathBuf::from(value));
            }
        }
    }
    for root in roots {
        collect_install_names(&root, 0, &mut names);
    }
    names
}

#[cfg(target_os = "windows")]
fn append_orphan_approved(items: &mut Vec<StartupItem>, seen_ids: &mut HashSet<String>) {
    let mut known = collect_run_value_names();
    for name in collect_startup_file_names() {
        known.insert(name);
    }
    for name in collect_scheduled_task_names() {
        known.insert(name);
    }
    for name in collect_program_names() {
        known.insert(name);
    }

    let sources = [
        (
            HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
            "HKCU Run",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
            "HKLM Run",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32",
            "HKLM Run32",
        ),
        (
            HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder",
            "HKCU StartupFolder",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder",
            "HKLM StartupFolder",
        ),
    ];
    for (root, path, label) in sources {
        let Ok(key) = RegKey::predef(root).open_subkey(path) else {
            continue;
        };
        for (name, _value) in key.enum_values().filter_map(|item| item.ok()) {
            if name.trim().is_empty() || names_match(&name, &known) {
                continue;
            }
            let id = format!("approved|{label}|{name}");
            if !seen_ids.insert(id.clone()) {
                continue;
            }
            items.push(StartupItem {
                id,
                name,
                command: String::new(),
                clean_path: String::new(),
                location: "Осиротевшая запись реестра".to_string(),
                enabled: false,
                file_exists: false,
                phantom: true,
            });
        }
    }
}

fn decode_command_output(bytes: &[u8]) -> String {
    let utf16 = bytes.starts_with(&[0xFF, 0xFE])
        || bytes.windows(4).take(8).any(|chunk| chunk[1] == 0 && chunk[3] == 0);
    if utf16 {
        let words: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16_lossy(&words)
            .trim_start_matches('\u{feff}')
            .trim()
            .to_string();
    }
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn hidden_powershell(script: &str) -> Result<String, String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("Не удалось запустить PowerShell: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Команда PowerShell завершилась с ошибкой".to_string()
        } else {
            stderr
        });
    }
    Ok(decode_command_output(&output.stdout))
}

#[allow(dead_code)]
fn append_cim_startup(items: &mut Vec<StartupItem>, seen_ids: &mut HashSet<String>) {
    let Ok(text) = hidden_powershell(
        "Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location | ConvertTo-Json -Compress",
    ) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let entries = match value {
        serde_json::Value::Array(list) => list,
        other => vec![other],
    };
    for entry in entries {
        let Some(name) = entry.get("Name").and_then(|v| v.as_str()).map(str::trim) else {
            continue;
        };
        if name.is_empty() || name_already_listed(items, name) {
            continue;
        }
        let id = format!("cim|{}", name.to_lowercase());
        if !seen_ids.insert(id.clone()) {
            continue;
        }
        let command = entry
            .get("Command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let location = entry
            .get("Location")
            .and_then(|v| v.as_str())
            .unwrap_or("Win32_StartupCommand");
        let clean_path = extract_clean_path(&command);
        items.push(StartupItem {
            id,
            name: name.to_string(),
            command,
            file_exists: startup_target_exists(&clean_path),
            clean_path,
            location: format!("CIM · {}", location),
            enabled: true,
            phantom: false,
        });
    }
}

fn split_csv_line(line: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in line.chars() {
        match ch {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                cells.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    cells.push(current.trim().to_string());
    cells
}

#[allow(dead_code)]
fn append_logon_tasks(items: &mut Vec<StartupItem>, seen_ids: &mut HashSet<String>) {
    let mut cmd = Command::new("schtasks");
    cmd.args(["/query", "/fo", "csv", "/v"]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let Ok(output) = cmd.output() else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let text = decode_command_output(&output.stdout);
    let mut lines = text.lines();
    let Some(header) = lines.next() else {
        return;
    };
    let columns = split_csv_line(header);
    let name_idx = columns.iter().position(|cell| {
        let low = cell.to_lowercase();
        low.contains("taskname") || low.contains("имя задачи")
    });
    let Some(name_idx) = name_idx else {
        return;
    };
    for line in lines {
        let cells = split_csv_line(line);
        let blob = cells.join(" ").to_lowercase();
        let logon = blob.contains("at logon")
            || blob.contains("at log on")
            || blob.contains("при входе")
            || blob.contains("onlogon");
        if !logon {
            continue;
        }
        let Some(task_name) = cells.get(name_idx).map(|s| s.trim()) else {
            continue;
        };
        if task_name.is_empty() || task_name.to_lowercase().contains("\\microsoft\\") {
            continue;
        }
        let short = task_name.rsplit('\\').next().unwrap_or(task_name);
        if name_already_listed(items, short) {
            continue;
        }
        let id = format!("task|{}", task_name.to_lowercase());
        if !seen_ids.insert(id.clone()) {
            continue;
        }
        items.push(StartupItem {
            id,
            name: short.to_string(),
            command: task_name.to_string(),
            clean_path: String::new(),
            location: "Планировщик · вход в систему".to_string(),
            enabled: !blob.contains("disabled") && !blob.contains("отключено"),
            file_exists: true,
            phantom: false,
        });
    }
}

#[tauri::command]
fn toggle_startup_item(id: String, enable: bool) -> Result<(), String> {
    if let Some(base_path) = id.strip_prefix("dir|") {
        let disabled_path = format!("{}.disabled", base_path);
        if enable {
            if Path::new(&disabled_path).exists() {
                std::fs::rename(&disabled_path, base_path).map_err(|e| {
                    format!("Не удалось включить ярлык автозагрузки (проверьте права доступа): {}", e)
                })?;
            }
        } else if Path::new(base_path).exists() {
            std::fs::rename(base_path, &disabled_path).map_err(|e| {
                format!("Не удалось отключить ярлык автозагрузки (проверьте права доступа): {}", e)
            })?;
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    if let Some(rest) = id.strip_prefix("reg|") {
        let mut parts = rest.splitn(2, '|');
        let source_tag = parts.next().ok_or("Некорректный ID записи реестра")?;
        let value_name = parts.next().ok_or("Не указано имя параметра реестра")?;

        let (active_root, active_subkey) = match source_tag {
            "HKCU_RUN" => (HKEY_CURRENT_USER, RUN_KEY_PATH),
            "HKLM_RUN" => (HKEY_LOCAL_MACHINE, RUN_KEY_PATH),
            "HKLM_WOW64_RUN" => (HKEY_LOCAL_MACHINE, RUN_WOW64_KEY_PATH),
            _ => return Err(format!("Неизвестный источник реестра: {}", source_tag)),
        };

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let active_hive = RegKey::predef(active_root);
        let backup_subkey_path = format!(r"{}\{}", NEXUS_DISABLED_REG_BASE, source_tag);

        if !enable {
            let active_key = active_hive
                .open_subkey_with_flags(active_subkey, KEY_READ | KEY_SET_VALUE)
                .map_err(|e| {
                    format!(
                        "Не удалось открыть ветку реестра для изменения (для HKLM требуются права администратора): {}",
                        e
                    )
                })?;

            let command: String = active_key
                .get_value(value_name)
                .map_err(|e| format!("Не удалось прочитать значение '{}': {}", value_name, e))?;

            let (backup_key, _) = hkcu
                .create_subkey(&backup_subkey_path)
                .map_err(|e| format!("Не удалось создать резервный ключ Nexus: {}", e))?;

            backup_key
                .set_value(value_name, &command)
                .map_err(|e| format!("Не удалось сохранить резервную копию записи: {}", e))?;

            if let Err(e) = active_key.delete_value(value_name) {
                let _ = backup_key.delete_value(value_name);
                return Err(format!(
                    "Не удалось удалить запись из автозагрузки: {}",
                    e
                ));
            }
        } else {
            let backup_key = hkcu
                .open_subkey_with_flags(&backup_subkey_path, KEY_READ | KEY_SET_VALUE)
                .or_else(|_| {
                    hkcu.open_subkey_with_flags(NEXUS_DISABLED_REG_BASE, KEY_READ | KEY_SET_VALUE)
                })
                .map_err(|e| format!("Резервная запись не найдена: {}", e))?;

            let command: String = backup_key
                .get_value(value_name)
                .map_err(|e| format!("Не удалось прочитать отключенную запись '{}': {}", value_name, e))?;

            let active_key = active_hive
                .open_subkey_with_flags(active_subkey, KEY_SET_VALUE)
                .map_err(|e| {
                    format!(
                        "Не удалось открыть ветку автозагрузки для записи (для HKLM нужны права администратора): {}",
                        e
                    )
                })?;

            active_key
                .set_value(value_name, &command)
                .map_err(|e| format!("Не удалось восстановить запись в Run: {}", e))?;

            let _ = backup_key.delete_value(value_name);
        }

        return Ok(());
    }

    Err("Неизвестный формат идентификатора автозагрузки".to_string())
}

fn startup_target_exists(clean_path: &str) -> bool {
    if clean_path.is_empty() {
        return false;
    }
    let path = Path::new(clean_path);
    if !path.exists() {
        return false;
    }
    if clean_path.to_ascii_lowercase().contains(".lnk") {
        return shortcut_target(path).is_some_and(|target| Path::new(&target).exists());
    }
    true
}

fn shortcut_target(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let raw = parse_shell_link_target(&bytes).or_else(|| find_embedded_path(&bytes));
    let raw = raw.or_else(|| shortcut_target_via_shell(path))?;
    let expanded = expand_environment_path(raw.trim().trim_matches('"'));
    if expanded.is_empty() {
        return None;
    }
    let target = Path::new(&expanded);
    if target.is_absolute() {
        Some(expanded)
    } else {
        path.parent()
            .map(|parent| parent.join(target).to_string_lossy().into_owned())
            .or(Some(expanded))
    }
}

fn shortcut_target_via_shell(path: &Path) -> Option<String> {
    let escaped = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "(New-Object -ComObject WScript.Shell).CreateShortcut('{escaped}').TargetPath"
    );
    let text = hidden_powershell(&script).ok()?;
    let line = text.lines().find(|line| !line.trim().is_empty())?.trim().to_string();
    if line.is_empty() { None } else { Some(line) }
}

fn read_cstr(bytes: &[u8], offset: usize) -> Option<String> {
    if offset == 0 || offset >= bytes.len() {
        return None;
    }
    let end = bytes[offset..].iter().position(|byte| *byte == 0).map(|pos| offset + pos)?;
    let text = String::from_utf8_lossy(&bytes[offset..end]).trim().to_string();
    if text.len() > 3 { Some(text) } else { None }
}

fn read_utf16_cstr(bytes: &[u8], offset: usize) -> Option<String> {
    if offset == 0 || offset + 2 > bytes.len() {
        return None;
    }
    let mut units = Vec::new();
    let mut cursor = offset;
    while cursor + 1 < bytes.len() {
        let unit = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]);
        if unit == 0 {
            break;
        }
        units.push(unit);
        cursor += 2;
        if units.len() > 1024 {
            break;
        }
    }
    let text = String::from_utf16_lossy(&units).trim().to_string();
    if text.len() > 3 { Some(text) } else { None }
}

fn parse_shell_link_target(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 0x4C || read_u32(bytes, 0)? < 0x4C {
        return None;
    }
    let flags = read_u32(bytes, 0x14)?;
    let mut offset = 0x4Cusize;
    if flags & 0x1 != 0 {
        let id_size = u16::from_le_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?) as usize;
        offset = offset.checked_add(2 + id_size)?;
    }
    if flags & 0x2 == 0 || offset + 28 > bytes.len() {
        return None;
    }
    let info = &bytes[offset..];
    let header_size = read_u32(info, 4)? as usize;
    let info_flags = read_u32(info, 8)?;
    let mut target = None;
    if info_flags & 0x1 != 0 {
        target = read_cstr(info, read_u32(info, 16)? as usize);
        if header_size >= 0x24 {
            if let Some(wide) = read_utf16_cstr(info, read_u32(info, 28)? as usize) {
                target = Some(wide);
            }
        }
        let suffix_off = read_u32(info, 24).unwrap_or(0) as usize;
        if let Some(suffix) = read_cstr(info, suffix_off) {
            if let Some(base) = target.as_mut() {
                if !base.to_ascii_lowercase().ends_with(&suffix.to_ascii_lowercase()) {
                    if !base.ends_with('\\') && !suffix.starts_with('\\') {
                        base.push('\\');
                    }
                    base.push_str(&suffix);
                }
            }
        }
    }
    target.filter(|value| value.contains(":\\") || value.contains(":/") || value.starts_with("\\\\"))
}

fn find_slice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn is_path_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'\\' | b'/' | b':' | b'.' | b' ' | b'(' | b')' | b'-' | b'_' | b'&' | b'\'' | b'[' | b']' | b'+' | b',' | b'~'
        )
}

fn find_embedded_path(bytes: &[u8]) -> Option<String> {
    let lower: Vec<u8> = bytes.iter().copied().map(|byte| byte.to_ascii_lowercase()).collect();
    for ext in [b".exe".as_slice(), b".bat", b".cmd", b".com"] {
        let mut from = 0usize;
        while let Some(rel) = find_slice(&lower[from..], ext) {
            let end = from + rel + ext.len();
            let mut start = end - ext.len();
            while start > 0 && is_path_byte(bytes[start - 1]) {
                start -= 1;
            }
            if end - start > 5 {
                let text = String::from_utf8_lossy(&bytes[start..end]).trim().to_string();
                if text.contains(":\\") || text.contains(":/") {
                    return Some(text);
                }
            }
            from = end;
        }
    }

    let mut index = 2usize;
    while index + 3 < bytes.len() {
        if bytes[index] == b':'
            && bytes[index + 1] == 0
            && (bytes[index + 2] == b'\\' || bytes[index + 2] == b'/')
            && bytes[index + 3] == 0
            && bytes[index - 1] == 0
            && bytes[index - 2].is_ascii_alphabetic()
        {
            let start = index - 2;
            let mut end = start;
            while end + 1 < bytes.len() && bytes[end + 1] == 0 && is_path_byte(bytes[end]) {
                end += 2;
            }
            if end > start + 8 {
                let units: Vec<u16> = bytes[start..end]
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .collect();
                let text = String::from_utf16_lossy(&units);
                let low = text.to_ascii_lowercase();
                if low.contains(".exe") || low.ends_with(".bat") || low.ends_with(".cmd") {
                    return Some(text);
                }
            }
        }
        index += 1;
    }
    None
}

fn startup_delete_error(err: &dyn std::fmt::Display) -> String {
    let text = err.to_string().to_lowercase();
    if text.contains("os error 5")
        || text.contains("access is denied")
        || text.contains("отказано")
        || text.contains("доступ")
    {
        "Для удаления системной записи требуются права Администратора (кнопка в шапке)".to_string()
    } else {
        format!("Не удалось удалить запись: {err}")
    }
}

fn delete_registry_value(root: winreg::HKEY, subkey: &str, name: &str) -> Result<(), String> {
    let key = RegKey::predef(root)
        .open_subkey_with_flags(subkey, KEY_SET_VALUE)
        .map_err(|e| startup_delete_error(&e))?;
    key.delete_value(name)
        .map_err(|e| startup_delete_error(&e))
}

#[tauri::command]
fn remove_startup_entry(entry_id: String, source: String) -> Result<(), String> {
    let entry_id = entry_id.trim().to_string();
    if entry_id.is_empty() {
        return Err("Не указана запись автозагрузки".to_string());
    }

    if let Some(base_path) = entry_id.strip_prefix("dir|") {
        for candidate in [base_path.to_string(), format!("{base_path}.disabled")] {
            let path = Path::new(&candidate);
            if path.exists() {
                std::fs::remove_file(path)
                    .map_err(|e| format!("Не удалось удалить файл автозапуска: {e}"))?;
            }
        }
        if let Some(file_name) = Path::new(base_path).file_name().and_then(|name| name.to_str()) {
            let _ = delete_registry_value(
                HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder",
                file_name,
            );
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    if let Some(rest) = entry_id.strip_prefix("reg|") {
        let mut parts = rest.splitn(2, '|');
        let source_tag = parts.next().ok_or("Некорректный ID записи реестра")?;
        let value_name = parts.next().ok_or("Не указано имя параметра реестра")?;
        let (active_root, active_subkey, approved_root, approved_subkey) = match source_tag {
            "HKCU_RUN" => (
                HKEY_CURRENT_USER,
                RUN_KEY_PATH,
                HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
            ),
            "HKLM_RUN" => (
                HKEY_LOCAL_MACHINE,
                RUN_KEY_PATH,
                HKEY_LOCAL_MACHINE,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
            ),
            "HKLM_WOW64_RUN" => (
                HKEY_LOCAL_MACHINE,
                RUN_WOW64_KEY_PATH,
                HKEY_LOCAL_MACHINE,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32",
            ),
            _ => return Err(format!("Неизвестный источник реестра: {source_tag}")),
        };
        delete_registry_value(active_root, active_subkey, value_name)?;
        let _ = delete_registry_value(approved_root, approved_subkey, value_name);
        let backup = format!(r"{NEXUS_DISABLED_REG_BASE}\{source_tag}");
        let _ = delete_registry_value(HKEY_CURRENT_USER, &backup, value_name);
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    if let Some(rest) = entry_id.strip_prefix("approved|") {
        let mut parts = rest.splitn(2, '|');
        let label = parts.next().unwrap_or("");
        let value_name = parts.next().ok_or("Не указано имя битой записи")?;
        let hive = if label.contains("HKLM") {
            HKEY_LOCAL_MACHINE
        } else {
            HKEY_CURRENT_USER
        };
        let subkey = if label.contains("Run32") {
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32"
        } else if label.contains("StartupFolder") {
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder"
        } else {
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
        };
        delete_registry_value(hive, subkey, value_name)?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    if let Some(rest) = entry_id.strip_prefix("msix|") {
        let mut parts = rest.splitn(2, '|');
        let family = parts.next().ok_or("Не указано приложение Store")?;
        let task = parts.next().ok_or("Не указана задача Store")?;
        let parent = format!(
            r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData\{family}\StartupTasks"
        );
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(&parent, KEY_WRITE)
            .and_then(|key| key.delete_subkey_all(task))
            .map_err(|e| format!("Не удалось удалить задачу Store: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    if let Some(name) = entry_id.strip_prefix("cim|") {
        let mut removed = false;
        for (root, subkey) in [
            (HKEY_CURRENT_USER, RUN_KEY_PATH),
            (HKEY_LOCAL_MACHINE, RUN_KEY_PATH),
            (HKEY_LOCAL_MACHINE, RUN_WOW64_KEY_PATH),
        ] {
            if let Ok(key) = RegKey::predef(root).open_subkey_with_flags(subkey, KEY_READ | KEY_SET_VALUE) {
                let names: Vec<String> = key.enum_values().filter_map(|item| item.ok().map(|(value_name, _)| value_name)).collect();
                for value_name in names {
                    if value_name.eq_ignore_ascii_case(name) {
                        key.delete_value(&value_name)
                            .map_err(|e| format!("Не удалось удалить запись «{value_name}»: {e}"))?;
                        removed = true;
                    }
                }
            }
        }
        if !removed {
            return Err(format!("Запись «{name}» не найдена в реестре ({source})"));
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    if let Some(task) = entry_id.strip_prefix("task|") {
        let mut cmd = Command::new("schtasks");
        cmd.args(["/Delete", "/TN", task, "/F"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output().map_err(|e| format!("Не удалось запустить schtasks: {e}"))?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = decode_command_output(&output.stderr);
        return Err(if stderr.trim().is_empty() {
            format!("Не удалось удалить задачу планировщика ({source})")
        } else {
            stderr
        });
    }

    Err(format!("Неизвестный формат записи автозагрузки ({source})"))
}

fn explorer_display_path(path: &Path) -> String {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut shown = resolved.display().to_string();
    if let Some(stripped) = shown.strip_prefix(r"\\?\") {
        shown = stripped.to_string();
    }
    if let Some(unc) = shown.strip_prefix(r"UNC\") {
        shown = format!(r"\\{unc}");
    }
    shown
}

fn spawn_explorer_select(shown: &str) -> Result<(), String> {
    let mut cmd = Command::new("explorer");
    #[cfg(target_os = "windows")]
    cmd.raw_arg(format!("/select,\"{shown}\""));
    #[cfg(not(target_os = "windows"))]
    cmd.arg(shown);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn spawn_explorer_folder(shown: &str) -> Result<(), String> {
    let mut cmd = Command::new("explorer");
    #[cfg(target_os = "windows")]
    cmd.raw_arg(format!("\"{shown}\""));
    #[cfg(not(target_os = "windows"))]
    cmd.arg(shown);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_item_location(path: String) -> Result<(), String> {
    let cleaned = sanitize_launch_path(&path);
    if cleaned.is_empty() {
        return Err("Путь к файлу пуст".to_string());
    }

    let path_buf = PathBuf::from(&cleaned);
    if path_buf.is_dir() {
        return spawn_explorer_folder(&explorer_display_path(&path_buf));
    }
    if path_buf.exists() {
        return spawn_explorer_select(&explorer_display_path(&path_buf));
    }

    if let Some(parent) = path_buf.parent() {
        if parent.as_os_str().len() > 0 && parent.exists() {
            return spawn_explorer_folder(&explorer_display_path(parent));
        }
    }

    Err(format!("Файл не найден: {cleaned}"))
}

// Возвращает список доступных дисков системы (C:\, D:\ и т.д.)
#[tauri::command]
fn get_available_drives() -> Vec<String> {
    let disks = Disks::new_with_refreshed_list();
    let mut drives: Vec<String> = Vec::new();

    for disk in disks.iter() {
        let mount = disk.mount_point().to_string_lossy().to_string();
        if !mount.is_empty() && !drives.contains(&mount) {
            drives.push(mount);
        }
    }

    drives.sort();
    if drives.is_empty() {
        drives.push(r"C:\".to_string());
    }
    drives
}

fn classify_extension(ext: &str) -> &'static str {
    match ext {
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "webm" | "m4v" | "flv" => "Видео",
        "zip" | "rar" | "7z" | "tar" | "gz" | "iso" | "vhd" | "vhdx" | "xz" | "bz2" => {
            "Архивы и образы"
        }
        "exe" | "dll" | "msi" | "pak" | "bin" | "cab" | "sys" | "vpk" | "uasset" | "upk" => {
            "Игры и софт"
        }
        "mp3" | "flac" | "wav" | "ogg" | "m4a" | "aac" | "wma" => "Аудио",
        "pdf" | "docx" | "doc" | "xlsx" | "xls" | "pptx" | "ppt" | "txt" | "md" | "rtf"
        | "csv" => "Документы",
        _ => "Прочее",
    }
}

struct ScanShared {
    files: AtomicU64,
    bytes: AtomicU64,
    cats: [AtomicU64; 6],
    top: Mutex<BinaryHeap<Reverse<(u64, String, String, String)>>>,
    top_floor: AtomicU64,
}

fn skip_scan_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("$Recycle.Bin")
        || name.eq_ignore_ascii_case("System Volume Information")
        || name.eq_ignore_ascii_case("Recovery")
        || name.eq_ignore_ascii_case("hiberfil.sys")
        || name.eq_ignore_ascii_case("pagefile.sys")
}

fn metadata_is_reparse(meta: &std::fs::Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        return meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = meta;
        false
    }
}

fn content_label(path: &str) -> String {
    let folders: Vec<String> = Path::new(path)
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if folders.len() < 2 {
        return String::new();
    }
    let lower: Vec<String> = folders.iter().map(|part| part.to_lowercase()).collect();
    let mut best: Option<(u8, usize)> = None;
    let consider = |best: &mut Option<(u8, usize)>, rank: u8, at: usize| {
        if at + 1 < folders.len() && (best.map(|(prev, _)| rank > prev).unwrap_or(true)) {
            *best = Some((rank, at));
        }
    };
    for index in 0..lower.len() {
        if lower[index] == "steamapps" && lower.get(index + 1).map(String::as_str) == Some("common") {
            consider(&mut best, 100, index + 2);
        }
        if lower[index] == "gog galaxy" && lower.get(index + 1).map(String::as_str) == Some("games") {
            consider(&mut best, 90, index + 2);
        }
        if matches!(lower[index].as_str(), "gog games" | "epic games") {
            consider(&mut best, 85, index + 1);
        }
        if lower[index] == "riot games" {
            consider(&mut best, 80, index + 1);
        }
        if lower[index] == "games" {
            consider(&mut best, 70, index + 1);
        }
        if matches!(lower[index].as_str(), "program files" | "program files (x86)") {
            consider(&mut best, 40, index + 1);
        }
    }
    if let Some((_, at)) = best {
        if let Some(name) = folders.get(at) {
            return name.clone();
        }
    }
    folders.first().cloned().unwrap_or_default()
}

fn category_index(ext: &str) -> usize {
    match classify_extension(ext) {
        "Видео" => 0,
        "Игры и софт" => 1,
        "Архивы и образы" => 2,
        "Аудио" => 3,
        "Документы" => 4,
        _ => 5,
    }
}

fn push_top_file(shared: &ScanShared, size: u64, path: String, name: String, ext: String) {
    if size == 0 {
        return;
    }
    let floor = shared.top_floor.load(Ordering::Relaxed);
    if floor > 0 && size <= floor {
        return;
    }
    let Ok(mut heap) = shared.top.lock() else {
        return;
    };
    if heap.len() >= 100 {
        if let Some(smallest) = heap.peek() {
            if size <= smallest.0.0 {
                shared.top_floor.store(smallest.0.0, Ordering::Relaxed);
                return;
            }
        }
    }
    heap.push(Reverse((size, path, name, ext)));
    if heap.len() > 100 {
        heap.pop();
    }
    if heap.len() >= 100 {
        if let Some(smallest) = heap.peek() {
            shared.top_floor.store(smallest.0.0, Ordering::Relaxed);
        }
    }
}

/// Параллельный обход без повторного запроса атрибутов безопасности.
/// Размер берётся из записи каталога, символические ссылки и точки повторной обработки не раскрываются.
fn scan_dir_fast(path: &Path, depth: u8, shared: &ScanShared) -> (u64, u64, Vec<FolderNode>) {
    let Ok(entries) = std::fs::read_dir(path) else {
        return (0, 0, Vec::new());
    };

    let mut direct_bytes = 0u64;
    let mut local_files = 0u64;
    let mut local_cats = [0u64; 6];
    let mut subdirs: Vec<PathBuf> = Vec::new();

    for item in entries {
        let Ok(entry) = item else { continue };
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if skip_scan_name(&name_text) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if metadata_is_reparse(&meta) {
            continue;
        }
        if file_type.is_dir() {
            subdirs.push(path.join(&name));
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let size = meta.len();
        direct_bytes = direct_bytes.saturating_add(size);
        local_files = local_files.saturating_add(1);
        let ext = Path::new(&name)
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        local_cats[category_index(&ext)] = local_cats[category_index(&ext)].saturating_add(size);

        let floor = shared.top_floor.load(Ordering::Relaxed);
        if size > 0 && (floor == 0 || size > floor) {
            push_top_file(
                shared,
                size,
                path.join(&name).to_string_lossy().into_owned(),
                name_text.into_owned(),
                ext,
            );
        }
    }

    shared.bytes.fetch_add(direct_bytes, Ordering::Relaxed);
    shared.files.fetch_add(local_files, Ordering::Relaxed);
    for (idx, bytes) in local_cats.iter().enumerate() {
        if *bytes > 0 {
            shared.cats[idx].fetch_add(*bytes, Ordering::Relaxed);
        }
    }

    let nested: Vec<(PathBuf, u64, Vec<FolderNode>)> = if subdirs.len() > 1 && depth < 4 {
        subdirs
            .into_par_iter()
            .map(|sub| {
                let (bytes, _direct, children) = scan_dir_fast(&sub, depth + 1, shared);
                (sub, bytes, children)
            })
            .collect()
    } else {
        subdirs
            .into_iter()
            .map(|sub| {
                let (bytes, _direct, children) = scan_dir_fast(&sub, depth + 1, shared);
                (sub, bytes, children)
            })
            .collect()
    };

    let mut tree_bytes = direct_bytes;
    let mut children = Vec::new();
    for (sub, bytes, kids) in nested {
        tree_bytes = tree_bytes.saturating_add(bytes);
        if depth < 3 {
            children.push(FolderNode {
                name: sub
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: sub.to_string_lossy().into_owned(),
                size_bytes: bytes,
                children: if depth < 2 { kids } else { Vec::new() },
            });
        }
    }
    if depth < 3 {
        children.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        children.truncate(10);
    }

    (tree_bytes, direct_bytes, children)
}

// Многопоточное сканирование выбранного диска или папки через rayon
#[tauri::command]
async fn scan_storage(path: String) -> Result<ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut normalized = path.trim().to_string();
        if normalized.len() == 2 && normalized.ends_with(':') {
            normalized.push('\\');
        }

        let root_path = PathBuf::from(&normalized);
        if !root_path.exists() {
            return Err(format!("Указанный путь не существует: {}", normalized));
        }

        let shared = ScanShared {
            files: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            cats: std::array::from_fn(|_| AtomicU64::new(0)),
            top: Mutex::new(BinaryHeap::new()),
            top_floor: AtomicU64::new(0),
        };
        let (_tree_bytes, root_direct_files_bytes, mut root_children) =
            scan_dir_fast(&root_path, 0, &shared);

        let total_scanned_bytes = shared.bytes.load(Ordering::Relaxed);
        let total_files_count = shared.files.load(Ordering::Relaxed);
        let top_heap = shared
            .top
            .lock()
            .map(|mut heap| std::mem::take(&mut *heap))
            .unwrap_or_default();

        let mut top_files: Vec<FileEntry> = top_heap
            .into_iter()
            .map(|Reverse((size_bytes, path, name, extension))| {
                let app_label = content_label(&path);
                FileEntry {
                    path,
                    name,
                    size_bytes,
                    extension,
                    app_label,
                }
            })
            .collect();
        top_files.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));

        if root_direct_files_bytes > 0 {
            root_children.push(FolderNode {
                name: "[Файлы в корне]".to_string(),
                path: normalized.clone(),
                size_bytes: root_direct_files_bytes,
                children: Vec::new(),
            });
            root_children.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
            root_children.truncate(10);
        }

        let root_name = root_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| normalized.clone());

        let root_node = FolderNode {
            name: root_name,
            path: normalized.clone(),
            size_bytes: total_scanned_bytes,
            children: root_children,
        };

        let category_sizes = vec![
            ("Игры и софт".to_string(), shared.cats[1].load(Ordering::Relaxed)),
            ("Видео".to_string(), shared.cats[0].load(Ordering::Relaxed)),
            ("Архивы и образы".to_string(), shared.cats[2].load(Ordering::Relaxed)),
            ("Аудио".to_string(), shared.cats[3].load(Ordering::Relaxed)),
            ("Документы".to_string(), shared.cats[4].load(Ordering::Relaxed)),
            ("Прочее".to_string(), shared.cats[5].load(Ordering::Relaxed)),
        ];

        Ok(ScanResult {
            target_path: normalized,
            total_scanned_bytes,
            total_files_count,
            root_node,
            top_files,
            category_sizes,
        })
    })
    .await
    .map_err(|e| format!("Ошибка выполнения фонового потока сканирования: {}", e))?
}

// Замер реального TCP-пинга до DNS-шлюзов (1.1.1.1:53 / 8.8.8.8:53) с кэшированием на 2.5 сек
fn measure_network_ping_ms(state: &AppState) -> u32 {
    if let Ok(guard) = state.ping_cache.lock() {
        if let (cached_ms, Some(last_checked)) = *guard {
            if last_checked.elapsed() < Duration::from_millis(2500) {
                return cached_ms;
            }
        }
    }

    let targets = [
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)), 53),
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), 53),
    ];
    let timeout = Duration::from_millis(450);

    let mut measured_ms: u32 = 0;
    for addr in &targets {
        let start = Instant::now();
        if TcpStream::connect_timeout(addr, timeout).is_ok() {
            let ms = start.elapsed().as_millis() as u32;
            measured_ms = ms.max(1);
            break;
        }
    }

    if let Ok(mut guard) = state.ping_cache.lock() {
        *guard = (measured_ms, Some(Instant::now()));
    }

    measured_ms
}

#[tauri::command]
fn get_system_metrics(state: State<'_, AppState>) -> SystemMetrics {
    let mut sys = state.sys.lock().unwrap();

    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpu_usage = sys.global_cpu_usage();
    let ram_used = sys.used_memory() as f32 / 1024.0 / 1024.0 / 1024.0;
    let ram_total = sys.total_memory() as f32 / 1024.0 / 1024.0 / 1024.0;
    let ram_percentage = if ram_total > 0.0 {
        (ram_used / ram_total) * 100.0
    } else {
        0.0
    };

    let swap_used_gb = sys.used_swap() as f32 / 1024.0 / 1024.0 / 1024.0;
    let swap_total_gb = sys.total_swap() as f32 / 1024.0 / 1024.0 / 1024.0;

    drop(sys);

    let (net_rx_kbps, net_tx_kbps) = if let Ok(mut networks) = state.networks.lock() {
        networks.refresh(true);
        let mut total_rx_bytes: u64 = 0;
        let mut total_tx_bytes: u64 = 0;

        for (_interface_name, data) in networks.iter() {
            total_rx_bytes = total_rx_bytes.saturating_add(data.received());
            total_tx_bytes = total_tx_bytes.saturating_add(data.transmitted());
        }

        (
            total_rx_bytes as f32 / 1024.0,
            total_tx_bytes as f32 / 1024.0,
        )
    } else {
        (0.0, 0.0)
    };

    let net_ping_ms = measure_network_ping_ms(&state);
    update_tray_ping(&state, net_ping_ms);

    let (disk_free_gb, disk_total_gb) = state
        .disk_space
        .lock()
        .map(|slot| *slot)
        .unwrap_or((0, 0));

    SystemMetrics {
        cpu_usage,
        ram_used_gb: ram_used,
        ram_total_gb: ram_total,
        ram_percentage,
        swap_used_gb,
        swap_total_gb,
        disk_free_gb,
        disk_total_gb,
        net_rx_kbps,
        net_tx_kbps,
        net_ping_ms,
    }
}

#[tauri::command]
fn schedule_shutdown(seconds: u64, restart: bool) -> Result<(), String> {
    if seconds == 0 {
        return Err("Время таймера должно быть больше 0 секунд".to_string());
    }

    let mut abort_cmd = Command::new("shutdown");
    abort_cmd.arg("/a");
    #[cfg(target_os = "windows")]
    abort_cmd.creation_flags(CREATE_NO_WINDOW);
    let _ = abort_cmd.output();

    let mode_flag = if restart { "/r" } else { "/s" };

    let mut cmd = Command::new("shutdown");
    cmd.args([mode_flag, "/t", &seconds.to_string()]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("Не удалось запустить команду shutdown: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!(
                "Команда shutdown завершилась с кодом: {:?}",
                output.status.code()
            )
        } else {
            stderr
        })
    }
}

#[tauri::command]
fn cancel_shutdown() -> Result<(), String> {
    let mut cmd = Command::new("shutdown");
    cmd.arg("/a");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("Не удалось вызвать отмену выключения: {}", e))?;

    if output.status.success() || output.status.code() == Some(1116) {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!(
                "Не удалось отменить таймер (код {:?})",
                output.status.code()
            )
        } else {
            stderr
        })
    }
}

// Проверка запуска с правами Администратора (чтение защищённого куста реестра S-1-5-19)
fn check_is_elevated_admin() -> bool {
    #[cfg(target_os = "windows")]
    {
        RegKey::predef(HKEY_USERS).open_subkey("S-1-5-19").is_ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
fn is_elevated_admin() -> bool {
    check_is_elevated_admin()
}

#[tauri::command]
fn restart_as_admin(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Не удалось определить путь к исполняемому файлу: {}", e))?;
    let escaped = exe_path.to_string_lossy().replace('\'', "''");

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        &format!("Start-Process -FilePath '{}' -Verb RunAs", escaped),
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let status = cmd
        .status()
        .map_err(|e| format!("Ошибка вызова UAC PowerShell: {}", e))?;

    if !status.success() {
        return Err("Запрос на повышение привилегий (UAC) был отклонён".to_string());
    }

    // Останавливаем фоновый sidecar перед выходом текущего процесса
    if let Ok(mut guard) = state.hw_sidecar_child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
    }

    app.exit(0);
    Ok(())
}

#[tauri::command]
fn app_exit(app: tauri::AppHandle, state: State<'_, AppState>) {
    if let Ok(mut guard) = state.hw_sidecar_child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
    }
    app.exit(0);
}

#[tauri::command]
fn flush_dns() -> Result<(), String> {
    let mut cmd = Command::new("ipconfig");
    cmd.args(["/flushdns"]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("Не удалось запустить ipconfig /flushdns: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "Очистка кэша DNS не выполнена".to_string()
        } else {
            stderr
        })
    }
}

const MEDIA_PROFILE_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile";

#[derive(Serialize, Clone)]
struct RouteProbe {
    label: String,
    host: String,
    ping_ms: u32,
    jitter_ms: u32,
}

fn sample_tcp_route(ip: Ipv4Addr, port: u16) -> (u32, u32) {
    let addr = SocketAddr::new(IpAddr::V4(ip), port);
    let mut samples = Vec::new();
    for _ in 0..3 {
        let started = Instant::now();
        if TcpStream::connect_timeout(&addr, Duration::from_millis(700)).is_ok() {
            samples.push(started.elapsed().as_millis().max(1) as u32);
        }
    }
    if samples.is_empty() {
        return (0, 0);
    }
    let fastest = *samples.iter().min().unwrap_or(&0);
    let slowest = *samples.iter().max().unwrap_or(&0);
    (fastest, slowest.saturating_sub(fastest))
}

#[tauri::command]
fn probe_game_routes() -> Vec<RouteProbe> {
    let targets = [
        ("DNS / Магистраль", Ipv4Addr::new(1, 1, 1, 1), 53u16),
        ("СНГ / Москва", Ipv4Addr::new(162, 159, 135, 234), 443u16),
        ("Европа / Cloudflare", Ipv4Addr::new(1, 0, 0, 1), 53u16),
    ];
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for (label, ip, port) in targets {
            handles.push(scope.spawn(move || {
                let (ping_ms, jitter_ms) = sample_tcp_route(ip, port);
                RouteProbe {
                    label: label.to_string(),
                    host: ip.to_string(),
                    ping_ms,
                    jitter_ms,
                }
            }));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap_or(RouteProbe {
                label: String::new(),
                host: String::new(),
                ping_ms: 0,
                jitter_ms: 0,
            }))
            .collect()
    })
}

#[cfg(target_os = "windows")]
fn media_profile_key(writable: bool) -> Result<RegKey, String> {
    let flags = if writable {
        KEY_READ | KEY_SET_VALUE | KEY_WOW64_64KEY
    } else {
        KEY_READ | KEY_WOW64_64KEY
    };
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(MEDIA_PROFILE_KEY, flags)
        .map_err(|e| format!("Не удалось открыть профиль мультимедиа: {}", e))
}

#[tauri::command]
fn get_packet_priority() -> Result<bool, String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Ok(false);
    }
    #[cfg(target_os = "windows")]
    {
        let key = media_profile_key(false)?;
        let throttle: u32 = key.get_value("NetworkThrottlingIndex").unwrap_or(10);
        Ok(throttle == u32::MAX)
    }
}

#[tauri::command]
fn set_packet_priority(enabled: bool) -> Result<(), String> {
    if !check_is_elevated_admin() {
        return Err("Требуются права Администратора (кнопка в шапке)".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let key = media_profile_key(true)?;
        if enabled {
            key.set_value("NetworkThrottlingIndex", &u32::MAX)
                .map_err(|e| format!("Не удалось записать NetworkThrottlingIndex: {}", e))?;
            key.set_value("SystemResponsiveness", &0u32)
                .map_err(|e| format!("Не удалось записать SystemResponsiveness: {}", e))?;
        } else {
            key.set_value("NetworkThrottlingIndex", &10u32)
                .map_err(|e| format!("Не удалось вернуть NetworkThrottlingIndex: {}", e))?;
            key.set_value("SystemResponsiveness", &20u32)
                .map_err(|e| format!("Не удалось вернуть SystemResponsiveness: {}", e))?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("Настройка доступна только в Windows".to_string())
    }
}

#[tauri::command]
fn tune_ethernet_adapter() -> Result<String, String> {
    if !check_is_elevated_admin() {
        return Err("Требуются права Администратора (кнопка в шапке)".to_string());
    }
    let script = r#"
$script:changed = 0
Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  $props = Get-NetAdapterAdvancedProperty -Name $_.Name -ErrorAction SilentlyContinue
  foreach ($p in $props) {
    $key = [string]$p.RegistryKeyword
    if ($key -match 'EEE|GreenEthernet|InterruptModeration') {
      $choice = $null
      foreach ($v in @($p.ValidDisplayValues)) {
        if ($v -match '^(Disabled|Отключено)$') { $choice = $v; break }
      }
      if (-not $choice -and $key -match 'Interrupt') {
        foreach ($v in @($p.ValidDisplayValues)) {
          if ($v -match 'Low|Низк') { $choice = $v; break }
        }
      }
      if ($choice) {
        try {
          Set-NetAdapterAdvancedProperty -Name $_.Name -RegistryKeyword $key -DisplayValue $choice -NoRestart -ErrorAction Stop
          $script:changed++
        } catch {}
      }
    }
  }
}
Write-Output $script:changed
"#;
    let text = hidden_powershell(script)?;
    let changed = text.lines().last().unwrap_or("0").trim().parse::<u32>().unwrap_or(0);
    if changed == 0 {
        return Err("У активного Ethernet-адаптера не найдены Energy Efficient Ethernet, Green Ethernet или Interrupt Moderation".to_string());
    }
    Ok(format!("Отключено параметров адаптера: {}", changed))
}

#[tauri::command]
fn get_ethernet_tuned() -> Result<bool, String> {
    let script = r#"
$seen = 0
$tuned = 0
Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  $props = Get-NetAdapterAdvancedProperty -Name $_.Name -ErrorAction SilentlyContinue
  foreach ($p in $props) {
    $key = [string]$p.RegistryKeyword
    if ($key -match 'EEE|GreenEthernet|InterruptModeration') {
      $seen++
      $value = [string]$p.DisplayValue
      if ($value -match 'Disabled|Отключено|Low|Низк') { $tuned++ }
    }
  }
}
if ($seen -gt 0 -and $tuned -eq $seen) { '1' } else { '0' }
"#;
    let text = hidden_powershell(script)?;
    Ok(text.lines().last().unwrap_or("0").trim() == "1")
}

#[tauri::command]
fn set_ethernet_tuned(enabled: bool) -> Result<String, String> {
    if enabled {
        return tune_ethernet_adapter();
    }
    if !check_is_elevated_admin() {
        return Err("Требуются права Администратора (кнопка в шапке)".to_string());
    }
    let script = r#"
$script:changed = 0
Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  $props = Get-NetAdapterAdvancedProperty -Name $_.Name -ErrorAction SilentlyContinue
  foreach ($p in $props) {
    $key = [string]$p.RegistryKeyword
    if ($key -match 'EEE|GreenEthernet|InterruptModeration') {
      $choice = $null
      $pattern = if ($key -match 'Interrupt') { 'Enabled|Включено|Moderate|Средн' } else { '^(Enabled|Включено)$' }
      foreach ($v in @($p.ValidDisplayValues)) {
        if ($v -match $pattern) { $choice = $v; break }
      }
      if ($choice) {
        try {
          Set-NetAdapterAdvancedProperty -Name $_.Name -RegistryKeyword $key -DisplayValue $choice -NoRestart -ErrorAction Stop
          $script:changed++
        } catch {}
      }
    }
  }
}
Write-Output $script:changed
"#;
    let text = hidden_powershell(script)?;
    let changed = text.lines().last().unwrap_or("0").trim().parse::<u32>().unwrap_or(0);
    if changed == 0 {
        return Err("Не удалось вернуть энергосбережение сетевого адаптера".to_string());
    }
    Ok(format!("Возвращено параметров адаптера: {}", changed))
}

fn update_tray_ping(state: &AppState, ping_ms: u32) {
    let Ok(guard) = state.tray_ping_item.lock() else {
        return;
    };
    let Some(item) = guard.as_ref() else {
        return;
    };
    let label = if ping_ms > 0 {
        format!("Ping: {ping_ms} ms")
    } else {
        "Ping: нет сети".to_string()
    };
    let _ = item.set_text(label);
}

fn reveal_main_window(app: &tauri::AppHandle) {
    if let Some(hud) = app.get_webview_window("tray_hud") {
        let _ = hud.hide();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_tray_hud(app: &tauri::AppHandle, icon_x: f64, icon_y: f64) {
    let Some(window) = app.get_webview_window("tray_hud") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = 280.0 * scale;
    let height = 180.0 * scale;
    let x = (icon_x - width + 20.0).max(8.0) as i32;
    let y = (icon_y - height - 10.0).max(8.0) as i32;
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    let _ = window.show();
    let _ = window.set_focus();
}

// Описание цели очистки для модуля Cleanup Center
struct CleanupTargetSpec {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    paths_hint: &'static str,
    requires_admin: bool,
    dirs: Vec<PathBuf>,
}

fn build_cleanup_specs() -> Vec<CleanupTargetSpec> {
    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());

    // 1. Временные файлы пользователя (%TEMP%)
    let user_temp_dir = std::env::temp_dir();

    // 2. Системный Temp (C:\Windows\Temp)
    let sys_temp_dir = PathBuf::from(&sys_root).join("Temp");

    // 3. Кэш миниатюр Проводника (thumbcache_*.db)
    let explorer_dir = if !local_app_data.is_empty() {
        vec![PathBuf::from(&local_app_data).join(r"Microsoft\Windows\Explorer")]
    } else {
        Vec::new()
    };

    // 4. Кэш шейдеров DirectX и видеокарт (DirectX / NVIDIA / AMD)
    let mut shader_dirs = Vec::new();
    if !local_app_data.is_empty() {
        let base = PathBuf::from(&local_app_data);
        shader_dirs.push(base.join("D3DSCache"));
        shader_dirs.push(base.join(r"NVIDIA\DXCache"));
        shader_dirs.push(base.join(r"NVIDIA\GLCache"));
        shader_dirs.push(base.join(r"AMD\DxCache"));
        shader_dirs.push(base.join(r"AMD\DxcCache"));
        shader_dirs.push(base.join(r"AMD\GLCache"));
    }

    // 5. Корзина Windows ($Recycle.Bin на всех локальных дисках)
    let disks = Disks::new_with_refreshed_list();
    let mut recycle_dirs = Vec::new();
    let mut seen_mounts = HashSet::new();
    for d in disks.iter() {
        let mount = d.mount_point().to_path_buf();
        if seen_mounts.insert(mount.clone()) {
            recycle_dirs.push(mount.join("$Recycle.Bin"));
        }
    }
    if recycle_dirs.is_empty() {
        recycle_dirs.push(PathBuf::from(r"C:\$Recycle.Bin"));
    }

    // 6. Системные дампы памяти и крэш-логи (CrashDumps, Minidump, WER)
    let mut dump_dirs = Vec::new();
    if !local_app_data.is_empty() {
        let base = PathBuf::from(&local_app_data);
        dump_dirs.push(base.join("CrashDumps"));
        dump_dirs.push(base.join(r"Microsoft\Windows\WER\ReportArchive"));
        dump_dirs.push(base.join(r"Microsoft\Windows\WER\ReportQueue"));
    }
    dump_dirs.push(PathBuf::from(&sys_root).join("Minidump"));
    dump_dirs.push(PathBuf::from(&sys_root).join("LiveKernelReports"));

    let mut browser_dirs = Vec::new();
    if !local_app_data.is_empty() {
        let base = PathBuf::from(&local_app_data);
        push_chromium_caches(&mut browser_dirs, base.join(r"Google\Chrome\User Data"));
        push_chromium_caches(&mut browser_dirs, base.join(r"Microsoft\Edge\User Data"));
        push_chromium_caches(&mut browser_dirs, base.join(r"Yandex\YandexBrowser\User Data"));
    }

    let mut discord_dirs = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        let discord = PathBuf::from(appdata).join("discord");
        for leaf in ["Cache", "Code Cache", "GPUCache"] {
            let dir = discord.join(leaf);
            if dir.is_dir() {
                discord_dirs.push(dir);
            }
        }
    }

    vec![
        CleanupTargetSpec {
            id: "user_temp",
            name: "Временные файлы пользователя (%TEMP%)",
            description: "Временные кэши запущенных приложений, инсталляторов и распакованных пакетов текущего профиля",
            paths_hint: "%LOCALAPPDATA%\\Temp",
            requires_admin: false,
            dirs: vec![user_temp_dir],
        },
        CleanupTargetSpec {
            id: "system_temp",
            name: "Системный Temp (Windows\\Temp)",
            description: "Временные файлы системных служб Windows и фоновых установщиков ОС",
            paths_hint: "C:\\Windows\\Temp",
            requires_admin: true,
            dirs: vec![sys_temp_dir],
        },
        CleanupTargetSpec {
            id: "thumbnails",
            name: "Кэш миниатюр Проводника (Thumbnails)",
            description: "Базы предпросмотра изображений и эскизов папок Проводника Windows (thumbcache_*.db)",
            paths_hint: "%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer\\thumbcache_*.db",
            requires_admin: false,
            dirs: explorer_dir,
        },
        CleanupTargetSpec {
            id: "shader_cache",
            name: "Кэш шейдеров DirectX / NVIDIA / AMD",
            description: "Скомпилированные шейдеры игр и графических API (пересоздаются автоматически при запуске)",
            paths_hint: "D3DSCache • NVIDIA\\DXCache • AMD\\DxCache",
            requires_admin: false,
            dirs: shader_dirs,
        },
        CleanupTargetSpec {
            id: "recycle_bin",
            name: "Корзина Windows ($Recycle.Bin)",
            description: "Удалённые пользователем файлы во всех разделах накопителей, ожидающие полной очистки",
            paths_hint: "All Drives:\\$Recycle.Bin",
            requires_admin: false,
            dirs: recycle_dirs,
        },
        CleanupTargetSpec {
            id: "crash_dumps",
            name: "Системные дампы памяти и отчёты сбоев (*.dmp)",
            description: "Аварийные дампы процессов (CrashDumps), отчёты Windows Error Reporting и минидампы ядра",
            paths_hint: "%LOCALAPPDATA%\\CrashDumps • C:\\Windows\\Minidump • WER",
            requires_admin: false,
            dirs: dump_dirs,
        },
        CleanupTargetSpec {
            id: "browser_cache",
            name: "Кэш браузеров (Chrome, Edge, Yandex)",
            description: "Временный кэш картинок, стилей и скриптов. Сессии и пароли сохраняются.",
            paths_hint: "Cache • Code Cache • GPUCache",
            requires_admin: false,
            dirs: browser_dirs,
        },
        CleanupTargetSpec {
            id: "windows_update",
            name: "Загрузки Windows Update",
            description: "Установочные пакеты уже применённых обновлений операционной системы.",
            paths_hint: "%SystemRoot%\\SoftwareDistribution\\Download",
            requires_admin: true,
            dirs: vec![PathBuf::from(&sys_root).join(r"SoftwareDistribution\Download")],
        },
        CleanupTargetSpec {
            id: "discord_cache",
            name: "Кэш Discord и мессенджеров",
            description: "Кэшированные превью медиафайлов и голосовых сообщений.",
            paths_hint: "%APPDATA%\\discord\\Cache • Code Cache • GPUCache",
            requires_admin: false,
            dirs: discord_dirs,
        },
    ]
}

fn push_chromium_caches(dirs: &mut Vec<PathBuf>, user_data: PathBuf) {
    let Ok(entries) = std::fs::read_dir(&user_data) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let profile_name = entry.file_name().to_string_lossy().to_lowercase();
        if profile_name != "default" && !profile_name.starts_with("profile ") {
            continue;
        }
        for leaf in ["Cache", "Code Cache", "GPUCache"] {
            let dir = entry.path().join(leaf);
            if dir.is_dir() {
                dirs.push(dir);
            }
        }
    }
}

fn is_cache_only_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            let low = name.to_lowercase();
            low == "cache" || low == "code cache" || low == "gpucache"
        })
        .unwrap_or(false)
}

fn is_protected_browser_entry(path: &Path) -> bool {
    path.components().any(|component| {
        let std::path::Component::Normal(name) = component else {
            return false;
        };
        matches!(
            name.to_string_lossy().to_lowercase().as_str(),
            "cookies"
                | "cookies-journal"
                | "history"
                | "history-journal"
                | "login data"
                | "login data-journal"
                | "web data"
                | "web data-journal"
                | "bookmarks"
                | "bookmarks.bak"
                | "preferences"
                | "secure preferences"
                | "sessions"
                | "indexeddb"
                | "local storage"
                | "session storage"
                | "extension cookies"
        )
    })
}

// Проверка, подлежит ли конкретный файл учёту и удалению в рамках категории
fn is_cleanup_file_eligible(category_id: &str, file_path: &Path) -> bool {
    let Some(file_name_os) = file_path.file_name() else {
        return false;
    };
    let file_name = file_name_os.to_string_lossy().to_lowercase();

    match category_id {
        "thumbnails" => file_name.starts_with("thumbcache_") && file_name.ends_with(".db"),
        "recycle_bin" => file_name != "desktop.ini",
        _ => true,
    }
}

// Безопасный рекурсивный подсчёт размера и количества файлов в категории (без перехода по симлинкам)
fn scan_category_dir_recursive(category_id: &str, dir: &Path, size_acc: &mut u64, count_acc: &mut u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry_res in entries {
        let Ok(entry) = entry_res else {
            continue;
        };
        let path = entry.path();
        if matches!(category_id, "browser_cache" | "discord_cache") && is_protected_browser_entry(&path) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };

        if meta.file_type().is_symlink() {
            continue;
        }

        if meta.is_dir() {
            if category_id != "thumbnails" {
                scan_category_dir_recursive(category_id, &path, size_acc, count_acc);
            }
        } else if meta.is_file() && is_cleanup_file_eligible(category_id, &path) {
            *size_acc = size_acc.saturating_add(meta.len());
            *count_acc = count_acc.saturating_add(1);
        }
    }
}

// Безопасное рекурсивное удаление файлов с пропуском заблокированных системой (EBUSY / PermissionDenied)
fn clean_category_dir_recursive(
    category_id: &str,
    dir: &Path,
    is_root: bool,
    deleted_acc: &mut u64,
    skipped_acc: &mut u64,
    freed_acc: &mut u64,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry_res in entries {
        let Ok(entry) = entry_res else {
            continue;
        };
        let path = entry.path();
        if matches!(category_id, "browser_cache" | "discord_cache") && is_protected_browser_entry(&path) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };

        if meta.file_type().is_symlink() {
            continue;
        }

        if meta.is_dir() {
            if category_id != "thumbnails" {
                clean_category_dir_recursive(
                    category_id,
                    &path,
                    false,
                    deleted_acc,
                    skipped_acc,
                    freed_acc,
                );
                // В $Recycle.Bin сохраняем корневые SID-папки пользователя, удаляя только вложенные подпапки
                let is_recycle_sid_dir = is_root && category_id == "recycle_bin";
                if !is_recycle_sid_dir {
                    let _ = std::fs::remove_dir(&path);
                }
            }
        } else if meta.is_file() && is_cleanup_file_eligible(category_id, &path) {
            let file_len = meta.len();
            // Снимаем атрибут Read-Only перед удалением, если он установлен на старом кэше
            if meta.permissions().readonly() {
                let mut perms = meta.permissions();
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(&path, perms);
            }

            match std::fs::remove_file(&path) {
                Ok(()) => {
                    *deleted_acc = deleted_acc.saturating_add(1);
                    *freed_acc = freed_acc.saturating_add(file_len);
                }
                Err(_) => {
                    // Файл занят процессом (EBUSY / Sharing Violation) или защищён — безопасно пропускаем
                    *skipped_acc = skipped_acc.saturating_add(1);
                }
            }
        }
    }
}

#[tauri::command]
async fn scan_cleanup_targets() -> Result<Vec<CleanupCategory>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let specs = build_cleanup_specs();
        let mut results = Vec::with_capacity(specs.len());

        for spec in specs {
            let mut total_size: u64 = 0;
            let mut total_files: u64 = 0;

            for dir in &spec.dirs {
                if matches!(spec.id, "browser_cache" | "discord_cache") && !is_cache_only_dir(dir) {
                    continue;
                }
                if dir.exists() {
                    scan_category_dir_recursive(spec.id, dir, &mut total_size, &mut total_files);
                }
            }

            results.push(CleanupCategory {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                description: spec.description.to_string(),
                paths_hint: spec.paths_hint.to_string(),
                size_bytes: total_size,
                files_count: total_files,
                requires_admin: spec.requires_admin,
            });
        }

        Ok(results)
    })
    .await
    .map_err(|e| format!("Ошибка потока анализа очистки: {}", e))?
}

#[tauri::command]
async fn execute_cleanup(category_ids: Vec<String>) -> Result<CleanupReport, String> {
    if category_ids.is_empty() {
        return Err("Не выбрано ни одной категории для очистки".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let selected_set: HashSet<String> = category_ids.into_iter().collect();
        let specs = build_cleanup_specs();

        let mut total_deleted: u64 = 0;
        let mut total_skipped: u64 = 0;
        let mut total_freed: u64 = 0;
        let mut category_reports = Vec::new();

        for spec in specs {
            if !selected_set.contains(spec.id) {
                continue;
            }

            let mut cat_deleted: u64 = 0;
            let mut cat_skipped: u64 = 0;
            let mut cat_freed: u64 = 0;

            for dir in &spec.dirs {
                if matches!(spec.id, "browser_cache" | "discord_cache") && !is_cache_only_dir(dir) {
                    continue;
                }
                if dir.exists() {
                    clean_category_dir_recursive(
                        spec.id,
                        dir,
                        true,
                        &mut cat_deleted,
                        &mut cat_skipped,
                        &mut cat_freed,
                    );
                }
            }

            total_deleted = total_deleted.saturating_add(cat_deleted);
            total_skipped = total_skipped.saturating_add(cat_skipped);
            total_freed = total_freed.saturating_add(cat_freed);

            category_reports.push(CleanupCategoryReport {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                deleted_files: cat_deleted,
                skipped_files: cat_skipped,
                freed_bytes: cat_freed,
            });
        }

        Ok(CleanupReport {
            deleted_files_count: total_deleted,
            skipped_files_count: total_skipped,
            freed_bytes: total_freed,
            categories: category_reports,
        })
    })
    .await
    .map_err(|e| format!("Ошибка потока очистки диска: {}", e))?
}

// ===================== Process Explorer =====================

#[tauri::command]
fn get_process_list(state: State<'_, AppState>) -> Result<Vec<ProcessItem>, String> {
    // Интервал с прошлого опроса нужен для пересчёта дельты дискового I/O в байт/сек
    let elapsed_secs = {
        let mut guard = state
            .process_last_refresh
            .lock()
            .map_err(|_| "Состояние процессов заблокировано".to_string())?;
        let now = Instant::now();
        let secs = guard
            .map(|prev| now.duration_since(prev).as_secs_f64())
            .unwrap_or(1.0)
            .max(0.25);
        *guard = Some(now);
        secs
    };

    let mut sys = state
        .sys
        .lock()
        .map_err(|_| "Системный монитор заблокирован".to_string())?;

    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let cpu_count = sys.cpus().len().max(1) as f32;

    let list = sys
        .processes()
        .values()
        .filter(|p| p.pid().as_u32() != 0)
        .map(|p| {
            let disk = p.disk_usage();
            ProcessItem {
                pid: p.pid().as_u32(),
                parent_pid: p.parent().map(|pp| pp.as_u32()),
                name: p.name().to_string_lossy().to_string(),
                exe_path: p
                    .exe()
                    .map(|e| e.to_string_lossy().to_string())
                    .unwrap_or_default(),
                cpu_usage: (p.cpu_usage() / cpu_count).clamp(0.0, 100.0),
                memory_mb: p.memory() as f64 / 1024.0 / 1024.0,
                disk_read_bytes_sec: (disk.read_bytes as f64 / elapsed_secs) as u64,
                disk_write_bytes_sec: (disk.written_bytes as f64 / elapsed_secs) as u64,
                run_time_sec: p.run_time(),
                icon_base64: None,
            }
        })
        .collect();

    drop(sys);

    let mut list: Vec<ProcessItem> = list;
    for item in &mut list {
        item.icon_base64 = cached_process_icon(&state.icon_cache, &item.exe_path);
    }

    Ok(list)
}

fn cached_process_icon(cache: &Mutex<HashMap<String, String>>, path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let key = trimmed.to_lowercase();

    if let Ok(guard) = cache.lock() {
        if let Some(hit) = guard.get(&key) {
            return if hit.is_empty() {
                None
            } else {
                Some(hit.clone())
            };
        }
    }

    let encoded = extract_exe_icon_png_base64(trimmed).unwrap_or_default();
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, encoded.clone());
    }
    if encoded.is_empty() {
        None
    } else {
        Some(encoded)
    }
}

#[cfg(not(target_os = "windows"))]
fn extract_exe_icon_png_base64(_path: &str) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn extract_exe_icon_png_base64(path: &str) -> Option<String> {
    use std::ffi::c_void;

    #[repr(C)]
    struct ShFileInfoW {
        h_icon: isize,
        i_icon: i32,
        dw_attributes: u32,
        sz_display_name: [u16; 260],
        sz_type_name: [u16; 80],
    }

    #[repr(C)]
    struct IconInfo {
        f_icon: i32,
        x_hotspot: u32,
        y_hotspot: u32,
        hbm_mask: isize,
        hbm_color: isize,
    }

    #[repr(C)]
    struct Bitmap {
        bm_type: i32,
        bm_width: i32,
        bm_height: i32,
        bm_width_bytes: i32,
        bm_planes: u16,
        bm_bits_pixel: u16,
        bm_bits: *mut c_void,
    }

    #[repr(C)]
    struct BitmapInfoHeader {
        bi_size: u32,
        bi_width: i32,
        bi_height: i32,
        bi_planes: u16,
        bi_bit_count: u16,
        bi_compression: u32,
        bi_size_image: u32,
        bi_x_pels_per_meter: i32,
        bi_y_pels_per_meter: i32,
        bi_clr_used: u32,
        bi_clr_important: u32,
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHGetFileInfoW(
            path: *const u16,
            file_attributes: u32,
            info: *mut ShFileInfoW,
            info_size: u32,
            flags: u32,
        ) -> usize;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn DestroyIcon(icon: isize) -> i32;
        fn GetIconInfo(icon: isize, info: *mut IconInfo) -> i32;
        fn GetDC(hwnd: isize) -> isize;
        fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
    }

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn GetObjectW(handle: isize, size: i32, out: *mut c_void) -> i32;
        fn CreateCompatibleDC(hdc: isize) -> isize;
        fn DeleteDC(hdc: isize) -> i32;
        fn GetDIBits(
            hdc: isize,
            bitmap: isize,
            start: u32,
            lines: u32,
            bits: *mut c_void,
            info: *mut BitmapInfoHeader,
            usage: u32,
        ) -> i32;
        fn DeleteObject(handle: isize) -> i32;
    }

    const SHGFI_ICON: u32 = 0x0000_0100;
    const SHGFI_SMALLICON: u32 = 0x0000_0001;

    let mut wide: Vec<u16> = path.encode_utf16().collect();
    wide.push(0);

    unsafe {
        let mut info: ShFileInfoW = std::mem::zeroed();
        let ok = SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut info,
            std::mem::size_of::<ShFileInfoW>() as u32,
            SHGFI_ICON | SHGFI_SMALLICON,
        );
        if ok == 0 || info.h_icon == 0 {
            return None;
        }

        let mut icon_info: IconInfo = std::mem::zeroed();
        if GetIconInfo(info.h_icon, &mut icon_info) == 0 || icon_info.hbm_color == 0 {
            if icon_info.hbm_mask != 0 {
                DeleteObject(icon_info.hbm_mask);
            }
            if icon_info.hbm_color != 0 {
                DeleteObject(icon_info.hbm_color);
            }
            DestroyIcon(info.h_icon);
            return None;
        }

        let mut bitmap: Bitmap = std::mem::zeroed();
        let got = GetObjectW(
            icon_info.hbm_color,
            std::mem::size_of::<Bitmap>() as i32,
            &mut bitmap as *mut Bitmap as *mut c_void,
        );
        let width = bitmap.bm_width;
        let height = bitmap.bm_height.abs();
        if got == 0 || width <= 0 || height <= 0 || width > 256 || height > 256 {
            DeleteObject(icon_info.hbm_color);
            if icon_info.hbm_mask != 0 {
                DeleteObject(icon_info.hbm_mask);
            }
            DestroyIcon(info.h_icon);
            return None;
        }

        let screen = GetDC(0);
        let mem_dc = CreateCompatibleDC(screen);
        let mut header = BitmapInfoHeader {
            bi_size: std::mem::size_of::<BitmapInfoHeader>() as u32,
            bi_width: width,
            bi_height: -height,
            bi_planes: 1,
            bi_bit_count: 32,
            bi_compression: 0,
            bi_size_image: 0,
            bi_x_pels_per_meter: 0,
            bi_y_pels_per_meter: 0,
            bi_clr_used: 0,
            bi_clr_important: 0,
        };
        let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
        let lines = GetDIBits(
            mem_dc,
            icon_info.hbm_color,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut c_void,
            &mut header,
            0,
        );
        DeleteDC(mem_dc);
        ReleaseDC(0, screen);
        DeleteObject(icon_info.hbm_color);
        if icon_info.hbm_mask != 0 {
            DeleteObject(icon_info.hbm_mask);
        }
        DestroyIcon(info.h_icon);

        if lines == 0 {
            return None;
        }

        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
        }

        encode_rgba_png_base64(width as u32, height as u32, &pixels)
    }
}

fn encode_rgba_png_base64(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut encoder = png::Encoder::new(&mut cursor, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().ok()?;
    writer.write_image_data(rgba).ok()?;
    drop(writer);
    Some(base64_encode(&cursor.into_inner()))
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut index = 0;
    while index + 3 <= data.len() {
        let n = ((data[index] as u32) << 16)
            | ((data[index + 1] as u32) << 8)
            | (data[index + 2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        index += 3;
    }
    if index < data.len() {
        let remain = data.len() - index;
        let mut n = (data[index] as u32) << 16;
        if remain == 2 {
            n |= (data[index + 1] as u32) << 8;
        }
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if remain == 2 {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
            out.push('=');
        } else {
            out.push('=');
            out.push('=');
        }
    }
    out
}

// Защита от завершения критичных узлов (System Idle, System) и самого NEXUS PC
fn guard_process_pid(pid: u32) -> Result<(), String> {
    if pid == 0 || pid == 4 {
        return Err("Системный процесс Windows защищён от изменения".to_string());
    }
    if pid == std::process::id() {
        return Err("Нельзя применить действие к самому NEXUS PC".to_string());
    }
    Ok(())
}

#[tauri::command]
fn kill_process(pid: u32, tree: bool) -> Result<(), String> {
    guard_process_pid(pid)?;

    let pid_str = pid.to_string();
    let mut cmd = Command::new("taskkill");
    if tree {
        cmd.args(["/F", "/T", "/PID", &pid_str]);
    } else {
        cmd.args(["/F", "/PID", &pid_str]);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("Не удалось вызвать taskkill: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() { stderr } else { stdout };
        Err(if details.is_empty() {
            format!(
                "Не удалось завершить процесс PID {} (код {:?}). Возможно, требуются права Администратора",
                pid,
                output.status.code()
            )
        } else {
            details
        })
    }
}

// Минимальный FFI к kernel32 для динамической загрузки NtSuspendProcess / NtResumeProcess из ntdll.dll
#[cfg(target_os = "windows")]
mod win_process_ffi {
    use std::ffi::c_void;

    pub type Handle = *mut c_void;
    pub const PROCESS_SUSPEND_RESUME: u32 = 0x0800;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        pub fn CloseHandle(handle: Handle) -> i32;
        pub fn GetModuleHandleW(module_name: *const u16) -> Handle;
        pub fn GetProcAddress(module: Handle, proc_name: *const u8) -> *mut c_void;
        pub fn GetLastError() -> u32;
    }

    pub type NtProcessFn = unsafe extern "system" fn(process_handle: Handle) -> i32;
}

#[tauri::command]
fn suspend_process(pid: u32, suspend: bool) -> Result<(), String> {
    guard_process_pid(pid)?;

    #[cfg(target_os = "windows")]
    {
        use win_process_ffi::*;

        let ntdll_name: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
        let fn_name: &[u8] = if suspend {
            b"NtSuspendProcess\0"
        } else {
            b"NtResumeProcess\0"
        };

        unsafe {
            let ntdll = GetModuleHandleW(ntdll_name.as_ptr());
            if ntdll.is_null() {
                return Err("Не удалось получить дескриптор ntdll.dll".to_string());
            }

            let proc_addr = GetProcAddress(ntdll, fn_name.as_ptr());
            if proc_addr.is_null() {
                return Err("Функция NtSuspendProcess/NtResumeProcess недоступна".to_string());
            }
            let nt_fn: NtProcessFn = std::mem::transmute(proc_addr);

            let handle = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
            if handle.is_null() {
                let err = GetLastError();
                return Err(format!(
                    "Нет доступа к процессу PID {} (Win32 код {}). Запустите NEXUS PC от имени Администратора",
                    pid, err
                ));
            }

            let status = nt_fn(handle);
            CloseHandle(handle);

            if status < 0 {
                return Err(format!(
                    "{} завершился с NTSTATUS 0x{:08X}",
                    if suspend { "NtSuspendProcess" } else { "NtResumeProcess" },
                    status as u32
                ));
            }
        }

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = suspend;
        Err("Заморозка процессов поддерживается только в Windows".to_string())
    }
}

fn tcp_state_name(state: u32) -> &'static str {
    match state {
        1 => "CLOSED",
        2 => "LISTEN",
        3 => "SYN_SENT",
        4 => "SYN_RCVD",
        5 => "ESTABLISHED",
        6 => "FIN_WAIT1",
        7 => "FIN_WAIT2",
        8 => "CLOSE_WAIT",
        9 => "CLOSING",
        10 => "LAST_ACK",
        11 => "TIME_WAIT",
        12 => "DELETE_TCB",
        _ => "UNKNOWN",
    }
}

fn read_u32(buf: &[u8], offset: usize) -> Option<u32> {
    let bytes: [u8; 4] = buf.get(offset..offset + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(bytes))
}

fn port_from_net_dword(value: u32) -> u16 {
    let low = (value & 0xFF) as u16;
    let high = ((value >> 8) & 0xFF) as u16;
    (low << 8) | high
}

fn ipv4_from_dword(addr: u32) -> String {
    format!(
        "{}.{}.{}.{}",
        addr & 0xFF,
        (addr >> 8) & 0xFF,
        (addr >> 16) & 0xFF,
        (addr >> 24) & 0xFF
    )
}

fn format_socket(ip: &str, port: u16, ipv6: bool) -> String {
    let unspecified = (!ipv6 && ip == "0.0.0.0" && port == 0) || (ipv6 && ip == "::" && port == 0);
    if unspecified {
        return "*:*".to_string();
    }
    if ipv6 {
        format!("[{}]:{}", ip, port)
    } else {
        format!("{}:{}", ip, port)
    }
}

#[cfg(target_os = "windows")]
fn query_iphlp_table(mut call: impl FnMut(*mut u8, *mut u32) -> u32) -> Result<Vec<u8>, String> {
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    let mut size = 0u32;
    let first = call(std::ptr::null_mut(), &mut size);
    if first == 0 || size == 0 {
        return Ok(Vec::new());
    }
    if first != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!("Таблица сокетов недоступна (код {})", first));
    }

    for _ in 0..4 {
        let mut buffer = vec![0u8; size as usize];
        let mut needed = size;
        let code = call(buffer.as_mut_ptr(), &mut needed);
        if code == 0 {
            return Ok(buffer);
        }
        if code == ERROR_INSUFFICIENT_BUFFER && needed > size {
            size = needed;
            continue;
        }
        return Err(format!("Не удалось прочитать таблицу сокетов (код {})", code));
    }
    Err("Не удалось выделить буфер таблицы сокетов".to_string())
}

#[cfg(target_os = "windows")]
fn collect_socket_rows() -> Result<Vec<(String, String, String, String, u32)>, String> {
    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn GetExtendedTcpTable(
            table: *mut u8,
            size: *mut u32,
            order: i32,
            family: u32,
            table_class: i32,
            reserved: u32,
        ) -> u32;
        fn GetExtendedUdpTable(
            table: *mut u8,
            size: *mut u32,
            order: i32,
            family: u32,
            table_class: i32,
            reserved: u32,
        ) -> u32;
    }

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const TCP_TABLE_OWNER_PID_ALL: i32 = 5;
    const UDP_TABLE_OWNER_PID: i32 = 1;

    let mut rows = Vec::new();

    let tcp4 = query_iphlp_table(|ptr, size| unsafe {
        GetExtendedTcpTable(ptr, size, 1, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0)
    })?;
    if tcp4.len() >= 4 {
        let count = read_u32(&tcp4, 0).unwrap_or(0) as usize;
        for index in 0..count {
            let offset = 4 + index * 24;
            let Some(state) = read_u32(&tcp4, offset) else { break };
            let Some(local_addr) = read_u32(&tcp4, offset + 4) else { break };
            let Some(local_port) = read_u32(&tcp4, offset + 8) else { break };
            let Some(remote_addr) = read_u32(&tcp4, offset + 12) else { break };
            let Some(remote_port) = read_u32(&tcp4, offset + 16) else { break };
            let Some(pid) = read_u32(&tcp4, offset + 20) else { break };
            let local_ip = ipv4_from_dword(local_addr);
            let remote_ip = ipv4_from_dword(remote_addr);
            rows.push((
                "TCP".to_string(),
                format_socket(&local_ip, port_from_net_dword(local_port), false),
                format_socket(&remote_ip, port_from_net_dword(remote_port), false),
                tcp_state_name(state).to_string(),
                pid,
            ));
        }
    }

    let tcp6 = query_iphlp_table(|ptr, size| unsafe {
        GetExtendedTcpTable(ptr, size, 1, AF_INET6, TCP_TABLE_OWNER_PID_ALL, 0)
    })?;
    if tcp6.len() >= 4 {
        let count = read_u32(&tcp6, 0).unwrap_or(0) as usize;
        for index in 0..count {
            let offset = 4 + index * 56;
            if offset + 56 > tcp6.len() {
                break;
            }
            let local_raw: [u8; 16] = tcp6[offset..offset + 16].try_into().unwrap_or([0; 16]);
            let remote_raw: [u8; 16] = tcp6[offset + 24..offset + 40].try_into().unwrap_or([0; 16]);
            let local_port = read_u32(&tcp6, offset + 20).unwrap_or(0);
            let remote_port = read_u32(&tcp6, offset + 44).unwrap_or(0);
            let state = read_u32(&tcp6, offset + 48).unwrap_or(0);
            let pid = read_u32(&tcp6, offset + 52).unwrap_or(0);
            let local_ip = std::net::Ipv6Addr::from(local_raw).to_string();
            let remote_ip = std::net::Ipv6Addr::from(remote_raw).to_string();
            rows.push((
                "TCP".to_string(),
                format_socket(&local_ip, port_from_net_dword(local_port), true),
                format_socket(&remote_ip, port_from_net_dword(remote_port), true),
                tcp_state_name(state).to_string(),
                pid,
            ));
        }
    }

    let udp4 = query_iphlp_table(|ptr, size| unsafe {
        GetExtendedUdpTable(ptr, size, 1, AF_INET, UDP_TABLE_OWNER_PID, 0)
    })?;
    if udp4.len() >= 4 {
        let count = read_u32(&udp4, 0).unwrap_or(0) as usize;
        for index in 0..count {
            let offset = 4 + index * 12;
            let Some(local_addr) = read_u32(&udp4, offset) else { break };
            let Some(local_port) = read_u32(&udp4, offset + 4) else { break };
            let Some(pid) = read_u32(&udp4, offset + 8) else { break };
            rows.push((
                "UDP".to_string(),
                format_socket(&ipv4_from_dword(local_addr), port_from_net_dword(local_port), false),
                "*:*".to_string(),
                "—".to_string(),
                pid,
            ));
        }
    }

    let udp6 = query_iphlp_table(|ptr, size| unsafe {
        GetExtendedUdpTable(ptr, size, 1, AF_INET6, UDP_TABLE_OWNER_PID, 0)
    })?;
    if udp6.len() >= 4 {
        let count = read_u32(&udp6, 0).unwrap_or(0) as usize;
        for index in 0..count {
            let offset = 4 + index * 28;
            if offset + 28 > udp6.len() {
                break;
            }
            let local_raw: [u8; 16] = udp6[offset..offset + 16].try_into().unwrap_or([0; 16]);
            let local_port = read_u32(&udp6, offset + 20).unwrap_or(0);
            let pid = read_u32(&udp6, offset + 24).unwrap_or(0);
            rows.push((
                "UDP".to_string(),
                format_socket(
                    &std::net::Ipv6Addr::from(local_raw).to_string(),
                    port_from_net_dword(local_port),
                    true,
                ),
                "*:*".to_string(),
                "—".to_string(),
                pid,
            ));
        }
    }

    Ok(rows)
}

#[cfg(not(target_os = "windows"))]
fn collect_socket_rows() -> Result<Vec<(String, String, String, String, u32)>, String> {
    Err("Таблица сокетов доступна только в Windows".to_string())
}

#[tauri::command]
fn start_drop_session(state: State<'_, AppState>) -> Result<drop_server::DropSessionInfo, String> {
    state.drop_hub.start()
}

#[tauri::command]
fn stop_drop_session(state: State<'_, AppState>) -> Result<(), String> {
    state.drop_hub.stop()
}

#[tauri::command]
fn get_drop_session(state: State<'_, AppState>) -> Result<drop_server::DropSessionInfo, String> {
    Ok(state.drop_hub.session())
}

#[tauri::command]
fn get_drop_history(state: State<'_, AppState>) -> Result<Vec<drop_server::DroppedFileItem>, String> {
    Ok(state.drop_hub.history())
}

#[tauri::command]
fn get_drop_texts(state: State<'_, AppState>) -> Result<Vec<drop_server::DropTextItem>, String> {
    Ok(state.drop_hub.texts())
}

#[tauri::command]
fn open_drop_folder(state: State<'_, AppState>) -> Result<(), String> {
    state.drop_hub.open_folder()
}

#[tauri::command]
fn get_network_connections(state: State<'_, AppState>) -> Result<Vec<NetworkConnection>, String> {
    let sockets = collect_socket_rows()?;

    let mut names: HashMap<u32, (String, String)> = HashMap::new();
    {
        let mut sys = state
            .sys
            .lock()
            .map_err(|_| "Системный монитор заблокирован".to_string())?;
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        for process in sys.processes().values() {
            names.insert(
                process.pid().as_u32(),
                (
                    process.name().to_string_lossy().to_string(),
                    process
                        .exe()
                        .map(|path| path.to_string_lossy().to_string())
                        .unwrap_or_default(),
                ),
            );
        }
    }

    let mut icon_memo: HashMap<String, Option<String>> = HashMap::new();
    let mut connections = Vec::with_capacity(sockets.len());
    for (protocol, local_addr, remote_addr, socket_state, pid) in sockets {
        let (process_name, exe_path) = names
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| ("Неизвестно".to_string(), String::new()));
        let icon_base64 = if exe_path.is_empty() {
            None
        } else {
            icon_memo
                .entry(exe_path.clone())
                .or_insert_with(|| cached_process_icon(&state.icon_cache, &exe_path))
                .clone()
        };
        connections.push(NetworkConnection {
            protocol,
            local_addr,
            remote_addr,
            state: socket_state,
            pid,
            process_name,
            icon_base64,
        });
    }

    Ok(connections)
}

fn hwnd_to_isize<T: Copy>(hwnd: T) -> isize {
    assert_eq!(std::mem::size_of::<T>(), std::mem::size_of::<isize>());
    unsafe { std::mem::transmute_copy(&hwnd) }
}

#[cfg(target_os = "windows")]
fn apply_dwm_rounded_corners(hwnd: isize) {
    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const u32, size: u32)
            -> i32;
    }

    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;
    let preference = DWMWCP_ROUND;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_dwm_rounded_corners(_hwnd: isize) {}

fn start_background_services(
    sys: Arc<Mutex<System>>,
    networks: Arc<Mutex<Networks>>,
    disk_space: Arc<Mutex<(u64, u64)>>,
    hw_telemetry: Arc<Mutex<Option<HardwareTelemetry>>>,
    hw_sidecar_child: Arc<Mutex<Option<Child>>>,
) {
    std::thread::spawn(move || {
        spawn_hwmon_sidecar(hw_telemetry, Arc::clone(&hw_sidecar_child));
        if let Ok(mut guard) = sys.lock() {
            guard.refresh_cpu_usage();
        }
        std::thread::sleep(Duration::from_millis(180));
        if let Ok(mut guard) = sys.lock() {
            guard.refresh_cpu_usage();
            guard.refresh_memory();
        }
        if let Ok(mut guard) = networks.lock() {
            guard.refresh(true);
        }
        loop {
            let disks = Disks::new_with_refreshed_list();
            let sample = disks
                .first()
                .map(|disk| {
                    (
                        disk.available_space() / 1024 / 1024 / 1024,
                        disk.total_space() / 1024 / 1024 / 1024,
                    )
                })
                .unwrap_or((0, 0));
            if let Ok(mut slot) = disk_space.lock() {
                *slot = sample;
            }
            std::thread::sleep(Duration::from_secs(8));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sys = Arc::new(Mutex::new(System::new()));
    let networks = Arc::new(Mutex::new(Networks::new()));
    let disk_space = Arc::new(Mutex::new((0u64, 0u64)));
    let hw_telemetry = Arc::new(Mutex::new(None));
    let hw_sidecar_child = Arc::new(Mutex::new(None));

    start_background_services(
        Arc::clone(&sys),
        Arc::clone(&networks),
        Arc::clone(&disk_space),
        Arc::clone(&hw_telemetry),
        Arc::clone(&hw_sidecar_child),
    );

    let child_for_exit = Arc::clone(&hw_sidecar_child);

    tauri::Builder::default()
        .manage(AppState {
            sys,
            networks,
            disk_space,
            ping_cache: Mutex::new((0, None)),
            process_last_refresh: Mutex::new(None),
            hw_telemetry,
            hw_sidecar_child,
            icon_cache: Mutex::new(HashMap::new()),
            drop_hub: Arc::new(drop_server::DropHub::new()),
            tray_ping_item: Mutex::new(None),
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                if let Ok(hwnd) = window.hwnd() {
                    apply_dwm_rounded_corners(hwnd_to_isize(hwnd));
                }
            }

            let ping_item = tauri::menu::MenuItem::with_id(app, "ping", "Ping: —", false, None::<&str>)?;
            let title_item = tauri::menu::MenuItem::with_id(app, "title", "NEXUS PC", false, None::<&str>)?;
            let show_item = tauri::menu::MenuItem::with_id(app, "show", "Показать окно", true, None::<&str>)?;
            let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&title_item, &ping_item, &show_item, &quit_item])?;
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut slot) = state.tray_ping_item.lock() {
                    *slot = Some(ping_item);
                }
            }
            if let Some(icon) = app.default_window_icon() {
                let _tray = tauri::tray::TrayIconBuilder::with_id("nexus")
                    .icon(icon.clone())
                    .tooltip("NEXUS PC")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => reveal_main_window(app),
                        "quit" => {
                            if let Some(state) = app.try_state::<AppState>() {
                                if let Ok(mut guard) = state.hw_sidecar_child.lock() {
                                    if let Some(mut child) = guard.take() {
                                        let _ = child.kill();
                                    }
                                }
                            }
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| match event {
                        tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            position,
                            ..
                        } => toggle_tray_hud(tray.app_handle(), position.x, position.y),
                        tauri::tray::TrayIconEvent::DoubleClick {
                            button: tauri::tray::MouseButton::Left,
                            ..
                        } => reveal_main_window(tray.app_handle()),
                        _ => {}
                    })
                    .build(app)?;
            }
            Ok(())
        })
        .on_window_event(move |window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            tauri::WindowEvent::Destroyed => {
                if window.label() == "main" {
                    if let Ok(mut guard) = child_for_exit.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_system_metrics,
            schedule_shutdown,
            cancel_shutdown,
            get_startup_items,
            toggle_startup_item,
            remove_startup_entry,
            open_item_location,
            get_available_drives,
            scan_storage,
            get_hardware_telemetry,
            is_elevated_admin,
            restart_as_admin,
            app_exit,
            flush_dns,
            probe_game_routes,
            get_packet_priority,
            set_packet_priority,
            tune_ethernet_adapter,
            get_ethernet_tuned,
            set_ethernet_tuned,
            scan_cleanup_targets,
            execute_cleanup,
            get_process_list,
            kill_process,
            suspend_process,
            get_network_connections,
            start_drop_session,
            stop_drop_session,
            get_drop_session,
            get_drop_history,
            get_drop_texts,
            open_drop_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
