use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UserScript {
    pub id: String,
    pub title: String,
    pub script_type: String,
    pub content: String,
    pub updated_at: u64,
}

static SCRIPTS_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn now_epoch_sec() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn nexus_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.is_empty() {
            return PathBuf::from(appdata).join("nexus");
        }
    }
    PathBuf::from("nexus-data")
}

fn scripts_path() -> PathBuf {
    nexus_dir().join("scripts.json")
}

fn ensure_dir() -> Result<(), String> {
    fs::create_dir_all(nexus_dir())
        .map_err(|err| format!("Не удалось создать директорию скриптов: {err}"))
}

fn normalize_type(script_type: &str) -> String {
    match script_type.trim().to_ascii_lowercase().as_str() {
        "powershell" | "ps1" => "powershell".to_string(),
        "cmd" | "bat" | "batch" => "cmd".to_string(),
        "vbs" | "vbscript" => "vbs".to_string(),
        "text" | "txt" => "text".to_string(),
        _ => "powershell".to_string(),
    }
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
        },
        UserScript {
            id: "preset-cmd-netreset".to_string(),
            title: "Сброс DNS и проверка сетевых сокетов".to_string(),
            script_type: "cmd".to_string(),
            content: "@echo off\nipconfig /flushdns\necho.\nnetstat -e".to_string(),
            updated_at: ts.saturating_sub(60),
        },
    ]
}

fn read_scripts_sync() -> Result<Vec<UserScript>, String> {
    let _guard = SCRIPTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = scripts_path();
    if !path.exists() {
        let starters = default_starter_scripts();
        let _ = write_scripts_unlocked(&starters);
        return Ok(starters);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Ошибка чтения файла scripts.json: {err}"))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut scripts: Vec<UserScript> = serde_json::from_str(&raw)
        .map_err(|err| format!("Ошибка разбора JSON в scripts.json: {err}"))?;
    scripts.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(scripts)
}

fn write_scripts_unlocked(scripts: &[UserScript]) -> Result<(), String> {
    ensure_dir()?;
    let json = serde_json::to_string_pretty(scripts)
        .map_err(|err| format!("Ошибка сериализации скриптов: {err}"))?;
    let path = scripts_path();
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, json).map_err(|err| format!("Ошибка записи scripts.json.tmp: {err}"))?;
    fs::rename(&tmp_path, &path).or_else(|_| {
        fs::copy(&tmp_path, &path)
            .map(|_| {
                let _ = fs::remove_file(&tmp_path);
            })
            .map_err(|err| format!("Ошибка сохранения scripts.json: {err}"))
    })
}

fn save_script_sync(mut script: UserScript) -> Result<(), String> {
    let _guard = SCRIPTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = scripts_path();
    let mut list: Vec<UserScript> = if path.exists() {
        let raw = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        default_starter_scripts()
    };

    if script.id.trim().is_empty() {
        script.id = format!("script-{}", now_epoch_sec());
    }
    if script.title.trim().is_empty() {
        script.title = "Без названия".to_string();
    }
    script.script_type = normalize_type(&script.script_type);
    script.updated_at = now_epoch_sec();

    if let Some(existing) = list.iter_mut().find(|item| item.id == script.id) {
        *existing = script;
    } else {
        list.push(script);
    }

    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    write_scripts_unlocked(&list)
}

fn delete_script_sync(id: &str) -> Result<(), String> {
    let _guard = SCRIPTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = scripts_path();
    if !path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Ошибка чтения scripts.json: {err}"))?;
    let mut list: Vec<UserScript> = serde_json::from_str(&raw).unwrap_or_default();
    list.retain(|item| item.id != id);
    write_scripts_unlocked(&list)
}

fn run_script_sync(id: &str, as_admin: bool) -> Result<String, String> {
    let scripts = read_scripts_sync()?;
    let script = scripts
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "Скрипт не найден. Сохраните скрипт перед запуском.".to_string())?;

    let kind = normalize_type(&script.script_type);
    if kind == "text" {
        return Ok("[INFO] Текстовая заметка (TXT) не предназначена для выполнения интерпретатором.".to_string());
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
        return run_elevated_via_powershell(&temp_dir, &token, &kind, &script.content);
    }

    let output = match kind.as_str() {
        "powershell" => {
            let file_path = temp_dir.join(format!("{token}.ps1"));
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            let wrapped = format!(
                "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n$OutputEncoding = [System.Text.Encoding]::UTF8\r\n{}",
                script.content
            );
            bytes.extend_from_slice(wrapped.as_bytes());
            fs::write(&file_path, bytes)
                .map_err(|err| format!("Не удалось подготовить временный PS1 файл: {err}"))?;

            let mut cmd = Command::new("powershell.exe");
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&file_path);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let res = cmd.output();
            let _ = fs::remove_file(&file_path);
            res.map_err(|err| format!("Ошибка запуска powershell.exe: {err}"))?
        }
        "cmd" => {
            let file_path = temp_dir.join(format!("{token}.cmd"));
            let body = format!("@chcp 65001 >nul\r\n{}", script.content.replace('\n', "\r\n"));
            fs::write(&file_path, body.as_bytes())
                .map_err(|err| format!("Не удалось подготовить временный CMD файл: {err}"))?;

            let mut cmd = Command::new("cmd.exe");
            cmd.args(["/d", "/c"]).arg(&file_path);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let res = cmd.output();
            let _ = fs::remove_file(&file_path);
            res.map_err(|err| format!("Ошибка запуска cmd.exe: {err}"))?
        }
        "vbs" => {
            let file_path = temp_dir.join(format!("{token}.vbs"));
            fs::write(&file_path, script.content.as_bytes())
                .map_err(|err| format!("Не удалось подготовить временный VBS файл: {err}"))?;

            let mut cmd = Command::new("cscript.exe");
            cmd.args(["//NoLogo", "//U"]).arg(&file_path);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let res = cmd.output();
            let _ = fs::remove_file(&file_path);
            res.map_err(|err| format!("Ошибка запуска cscript.exe: {err}"))?
        }
        _ => return Err("Неподдерживаемый тип скрипта".to_string()),
    };

    format_process_output(&kind, &output)
}

fn format_process_output(kind: &str, output: &std::process::Output) -> Result<String, String> {
    let stdout = decode_output_bytes(kind, &output.stdout);
    let stderr = decode_output_bytes(kind, &output.stderr);
    let code = output.status.code().unwrap_or(-1);

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
    if combined.is_empty() {
        combined = format!("[EXIT CODE {code}] Скрипт завершён без текстового вывода.");
    } else if code != 0 {
        combined.push_str(&format!("\n\n[EXIT CODE {code}]"));
    }
    Ok(combined)
}

fn decode_output_bytes(kind: &str, bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if kind == "vbs" && bytes.len() >= 2 && bytes.len() % 2 == 0 {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let decoded = String::from_utf16_lossy(&u16s);
        let trimmed = decoded.trim_start_matches('\u{feff}');
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    String::from_utf8_lossy(bytes).to_string()
}

fn run_elevated_via_powershell(
    temp_dir: &PathBuf,
    token: &str,
    kind: &str,
    content: &str,
) -> Result<String, String> {
    let out_log = temp_dir.join(format!("{token}_out.log"));
    let err_log = temp_dir.join(format!("{token}_err.log"));
    let ext = match kind {
        "cmd" => "cmd",
        "vbs" => "vbs",
        _ => "ps1",
    };
    let script_file = temp_dir.join(format!("{token}.{ext}"));

    match kind {
        "powershell" => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(content.as_bytes());
            fs::write(&script_file, bytes).map_err(|e| e.to_string())?;
        }
        "cmd" => {
            let body = format!("@chcp 65001 >nul\r\n{}", content.replace('\n', "\r\n"));
            fs::write(&script_file, body.as_bytes()).map_err(|e| e.to_string())?;
        }
        "vbs" => {
            fs::write(&script_file, content.as_bytes()).map_err(|e| e.to_string())?;
        }
        _ => {}
    }

    let wrapper_ps1 = temp_dir.join(format!("{token}_elevated_wrapper.ps1"));
    let wrapper_body = match kind {
        "powershell" => format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n& '{}' > '{}' 2> '{}'",
            script_file.display().to_string().replace('\'', "''"),
            out_log.display().to_string().replace('\'', "''"),
            err_log.display().to_string().replace('\'', "''"),
        ),
        "cmd" => format!(
            "cmd.exe /d /c \"`\"{}\"`\" > `\"{}\"`\" 2> `\"{}\"`\"\"",
            script_file.display(),
            out_log.display(),
            err_log.display(),
        ),
        "vbs" => format!(
            "cscript.exe //NoLogo '{}' > '{}' 2> '{}'",
            script_file.display().to_string().replace('\'', "''"),
            out_log.display().to_string().replace('\'', "''"),
            err_log.display().to_string().replace('\'', "''"),
        ),
        _ => String::new(),
    };

    let mut wrapper_bytes = vec![0xEF, 0xBB, 0xBF];
    wrapper_bytes.extend_from_slice(wrapper_body.as_bytes());
    fs::write(&wrapper_ps1, wrapper_bytes).map_err(|e| e.to_string())?;

    let launch_cmd = format!(
        "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','{}' -Verb RunAs -Wait",
        wrapper_ps1.display().to_string().replace('\'', "''")
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

    let status_res = cmd.output();
    let stdout_str = fs::read_to_string(&out_log).unwrap_or_default();
    let stderr_str = fs::read_to_string(&err_log).unwrap_or_default();

    let _ = fs::remove_file(&script_file);
    let _ = fs::remove_file(&wrapper_ps1);
    let _ = fs::remove_file(&out_log);
    let _ = fs::remove_file(&err_log);

    let output = status_res.map_err(|e| format!("Не удалось запросить права Администратора (UAC): {e}"))?;
    if !output.status.success() && stdout_str.trim().is_empty() && stderr_str.trim().is_empty() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if msg.is_empty() {
            "Запуск от имени Администратора был отменён в окне UAC.".to_string()
        } else {
            msg
        });
    }

    let mut combined = String::new();
    if !stdout_str.trim().is_empty() {
        combined.push_str(stdout_str.trim_end());
    }
    if !stderr_str.trim().is_empty() {
        if !combined.is_empty() {
            combined.push_str("\n\n");
        }
        combined.push_str("[STDERR]\n");
        combined.push_str(stderr_str.trim_end());
    }
    if combined.is_empty() {
        combined = "[ADMIN OK] Скрипт выполнен с правами Администратора (без консольного вывода).".to_string();
    }
    Ok(combined)
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
    tauri::async_runtime::spawn_blocking(move || run_script_sync(&id, as_admin))
        .await
        .map_err(|err| format!("Ошибка потока выполнения скрипта: {err}"))?
}
