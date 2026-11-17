use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
#[cfg(target_os = "windows")]
use winreg::RegKey;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "NEXUS PC";
const EVENT_LIMIT: usize = 100;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NexusSettings {
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub minimize_to_tray: bool,
    #[serde(default)]
    pub start_minimized: bool,
    #[serde(default = "default_polling")]
    pub polling_rate_ms: u64,
    #[serde(default = "default_cpu_temp")]
    pub alert_cpu_temp: u32,
    #[serde(default = "default_gpu_temp")]
    pub alert_gpu_temp: u32,
    #[serde(default = "default_disk_free")]
    pub alert_disk_free_gb: u32,
    #[serde(default = "default_true")]
    pub notifications_enabled: bool,
}

fn default_true() -> bool {
    true
}
fn default_polling() -> u64 {
    2000
}
fn default_cpu_temp() -> u32 {
    85
}
fn default_gpu_temp() -> u32 {
    83
}
fn default_disk_free() -> u32 {
    20
}

impl Default for NexusSettings {
    fn default() -> Self {
        Self {
            autostart: false,
            minimize_to_tray: false,
            start_minimized: false,
            polling_rate_ms: 2000,
            alert_cpu_temp: 85,
            alert_gpu_temp: 83,
            alert_disk_free_gb: 20,
            notifications_enabled: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NexusEvent {
    pub id: String,
    pub timestamp: String,
    pub category: String,
    pub message: String,
    pub level: String,
}

fn nexus_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.is_empty() {
            return PathBuf::from(appdata).join("nexus");
        }
    }
    PathBuf::from("nexus-data")
}

fn settings_path() -> PathBuf {
    nexus_dir().join("settings.json")
}

fn events_path() -> PathBuf {
    nexus_dir().join("events.json")
}

fn ensure_dir() -> Result<(), String> {
    fs::create_dir_all(nexus_dir()).map_err(|err| format!("Не удалось создать папку настроек: {err}"))
}

pub fn normalize_settings(mut settings: NexusSettings) -> NexusSettings {
    if !matches!(settings.polling_rate_ms, 1000 | 2000 | 5000) {
        settings.polling_rate_ms = 2000;
    }
    settings.alert_cpu_temp = settings.alert_cpu_temp.clamp(70, 100);
    settings.alert_gpu_temp = settings.alert_gpu_temp.clamp(65, 95);
    settings.alert_disk_free_gb = settings.alert_disk_free_gb.clamp(5, 50);
    settings
}

struct SettingsMemoryState {
    settings: NexusSettings,
    load_error: Option<String>,
}

static SETTINGS: LazyLock<RwLock<SettingsMemoryState>> = LazyLock::new(|| {
    let (settings, load_error) = read_settings_once();
    RwLock::new(SettingsMemoryState {
        settings,
        load_error,
    })
});

fn read_settings_once() -> (NexusSettings, Option<String>) {
    let path = settings_path();
    if !path.exists() {
        let settings = NexusSettings::default();
        let _ = write_settings_file(&settings);
        return (settings, None);
    }
    match fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<NexusSettings>(&raw) {
            Ok(settings) => (normalize_settings(settings), None),
            Err(err) => (
                NexusSettings::default(),
                Some(format!(
                    "Файл settings.json повреждён и оставлен без перезаписи: {err}"
                )),
            ),
        },
        Err(err) => (
            NexusSettings::default(),
            Some(format!("Не удалось прочитать settings.json: {err}")),
        ),
    }
}

pub fn init_settings() {
    let _ = &*SETTINGS;
}

pub fn load_settings() -> NexusSettings {
    SETTINGS
        .read()
        .map(|guard| guard.settings.clone())
        .unwrap_or_default()
}

pub fn get_settings() -> Result<NexusSettings, String> {
    let guard = SETTINGS
        .read()
        .map_err(|_| "Хранилище настроек в памяти заблокировано".to_string())?;
    if let Some(err) = &guard.load_error {
        return Err(err.clone());
    }
    Ok(guard.settings.clone())
}

fn write_settings_file(settings: &NexusSettings) -> Result<(), String> {
    ensure_dir()?;
    let body = serde_json::to_string_pretty(settings).map_err(|err| format!("Не удалось сериализовать настройки: {err}"))?;
    fs::write(settings_path(), body).map_err(|err| format!("Не удалось записать settings.json: {err}"))
}

pub fn save_settings(settings: NexusSettings) -> Result<(), String> {
    let settings = normalize_settings(settings);
    write_settings_file(&settings)?;
    if let Ok(mut guard) = SETTINGS.write() {
        guard.settings = settings.clone();
        guard.load_error = None;
    }
    sync_autostart(settings.autostart)
}

#[cfg(target_os = "windows")]
fn sync_autostart(enabled: bool) -> Result<(), String> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
        .map_err(|err| format!("Не удалось открыть автозагрузку Windows: {err}"))?;
    if enabled {
        let exe = std::env::current_exe().map_err(|err| format!("Не удалось определить путь NEXUS: {err}"))?;
        let command = format!("\"{}\" --autostart", exe.display());
        key.set_value(RUN_VALUE, &command)
            .map_err(|err| format!("Не удалось записать автозапуск: {err}"))
    } else {
        match key.delete_value(RUN_VALUE) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("Не удалось убрать автозапуск: {err}")),
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn sync_autostart(_enabled: bool) -> Result<(), String> {
    Ok(())
}

static EVENT_LOCK: Mutex<()> = Mutex::new(());
static EVENT_SEQ: AtomicU64 = AtomicU64::new(1);
static ALERT_LOCK: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());

fn local_rfc3339() -> String {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct SystemTime {
            year: u16,
            month: u16,
            day_of_week: u16,
            day: u16,
            hour: u16,
            minute: u16,
            second: u16,
            millis: u16,
        }
        unsafe extern "system" {
            fn GetLocalTime(time: *mut SystemTime);
        }
        let mut time = SystemTime {
            year: 0,
            month: 0,
            day_of_week: 0,
            day: 0,
            hour: 0,
            minute: 0,
            second: 0,
            millis: 0,
        };
        unsafe { GetLocalTime(&mut time) };
        return format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            time.year, time.month, time.day, time.hour, time.minute, time.second
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        "1970-01-01T00:00:00".to_string()
    }
}

fn read_events() -> Vec<NexusEvent> {
    let path = events_path();
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_events(events: &[NexusEvent]) -> Result<(), String> {
    ensure_dir()?;
    let body = serde_json::to_string_pretty(events).map_err(|err| format!("Не удалось сериализовать журнал: {err}"))?;
    fs::write(events_path(), body).map_err(|err| format!("Не удалось записать events.json: {err}"))
}

pub fn record_event(category: &str, message: &str, level: &str) {
    let _guard = EVENT_LOCK.lock().ok();
    let mut events = read_events();
    let seq = EVENT_SEQ.fetch_add(1, Ordering::Relaxed);
    let timestamp = local_rfc3339();
    events.insert(
        0,
        NexusEvent {
            id: format!("{timestamp}-{seq}"),
            timestamp,
            category: category.to_string(),
            message: message.to_string(),
            level: level.to_string(),
        },
    );
    events.truncate(EVENT_LIMIT);
    let _ = write_events(&events);
}

pub fn get_event_log() -> Vec<NexusEvent> {
    let _guard = EVENT_LOCK.lock().ok();
    read_events()
}

pub fn clear_event_log() -> Result<(), String> {
    let _guard = EVENT_LOCK.lock().ok();
    write_events(&[])
}

pub fn record_cleanup(freed_bytes: u64) {
    let gb = freed_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    record_event(
        "Очистка",
        &format!("Очищено {gb:.1} ГБ временных файлов"),
        "info",
    );
}

pub fn record_startup_removal(entry_id: &str, source: &str) {
    let name = entry_id.rsplit('|').next().unwrap_or(entry_id).trim();
    let name = if name.is_empty() { entry_id } else { name };
    let message = if entry_id.starts_with("reg|") || entry_id.starts_with("approved|") || entry_id.starts_with("cim|") {
        format!("Удалена запись {name} из реестра")
    } else {
        format!("Удалена запись {name} из {source}")
    };
    record_event("Безопасность", &message, "info");
}

fn alert_ready(key: &str) -> bool {
    let Ok(mut guard) = ALERT_LOCK.lock() else {
        return false;
    };
    let now = Instant::now();
    if let Some((_, last)) = guard.iter().find(|(name, _)| name == key) {
        if now.duration_since(*last) < Duration::from_secs(600) {
            return false;
        }
    }
    guard.retain(|(name, _)| name != key);
    guard.push((key.to_string(), now));
    true
}

pub fn consider_hardware(cpu_temp: Option<f32>, gpu_temp: Option<f32>) {
    let settings = load_settings();
    if !settings.notifications_enabled {
        return;
    }
    if let Some(temp) = cpu_temp {
        if temp >= settings.alert_cpu_temp as f32 && alert_ready("cpu") {
            let level = if temp >= settings.alert_cpu_temp as f32 + 10.0 { "critical" } else { "warning" };
            record_event(
                "Железо",
                &format!("Температура CPU {temp:.0} °C выше порога {} °C", settings.alert_cpu_temp),
                level,
            );
        }
    }
    if let Some(temp) = gpu_temp {
        if temp >= settings.alert_gpu_temp as f32 && alert_ready("gpu") {
            let level = if temp >= settings.alert_gpu_temp as f32 + 10.0 { "critical" } else { "warning" };
            record_event(
                "Железо",
                &format!("Температура GPU {temp:.0} °C выше порога {} °C", settings.alert_gpu_temp),
                level,
            );
        }
    }
}

pub fn consider_disk(free_gb: u64, total_gb: u64) {
    let settings = load_settings();
    if !settings.notifications_enabled || total_gb == 0 {
        return;
    }
    if free_gb < settings.alert_disk_free_gb as u64 && alert_ready("disk") {
        record_event(
            "Система",
            &format!("На диске C: осталось {free_gb} ГБ, порог {} ГБ", settings.alert_disk_free_gb),
            "warning",
        );
    }
}
