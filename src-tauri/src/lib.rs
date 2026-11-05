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
}

// Хранилище состояния приложения
pub struct AppState {
    pub sys: Mutex<System>,
    pub networks: Mutex<Networks>,
    pub ping_cache: Mutex<(u32, Option<Instant>)>,
    pub process_last_refresh: Mutex<Option<Instant>>,
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
    ]
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
            }
        })
        .collect();

    Ok(list)
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
            process_last_refresh: Mutex::new(None),
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
            get_hardware_telemetry,
            is_elevated_admin,
            restart_as_admin,
            app_exit,
            scan_cleanup_targets,
            execute_cleanup,
            get_process_list,
            kill_process,
            suspend_process
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
