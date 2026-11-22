use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub const MAX_SCRIPT_OUTPUT_BYTES: usize = 256 * 1024;
pub const DEFAULT_SCRIPT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UserScript {
    pub id: String,
    pub title: String,
    pub script_type: String,
    pub content: String,
    pub updated_at: u64,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize)]
pub struct ScriptRunResult {
    output: String,
    exit_code: Option<i32>,
    timed_out: bool,
    skipped: bool,
}

static SCRIPTS_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn now_epoch_sec() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn normalize_type(script_type: &str) -> Result<String, String> {
    let kind = match script_type.trim().to_ascii_lowercase().as_str() {
        "powershell" | "ps1" => "powershell",
        "cmd" | "bat" | "batch" => "cmd",
        "vbs" | "vbscript" => "vbs",
        "text" | "txt" => "text",
        _ => return Err(format!("Неподдерживаемый тип скрипта: {script_type}")),
    };
    Ok(kind.to_string())
}

fn default_starter_scripts() -> Vec<UserScript> {
    let ts = now_epoch_sec();
    vec![
        UserScript {
            id: "preset-ps-sysinfo".to_string(),
            title: "Диагностика системы и аптайма".to_string(),
            script_type: "powershell".to_string(),
            content: "$os = Get-CimInstance Win32_OperatingSystem\n$up = (Get-Date) - $os.LastBootUpTime\nWrite-Output \"OS: $($os.Caption) ($($os.Version))\"\nWrite-Output (\"Uptime: {0}d {1}h {2}m\" -f $up.Days, $up.Hours, $up.Minutes)\nGet-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 Name, Id, @{N='RAM_MB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize".to_string(),
            updated_at: ts,
            extra: Default::default(),
        },
        UserScript {
            id: "preset-cmd-netreset".to_string(),
            title: "Сброс DNS и проверка сетевых сокетов".to_string(),
            script_type: "cmd".to_string(),
            content: "@echo off\nipconfig /flushdns\necho.\nnetstat -e".to_string(),
            updated_at: ts.saturating_sub(60),
            extra: Default::default(),
        },
    ]
}

fn read_scripts_file(path: &Path) -> Result<Option<Vec<UserScript>>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Ошибка чтения файла scripts.json: {err}")),
    };
    if raw.trim().is_empty() {
        return Ok(Some(Vec::new()));
    }
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map(Some)
        .map_err(|err| format!("Повреждённый файл scripts.json оставлен без изменений: {err}"))
}

fn read_scripts_sync() -> Result<Vec<UserScript>, String> {
    let _guard = SCRIPTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = crate::profile::file("scripts.json")?;
    let mut scripts = match read_scripts_file(&path)? {
        Some(scripts) => scripts,
        None => {
            let starters = default_starter_scripts();
            write_scripts_unlocked(&path, &starters)?;
            starters
        }
    };
    scripts.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(scripts)
}

fn write_scripts_unlocked(path: &Path, scripts: &[UserScript]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Не удалось создать директорию скриптов: {err}"))?;
    }
    let json = serde_json::to_string_pretty(scripts)
        .map_err(|err| format!("Ошибка сериализации скриптов: {err}"))?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, json).map_err(|err| format!("Ошибка записи scripts.json.tmp: {err}"))?;
    fs::rename(&tmp_path, path).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        format!("Ошибка сохранения scripts.json: {err}")
    })
}

fn save_script_sync(script: UserScript) -> Result<(), String> {
    let _guard = SCRIPTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    save_script_unlocked(&crate::profile::file("scripts.json")?, script)
}

fn save_script_unlocked(path: &Path, mut script: UserScript) -> Result<(), String> {
    let mut list = read_scripts_file(path)?.unwrap_or_else(default_starter_scripts);

    if script.id.trim().is_empty() {
        script.id = format!("script-{}", now_epoch_sec());
    }
    if script.title.trim().is_empty() {
        script.title = "Без названия".to_string();
    }
    script.script_type = normalize_type(&script.script_type)?;
    script.updated_at = now_epoch_sec();

    if let Some(existing) = list.iter_mut().find(|item| item.id == script.id) {
        // The editor submits only the fields it understands.
        script.extra = std::mem::take(&mut existing.extra);
        *existing = script;
    } else {
        list.push(script);
    }

    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    write_scripts_unlocked(path, &list)
}

fn delete_script_sync(id: &str) -> Result<(), String> {
    let _guard = SCRIPTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    delete_script_unlocked(&crate::profile::file("scripts.json")?, id)
}

fn delete_script_unlocked(path: &Path, id: &str) -> Result<(), String> {
    let Some(mut list) = read_scripts_file(path)? else {
        return Ok(());
    };
    list.retain(|item| item.id != id);
    write_scripts_unlocked(path, &list)
}

struct TempFilesGuard(Vec<PathBuf>);

impl TempFilesGuard {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn track(&mut self, path: PathBuf) -> PathBuf {
        self.0.push(path.clone());
        path
    }
}

impl Drop for TempFilesGuard {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = fs::remove_file(p);
        }
    }
}

struct CapturedProcessResult {
    exit_code: Option<i32>,
    timed_out: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

fn read_stream_capped<R: Read>(mut reader: R, max_bytes: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut truncated = false;
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() < max_bytes {
                    let take = n.min(max_bytes - buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                    if take < n {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (buf, truncated)
}

fn read_file_capped(path: &Path, max_bytes: usize) -> (Vec<u8>, bool) {
    let Ok(file) = File::open(path) else {
        return (Vec::new(), false);
    };
    read_stream_capped(file, max_bytes)
}

fn terminate_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    if pid > 0 {
        let mut tk = Command::new("taskkill");
        tk.args(["/F", "/T", "/PID", &pid.to_string()]);
        tk.creation_flags(CREATE_NO_WINDOW);
        let _ = tk.output();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = pid;
}

fn run_command_with_timeout_and_limit(
    mut cmd: Command,
    timeout: Duration,
    max_bytes: usize,
    spawn_label: &str,
) -> Result<CapturedProcessResult, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("Ошибка запуска {spawn_label}: {err}"))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let out_handle = std::thread::spawn(move || {
        stdout_pipe
            .map(|p| read_stream_capped(p, max_bytes))
            .unwrap_or_else(|| (Vec::new(), false))
    });
    let err_handle = std::thread::spawn(move || {
        stderr_pipe
            .map(|p| read_stream_capped(p, max_bytes))
            .unwrap_or_else(|| (Vec::new(), false))
    });

    let started = Instant::now();
    let mut timed_out = false;
    let mut exit_status = None;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_status = Some(status);
                break;
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    timed_out = true;
                    let pid = child.id();
                    terminate_process_tree(pid);
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Ошибка ожидания {spawn_label}: {err}"));
            }
        }
    }

    let (stdout, stdout_truncated) = out_handle.join().unwrap_or_default();
    let (stderr, stderr_truncated) = err_handle.join().unwrap_or_default();

    Ok(CapturedProcessResult {
        exit_code: if timed_out {
            None
        } else {
            exit_status.and_then(|s| s.code())
        },
        timed_out,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    })
}

fn prepare_script_file(
    guard: &mut TempFilesGuard,
    temp_dir: &Path,
    token: &str,
    kind: &str,
    content: &str,
    with_utf8_preamble: bool,
) -> Result<PathBuf, String> {
    let ext = match kind {
        "cmd" => "cmd",
        "vbs" => "vbs",
        _ => "ps1",
    };
    let file_path = guard.track(temp_dir.join(format!("{token}.{ext}")));
    match kind {
        "powershell" => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            let body = if with_utf8_preamble {
                format!(
                    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n$OutputEncoding = [System.Text.Encoding]::UTF8\r\n{}",
                    content
                )
            } else {
                content.to_string()
            };
            bytes.extend_from_slice(body.as_bytes());
            fs::write(&file_path, bytes)
                .map_err(|err| format!("Не удалось подготовить временный PS1 файл: {err}"))?;
        }
        "cmd" => {
            let body = format!("@chcp 65001 >nul\r\n{}", content.replace('\n', "\r\n"));
            fs::write(&file_path, body.as_bytes())
                .map_err(|err| format!("Не удалось подготовить временный CMD файл: {err}"))?;
        }
        "vbs" => {
            fs::write(&file_path, content.as_bytes())
                .map_err(|err| format!("Не удалось подготовить временный VBS файл: {err}"))?;
        }
        _ => return Err("Неподдерживаемый тип скрипта".to_string()),
    }
    Ok(file_path)
}

fn execute_script_content_with_limits(
    temp_dir: &Path,
    token: &str,
    kind: &str,
    content: &str,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<CapturedProcessResult, String> {
    let _ = fs::create_dir_all(temp_dir);
    let mut guard = TempFilesGuard::new();
    let file_path = prepare_script_file(&mut guard, temp_dir, token, kind, content, true)?;

    let (mut cmd, label) = match kind {
        "powershell" => {
            let mut c = Command::new("powershell.exe");
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&file_path);
            (c, "powershell.exe")
        }
        "cmd" => {
            let mut c = Command::new("cmd.exe");
            c.args(["/d", "/c"]).arg(&file_path);
            (c, "cmd.exe")
        }
        "vbs" => {
            let mut c = Command::new("cscript.exe");
            c.args(["//NoLogo", "//U"]).arg(&file_path);
            (c, "cscript.exe")
        }
        _ => return Err("Неподдерживаемый тип скрипта".to_string()),
    };
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    run_command_with_timeout_and_limit(cmd, timeout, max_output_bytes, label)
}

fn format_captured_result(
    kind: &str,
    res: &CapturedProcessResult,
    elevated_label: bool,
    timeout: Duration,
    max_bytes: usize,
) -> String {
    let stdout = decode_output_bytes(kind, &res.stdout);
    let stderr = decode_output_bytes(kind, &res.stderr);

    let mut combined = String::new();
    if !stdout.trim().is_empty() {
        combined.push_str(stdout.trim_end());
    }
    if !stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push_str("\n\n");
        }
        combined.push_str("[STDERR]\n");
        combined.push_str(stderr.trim_end());
    }

    if res.stdout_truncated || res.stderr_truncated {
        if !combined.is_empty() {
            combined.push_str("\n\n");
        }
        combined.push_str(&format!(
            "[ВЫВОД УСЕЧЁН: превышен лимит {} КБ на поток]",
            max_bytes / 1024
        ));
    }

    if res.timed_out {
        if !combined.is_empty() {
            combined.push_str("\n\n");
        }
        combined.push_str(&format!(
            "[TIMEOUT] Скрипт превысил лимит времени ({} с) и был принудительно завершён.",
            timeout.as_secs().max(1)
        ));
        return combined;
    }

    match res.exit_code {
        Some(0) => {
            if combined.is_empty() {
                if elevated_label {
                    "[ADMIN OK · Код выхода: 0] Скрипт выполнен с правами Администратора (без консольного вывода).".to_string()
                } else {
                    "[EXIT CODE 0] Скрипт завершён без текстового вывода.".to_string()
                }
            } else {
                combined
            }
        }
        Some(code) => {
            if !combined.is_empty() {
                combined.push_str("\n\n");
            }
            if elevated_label {
                combined.push_str(&format!("[ОШИБКА · Администратор · Код выхода: {code}]"));
            } else {
                combined.push_str(&format!("[ОШИБКА · Код выхода: {code}]"));
            }
            combined
        }
        None => {
            if !combined.is_empty() {
                combined.push_str("\n\n");
            }
            combined.push_str("[ОШИБКА] Не удалось получить код завершения скрипта.");
            combined
        }
    }
}

fn to_run_result(
    kind: &str,
    captured: &CapturedProcessResult,
    elevated_label: bool,
    timeout: Duration,
    max_output_bytes: usize,
) -> ScriptRunResult {
    ScriptRunResult {
        output: format_captured_result(kind, captured, elevated_label, timeout, max_output_bytes),
        exit_code: captured.exit_code.filter(|_| !captured.timed_out),
        timed_out: captured.timed_out,
        skipped: false,
    }
}

fn run_script_sync(id: &str, as_admin: bool) -> Result<ScriptRunResult, String> {
    let scripts = read_scripts_sync()?;
    let script = scripts
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "Скрипт не найден. Сохраните скрипт перед запуском.".to_string())?;

    let kind = normalize_type(&script.script_type)?;
    if kind == "text" {
        return Ok(ScriptRunResult {
            output:
                "[INFO] Текстовая заметка (TXT) не предназначена для выполнения интерпретатором."
                    .to_string(),
            exit_code: None,
            timed_out: false,
            skipped: true,
        });
    }
    if script.content.trim().is_empty() {
        return Err("Тело скрипта пусто".to_string());
    }

    let temp_dir = std::env::temp_dir().join("nexus_scripts");
    let _ = fs::create_dir_all(&temp_dir);
    let safe_id: String = script
        .id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let token = format!(
        "{}_{}",
        if safe_id.is_empty() { "run" } else { &safe_id },
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    if as_admin && !crate::check_is_elevated_admin() {
        return run_elevated_via_powershell(
            &temp_dir,
            &token,
            &kind,
            &script.content,
            DEFAULT_SCRIPT_TIMEOUT,
            MAX_SCRIPT_OUTPUT_BYTES,
        );
    }

    let res = execute_script_content_with_limits(
        &temp_dir,
        &token,
        &kind,
        &script.content,
        DEFAULT_SCRIPT_TIMEOUT,
        MAX_SCRIPT_OUTPUT_BYTES,
    )?;
    Ok(to_run_result(
        &kind,
        &res,
        as_admin && crate::check_is_elevated_admin(),
        DEFAULT_SCRIPT_TIMEOUT,
        MAX_SCRIPT_OUTPUT_BYTES,
    ))
}

fn decode_output_bytes(kind: &str, bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let looks_utf16_le = bytes.starts_with(&[0xFF, 0xFE])
        || (kind == "vbs"
            && bytes.len() >= 2
            && bytes.len() % 2 == 0
            && bytes.iter().skip(1).step_by(2).any(|&b| b == 0));
    if looks_utf16_le {
        let slice = bytes.strip_prefix(&[0xFF, 0xFE]).unwrap_or(bytes);
        let u16s: Vec<u16> = slice
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let decoded = String::from_utf16_lossy(&u16s);
        let trimmed = decoded.trim_start_matches('\u{feff}');
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{feff}')
        .to_string()
}

fn ps_single_quote(text: &str) -> String {
    text.replace('\'', "''")
}

fn build_elevated_wrapper_body(
    kind: &str,
    script_file: &Path,
    out_log: &Path,
    err_log: &Path,
    exit_code_file: &Path,
    timeout: Duration,
) -> String {
    let script_sq = ps_single_quote(&script_file.display().to_string());
    let out_sq = ps_single_quote(&out_log.display().to_string());
    let err_sq = ps_single_quote(&err_log.display().to_string());
    let exit_sq = ps_single_quote(&exit_code_file.display().to_string());
    let timeout_ms = timeout.as_millis().clamp(1000, i32::MAX as u128) as i32;

    let (exe_literal, args_expr) = match kind {
        "cmd" => ("cmd.exe", format!("('/d /c \"' + '{script_sq}' + '\"')")),
        "vbs" => (
            "cscript.exe",
            format!("('//NoLogo //U \"' + '{script_sq}' + '\"')"),
        ),
        _ => (
            "powershell.exe",
            format!(
                "('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + '{script_sq}' + '\"')"
            ),
        ),
    };

    format!(
        "$ErrorActionPreference = 'Stop'\r\n\
         [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n\
         $OutputEncoding = [System.Text.Encoding]::UTF8\r\n\
         $__exitCode = 1\r\n\
         $__timedOut = $false\r\n\
         $__outFs = $null\r\n\
         $__errFs = $null\r\n\
         $__proc = $null\r\n\
         try {{\r\n\
           $__psi = New-Object System.Diagnostics.ProcessStartInfo\r\n\
           $__psi.FileName = '{exe_literal}'\r\n\
           $__psi.Arguments = {args_expr}\r\n\
           $__psi.UseShellExecute = $false\r\n\
           $__psi.CreateNoWindow = $true\r\n\
           $__psi.RedirectStandardOutput = $true\r\n\
           $__psi.RedirectStandardError = $true\r\n\
           $__proc = New-Object System.Diagnostics.Process\r\n\
           $__proc.StartInfo = $__psi\r\n\
           [void]$__proc.Start()\r\n\
           $__outFs = [System.IO.File]::Open('{out_sq}', [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)\r\n\
           $__errFs = [System.IO.File]::Open('{err_sq}', [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)\r\n\
           $__outTask = $__proc.StandardOutput.BaseStream.CopyToAsync($__outFs)\r\n\
           $__errTask = $__proc.StandardError.BaseStream.CopyToAsync($__errFs)\r\n\
           if (-not $__proc.WaitForExit({timeout_ms})) {{\r\n\
             $__timedOut = $true\r\n\
             try {{ cmd.exe /c ('taskkill /F /T /PID ' + $__proc.Id) | Out-Null }} catch {{}}\r\n\
             try {{ $__proc.Kill() }} catch {{}}\r\n\
             try {{ $__proc.WaitForExit(3000) | Out-Null }} catch {{}}\r\n\
             $__exitCode = 124\r\n\
           }} else {{\r\n\
             $__proc.WaitForExit()\r\n\
             $__exitCode = [int]$__proc.ExitCode\r\n\
           }}\r\n\
           try {{ $__outTask.Wait(3000) | Out-Null }} catch {{}}\r\n\
           try {{ $__errTask.Wait(3000) | Out-Null }} catch {{}}\r\n\
         }} catch {{\r\n\
           try {{ [System.IO.File]::AppendAllText('{err_sq}', ($_ | Out-String), [System.Text.Encoding]::UTF8) }} catch {{}}\r\n\
           $__exitCode = 1\r\n\
         }} finally {{\r\n\
           if ($null -ne $__outFs) {{ try {{ $__outFs.Dispose() }} catch {{}} }}\r\n\
           if ($null -ne $__errFs) {{ try {{ $__errFs.Dispose() }} catch {{}} }}\r\n\
           if ($null -ne $__proc) {{ try {{ $__proc.Dispose() }} catch {{}} }}\r\n\
           $__marker = if ($__timedOut) {{ 'TIMEOUT' }} else {{ [string]$__exitCode }}\r\n\
           try {{ [System.IO.File]::WriteAllText('{exit_sq}', $__marker, [System.Text.Encoding]::ASCII) }} catch {{}}\r\n\
         }}\r\n\
         exit $__exitCode\r\n"
    )
}

fn run_elevated_via_powershell(
    temp_dir: &PathBuf,
    token: &str,
    kind: &str,
    content: &str,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<ScriptRunResult, String> {
    let _ = fs::create_dir_all(temp_dir);
    let mut guard = TempFilesGuard::new();

    let out_log = guard.track(temp_dir.join(format!("{token}_out.log")));
    let err_log = guard.track(temp_dir.join(format!("{token}_err.log")));
    let exit_code_file = guard.track(temp_dir.join(format!("{token}_exit.code")));
    let script_file = prepare_script_file(&mut guard, temp_dir, token, kind, content, true)?;

    let wrapper_ps1 = guard.track(temp_dir.join(format!("{token}_elevated_wrapper.ps1")));
    let wrapper_body = build_elevated_wrapper_body(
        kind,
        &script_file,
        &out_log,
        &err_log,
        &exit_code_file,
        timeout,
    );

    let mut wrapper_bytes = vec![0xEF, 0xBB, 0xBF];
    wrapper_bytes.extend_from_slice(wrapper_body.as_bytes());
    fs::write(&wrapper_ps1, wrapper_bytes).map_err(|e| e.to_string())?;

    let launch_cmd = format!(
        "$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','{}' -Verb RunAs -Wait -PassThru; if ($null -ne $p) {{ exit $p.ExitCode }}",
        ps_single_quote(&wrapper_ps1.display().to_string())
    );

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &launch_cmd,
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    // Внешний таймаут slightly > внутреннего (даёт wrapper время завершить дочернее дерево и записать exit.code)
    let launcher_timeout = timeout.saturating_add(Duration::from_secs(30));
    let launcher_res = run_command_with_timeout_and_limit(
        cmd,
        launcher_timeout,
        max_output_bytes,
        "UAC PowerShell",
    )
    .map_err(|e| format!("Не удалось запросить права Администратора (UAC): {e}"))?;

    let exit_marker = fs::read_to_string(&exit_code_file).unwrap_or_default();
    let exit_trimmed = exit_marker.trim();
    let (stdout, stdout_truncated) = read_file_capped(&out_log, max_output_bytes);
    let (stderr, stderr_truncated) = read_file_capped(&err_log, max_output_bytes);

    if exit_trimmed.is_empty()
        && launcher_res.exit_code != Some(0)
        && stdout.is_empty()
        && stderr.is_empty()
    {
        if launcher_res.timed_out {
            return Err(
                "Превышено время ожидания запуска с правами Администратора (UAC).".to_string(),
            );
        }
        let msg = decode_output_bytes("powershell", &launcher_res.stderr);
        let msg_trimmed = msg.trim();
        return Err(if msg_trimmed.is_empty() {
            "Запуск от имени Администратора был отменён в окне UAC.".to_string()
        } else {
            msg_trimmed.to_string()
        });
    }

    let inner_timed_out = exit_trimmed.eq_ignore_ascii_case("TIMEOUT") || launcher_res.timed_out;
    let inner_exit_code = if inner_timed_out {
        None
    } else {
        exit_trimmed.parse::<i32>().ok()
    };

    let captured = CapturedProcessResult {
        exit_code: inner_exit_code,
        timed_out: inner_timed_out,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    };

    Ok(to_run_result(
        kind,
        &captured,
        true,
        timeout,
        max_output_bytes,
    ))
}

#[tauri::command]
pub async fn get_user_scripts() -> Result<Vec<UserScript>, String> {
    tauri::async_runtime::spawn_blocking(read_scripts_sync)
        .await
        .map_err(|err| format!("Ошибка потока чтения скриптов: {err}"))?
}

#[tauri::command]
pub async fn save_user_script(script: UserScript) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_script_sync(script))
        .await
        .map_err(|err| format!("Ошибка потока сохранения скрипта: {err}"))?
}

#[tauri::command]
pub async fn delete_user_script(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_script_sync(&id))
        .await
        .map_err(|err| format!("Ошибка потока удаления скрипта: {err}"))?
}

#[tauri::command]
pub async fn run_user_script(id: String, as_admin: bool) -> Result<String, String> {
    run_user_script_details(id, as_admin)
        .await
        .map(|result| result.output)
}

#[tauri::command]
pub async fn run_user_script_details(
    id: String,
    as_admin: bool,
) -> Result<ScriptRunResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_script_sync(&id, as_admin))
        .await
        .map_err(|err| format!("Ошибка потока выполнения скрипта: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "nexus_scripts_test_{tag}_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn script_mutations_preserve_malformed_library() {
        let mut files = TempFilesGuard::new();
        let path = files.track(test_temp_dir("invalid_library").with_extension("json"));
        let original = br#"[{"id":"keep-me""#;
        fs::write(&path, original).expect("write invalid library");
        let script = default_starter_scripts().remove(0);
        assert!(save_script_unlocked(&path, script).is_err());
        assert!(delete_script_unlocked(&path, "keep-me").is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn script_mutations_update_existing_library() {
        let mut files = TempFilesGuard::new();
        let path = files.track(test_temp_dir("existing_library").with_extension("json"));
        let mut starters = default_starter_scripts();
        starters[0].extra.insert("revision".into(), 42.into());
        write_scripts_unlocked(&path, &starters).expect("write a new library");
        let mut edited = starters.remove(0);
        edited.extra.clear();
        edited.title = "Edited title".to_string();
        save_script_unlocked(&path, edited.clone()).expect("replace the existing file");
        delete_script_unlocked(&path, &starters[0].id).expect("remove the other script");
        let remaining = read_scripts_file(&path).unwrap().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, edited.id);
        assert_eq!(remaining[0].title, edited.title);
        assert_eq!(remaining[0].extra["revision"], 42);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn script_result_metadata_does_not_depend_on_output_text() {
        let dir = test_temp_dir("metadata");
        let captured = execute_script_content_with_limits(
            &dir,
            "markers",
            "cmd",
            "@echo off\r\necho [TIMEOUT] printed intentionally\r\nexit /b 0",
            Duration::from_secs(10),
            MAX_SCRIPT_OUTPUT_BYTES,
        )
        .expect("run a script that prints a timeout marker");
        let result = to_run_result(
            "cmd",
            &captured,
            false,
            Duration::from_secs(10),
            MAX_SCRIPT_OUTPUT_BYTES,
        );
        assert!(result.output.contains("[TIMEOUT]"));
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
        assert!(!result.skipped);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn script_reports_nonzero_exit_code_and_never_fakes_admin_ok() {
        let dir = test_temp_dir("exitcode");
        let res = execute_script_content_with_limits(
            &dir,
            "nonzero",
            "cmd",
            "@echo off\r\necho fail_line\r\nexit /b 5",
            Duration::from_secs(10),
            MAX_SCRIPT_OUTPUT_BYTES,
        )
        .expect("execution captures exit code");
        assert_eq!(res.exit_code, Some(5));
        assert!(!res.timed_out);

        let text = format_captured_result(
            &"cmd",
            &res,
            true,
            Duration::from_secs(10),
            MAX_SCRIPT_OUTPUT_BYTES,
        );
        assert!(
            text.contains("Код выхода: 5"),
            "Expected exit code 5 in output: {text}"
        );
        assert!(
            !text.contains("[ADMIN OK]"),
            "Nonzero script must never emit [ADMIN OK]: {text}"
        );
        assert!(
            !dir.join("nonzero.cmd").exists(),
            "Temp script file must be cleaned up"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn script_caps_large_output_and_reports_truncation() {
        let dir = test_temp_dir("cap");
        let res = execute_script_content_with_limits(
            &dir,
            "spam",
            "powershell",
            "1..2000 | ForEach-Object { Write-Output 'NEXUS_LONG_LINE_0123456789' }",
            Duration::from_secs(15),
            4096,
        )
        .expect("large output script completes without deadlock");
        assert_eq!(res.exit_code, Some(0));
        assert!(res.stdout_truncated);
        assert!(res.stdout.len() <= 4096);

        let text = format_captured_result("powershell", &res, false, Duration::from_secs(15), 4096);
        assert!(text.contains("[ВЫВОД УСЕЧЁН"));
        assert!(!dir.join("spam.ps1").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn script_kills_hung_process_on_timeout_and_cleans_temp_files() {
        let dir = test_temp_dir("timeout");
        let started = Instant::now();
        let res = execute_script_content_with_limits(
            &dir,
            "hang",
            "powershell",
            "Write-Output 'started'; Start-Sleep -Seconds 30",
            Duration::from_millis(350),
            MAX_SCRIPT_OUTPUT_BYTES,
        )
        .expect("timed-out execution returns CapturedProcessResult");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "Hung script must be killed promptly"
        );
        assert!(res.timed_out);
        assert_eq!(res.exit_code, None);

        let text = format_captured_result(
            "powershell",
            &res,
            false,
            Duration::from_millis(350),
            MAX_SCRIPT_OUTPUT_BYTES,
        );
        assert!(text.contains("[TIMEOUT]"));
        assert!(
            !dir.join("hang.ps1").exists(),
            "Temp file must be deleted on timeout"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn elevated_wrapper_records_exit_code_marker_and_cleans_up() {
        let mut guard = TempFilesGuard::new();
        let dir = test_temp_dir("wrapper");
        fs::create_dir_all(&dir).unwrap();
        let script = guard.track(dir.join("inner.cmd"));
        let out_log = guard.track(dir.join("inner_out.log"));
        let err_log = guard.track(dir.join("inner_err.log"));
        let exit_code_file = guard.track(dir.join("inner_exit.code"));
        fs::write(
            &script,
            b"@echo off\r\necho elevated_check\r\nexit /b 7\r\n",
        )
        .unwrap();

        let wrapper_body = build_elevated_wrapper_body(
            "cmd",
            &script,
            &out_log,
            &err_log,
            &exit_code_file,
            Duration::from_secs(10),
        );
        let wrapper_ps1 = guard.track(dir.join("wrap.ps1"));
        fs::write(&wrapper_ps1, wrapper_body.as_bytes()).unwrap();

        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&wrapper_ps1);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let launcher = run_command_with_timeout_and_limit(
            cmd,
            Duration::from_secs(15),
            MAX_SCRIPT_OUTPUT_BYTES,
            "wrapper test",
        )
        .expect("wrapper executes");
        assert_eq!(launcher.exit_code, Some(7));
        let marker = fs::read_to_string(&exit_code_file).expect("exit code file written");
        assert_eq!(marker.trim(), "7");
        let out_text = fs::read_to_string(&out_log).unwrap_or_default();
        assert!(out_text.contains("elevated_check"));

        drop(guard);
        assert!(!script.exists());
        assert!(!out_log.exists());
        assert!(!err_log.exists());
        assert!(!exit_code_file.exists());
        assert!(!wrapper_ps1.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
