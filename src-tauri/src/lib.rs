use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
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
}

// Структуры модуля Storage Analyzer (Анализатор накопителей)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub extension: String,
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

// Хранилище состояния приложения
pub struct AppState {
    pub sys: Mutex<System>,
    pub networks: Mutex<Networks>,
    pub ping_cache: Mutex<(u32, Option<Instant>)>,
    pub hw_telemetry: Arc<Mutex<Option<HardwareTelemetry>>>,
    pub hw_sidecar_child: Arc<Mutex<Option<Child>>>,
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

#[tauri::command]
fn open_item_location(path: String) -> Result<(), String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("Путь к файлу пуст".to_string());
    }

    let target_path = Path::new(trimmed);
    let mut cmd = Command::new("explorer.exe");

    if target_path.exists() {
        if target_path.is_dir() {
            cmd.arg(trimmed);
        } else {
            cmd.arg(format!("/select,{}", trimmed));
        }
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

// Многопоточное сканирование выбранного диска или папки через jwalk
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

        let mut total_scanned_bytes: u64 = 0;
        let mut total_files_count: u64 = 0;

        let mut top_heap: BinaryHeap<Reverse<(u64, String, String, String)>> =
            BinaryHeap::with_capacity(101);

        let mut cat_video: u64 = 0;
        let mut cat_games_soft: u64 = 0;
        let mut cat_archives: u64 = 0;
        let mut cat_audio: u64 = 0;
        let mut cat_docs: u64 = 0;
        let mut cat_other: u64 = 0;

        let mut level1_sizes: HashMap<String, u64> = HashMap::new();
        let mut level2_sizes: HashMap<(String, String), u64> = HashMap::new();
        let mut level3_sizes: HashMap<(String, String, String), u64> = HashMap::new();
        let mut root_direct_files_bytes: u64 = 0;

        let walker = jwalk::WalkDir::new(&root_path)
            .skip_hidden(false)
            .process_read_dir(|_depth, _path, _state, children| {
                children.retain(|dir_entry_res| {
                    if let Ok(dir_entry) = dir_entry_res {
                        let name = dir_entry.file_name.to_string_lossy();
                        !name.eq_ignore_ascii_case("System Volume Information")
                            && !name.eq_ignore_ascii_case("$Recycle.Bin")
                    } else {
                        false
                    }
                });
            });

        for entry_res in walker {
            let Ok(entry) = entry_res else {
                continue;
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };

            let size = meta.len();
            total_scanned_bytes = total_scanned_bytes.saturating_add(size);
            total_files_count = total_files_count.saturating_add(1);

            let entry_path = entry.path();
            let ext = entry_path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            match classify_extension(&ext) {
                "Видео" => cat_video = cat_video.saturating_add(size),
                "Игры и софт" => cat_games_soft = cat_games_soft.saturating_add(size),
                "Архивы и образы" => cat_archives = cat_archives.saturating_add(size),
                "Аудио" => cat_audio = cat_audio.saturating_add(size),
                "Документы" => cat_docs = cat_docs.saturating_add(size),
                _ => cat_other = cat_other.saturating_add(size),
            }

            let qualifies = top_heap.len() < 100
                || top_heap
                    .peek()
                    .map(|smallest| size > smallest.0 .0)
                    .unwrap_or(true);

            if qualifies && size > 0 {
                let file_name = entry.file_name().to_string_lossy().to_string();
                let full_path_str = entry_path.to_string_lossy().to_string();
                top_heap.push(Reverse((size, full_path_str, file_name, ext)));
                if top_heap.len() > 100 {
                    top_heap.pop();
                }
            }

            if let Ok(rel) = entry_path.strip_prefix(&root_path) {
                let mut comps = rel.components().filter_map(|c| match c {
                    std::path::Component::Normal(os) => Some(os.to_string_lossy().to_string()),
                    _ => None,
                });

                let first = comps.next();
                let second = comps.next();
                let third = comps.next();
                let fourth = comps.next();

                match (first, second, third, fourth) {
                    (Some(_file_in_root), None, _, _) => {
                        root_direct_files_bytes = root_direct_files_bytes.saturating_add(size);
                    }
                    (Some(c1), Some(_c2_or_file), None, _) => {
                        *level1_sizes.entry(c1).or_insert(0) += size;
                    }
                    (Some(c1), Some(c2), Some(_c3_or_file), None) => {
                        *level1_sizes.entry(c1.clone()).or_insert(0) += size;
                        *level2_sizes.entry((c1, c2)).or_insert(0) += size;
                    }
                    (Some(c1), Some(c2), Some(c3), Some(_)) => {
                        *level1_sizes.entry(c1.clone()).or_insert(0) += size;
                        *level2_sizes.entry((c1.clone(), c2.clone())).or_insert(0) += size;
                        *level3_sizes.entry((c1, c2, c3)).or_insert(0) += size;
                    }
                    _ => {}
                }
            }
        }

        let mut top_files: Vec<FileEntry> = top_heap
            .into_iter()
            .map(|Reverse((size_bytes, path, name, extension))| FileEntry {
                path,
                name,
                size_bytes,
                extension,
            })
            .collect();
        top_files.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));

        let mut l1_vec: Vec<(String, u64)> = level1_sizes.into_iter().collect();
        l1_vec.sort_by(|a, b| b.1.cmp(&a.1));
        l1_vec.truncate(10);

        let mut root_children: Vec<FolderNode> = l1_vec
            .into_iter()
            .map(|(c1_name, c1_size)| {
                let c1_path = root_path.join(&c1_name);

                let mut l2_vec: Vec<(String, u64)> = level2_sizes
                    .iter()
                    .filter(|((parent_c1, _), _)| parent_c1 == &c1_name)
                    .map(|((_, c2_name), &sz)| (c2_name.clone(), sz))
                    .collect();
                l2_vec.sort_by(|a, b| b.1.cmp(&a.1));
                l2_vec.truncate(10);

                let l2_children: Vec<FolderNode> = l2_vec
                    .into_iter()
                    .map(|(c2_name, c2_size)| {
                        let c2_path = c1_path.join(&c2_name);

                        let mut l3_vec: Vec<(String, u64)> = level3_sizes
                            .iter()
                            .filter(|((p1, p2, _), _)| p1 == &c1_name && p2 == &c2_name)
                            .map(|((_, _, c3_name), &sz)| (c3_name.clone(), sz))
                            .collect();
                        l3_vec.sort_by(|a, b| b.1.cmp(&a.1));
                        l3_vec.truncate(10);

                        let l3_children: Vec<FolderNode> = l3_vec
                            .into_iter()
                            .map(|(c3_name, c3_size)| FolderNode {
                                path: c2_path.join(&c3_name).to_string_lossy().to_string(),
                                name: c3_name,
                                size_bytes: c3_size,
                                children: Vec::new(),
                            })
                            .collect();

                        FolderNode {
                            name: c2_name,
                            path: c2_path.to_string_lossy().to_string(),
                            size_bytes: c2_size,
                            children: l3_children,
                        }
                    })
                    .collect();

                FolderNode {
                    name: c1_name,
                    path: c1_path.to_string_lossy().to_string(),
                    size_bytes: c1_size,
                    children: l2_children,
                }
            })
            .collect();

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
            ("Игры и софт".to_string(), cat_games_soft),
            ("Видео".to_string(), cat_video),
            ("Архивы и образы".to_string(), cat_archives),
            ("Аудио".to_string(), cat_audio),
            ("Документы".to_string(), cat_docs),
            ("Прочее".to_string(), cat_other),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut sys = System::new_all();
    sys.refresh_all(); // Первичный прогрев датчиков

    let networks = Networks::new_with_refreshed_list();
    let hw_telemetry = Arc::new(Mutex::new(None));
    let hw_sidecar_child = Arc::new(Mutex::new(None));

    // Запускаем фоновый C# sidecar-процесс мониторинга железа
    spawn_hwmon_sidecar(Arc::clone(&hw_telemetry), Arc::clone(&hw_sidecar_child));

    let child_for_exit = Arc::clone(&hw_sidecar_child);

    tauri::Builder::default()
        .manage(AppState {
            sys: Mutex::new(sys),
            networks: Mutex::new(networks),
            ping_cache: Mutex::new((0, None)),
            hw_telemetry,
            hw_sidecar_child,
        })
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Ok(mut guard) = child_for_exit.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_system_metrics,
            schedule_shutdown,
            cancel_shutdown,
            get_startup_items,
            toggle_startup_item,
            open_item_location,
            get_available_drives,
            scan_storage,
            get_hardware_telemetry
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
