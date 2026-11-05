use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use sysinfo::{Disks, Networks, System};
use tauri::State;

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

// Структура данных телеметрии, которую мы отправляем в интерфейс
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
}

// Хранилище состояния sysinfo в памяти, чтобы не пересоздавать его каждую секунду
pub struct AppState {
    pub sys: Mutex<System>,
    pub networks: Mutex<Networks>,
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

// Извлечение чистого пути к исполняемому файлу из строки команды реестра
fn extract_clean_path(raw_command: &str) -> String {
    let expanded = expand_env_vars(raw_command.trim());
    if expanded.is_empty() {
        return String::new();
    }

    let candidate = if let Some(stripped) = expanded.strip_prefix('"') {
        if let Some(end_quote) = stripped.find('"') {
            stripped[..end_quote].trim().to_string()
        } else {
            stripped.trim().to_string()
        }
    } else {
        let lower = expanded.to_lowercase();
        let mut cut = None;
        for ext in [".exe", ".bat", ".cmd", ".com", ".msc"] {
            if let Some(pos) = lower.find(ext) {
                cut = Some(pos + ext.len());
                break;
            }
        }
        if let Some(end_idx) = cut {
            expanded[..end_idx].trim().to_string()
        } else {
            expanded
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim()
                .to_string()
        }
    };

    // Если указано только имя системного файла (например, SecurityHealthSystray.exe),
    // проверяем его наличие в System32 и папке Windows
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
fn read_registry_run_items(
    root: winreg::HKEY,
    subkey_path: &str,
    source_tag: &str,
    location_label: &str,
    enabled: bool,
    seen_ids: &mut HashSet<String>,
    items: &mut Vec<StartupItem>,
) {
    let hive = RegKey::predef(root);
    let Ok(key) = hive.open_subkey_with_flags(subkey_path, KEY_READ) else {
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
        let file_exists = !clean_path.is_empty() && Path::new(&clean_path).exists();

        items.push(StartupItem {
            id,
            name,
            command,
            clean_path,
            location: location_label.to_string(),
            enabled,
            file_exists,
        });
    }
}

fn scan_startup_folder(dir_path: &Path, items: &mut Vec<StartupItem>, seen_ids: &mut HashSet<String>) {
    let Ok(entries) = std::fs::read_dir(dir_path) else {
        return;
    };

    for entry_res in entries {
        let Ok(entry) = entry_res else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(file_name_os) = path.file_name() else {
            continue;
        };
        let file_name = file_name_os.to_string_lossy().to_string();

        // Пропускаем служебный файл Windows
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
        let file_exists = path.exists();

        items.push(StartupItem {
            id,
            name: display_name,
            command: actual_path_str.clone(),
            clean_path: actual_path_str,
            location: "Папка Автозагрузка".to_string(),
            enabled,
            file_exists,
        });
    }
}

#[tauri::command]
fn get_startup_items() -> Result<Vec<StartupItem>, String> {
    let mut items = Vec::new();
    let mut seen_ids = HashSet::new();

    #[cfg(target_os = "windows")]
    {
        // 1. Активные записи реестра
        read_registry_run_items(
            HKEY_CURRENT_USER,
            RUN_KEY_PATH,
            "HKCU_RUN",
            "HKCU (Реестр)",
            true,
            &mut seen_ids,
            &mut items,
        );
        read_registry_run_items(
            HKEY_LOCAL_MACHINE,
            RUN_KEY_PATH,
            "HKLM_RUN",
            "HKLM (Система)",
            true,
            &mut seen_ids,
            &mut items,
        );
        read_registry_run_items(
            HKEY_LOCAL_MACHINE,
            RUN_WOW64_KEY_PATH,
            "HKLM_WOW64_RUN",
            "HKLM (Система)",
            true,
            &mut seen_ids,
            &mut items,
        );

        // 2. Отключенные через NEXUS записи в HKCU\Software\Nexus\DisabledStartup
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
                source_tag,
                location_label,
                false,
                &mut seen_ids,
                &mut items,
            );
        }

        // Поддержка плоских значений непосредственно в HKCU\Software\Nexus\DisabledStartup
        read_registry_run_items(
            HKEY_CURRENT_USER,
            NEXUS_DISABLED_REG_BASE,
            "HKCU_RUN",
            "HKCU (Реестр)",
            false,
            &mut seen_ids,
            &mut items,
        );
    }

    // 3. Папки автозагрузки (Пользовательская и Общая)
    if let Ok(appdata) = std::env::var("APPDATA") {
        let user_startup: PathBuf = Path::new(&appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup");
        scan_startup_folder(&user_startup, &mut items, &mut seen_ids);
    }

    if let Ok(all_users) = std::env::var("ALLUSERSPROFILE") {
        let common_startup: PathBuf = Path::new(&all_users)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup");
        scan_startup_folder(&common_startup, &mut items, &mut seen_ids);
    }

    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(items)
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
            // Переносим из боевой ветки Run в HKCU\Software\Nexus\DisabledStartup\<source>
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
            // Возвращаем запись из HKCU\Software\Nexus\DisabledStartup\<source> обратно в Run
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

#[tauri::command]
fn open_item_location(path: String) -> Result<(), String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("Путь к файлу пуст".to_string());
    }

    let target_path = Path::new(trimmed);
    let mut cmd = Command::new("explorer.exe");

    if target_path.exists() {
        cmd.arg(format!("/select,{}", trimmed));
    } else if let Some(parent) = target_path.parent() {
        if parent.exists() {
            cmd.arg(parent.as_os_str());
        } else {
            return Err(format!("Файл и родительская папка не найдены: {}", trimmed));
        }
    } else {
        return Err(format!("Файл не найден на диске: {}", trimmed));
    }

    cmd.spawn()
        .map_err(|e| format!("Не удалось открыть Проводник Windows: {}", e))?;

    Ok(())
}

#[tauri::command]
fn get_system_metrics(state: State<'_, AppState>) -> SystemMetrics {
    let mut sys = state.sys.lock().unwrap();

    // Обновляем процессор и память (включая Swap)
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

    // Обновляем сетевые интерфейсы и считаем дельту трафика (КБ/с)
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

    // Читаем системный диск
    let disks = Disks::new_with_refreshed_list();
    let (disk_free_gb, disk_total_gb) = disks
        .first()
        .map(|d| {
            (
                d.available_space() / 1024 / 1024 / 1024,
                d.total_space() / 1024 / 1024 / 1024,
            )
        })
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
    }
}

#[tauri::command]
fn schedule_shutdown(seconds: u64, restart: bool) -> Result<(), String> {
    if seconds == 0 {
        return Err("Время таймера должно быть больше 0 секунд".to_string());
    }

    // Сначала отменяем предыдущий запланированный таймер (если он был),
    // чтобы избежать системной ошибки Windows 1190 при повторном запуске.
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

    // Код 1116 в Windows означает, что запланированного выключения уже нет
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut sys = System::new_all();
    sys.refresh_all(); // Первичный прогрев датчиков

    let networks = Networks::new_with_refreshed_list();

    tauri::Builder::default()
        .manage(AppState {
            sys: Mutex::new(sys),
            networks: Mutex::new(networks),
        })
        .invoke_handler(tauri::generate_handler![
            get_system_metrics,
            schedule_shutdown,
            cancel_shutdown,
            get_startup_items,
            toggle_startup_item,
            open_item_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
