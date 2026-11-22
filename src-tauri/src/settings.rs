use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, RegType};
#[cfg(target_os = "windows")]
use winreg::{RegKey, RegValue};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "AURORA";
const LEGACY_RUN_VALUE: &str = "NEXUS PC";
#[cfg(target_os = "windows")]
const APPROVAL_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
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
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
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
            extra: Default::default(),
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
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn write_json<T: Serialize>(file: &str, value: &T) -> Result<(), String> {
    let path = crate::profile::file(file)?;
    let parent = path.parent().ok_or("Не найден каталог профиля")?;
    let write = || -> std::io::Result<()> {
        fs::create_dir_all(parent)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(temp.as_file_mut(), value)?;
        temp.persist(&path)?;
        Ok(())
    };
    write().map_err(|err| format!("Не удалось записать {file}: {err}"))
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
    let path = match crate::profile::file("settings.json") {
        Ok(path) => path,
        Err(err) => return (NexusSettings::default(), Some(err)),
    };
    match fs::read_to_string(&path) {
        Ok(raw) => {
            match serde_json::from_str::<NexusSettings>(raw.trim_start_matches('\u{feff}')) {
                Ok(settings) => (normalize_settings(settings), None),
                Err(err) => (
                    NexusSettings::default(),
                    Some(format!(
                        "Файл settings.json повреждён и оставлен без перезаписи: {err}"
                    )),
                ),
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => (NexusSettings::default(), None),
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

pub fn should_start_in_tray(
    start_minimized: bool,
    args: impl IntoIterator<Item = impl AsRef<OsStr>>,
) -> bool {
    start_minimized
        && args
            .into_iter()
            .any(|arg| arg.as_ref() == "--autostart" || arg.as_ref() == "--minimized")
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

pub fn save_settings(settings: NexusSettings) -> Result<(), String> {
    let mut guard = SETTINGS.write().map_err(|_| "Настройки заблокированы")?;
    if let Some(err) = &guard.load_error {
        return Err(err.clone());
    }
    let mut settings = normalize_settings(settings);
    settings.extra = guard.settings.extra.clone();
    write_json("settings.json", &settings)?;
    guard.settings = settings;
    Ok(())
}

#[cfg(target_os = "windows")]
fn autostart_command() -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|err| format!("Не удалось определить путь AURORA: {err}"))?;
    Ok(format!("\"{}\" --autostart", exe.display()))
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutostartStatus {
    Enabled,
    Disabled,
    Blocked,
    Outdated,
    #[cfg(not(target_os = "windows"))]
    Unsupported,
}

#[cfg(target_os = "windows")]
fn read_value(key: &RegKey, name: &str) -> Result<Option<RegValue>, String> {
    match key.get_raw_value(name) {
        Ok(value) => Ok(Some(value)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Не удалось прочитать автозапуск Windows: {err}")),
    }
}

#[cfg(target_os = "windows")]
fn read_approval(root: &RegKey, approval_key: &str) -> Result<Option<RegValue>, String> {
    match root.open_subkey_with_flags(approval_key, KEY_QUERY_VALUE) {
        Ok(key) => read_value(&key, RUN_VALUE),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!(
            "Не удалось прочитать состояние в StartupApproved: {err}"
        )),
    }
}

#[cfg(target_os = "windows")]
fn approval_blocks(approval: Option<&RegValue>) -> Result<bool, String> {
    match approval {
        None => Ok(false),
        Some(raw) if raw.vtype == RegType::REG_BINARY && !raw.bytes.is_empty() => {
            Ok(raw.bytes[0] % 2 == 1)
        }
        Some(_) => Err("Windows вернула некорректную запись StartupApproved для AURORA".into()),
    }
}

#[cfg(target_os = "windows")]
fn registered_command(key: &RegKey, name: &str) -> Result<Option<String>, String> {
    match key.get_value::<String, _>(name) {
        Ok(command) => Ok(Some(command)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Не удалось прочитать команду автозапуска: {err}")),
    }
}

#[cfg(target_os = "windows")]
fn is_app_command(command: &str, executable: &str) -> bool {
    let value = command.trim();
    let path = value
        .strip_suffix(" --autostart")
        .or_else(|| value.strip_suffix(" --minimized"))
        .unwrap_or(value);
    let path = path
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(path);
    let path = Path::new(path);
    path.is_absolute()
        && path
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|n| n.eq_ignore_ascii_case(executable))
}

#[cfg(target_os = "windows")]
fn inspect_autostart(
    root: &RegKey,
    run_key: &str,
    approval_key: &str,
    expected: &str,
) -> Result<AutostartStatus, String> {
    let key = match root.open_subkey_with_flags(run_key, KEY_QUERY_VALUE) {
        Ok(key) => key,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AutostartStatus::Disabled);
        }
        Err(err) => return Err(format!("Не удалось открыть автозагрузку Windows: {err}")),
    };
    if registered_command(&key, LEGACY_RUN_VALUE)?.is_some() {
        return Ok(AutostartStatus::Outdated);
    }
    let Some(command) = registered_command(&key, RUN_VALUE)? else {
        return Ok(AutostartStatus::Disabled);
    };
    if approval_blocks(read_approval(root, approval_key)?.as_ref())? {
        Ok(AutostartStatus::Blocked)
    } else if command.eq_ignore_ascii_case(expected) {
        Ok(AutostartStatus::Enabled)
    } else {
        Ok(AutostartStatus::Outdated)
    }
}

#[cfg(target_os = "windows")]
fn update_autostart(
    root: &RegKey,
    run_key: &str,
    approval_key: &str,
    expected: &str,
    enabled: bool,
) -> Result<AutostartStatus, String> {
    use winreg::transaction::Transaction;
    let fail = |err| format!("Не удалось обновить автозапуск Windows: {err}");
    let tx = Transaction::new().map_err(fail)?;
    let (key, _) = root
        .create_subkey_transacted_with_flags(run_key, &tx, KEY_QUERY_VALUE | KEY_SET_VALUE)
        .map_err(fail)?;
    let current = registered_command(&key, RUN_VALUE)?;
    if let Some(path) = &current
        && !path.eq_ignore_ascii_case(expected)
        && !is_app_command(path, "aurora.exe")
    {
        return Err("Имя AURORA в автозагрузке уже занято другой командой. Проверьте её в разделе автозагрузки.".into());
    }
    if enabled {
        if let Some(legacy) = registered_command(&key, LEGACY_RUN_VALUE)? {
            if !is_app_command(&legacy, "nexus.exe") {
                return Err("Неопознанная команда прежней версии в автозагрузке. Проверьте её в разделе автозагрузки.".into());
            }
            key.delete_value(LEGACY_RUN_VALUE).map_err(fail)?;
        }
        if let Some(mut raw) = read_approval(root, approval_key)?
            && approval_blocks(Some(&raw))?
        {
            raw.bytes.resize(raw.bytes.len().max(12), 0);
            raw.bytes[0] = 0x02;
            raw.bytes[4..].fill(0);
            root.open_subkey_transacted_with_flags(approval_key, &tx, KEY_SET_VALUE)
                .and_then(|k| k.set_raw_value(RUN_VALUE, &raw))
                .map_err(fail)?;
        }
        key.set_value(RUN_VALUE, &expected).map_err(fail)?;
    } else if current.is_some() {
        key.delete_value(RUN_VALUE).map_err(fail)?;
    }
    tx.commit().map_err(fail)?;
    inspect_autostart(root, run_key, approval_key, expected)
}

pub fn get_windows_autostart() -> Result<AutostartStatus, String> {
    #[cfg(target_os = "windows")]
    return inspect_autostart(
        &RegKey::predef(HKEY_CURRENT_USER),
        RUN_KEY,
        APPROVAL_KEY,
        &autostart_command()?,
    );
    #[cfg(not(target_os = "windows"))]
    Ok(AutostartStatus::Unsupported)
}

pub fn set_windows_autostart(enabled: bool) -> Result<AutostartStatus, String> {
    #[cfg(target_os = "windows")]
    return update_autostart(
        &RegKey::predef(HKEY_CURRENT_USER),
        RUN_KEY,
        APPROVAL_KEY,
        &autostart_command()?,
        enabled,
    );
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("Автозапуск доступен только в Windows".into())
    }
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

fn read_events() -> Result<Vec<NexusEvent>, String> {
    let path = crate::profile::file("events.json")?;
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(raw.trim_start_matches('\u{feff}'))
            .map_err(|err| format!("Ошибка формата events.json: {err}")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(format!("Не удалось прочитать events.json: {err}")),
    }
}

fn write_events(events: &[NexusEvent]) -> Result<(), String> {
    write_json("events.json", &events)
}

pub fn record_event(category: &str, message: &str, level: &str) {
    let _guard = EVENT_LOCK.lock().ok();
    let Ok(mut events) = read_events() else {
        return;
    };
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
            extra: Default::default(),
        },
    );
    events.truncate(EVENT_LIMIT);
    let _ = write_events(&events);
}

pub fn get_event_log() -> Result<Vec<NexusEvent>, String> {
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
    let message = if entry_id.starts_with("reg|")
        || entry_id.starts_with("approved|")
        || entry_id.starts_with("cim|")
    {
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
            let level = if temp >= settings.alert_cpu_temp as f32 + 10.0 {
                "critical"
            } else {
                "warning"
            };
            record_event(
                "Железо",
                &format!(
                    "Температура CPU {temp:.0} °C выше порога {} °C",
                    settings.alert_cpu_temp
                ),
                level,
            );
        }
    }
    if let Some(temp) = gpu_temp {
        if temp >= settings.alert_gpu_temp as f32 && alert_ready("gpu") {
            let level = if temp >= settings.alert_gpu_temp as f32 + 10.0 {
                "critical"
            } else {
                "warning"
            };
            record_event(
                "Железо",
                &format!(
                    "Температура GPU {temp:.0} °C выше порога {} °C",
                    settings.alert_gpu_temp
                ),
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
            &format!(
                "На диске C: осталось {free_gb} ГБ, порог {} ГБ",
                settings.alert_disk_free_gb
            ),
            "warning",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::should_start_in_tray;

    #[test]
    fn tray_start_requires_both_the_setting_and_the_autostart_argument() {
        for setting in [false, true] {
            assert!(!should_start_in_tray(setting, [] as [&str; 0]));
            assert!(!should_start_in_tray(setting, ["--other"]));
            assert_eq!(should_start_in_tray(setting, ["--autostart"]), setting);
            assert_eq!(should_start_in_tray(setting, ["--minimized"]), setting);
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn autostart_round_trip_reads_registration_and_windows_approval() {
        use super::*;
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let base = format!(r"Software\NexusAuroraTest-{}", std::process::id());
        struct Cleanup<'a>(&'a RegKey, &'a str);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.delete_subkey_all(self.1);
            }
        }
        let _cleanup = Cleanup(&root, &base);
        let run_path = format!(r"{base}\Run");
        let approve_path = format!(r"{base}\Approved");
        let (run, _) = root.create_subkey(&run_path).unwrap();
        let (approval, _) = root.create_subkey(&approve_path).unwrap();
        let command = r#""C:\Apps\AURORA\aurora.exe" --autostart"#;
        let read = || inspect_autostart(&root, &run_path, &approve_path, command).unwrap();
        assert_eq!(read(), AutostartStatus::Disabled);
        run.set_value(RUN_VALUE, &r"C:\Old\aurora.exe").unwrap();
        assert_eq!(read(), AutostartStatus::Outdated);
        approval
            .set_raw_value(
                RUN_VALUE,
                &RegValue {
                    bytes: vec![3, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0],
                    vtype: RegType::REG_BINARY,
                },
            )
            .unwrap();
        assert_eq!(read(), AutostartStatus::Blocked);
        assert_eq!(
            update_autostart(&root, &run_path, &approve_path, command, true).unwrap(),
            AutostartStatus::Enabled
        );
        assert_eq!(read(), AutostartStatus::Enabled);
        assert_eq!(run.get_value::<String, _>(RUN_VALUE).unwrap(), command);
        assert_eq!(
            update_autostart(&root, &run_path, &approve_path, command, false).unwrap(),
            AutostartStatus::Disabled
        );
        assert_eq!(read(), AutostartStatus::Disabled);
        let legacy = r#""C:\Old App\nexus.exe" --autostart"#;
        run.set_value(LEGACY_RUN_VALUE, &legacy).unwrap();
        assert_eq!(read(), AutostartStatus::Outdated);
        assert_eq!(
            run.get_value::<String, _>(LEGACY_RUN_VALUE).unwrap(),
            legacy
        );
        update_autostart(&root, &run_path, &approve_path, command, true).unwrap();
        assert_eq!(read(), AutostartStatus::Enabled);
        assert!(
            registered_command(&run, LEGACY_RUN_VALUE)
                .unwrap()
                .is_none()
        );
        run.set_value(LEGACY_RUN_VALUE, &"custom command").unwrap();
        assert!(update_autostart(&root, &run_path, &approve_path, command, true).is_err());
        assert_eq!(
            run.get_value::<String, _>(LEGACY_RUN_VALUE).unwrap(),
            "custom command"
        );
    }
}
