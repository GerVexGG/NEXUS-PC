use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use winreg::RegKey;
#[cfg(target_os = "windows")]
use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, KEY_WOW64_64KEY};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const MEDIA_PROFILE_KEY_PATH: &str =
    r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "state", content = "value", rename_all = "snake_case")]
pub enum SavedRegDword {
    Present(u32),
    Absent,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PacketPriorityBackup {
    pub captured_at: String,
    pub network_throttling_index: Option<SavedRegDword>,
    pub system_responsiveness: Option<SavedRegDword>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AdapterPropertyBackup {
    pub registry_keyword: String,
    pub display_name: String,
    pub original_registry_value: Option<Vec<String>>,
    pub original_display_value: Option<String>,
    pub applied_registry_value: Option<Vec<String>>,
    pub applied_display_value: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AdapterTuningBackup {
    pub interface_guid: String,
    pub interface_description: String,
    pub pnp_device_id: String,
    pub mac_address: String,
    pub last_known_name: String,
    pub captured_at: String,
    pub properties: HashMap<String, AdapterPropertyBackup>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct NetworkOptimizerBackupStore {
    pub version: u32,
    pub packet_priority: Option<PacketPriorityBackup>,
    pub adapters: HashMap<String, AdapterTuningBackup>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NetworkOptimizerStatus {
    pub packet_priority_enabled: bool,
    pub packet_priority_has_backup: bool,
    pub ethernet_tuned: bool,
    pub ethernet_has_backup: bool,
    pub backed_up_adapters_count: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct LiveAdapterProperty {
    pub registry_keyword: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub display_value: Option<String>,
    #[serde(default)]
    pub registry_value: Option<Vec<String>>,
    #[serde(default)]
    pub valid_display_values: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct LiveEthernetAdapter {
    pub interface_guid: String,
    pub name: String,
    #[serde(default)]
    pub interface_description: String,
    #[serde(default)]
    pub pnp_device_id: String,
    #[serde(default)]
    pub mac_address: String,
    #[serde(default)]
    pub properties: Vec<LiveAdapterProperty>,
}

pub fn normalize_adapter_id(raw: &str) -> String {
    raw.trim().to_ascii_uppercase()
}

pub fn adapter_matches_hardware(backup: &AdapterTuningBackup, live: &LiveEthernetAdapter) -> bool {
    if normalize_adapter_id(&backup.interface_guid) != normalize_adapter_id(&live.interface_guid) {
        return false;
    }
    let backup_pnp = backup.pnp_device_id.trim();
    let live_pnp = live.pnp_device_id.trim();
    if !backup_pnp.is_empty() && !live_pnp.is_empty() {
        return backup_pnp.eq_ignore_ascii_case(live_pnp);
    }
    let backup_desc = backup.interface_description.trim();
    let live_desc = live.interface_description.trim();
    if !backup_desc.is_empty() && !live_desc.is_empty() {
        return backup_desc.eq_ignore_ascii_case(live_desc);
    }
    true
}

fn is_target_keyword(keyword: &str) -> bool {
    let lower = keyword.to_ascii_lowercase();
    lower.contains("eee")
        || lower.contains("greenethernet")
        || lower.contains("interruptmoderation")
}

fn is_property_already_tuned(prop: &LiveAdapterProperty) -> bool {
    if let Some(ref disp) = prop.display_value {
        let lower = disp.trim().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "disabled" | "отключено" | "low" | "низкий" | "низкая"
        ) || lower.contains("disabled")
            || lower.contains("отключ")
        {
            return true;
        }
    }
    false
}

fn pick_tune_display_value(prop: &LiveAdapterProperty) -> Option<String> {
    for v in &prop.valid_display_values {
        let t = v.trim();
        let lower = t.to_ascii_lowercase();
        if lower == "disabled" || lower == "отключено" {
            return Some(t.to_string());
        }
    }
    if prop
        .registry_keyword
        .to_ascii_lowercase()
        .contains("interrupt")
    {
        for v in &prop.valid_display_values {
            let t = v.trim();
            let lower = t.to_ascii_lowercase();
            if lower.contains("low") || lower.contains("низк") {
                return Some(t.to_string());
            }
        }
    }
    None
}

pub trait NetworkOptimizerBackend: Send + Sync {
    fn is_elevated_admin(&self) -> bool;
    fn now_timestamp(&self) -> String;
    fn read_mm_dword(&self, value_name: &str) -> Result<SavedRegDword, String>;
    fn write_mm_dword(&self, value_name: &str, value: &SavedRegDword) -> Result<(), String>;
    fn list_active_ethernet_adapters(&self) -> Result<Vec<LiveEthernetAdapter>, String>;
    fn set_adapter_property(
        &self,
        interface_guid: &str,
        registry_keyword: &str,
        registry_value: Option<&[String]>,
        display_value: Option<&str>,
    ) -> Result<(), String>;
}

pub struct WindowsNetworkOptimizerBackend;

impl WindowsNetworkOptimizerBackend {
    fn run_powershell(script: &str, envs: &[(&str, &str)]) -> Result<String, String> {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        for (k, v) in envs {
            cmd.env(k, v);
        }
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let out = cmd
            .output()
            .map_err(|e| format!("Не удалось запустить PowerShell: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        } else {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let msg = if !err.is_empty() { err } else { stdout };
            Err(if msg.is_empty() {
                format!("PowerShell завершился с кодом {:?}", out.status.code())
            } else {
                msg
            })
        }
    }

    #[cfg(target_os = "windows")]
    fn open_mm_key(writable: bool) -> Result<RegKey, String> {
        let flags = if writable {
            KEY_READ | KEY_SET_VALUE | KEY_WOW64_64KEY
        } else {
            KEY_READ | KEY_WOW64_64KEY
        };
        RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(MEDIA_PROFILE_KEY_PATH, flags)
            .map_err(|e| format!("Не удалось открыть ветку SystemProfile: {e}"))
    }
}

impl NetworkOptimizerBackend for WindowsNetworkOptimizerBackend {
    fn is_elevated_admin(&self) -> bool {
        crate::check_is_elevated_admin()
    }

    fn now_timestamp(&self) -> String {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        secs.to_string()
    }

    fn read_mm_dword(&self, value_name: &str) -> Result<SavedRegDword, String> {
        #[cfg(target_os = "windows")]
        {
            let key = Self::open_mm_key(false)?;
            match key.get_value::<u32, _>(value_name) {
                Ok(v) => Ok(SavedRegDword::Present(v)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SavedRegDword::Absent),
                Err(e) => Err(format!("Ошибка чтения параметра реестра {value_name}: {e}")),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = value_name;
            Ok(SavedRegDword::Absent)
        }
    }

    fn write_mm_dword(&self, value_name: &str, value: &SavedRegDword) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            let key = Self::open_mm_key(true)?;
            match value {
                SavedRegDword::Present(v) => key
                    .set_value(value_name, v)
                    .map_err(|e| format!("Не удалось записать {value_name}={v}: {e}")),
                SavedRegDword::Absent => match key.delete_value(value_name) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(format!(
                        "Не удалось удалить параметр {value_name} при восстановлении: {e}"
                    )),
                },
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (value_name, value);
            Err("Настройка доступна только в Windows".to_string())
        }
    }

    fn list_active_ethernet_adapters(&self) -> Result<Vec<LiveEthernetAdapter>, String> {
        let script = r#"
$adapters = @()
Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  $guid = ([string]$_.InterfaceGuid).Trim()
  if (-not $guid) { $guid = ([string]$_.Name).Trim() }
  $props = @()
  Get-NetAdapterAdvancedProperty -Name $_.Name -ErrorAction SilentlyContinue | ForEach-Object {
    $kw = [string]$_.RegistryKeyword
    if ($kw -match 'EEE|GreenEthernet|InterruptModeration') {
      $regVals = $null
      if ($null -ne $_.RegistryValue) {
        $regVals = @()
        foreach ($rv in @($_.RegistryValue)) { $regVals += [string]$rv }
      }
      $validVals = @()
      if ($null -ne $_.ValidDisplayValues) {
        foreach ($vv in @($_.ValidDisplayValues)) { $validVals += [string]$vv }
      }
      $dispVal = $null
      if ($null -ne $_.DisplayValue) { $dispVal = [string]$_.DisplayValue }
      $props += [PSCustomObject]@{
        registry_keyword = $kw
        display_name = [string]$_.DisplayName
        display_value = $dispVal
        registry_value = $regVals
        valid_display_values = @($validVals)
      }
    }
  }
  $adapters += [PSCustomObject]@{
    interface_guid = $guid
    name = [string]$_.Name
    interface_description = [string]$_.InterfaceDescription
    pnp_device_id = [string]$_.PnPDeviceID
    mac_address = [string]$_.MacAddress
    properties = @($props)
  }
}
ConvertTo-Json -InputObject @($adapters) -Depth 6 -Compress
"#;
        let out = Self::run_powershell(script, &[])?;
        let trimmed = out.trim();
        if trimmed.is_empty() || trimmed == "null" {
            return Ok(Vec::new());
        }
        let val: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("Не удалось разобрать параметры сетевых адаптеров: {e}"))?;
        match val {
            serde_json::Value::Array(arr) => serde_json::from_value(serde_json::Value::Array(arr))
                .map_err(|e| format!("Ошибка структуры сетевых адаптеров: {e}")),
            obj @ serde_json::Value::Object(_) => {
                let one: LiveEthernetAdapter = serde_json::from_value(obj)
                    .map_err(|e| format!("Ошибка разбора адаптера: {e}"))?;
                Ok(vec![one])
            }
            _ => Ok(Vec::new()),
        }
    }

    fn set_adapter_property(
        &self,
        interface_guid: &str,
        registry_keyword: &str,
        registry_value: Option<&[String]>,
        display_value: Option<&str>,
    ) -> Result<(), String> {
        let reg_json = match registry_value {
            Some(vals) => serde_json::to_string(vals)
                .map_err(|e| format!("Ошибка сериализации RegistryValue: {e}"))?,
            None => String::new(),
        };
        let disp = display_value.unwrap_or("");
        let script = r#"
$ErrorActionPreference = 'Stop'
$guid = $env:NEXUS_OPT_GUID
$kw = $env:NEXUS_OPT_KEYWORD
$disp = $env:NEXUS_OPT_DISP
$regJson = $env:NEXUS_OPT_REG_JSON

$adapter = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object {
  ([string]$_.InterfaceGuid).Trim().Equals($guid, 'OrdinalIgnoreCase') -or
  ([string]$_.Name).Trim().Equals($guid, 'OrdinalIgnoreCase')
} | Select-Object -First 1

if (-not $adapter) {
  throw "Адаптер '$guid' не найден или отключён"
}

if ($disp) {
  try {
    Set-NetAdapterAdvancedProperty -Name $adapter.Name -RegistryKeyword $kw -DisplayValue $disp -NoRestart -ErrorAction Stop
    exit 0
  } catch {
    if (-not $regJson) { throw }
  }
}

if ($regJson) {
  $vals = @(ConvertFrom-Json $regJson)
  Set-NetAdapterAdvancedProperty -Name $adapter.Name -RegistryKeyword $kw -RegistryValue $vals -NoRestart -ErrorAction Stop
  exit 0
}

throw "Отсутствует значение для применения параметра '$kw'"
"#;
        Self::run_powershell(
            script,
            &[
                ("NEXUS_OPT_GUID", interface_guid),
                ("NEXUS_OPT_KEYWORD", registry_keyword),
                ("NEXUS_OPT_DISP", disp),
                ("NEXUS_OPT_REG_JSON", &reg_json),
            ],
        )
        .map(|_| ())
    }
}

pub fn default_backup_path() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            return PathBuf::from(appdata)
                .join("nexus")
                .join("network_optimizer_backup.json");
        }
    }
    PathBuf::from("nexus-data").join("network_optimizer_backup.json")
}

pub struct NetworkOptimizerManager {
    backup_path: PathBuf,
    backend: Arc<dyn NetworkOptimizerBackend>,
    op_lock: Mutex<()>,
}

impl NetworkOptimizerManager {
    pub fn new() -> Self {
        Self::with_path_and_backend(
            default_backup_path(),
            Arc::new(WindowsNetworkOptimizerBackend),
        )
    }

    pub fn with_path_and_backend(
        backup_path: PathBuf,
        backend: Arc<dyn NetworkOptimizerBackend>,
    ) -> Self {
        Self {
            backup_path,
            backend,
            op_lock: Mutex::new(()),
        }
    }

    fn load_store(&self) -> Result<NetworkOptimizerBackupStore, String> {
        if !self.backup_path.exists() {
            return Ok(NetworkOptimizerBackupStore {
                version: 1,
                packet_priority: None,
                adapters: HashMap::new(),
            });
        }
        let raw = fs::read_to_string(&self.backup_path).map_err(|e| {
            format!(
                "Не удалось прочитать файл резервной копии Network Optimizer ({}): {e}",
                self.backup_path.display()
            )
        })?;
        serde_json::from_str::<NetworkOptimizerBackupStore>(&raw).map_err(|e| {
            format!(
                "Файл резервной копии Network Optimizer повреждён и оставлен без перезаписи ({}): {e}",
                self.backup_path.display()
            )
        })
    }

    fn save_store(&self, store: &NetworkOptimizerBackupStore) -> Result<(), String> {
        if store.packet_priority.is_none() && store.adapters.is_empty() {
            if self.backup_path.exists() {
                fs::remove_file(&self.backup_path)
                    .map_err(|e| format!("Не удалось удалить пустой файл резервной копии: {e}"))?;
            }
            return Ok(());
        }

        if let Some(parent) = self.backup_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Не удалось создать папку резервных копий сети: {e}"))?;
            }
        }
        let mut to_write = store.clone();
        to_write.version = 1;
        let body = serde_json::to_string_pretty(&to_write)
            .map_err(|e| format!("Не удалось сериализовать резервную копию сети: {e}"))?;

        let tmp = self.backup_path.with_extension("json.tmp");
        fs::write(&tmp, &body)
            .map_err(|e| format!("Не удалось записать временный файл резервной копии: {e}"))?;
        if let Err(rename_err) = fs::rename(&tmp, &self.backup_path) {
            let _ = fs::remove_file(&tmp);
            fs::write(&self.backup_path, &body).map_err(|e| {
                format!("Не удалось атомарно сохранить резервную копию ({rename_err}; {e})")
            })?;
        }
        Ok(())
    }

    pub fn get_packet_priority(&self) -> Result<bool, String> {
        let throttle = self.backend.read_mm_dword("NetworkThrottlingIndex")?;
        let resp = self.backend.read_mm_dword("SystemResponsiveness")?;
        Ok(throttle == SavedRegDword::Present(u32::MAX) && resp == SavedRegDword::Present(0))
    }

    pub fn set_packet_priority(&self, enabled: bool) -> Result<String, String> {
        if !self.backend.is_elevated_admin() {
            return Err("Требуются права Администратора (кнопка в шапке)".to_string());
        }

        let _lock = self
            .op_lock
            .lock()
            .map_err(|_| "Менеджер сетевых настроек заблокирован".to_string())?;

        let mut store = self.load_store()?;

        if enabled {
            let orig_nti = self.backend.read_mm_dword("NetworkThrottlingIndex")?;
            let orig_sr = self.backend.read_mm_dword("SystemResponsiveness")?;

            let had_existing_backup = store.packet_priority.is_some();
            if store.packet_priority.is_none() {
                store.packet_priority = Some(PacketPriorityBackup {
                    captured_at: self.backend.now_timestamp(),
                    network_throttling_index: Some(orig_nti.clone()),
                    system_responsiveness: Some(orig_sr.clone()),
                });
                self.save_store(&store)?;
            }

            if let Err(err1) = self
                .backend
                .write_mm_dword("NetworkThrottlingIndex", &SavedRegDword::Present(u32::MAX))
            {
                if !had_existing_backup {
                    store.packet_priority = None;
                    let _ = self.save_store(&store);
                }
                return Err(format!("Ошибка включения приоритета пакетов: {err1}"));
            }

            if let Err(err2) = self
                .backend
                .write_mm_dword("SystemResponsiveness", &SavedRegDword::Present(0))
            {
                // Транзакционный откат первого параметра при сбое второго
                let saved_nti = store
                    .packet_priority
                    .as_ref()
                    .and_then(|b| b.network_throttling_index.clone())
                    .unwrap_or(orig_nti);
                match self
                    .backend
                    .write_mm_dword("NetworkThrottlingIndex", &saved_nti)
                {
                    Ok(()) => {
                        if !had_existing_backup {
                            store.packet_priority = None;
                            let _ = self.save_store(&store);
                        }
                        return Err(format!(
                            "Частичный сбой настройки SystemResponsiveness ({err2}). Параметр NetworkThrottlingIndex успешно откачен к исходному состоянию."
                        ));
                    }
                    Err(rb_err) => {
                        if let Some(ref mut b) = store.packet_priority {
                            b.system_responsiveness = None;
                        }
                        let _ = self.save_store(&store);
                        return Err(format!(
                            "Частичный сбой: NetworkThrottlingIndex изменён, SystemResponsiveness не применён ({err2}), откат не удался ({rb_err}). Резервная копия сохранена."
                        ));
                    }
                }
            }

            Ok(
                "Игровой приоритет сетевых пакетов включён (исходные значения сохранены)"
                    .to_string(),
            )
        } else {
            let Some(mut backup) = store.packet_priority.take() else {
                return Err(
                    "Резервная копия исходных параметров мультимедиа не найдена — AURORA не заменяет системные настройки произвольными значениями"
                        .to_string(),
                );
            };

            let mut restored: Vec<&str> = Vec::new();
            let mut failed: Vec<String> = Vec::new();

            if let Some(ref orig_nti) = backup.network_throttling_index {
                match self
                    .backend
                    .write_mm_dword("NetworkThrottlingIndex", orig_nti)
                {
                    Ok(()) => {
                        backup.network_throttling_index = None;
                        restored.push("NetworkThrottlingIndex");
                    }
                    Err(e) => failed.push(format!("NetworkThrottlingIndex: {e}")),
                }
            }

            if let Some(ref orig_sr) = backup.system_responsiveness {
                match self.backend.write_mm_dword("SystemResponsiveness", orig_sr) {
                    Ok(()) => {
                        backup.system_responsiveness = None;
                        restored.push("SystemResponsiveness");
                    }
                    Err(e) => failed.push(format!("SystemResponsiveness: {e}")),
                }
            }

            if backup.network_throttling_index.is_some() || backup.system_responsiveness.is_some() {
                store.packet_priority = Some(backup);
            }
            let save_res = self.save_store(&store);

            if !failed.is_empty() {
                return Err(format!(
                    "Частичный откат приоритета пакетов. Восстановлены: [{}]. Ошибки: [{}]. Невосстановленные исходные значения сохранены в резервной копии.",
                    if restored.is_empty() {
                        "нет".to_string()
                    } else {
                        restored.join(", ")
                    },
                    failed.join("; ")
                ));
            }
            save_res?;

            Ok(format!(
                "Восстановлены исходные системные значения: {}",
                restored.join(", ")
            ))
        }
    }

    pub fn get_ethernet_tuned(&self) -> Result<bool, String> {
        let adapters = self.backend.list_active_ethernet_adapters()?;
        let mut seen = 0usize;
        let mut tuned = 0usize;
        for adapter in adapters {
            for prop in adapter.properties {
                if is_target_keyword(&prop.registry_keyword) {
                    seen += 1;
                    if is_property_already_tuned(&prop) {
                        tuned += 1;
                    }
                }
            }
        }
        Ok(seen > 0 && tuned == seen)
    }

    pub fn get_status(&self) -> Result<NetworkOptimizerStatus, String> {
        let store = self.load_store()?;
        let packet_priority_enabled = self.get_packet_priority().unwrap_or(false);
        let ethernet_tuned = self.get_ethernet_tuned().unwrap_or(false);
        let backed_up_adapters_count = store
            .adapters
            .values()
            .filter(|a| !a.properties.is_empty())
            .count();
        Ok(NetworkOptimizerStatus {
            packet_priority_enabled,
            packet_priority_has_backup: store.packet_priority.is_some(),
            ethernet_tuned,
            ethernet_has_backup: backed_up_adapters_count > 0,
            backed_up_adapters_count,
        })
    }

    pub fn tune_ethernet_adapter(&self) -> Result<String, String> {
        if !self.backend.is_elevated_admin() {
            return Err("Требуются права Администратора (кнопка в шапке)".to_string());
        }

        let _lock = self
            .op_lock
            .lock()
            .map_err(|_| "Менеджер сетевых настроек заблокирован".to_string())?;

        let mut store = self.load_store()?;
        let live_adapters = self.backend.list_active_ethernet_adapters()?;

        struct PlannedChange {
            guid: String,
            adapter_name: String,
            keyword: String,
            target_display: String,
            backup: AdapterPropertyBackup,
            newly_backed_up: bool,
        }

        let mut plan: Vec<PlannedChange> = Vec::new();
        let now_ts = self.backend.now_timestamp();

        for adapter in &live_adapters {
            let guid = normalize_adapter_id(&adapter.interface_guid);
            if guid.is_empty() {
                continue;
            }
            for prop in &adapter.properties {
                if !is_target_keyword(&prop.registry_keyword) {
                    continue;
                }
                if is_property_already_tuned(prop) {
                    continue;
                }
                let Some(choice) = pick_tune_display_value(prop) else {
                    continue;
                };

                let entry =
                    store
                        .adapters
                        .entry(guid.clone())
                        .or_insert_with(|| AdapterTuningBackup {
                            interface_guid: guid.clone(),
                            interface_description: adapter.interface_description.clone(),
                            pnp_device_id: adapter.pnp_device_id.clone(),
                            mac_address: adapter.mac_address.clone(),
                            last_known_name: adapter.name.clone(),
                            captured_at: now_ts.clone(),
                            properties: HashMap::new(),
                        });

                entry.last_known_name = adapter.name.clone();
                if !adapter.pnp_device_id.is_empty() {
                    entry.pnp_device_id = adapter.pnp_device_id.clone();
                }

                let newly_backed_up = !entry.properties.contains_key(&prop.registry_keyword);
                let backup = entry
                    .properties
                    .entry(prop.registry_keyword.clone())
                    .or_insert_with(|| AdapterPropertyBackup {
                        registry_keyword: prop.registry_keyword.clone(),
                        display_name: prop.display_name.clone(),
                        original_registry_value: prop.registry_value.clone(),
                        original_display_value: prop.display_value.clone(),
                        applied_registry_value: None,
                        applied_display_value: Some(choice.clone()),
                    })
                    .clone();

                plan.push(PlannedChange {
                    guid: guid.clone(),
                    adapter_name: adapter.name.clone(),
                    keyword: prop.registry_keyword.clone(),
                    target_display: choice,
                    backup,
                    newly_backed_up,
                });
            }
        }

        if plan.is_empty() {
            // Очистим пустые записи адаптеров если ничего не запланировано и не было старых свойств
            store.adapters.retain(|_, a| !a.properties.is_empty());
            let _ = self.save_store(&store);
            return Err(
                "У активных физических Ethernet-адаптеров не найдены неизменённые параметры EEE, Green Ethernet или Interrupt Moderation"
                    .to_string(),
            );
        }

        // Атомарно сохраняем исходные значения ПЕРЕД модификацией драйвера
        self.save_store(&store)?;

        let mut applied: Vec<PlannedChange> = Vec::new();
        let mut iter = plan.into_iter();
        while let Some(item) = iter.next() {
            match self.backend.set_adapter_property(
                &item.guid,
                &item.keyword,
                None,
                Some(&item.target_display),
            ) {
                Ok(()) => {
                    applied.push(item);
                }
                Err(apply_err) => {
                    // Частичный сбой -> транзакционный откат применённых свойств
                    let mut rolled_back: Vec<String> = Vec::new();
                    let mut rollback_failed: Vec<String> = Vec::new();

                    for prev in applied.iter().rev() {
                        match self.backend.set_adapter_property(
                            &prev.guid,
                            &prev.keyword,
                            prev.backup.original_registry_value.as_deref(),
                            prev.backup.original_display_value.as_deref(),
                        ) {
                            Ok(()) => {
                                rolled_back.push(format!("{}/{}", prev.adapter_name, prev.keyword));
                                if prev.newly_backed_up {
                                    if let Some(ad) = store.adapters.get_mut(&prev.guid) {
                                        ad.properties.remove(&prev.keyword);
                                    }
                                }
                            }
                            Err(rb_err) => {
                                rollback_failed.push(format!(
                                    "{}/{} ({rb_err})",
                                    prev.adapter_name, prev.keyword
                                ));
                            }
                        }
                    }

                    // Удаляем из резервной копии текущий элемент и все ещё не запускавшиеся элементы, если они были добавлены только в этой транзакции
                    for unapplied in std::iter::once(item).chain(iter) {
                        if unapplied.newly_backed_up {
                            if let Some(ad) = store.adapters.get_mut(&unapplied.guid) {
                                ad.properties.remove(&unapplied.keyword);
                            }
                        }
                    }
                    store.adapters.retain(|_, a| !a.properties.is_empty());
                    let _ = self.save_store(&store);

                    let last_err_detail = rolled_back.join(", ");
                    return Err(format!(
                        "Сбой применения параметра драйвера ({apply_err}). Откачены: [{}]. Ошибки отката: [{}].",
                        if last_err_detail.is_empty() {
                            "нет".to_string()
                        } else {
                            last_err_detail
                        },
                        if rollback_failed.is_empty() {
                            "нет".to_string()
                        } else {
                            rollback_failed.join("; ")
                        }
                    ));
                }
            }
        }

        Ok(format!(
            "Оптимизировано параметров адаптера (с сохранением исходных): {}",
            applied.len()
        ))
    }

    pub fn set_ethernet_tuned(&self, enabled: bool) -> Result<String, String> {
        if enabled {
            return self.tune_ethernet_adapter();
        }
        if !self.backend.is_elevated_admin() {
            return Err("Требуются права Администратора (кнопка в шапке)".to_string());
        }

        let _lock = self
            .op_lock
            .lock()
            .map_err(|_| "Менеджер сетевых настроек заблокирован".to_string())?;

        let mut store = self.load_store()?;
        if store.adapters.is_empty() {
            return Err(
                "Резервная копия параметров Ethernet-адаптера не найдена — AURORA не меняет настройки драйвера, которые он не изменял"
                    .to_string(),
            );
        }

        let live_adapters = self.backend.list_active_ethernet_adapters()?;
        let mut live_by_guid: HashMap<String, &LiveEthernetAdapter> = HashMap::new();
        for adapter in &live_adapters {
            live_by_guid.insert(normalize_adapter_id(&adapter.interface_guid), adapter);
        }

        let mut restored_labels: Vec<String> = Vec::new();
        let mut failed_labels: Vec<String> = Vec::new();
        let mut missing_or_replaced: Vec<String> = Vec::new();

        let guids: Vec<String> = store.adapters.keys().cloned().collect();
        for guid in guids {
            let Some(adapter_backup) = store.adapters.get_mut(&guid) else {
                continue;
            };
            let Some(live) = live_by_guid.get(&guid).copied() else {
                missing_or_replaced.push(format!(
                    "{} ({}) — адаптер удалён или отключён",
                    adapter_backup.last_known_name, guid
                ));
                continue;
            };

            if !adapter_matches_hardware(adapter_backup, live) {
                missing_or_replaced.push(format!(
                    "{} ({}) — оборудование адаптера изменилось (PnP/описание не совпадает)",
                    adapter_backup.last_known_name, guid
                ));
                continue;
            }

            let keywords: Vec<String> = adapter_backup.properties.keys().cloned().collect();
            for kw in keywords {
                let Some(prop_backup) = adapter_backup.properties.get(&kw).cloned() else {
                    continue;
                };
                match self.backend.set_adapter_property(
                    &guid,
                    &kw,
                    prop_backup.original_registry_value.as_deref(),
                    prop_backup.original_display_value.as_deref(),
                ) {
                    Ok(()) => {
                        adapter_backup.properties.remove(&kw);
                        restored_labels.push(format!("{}/{}", live.name, kw));
                    }
                    Err(err) => {
                        failed_labels.push(format!("{}/{}: {err}", live.name, kw));
                    }
                }
            }
        }

        store.adapters.retain(|_, a| !a.properties.is_empty());
        let save_res = self.save_store(&store);

        if !failed_labels.is_empty() || !missing_or_replaced.is_empty() {
            return Err(format!(
                "Неполное восстановление параметров адаптера. Восстановлены: [{}]. Ошибки: [{}]. Недоступные/заменённые адаптеры: [{}]. Остальные резервные копии сохранены.",
                if restored_labels.is_empty() {
                    "нет".to_string()
                } else {
                    restored_labels.join(", ")
                },
                if failed_labels.is_empty() {
                    "нет".to_string()
                } else {
                    failed_labels.join("; ")
                },
                if missing_or_replaced.is_empty() {
                    "нет".to_string()
                } else {
                    missing_or_replaced.join("; ")
                }
            ));
        }

        save_res?;
        Ok(format!(
            "Восстановлены исходные параметры адаптера ({}): {}",
            restored_labels.len(),
            restored_labels.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockNetBackend {
        is_admin: Mutex<bool>,
        mm_values: Mutex<HashMap<String, SavedRegDword>>,
        fail_mm_write: Mutex<Option<String>>,
        adapters: Mutex<Vec<LiveEthernetAdapter>>,
        fail_prop_set: Mutex<HashMap<(String, String), String>>,
        fail_prop_after_count: Mutex<Option<usize>>,
        prop_set_calls: Mutex<usize>,
    }

    impl MockNetBackend {
        fn new() -> Self {
            Self {
                is_admin: Mutex::new(true),
                mm_values: Mutex::new(HashMap::new()),
                fail_mm_write: Mutex::new(None),
                adapters: Mutex::new(Vec::new()),
                fail_prop_set: Mutex::new(HashMap::new()),
                fail_prop_after_count: Mutex::new(None),
                prop_set_calls: Mutex::new(0),
            }
        }
    }

    impl NetworkOptimizerBackend for MockNetBackend {
        fn is_elevated_admin(&self) -> bool {
            *self.is_admin.lock().unwrap()
        }

        fn now_timestamp(&self) -> String {
            "1795000000".to_string()
        }

        fn read_mm_dword(&self, value_name: &str) -> Result<SavedRegDword, String> {
            Ok(self
                .mm_values
                .lock()
                .unwrap()
                .get(value_name)
                .cloned()
                .unwrap_or(SavedRegDword::Absent))
        }

        fn write_mm_dword(&self, value_name: &str, value: &SavedRegDword) -> Result<(), String> {
            if self.fail_mm_write.lock().unwrap().as_deref() == Some(value_name) {
                return Err(format!("mock write failure for {value_name}"));
            }
            let mut g = self.mm_values.lock().unwrap();
            match value {
                SavedRegDword::Present(v) => {
                    g.insert(value_name.to_string(), SavedRegDword::Present(*v));
                }
                SavedRegDword::Absent => {
                    g.remove(value_name);
                }
            }
            Ok(())
        }

        fn list_active_ethernet_adapters(&self) -> Result<Vec<LiveEthernetAdapter>, String> {
            Ok(self.adapters.lock().unwrap().clone())
        }

        fn set_adapter_property(
            &self,
            interface_guid: &str,
            registry_keyword: &str,
            registry_value: Option<&[String]>,
            display_value: Option<&str>,
        ) -> Result<(), String> {
            {
                let mut calls = self.prop_set_calls.lock().unwrap();
                *calls += 1;
                if let Some(limit) = *self.fail_prop_after_count.lock().unwrap() {
                    if *calls == limit {
                        return Err(format!("mock injected failure on call #{calls}"));
                    }
                }
            }
            let key = (
                normalize_adapter_id(interface_guid),
                registry_keyword.to_string(),
            );
            if let Some(err) = self.fail_prop_set.lock().unwrap().get(&key) {
                return Err(err.clone());
            }

            let mut adapters = self.adapters.lock().unwrap();
            let adapter = adapters
                .iter_mut()
                .find(|a| normalize_adapter_id(&a.interface_guid) == key.0)
                .ok_or_else(|| "adapter not found".to_string())?;
            let prop = adapter
                .properties
                .iter_mut()
                .find(|p| p.registry_keyword == registry_keyword)
                .ok_or_else(|| "property not found".to_string())?;
            if let Some(disp) = display_value {
                prop.display_value = Some(disp.to_string());
            }
            if let Some(reg) = registry_value {
                prop.registry_value = Some(reg.to_vec());
            }
            Ok(())
        }
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "nexus_netopt_{name}_{}_{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn packet_priority_saves_exact_original_values_distinguishes_absent_and_zero_and_restores() {
        let dir = TempDir::new("mm_restore");
        let backup_path = dir.0.join("network_optimizer_backup.json");
        let backend = Arc::new(MockNetBackend::new());

        // Нестандартные исходные значения: NetworkThrottlingIndex = 0 (НЕ Absent и НЕ 10!), SystemResponsiveness отсутствует (Absent!)
        backend.mm_values.lock().unwrap().insert(
            "NetworkThrottlingIndex".to_string(),
            SavedRegDword::Present(0),
        );

        let mgr =
            NetworkOptimizerManager::with_path_and_backend(backup_path.clone(), backend.clone());

        // Без резервной копии отключение НЕ должно придумывать 10 и 20!
        assert!(mgr.set_packet_priority(false).is_err());
        assert_eq!(
            backend.read_mm_dword("NetworkThrottlingIndex").unwrap(),
            SavedRegDword::Present(0)
        );

        // Включаем оптимизацию
        mgr.set_packet_priority(true).unwrap();
        assert!(mgr.get_packet_priority().unwrap());
        assert_eq!(
            backend.read_mm_dword("NetworkThrottlingIndex").unwrap(),
            SavedRegDword::Present(u32::MAX)
        );
        assert_eq!(
            backend.read_mm_dword("SystemResponsiveness").unwrap(),
            SavedRegDword::Present(0)
        );
        assert!(backup_path.exists());

        // Имитируем перезапуск приложения (новый менеджер читает файл с диска) и отключаем оптимизацию
        let mgr_restarted =
            NetworkOptimizerManager::with_path_and_backend(backup_path.clone(), backend.clone());
        mgr_restarted.set_packet_priority(false).unwrap();

        assert_eq!(
            backend.read_mm_dword("NetworkThrottlingIndex").unwrap(),
            SavedRegDword::Present(0),
            "Original 0 value must be restored instead of hardcoded 10"
        );
        assert_eq!(
            backend.read_mm_dword("SystemResponsiveness").unwrap(),
            SavedRegDword::Absent,
            "Originally absent parameter must be deleted instead of setting hardcoded 20"
        );
        assert!(!backup_path.exists());
    }

    #[test]
    fn packet_priority_rolls_back_on_partial_failure_and_preserves_backup() {
        let dir = TempDir::new("mm_partial");
        let backup_path = dir.0.join("network_optimizer_backup.json");
        let backend = Arc::new(MockNetBackend::new());
        backend.mm_values.lock().unwrap().insert(
            "NetworkThrottlingIndex".to_string(),
            SavedRegDword::Present(7),
        );
        backend.mm_values.lock().unwrap().insert(
            "SystemResponsiveness".to_string(),
            SavedRegDword::Present(15),
        );

        let mgr =
            NetworkOptimizerManager::with_path_and_backend(backup_path.clone(), backend.clone());

        // Ошибка записи SystemResponsiveness -> NetworkThrottlingIndex должен откатиться обратно на 7
        *backend.fail_mm_write.lock().unwrap() = Some("SystemResponsiveness".to_string());
        assert!(mgr.set_packet_priority(true).is_err());
        assert_eq!(
            backend.read_mm_dword("NetworkThrottlingIndex").unwrap(),
            SavedRegDword::Present(7)
        );
        assert!(!backup_path.exists());

        // Успешное включение -> частичный отказ при восстановлении -> резервная копия сохраняется для несброшенного поля
        *backend.fail_mm_write.lock().unwrap() = None;
        mgr.set_packet_priority(true).unwrap();

        *backend.fail_mm_write.lock().unwrap() = Some("SystemResponsiveness".to_string());
        let restore_err = mgr.set_packet_priority(false).unwrap_err();
        assert!(restore_err.contains("SystemResponsiveness"));
        assert_eq!(
            backend.read_mm_dword("NetworkThrottlingIndex").unwrap(),
            SavedRegDword::Present(7)
        );
        assert!(
            backup_path.exists(),
            "Partial restore failure must keep remaining backup"
        );

        // Повторное отключение после устранения ошибки корректно до-восстанавливает SystemResponsiveness = 15
        *backend.fail_mm_write.lock().unwrap() = None;
        mgr.set_packet_priority(false).unwrap();
        assert_eq!(
            backend.read_mm_dword("SystemResponsiveness").unwrap(),
            SavedRegDword::Present(15)
        );
        assert!(!backup_path.exists());
    }

    #[test]
    fn ethernet_tuning_backups_per_adapter_guid_rolls_back_partial_and_handles_removed_adapter() {
        let dir = TempDir::new("eth_backup");
        let backup_path = dir.0.join("network_optimizer_backup.json");
        let backend = Arc::new(MockNetBackend::new());

        let guid1 = "{AAAA-1111}".to_string();
        let guid2 = "{BBBB-2222}".to_string();
        *backend.adapters.lock().unwrap() = vec![
            LiveEthernetAdapter {
                interface_guid: guid1.clone(),
                name: "Gaming NIC".to_string(),
                interface_description: "Realtek PCIe 2.5GbE".to_string(),
                pnp_device_id: r"PCI\VEN_10EC&DEV_8125".to_string(),
                mac_address: "AA-BB-CC-DD-EE-01".to_string(),
                properties: vec![
                    LiveAdapterProperty {
                        registry_keyword: "*EEE".to_string(),
                        display_name: "Energy-Efficient Ethernet".to_string(),
                        display_value: Some("Enabled".to_string()),
                        registry_value: Some(vec!["1".to_string()]),
                        valid_display_values: vec!["Disabled".to_string(), "Enabled".to_string()],
                    },
                    LiveAdapterProperty {
                        registry_keyword: "*InterruptModeration".to_string(),
                        display_name: "Interrupt Moderation".to_string(),
                        display_value: Some("Extreme".to_string()),
                        registry_value: Some(vec!["3".to_string()]),
                        valid_display_values: vec![
                            "Disabled".to_string(),
                            "Low".to_string(),
                            "Extreme".to_string(),
                        ],
                    },
                ],
            },
            LiveEthernetAdapter {
                interface_guid: guid2.clone(),
                name: "USB Dongle".to_string(),
                interface_description: "ASIX USB Gigabit".to_string(),
                pnp_device_id: r"USB\VID_0B95".to_string(),
                mac_address: "AA-BB-CC-DD-EE-02".to_string(),
                properties: vec![LiveAdapterProperty {
                    registry_keyword: "*EEE".to_string(),
                    display_name: "EEE".to_string(),
                    display_value: Some("Enabled".to_string()),
                    registry_value: Some(vec!["1".to_string()]),
                    valid_display_values: vec!["Disabled".to_string(), "Enabled".to_string()],
                }],
            },
        ];

        let mgr =
            NetworkOptimizerManager::with_path_and_backend(backup_path.clone(), backend.clone());

        // 1. Частичный сбой на 2-м свойстве -> 1-е свойство должно откатиться на "Enabled"
        *backend.fail_prop_after_count.lock().unwrap() = Some(2);
        assert!(mgr.set_ethernet_tuned(true).is_err());
        assert_eq!(
            backend.adapters.lock().unwrap()[0].properties[0]
                .display_value
                .as_deref(),
            Some("Enabled"),
            "First applied property must roll back on partial tuning failure"
        );
        assert!(!backup_path.exists());

        // 2. Успешное применение обоих адаптеров (без вмешательства в прочие свойства)
        *backend.fail_prop_after_count.lock().unwrap() = None;
        mgr.set_ethernet_tuned(true).unwrap();
        assert!(mgr.get_ethernet_tuned().unwrap());
        assert_eq!(
            backend.adapters.lock().unwrap()[0].properties[1]
                .display_value
                .as_deref(),
            Some("Disabled")
        );

        // 3. Переименование первого адаптера и удаление второго (USB Dongle выдернут)
        {
            let mut ads = backend.adapters.lock().unwrap();
            ads[0].name = "Renamed Gaming LAN".to_string();
            ads.pop(); // Удаляем USB Dongle
        }

        // Отключение: первый адаптер восстанавливается в "Extreme" по GUID, второй сохраняет свой backup без паники
        let err = mgr.set_ethernet_tuned(false).unwrap_err();
        assert!(err.contains("USB Dongle"));
        assert_eq!(
            backend.adapters.lock().unwrap()[0].properties[0]
                .display_value
                .as_deref(),
            Some("Enabled")
        );
        assert_eq!(
            backend.adapters.lock().unwrap()[0].properties[1]
                .display_value
                .as_deref(),
            Some("Extreme"),
            "Must restore exact original 'Extreme' rather than hardcoded default"
        );

        // Первый адаптер уже удалён из резервной копии, остался только отсутствующий guid2
        let remaining_store = mgr.load_store().unwrap();
        assert!(!remaining_store.adapters.contains_key(&guid1));
        assert!(remaining_store.adapters.contains_key(&guid2));
    }
}
