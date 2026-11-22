use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::VecDeque;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Disks, Networks, System};
mod archive;
mod drop_server;
mod gpu_fallback;
mod net_monitor;
mod net_optimizer;
mod power_manager;
mod process_io;
mod process_labels;
mod profile;
mod scripts;
mod settings;
mod storage_index;
mod storage_smart;
mod telemetry;

use tauri::{Emitter, Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use winreg::RegKey;
#[cfg(target_os = "windows")]
use winreg::enums::*;

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
    pub net_ping_method: String,
    net_ping_sample: Option<ExternalRtt>,
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
    pub top_files: Vec<FileEntry>, // ТОП-100 самых больших файлов
    pub category_sizes: Vec<(String, u64)>, // ("Видео", 12345678), ("Игры и софт", ...)
    #[serde(default)]
    pub scan_id: u64,
    #[serde(default)]
    pub skipped_dirs_count: u64,
    #[serde(default)]
    pub access_denied_count: u64,
    #[serde(default)]
    pub skipped_files_count: u64,
    #[serde(default)]
    pub is_partial: bool,
    #[serde(default)]
    pub skipped_samples: Vec<String>,
    #[serde(default)]
    pub total_dirs_count: u64,
    #[serde(default)]
    pub excluded_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<StorageScanDiagnostics>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StorageScanDiagnostics {
    elapsed_ms: f64,
    enumeration_worker_ms: f64,
    metadata_worker_ms: f64,
    counting_worker_ms: f64,
    aggregation_worker_ms: f64,
    tree_worker_ms: f64,
    finalize_ms: f64,
    serialization_sample_ms: f64,
    json_bytes: usize,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_temp_sensor: Option<String>,
    pub max_core_temp_c: Option<f32>,
    pub avg_clock_mhz: Option<f32>,
    pub power_watts: Option<f32>,
    pub voltage_v: Option<f32>,
    pub core_temps: Vec<CoreTemp>,
    #[serde(default)]
    pub usage_percent: f32,
    #[serde(default)]
    pub base_clock_mhz: Option<f32>,
    #[serde(default)]
    pub physical_cores: u32,
    #[serde(default)]
    pub logical_cores: u32,
    #[serde(default)]
    pub core_loads: Vec<f32>,
    #[serde(default)]
    pub hvci_enabled: bool,
}

fn validate_cpu_package(cpu: &mut CpuTelemetry) {
    let named_package = cpu.package_temp_sensor.as_deref().is_some_and(|sensor| {
        sensor.eq_ignore_ascii_case("CPU Package") || sensor.eq_ignore_ascii_case("Package")
    });
    if !named_package || !cpu.package_temp_c.is_some_and(f32::is_finite) {
        cpu.package_temp_c = None;
        cpu.package_temp_sensor = None;
    }
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
    #[serde(default)]
    pub load_percent: Option<f32>,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub vram_used_mb: Option<f32>,
    #[serde(default)]
    pub vram_total_mb: Option<f32>,
    #[serde(default)]
    pub vram_used_percent: Option<f32>,
    #[serde(default)]
    pub d3d_shared_mb: Option<f32>,
    #[serde(default)]
    pub memory_controller_load_percent: Option<f32>,
    #[serde(default)]
    pub video_engine_load_percent: Option<f32>,
    #[serde(default)]
    pub power_limit_percent: Option<f32>,
    #[serde(default)]
    pub pcie_rx_mb_s: Option<f32>,
    #[serde(default)]
    pub pcie_tx_mb_s: Option<f32>,
    #[serde(default)]
    pub fans: Vec<FanSensorItem>,
    #[serde(default)]
    pub telemetry_source: String,
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
    #[serde(default)]
    pub telemetry_stale: bool,
    #[serde(default)]
    pub sample_age_ms: Option<u64>,
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
    pub has_main_window: bool,
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub exe_path: String,
    pub cpu_usage: f32, // процент загрузки CPU (нормализован к числу логических ядер)
    pub memory_mb: f64, // занятая память в МБ
    pub disk_read_bytes_sec: f64,
    pub disk_write_bytes_sec: f64,
    disk_status: process_io::Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    disk_error_code: Option<u32>,
    pub run_time_sec: u64,
    pub start_time: u64,
    pub thread_count: u32,
    pub handle_count: u32,
    pub status: String,
    pub icon_base64: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProcessDetails {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub parent_name: Option<String>,
    pub name: String,
    pub exe_path: String,
    pub command_line: String,
    pub working_dir: String,
    pub status: String,
    pub cpu_usage: f32,
    pub memory_mb: f64,
    pub virtual_memory_mb: f64,
    pub run_time_sec: u64,
    pub start_time: u64,
    pub thread_count: u32,
    pub handle_count: u32,
    pub child_count: usize,
    pub total_descendants: usize,
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriveVolumeInfo {
    pub mount_point: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HwmonStatus {
    Ready,
    Restarting,
    DriverBlocked,
    Offline,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HwmonStatusResponse {
    pub status: HwmonStatus,
    pub restart_count: u32,
    pub last_error: Option<String>,
    pub telemetry_stale: bool,
    pub sample_age_ms: Option<u64>,
}

const HWMON_STARTUP_GRACE: Duration = Duration::from_secs(12);
const HWMON_STALE_THRESHOLD: Duration = Duration::from_secs(5);
const HWMON_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(10);
const HWMON_MAX_AUTO_RESTARTS: u32 = 5;

pub struct HwmonWatchdogState {
    pub status: HwmonStatus,
    pub restart_count: u32,
    pub last_error: Option<String>,
    pub last_stderr_line: Option<String>,
    generation: u64,
    pub manual_restart_in_progress: bool,
    pub shutdown_requested: bool,
    pub initial_spawn_attempted: bool,
    pub auto_restarts_exhausted: bool,
    pub last_spawn_at: Option<Instant>,
    pub last_sample_at: Option<Instant>,
    pub last_sample_timestamp_ms: Option<u64>,
}

impl Default for HwmonWatchdogState {
    fn default() -> Self {
        Self {
            status: HwmonStatus::Offline,
            restart_count: 0,
            last_error: None,
            last_stderr_line: None,
            generation: 0,
            manual_restart_in_progress: false,
            shutdown_requested: false,
            initial_spawn_attempted: false,
            auto_restarts_exhausted: false,
            last_spawn_at: None,
            last_sample_at: None,
            last_sample_timestamp_ms: None,
        }
    }
}

struct ActiveStorageScan {
    scan_id: u64,
    target_path: String,
    cancel_token: Arc<AtomicBool>,
}

pub struct ScanOperationGuard {
    coordinator: Arc<StorageScanCoordinator>,
    pub scan_id: u64,
    pub cancel_token: Arc<AtomicBool>,
}

impl Drop for ScanOperationGuard {
    fn drop(&mut self) {
        self.coordinator.release_scan(self.scan_id);
    }
}

pub struct StorageScanCoordinator {
    next_scan_id: AtomicU64,
    active: Mutex<Option<ActiveStorageScan>>,
    indexes: Mutex<VecDeque<(u64, Arc<storage_index::StorageIndex>)>>,
}

impl StorageScanCoordinator {
    pub fn new() -> Self {
        Self {
            next_scan_id: AtomicU64::new(1),
            active: Mutex::new(None),
            indexes: Mutex::new(VecDeque::new()),
        }
    }

    /// Регистрирует новую операцию сканирования с уникальным scan_id и изолированным токеном отмены.
    /// Если предыдущее сканирование ещё не завершилось, помечает его токен как отменённый —
    /// новое сканирование никогда не может случайно сбросить флаг отмены старого.
    pub fn begin_scan(self: &Arc<Self>, target_path: String) -> ScanOperationGuard {
        let scan_id = self.next_scan_id.fetch_add(1, Ordering::SeqCst);
        let cancel_token = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.active.lock() {
            if let Some(prev) = guard.take() {
                prev.cancel_token.store(true, Ordering::SeqCst);
            }
            *guard = Some(ActiveStorageScan {
                scan_id,
                target_path,
                cancel_token: Arc::clone(&cancel_token),
            });
        }
        ScanOperationGuard {
            coordinator: Arc::clone(self),
            scan_id,
            cancel_token,
        }
    }

    pub fn release_scan(&self, scan_id: u64) {
        if let Ok(mut guard) = self.active.lock() {
            if guard
                .as_ref()
                .is_some_and(|active| active.scan_id == scan_id)
            {
                *guard = None;
            }
        }
    }

    pub fn cancel_scan(&self, scan_id: Option<u64>) -> bool {
        if let Ok(guard) = self.active.lock() {
            if let Some(ref active) = *guard {
                if scan_id.is_none_or(|target_id| target_id == active.scan_id) {
                    active.cancel_token.store(true, Ordering::SeqCst);
                    return true;
                }
            }
        }
        false
    }

    fn store_index(&self, id: u64, index: storage_index::StorageIndex) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Состояние сканера недоступно")?;
        if !active
            .as_ref()
            .is_some_and(|scan| scan.scan_id == id && !scan.cancel_token.load(Ordering::SeqCst))
        {
            return Err("SCAN_CANCELLED".into());
        }
        let mut indexes = self
            .indexes
            .lock()
            .map_err(|_| "Индекс сканирования недоступен")?;
        indexes.retain(|(_, old)| old.path != index.path);
        indexes.push_back((id, Arc::new(index)));
        while indexes.len() > 2 {
            indexes.pop_front();
        }
        Ok(())
    }

    fn index(&self, id: u64) -> Result<Arc<storage_index::StorageIndex>, String> {
        let indexes = self
            .indexes
            .lock()
            .map_err(|_| "Индекс сканирования недоступен")?;
        indexes
            .iter()
            .find(|(scan_id, _)| *scan_id == id)
            .map(|(_, index)| Arc::clone(index))
            .ok_or_else(|| "Снимок устарел. Просканируйте том повторно.".into())
    }

    pub fn active_scan_snapshot(&self) -> Option<(u64, String)> {
        self.active
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|a| (a.scan_id, a.target_path.clone())))
    }
}

// Хранилище состояния приложения
pub struct AppState {
    pub sys: Arc<Mutex<System>>,
    pub networks: Arc<Mutex<Networks>>,
    pub networks_last_refresh: Arc<Mutex<Option<Instant>>>,
    pub disk_space: Arc<Mutex<(u64, u64)>>,
    ping_cache: Arc<Mutex<ExternalPingCache>>,
    process_io_sample: Arc<Mutex<process_io::History>>,
    pub pid_cache: Arc<Mutex<HashMap<u32, (String, String)>>>,
    pub hw_telemetry: Arc<Mutex<Option<HardwareTelemetry>>>,
    pub hw_sidecar_child: Arc<Mutex<Option<Child>>>,
    pub hwmon_watchdog: Arc<Mutex<HwmonWatchdogState>>,
    pub storage_scanner: Arc<StorageScanCoordinator>,
    pub power_timer: Arc<power_manager::PowerTimerManager>,
    pub net_optimizer: Arc<net_optimizer::NetworkOptimizerManager>,
    pub icon_cache: Arc<Mutex<HashMap<String, String>>>,
    pub drop_hub: Arc<drop_server::DropHub>,
    pub tray_ping_item: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
    pub history_buffer: Arc<RwLock<VecDeque<telemetry::TelemetrySnapshot>>>,
    pub gpu_pdh: Arc<Mutex<gpu_fallback::GpuPdhSampler>>,
    pub net_monitor: Arc<Mutex<net_monitor::NetworkMonitorState>>,
}

impl Drop for AppState {
    fn drop(&mut self) {
        if let Ok(mut wd) = self.hwmon_watchdog.lock() {
            wd.shutdown_requested = true;
        }
        terminate_sidecar_child(&self.hw_sidecar_child);
    }
}

fn normalize_sidecar_path(cand: &Path) -> Option<PathBuf> {
    if !cand.is_file() {
        return None;
    }
    let abs = std::fs::canonicalize(cand)
        .or_else(|_| std::env::current_dir().map(|cwd| cwd.join(cand)))
        .ok()?;
    let raw = abs.to_string_lossy();
    let stripped = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    Some(PathBuf::from(stripped))
}

fn find_hwmon_sidecar_exe() -> Option<PathBuf> {
    // The installed application may be elevated. Only its own bundled
    // helper is eligible in production, regardless of the working directory.
    let exe = std::env::current_exe().ok()?;
    let installed = exe.parent()?.join("aurora-hwmon.exe");
    if !cfg!(debug_assertions) || installed.is_file() {
        return normalize_sidecar_path(&installed);
    }
    // Cargo tests and Tauri dev can start with different current directories.
    // Use the staged, project-owned resource for both.
    normalize_sidecar_path(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("nexus-hwmon.exe"))
}

fn is_driver_blocked_indicator(exit_code: Option<i32>, stderr_line: Option<&str>) -> bool {
    if exit_code.is_some_and(|code| matches!(code as u32, 1275 | 577 | 0xC0000428)) {
        return true;
    }
    stderr_line.is_some_and(|line| {
        let lower = line.to_ascii_lowercase();
        let driver = ["driver", "winring0", "inpout", "ring0"]
            .iter()
            .any(|part| lower.contains(part));
        driver
            && [
                "blocked",
                "invalid image hash",
                "cannot verify the digital signature",
                "0x4fb",
                "1275",
            ]
            .iter()
            .any(|part| lower.contains(part))
    })
}

fn terminate_sidecar_child(child_holder: &Mutex<Option<Child>>) {
    let taken = child_holder.lock().ok().and_then(|mut guard| guard.take());
    stop_sidecar_process(taken);
}

fn stop_sidecar_process(taken: Option<Child>) {
    if let Some(mut child) = taken {
        drop(child.stdin.take());
        if matches!(child.try_wait(), Ok(None) | Err(_)) {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

fn check_sidecar_child_live(
    child_holder: &Mutex<Option<Child>>,
    consume_exit: bool,
) -> (bool, Option<Option<i32>>) {
    let Ok(mut guard) = child_holder.lock() else {
        return (false, None);
    };
    match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(status)) => {
                if consume_exit {
                    let _ = guard.take();
                }
                (false, Some(status.code()))
            }
            Ok(None) => (true, None),
            Err(_) => (true, None),
        },
        None => (false, None),
    }
}

fn compute_hwmon_staleness(
    wd: &HwmonWatchdogState,
    has_live_child: bool,
    now: Instant,
) -> (bool, Option<u64>) {
    let sample_age_ms = wd
        .last_sample_at
        .map(|at| now.saturating_duration_since(at).as_millis() as u64);
    let stale = match sample_age_ms {
        Some(age) => !has_live_child || age >= HWMON_STALE_THRESHOLD.as_millis() as u64,
        None => false,
    };
    (stale, sample_age_ms)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HwmonWatchdogAction {
    Idle,
    ExitThread,
    StopWithFailure {
        kill_hung_child: bool,
        driver_blocked: bool,
    },
    RestartAfterBackoff {
        delay_secs: u64,
        kill_hung_child: bool,
    },
}

fn evaluate_hwmon_watchdog_step(
    wd: &mut HwmonWatchdogState,
    child_alive: bool,
    exit_status: Option<Option<i32>>,
    now: Instant,
) -> HwmonWatchdogAction {
    if wd.shutdown_requested {
        return HwmonWatchdogAction::ExitThread;
    }
    if wd.manual_restart_in_progress {
        return HwmonWatchdogAction::Idle;
    }

    let failure: Option<(bool, Option<i32>, String)> = if child_alive {
        if let Some(last_sample) = wd.last_sample_at {
            if now.saturating_duration_since(last_sample) >= HWMON_HEARTBEAT_TIMEOUT {
                Some((
                    true,
                    None,
                    "Отсутствует свежая телеметрия от сайдкара (таймаут heartbeat > 10 сек)"
                        .to_string(),
                ))
            } else {
                None
            }
        } else if let Some(spawned_at) = wd.last_spawn_at {
            if now.saturating_duration_since(spawned_at) >= HWMON_STARTUP_GRACE {
                Some((
                    true,
                    None,
                    "Сайдкар не прислал стартовый снимок телеметрии в течение 12 сек".to_string(),
                ))
            } else {
                None
            }
        } else {
            None
        }
    } else if let Some(code_opt) = exit_status {
        let reason = wd
            .last_stderr_line
            .clone()
            .unwrap_or_else(|| format!("Сайдкар неожиданно завершился (код {:?})", code_opt));
        Some((false, code_opt, reason))
    } else if wd.initial_spawn_attempted
        && wd.status != HwmonStatus::DriverBlocked
        && !wd.auto_restarts_exhausted
        && (wd.last_error.is_some()
            || wd.last_spawn_at.is_none_or(|started| {
                now.saturating_duration_since(started) >= HWMON_STARTUP_GRACE
            }))
    {
        let reason = wd.last_error.clone().unwrap_or_else(|| {
            "Сервис аппаратных датчиков не запущен после первоначального сбоя".to_string()
        });
        Some((false, None, reason))
    } else {
        None
    };

    let Some((kill_hung_child, exit_code, reason)) = failure else {
        return HwmonWatchdogAction::Idle;
    };

    if wd.status == HwmonStatus::DriverBlocked
        || is_driver_blocked_indicator(exit_code, wd.last_stderr_line.as_deref())
    {
        wd.status = HwmonStatus::DriverBlocked;
        wd.last_error = Some(wd.last_stderr_line.clone().unwrap_or(reason));
        return HwmonWatchdogAction::StopWithFailure {
            kill_hung_child,
            driver_blocked: true,
        };
    }

    if wd.restart_count < HWMON_MAX_AUTO_RESTARTS {
        const BACKOFF_SECS: [u64; 5] = [1, 3, 5, 10, 10];
        let attempt_idx = wd.restart_count as usize;
        wd.restart_count += 1;
        wd.status = HwmonStatus::Restarting;
        wd.last_error = Some(reason);
        HwmonWatchdogAction::RestartAfterBackoff {
            delay_secs: BACKOFF_SECS[attempt_idx.min(BACKOFF_SECS.len() - 1)],
            kill_hung_child,
        }
    } else {
        wd.auto_restarts_exhausted = true;
        wd.status = HwmonStatus::Offline;
        wd.last_error =
            Some("Служба датчиков остановлена после 5 неудачных попыток перезапуска".to_string());
        HwmonWatchdogAction::StopWithFailure {
            kill_hung_child,
            driver_blocked: false,
        }
    }
}

fn spawn_hwmon_sidecar(
    telemetry_cache: Arc<Mutex<Option<HardwareTelemetry>>>,
    child_holder: Arc<Mutex<Option<Child>>>,
    watchdog_state: Arc<Mutex<HwmonWatchdogState>>,
    expected_generation: u64,
) -> Result<(), String> {
    let (generation, previous) = {
        let mut wd = watchdog_state
            .lock()
            .map_err(|_| "Недоступно состояние службы датчиков")?;
        if !accepts_hwmon_generation(&wd, expected_generation) {
            return Err("Запуск службы датчиков отменён".to_string());
        }
        let previous = child_holder
            .lock()
            .map_err(|_| "Недоступен процесс службы датчиков")?
            .take();
        wd.generation += 1;
        wd.initial_spawn_attempted = true;
        wd.last_spawn_at = Some(Instant::now());
        wd.last_sample_at = None;
        wd.last_stderr_line = None;
        wd.last_error = None;
        (wd.generation, previous)
    };
    stop_sidecar_process(previous);

    let Some(exe_path) = find_hwmon_sidecar_exe() else {
        if let Ok(mut wd) = watchdog_state.lock()
            && accepts_hwmon_generation(&wd, generation)
        {
            wd.status = HwmonStatus::Offline;
            wd.last_error =
                Some("Сервис аппаратных датчиков отсутствует в каталоге приложения".to_string());
        }
        return Err("Сервис аппаратных датчиков отсутствует в каталоге приложения".to_string());
    };

    let mut cmd = Command::new(&exe_path);
    if let Some(parent_dir) = exe_path.parent() {
        if !parent_dir.as_os_str().is_empty() && parent_dir.is_dir() {
            cmd.current_dir(parent_dir);
        }
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("Не удалось запустить сервис аппаратных датчиков: {e}");
        if let Ok(mut wd) = watchdog_state.lock()
            && accepts_hwmon_generation(&wd, generation)
        {
            wd.status = HwmonStatus::Offline;
            wd.last_error = Some(msg.clone());
        }
        msg
    })?;

    let Some(stdout) = child.stdout.take() else {
        drop(child.stdin.take());
        let _ = child.kill();
        let _ = child.wait();
        if let Ok(mut wd) = watchdog_state.lock()
            && accepts_hwmon_generation(&wd, generation)
        {
            wd.status = HwmonStatus::Offline;
            wd.last_error = Some("Не удалось подключиться к stdout сайдкара".to_string());
        }
        return Err("Не удалось подключиться к stdout сайдкара".to_string());
    };
    let stderr_opt = child.stderr.take();

    let mut candidate = Some(child);
    if let Ok(wd) = watchdog_state.lock()
        && accepts_hwmon_generation(&wd, generation)
        && let Ok(mut guard) = child_holder.lock()
    {
        *guard = candidate.take();
    }
    if candidate.is_some() {
        stop_sidecar_process(candidate);
        return Err("Запуск службы датчиков отменён".into());
    }

    if let Some(stderr) = stderr_opt {
        let wd_stderr = Arc::clone(&watchdog_state);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line_res in reader.lines() {
                let Ok(line) = line_res else {
                    break;
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(mut wd) = wd_stderr.lock() {
                    if !accepts_hwmon_generation(&wd, generation) {
                        break;
                    }
                    wd.last_stderr_line = Some(trimmed.to_string());
                    if is_driver_blocked_indicator(None, Some(trimmed)) {
                        wd.status = HwmonStatus::DriverBlocked;
                        wd.last_error = Some(trimmed.to_string());
                    }
                }
            }
        });
    }

    let wd_stdout = Arc::clone(&watchdog_state);
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
            if let Ok(mut parsed) = serde_json::from_str::<HardwareTelemetry>(trimmed) {
                validate_cpu_package(&mut parsed.cpu);
                parsed.telemetry_stale = false;
                parsed.sample_age_ms = Some(0);
                if let Ok(mut wd) = wd_stdout.lock() {
                    if !accepts_hwmon_generation(&wd, generation) {
                        break;
                    }
                    wd.last_sample_at = Some(Instant::now());
                    wd.last_sample_timestamp_ms = Some(parsed.timestamp_ms);
                    if wd.status != HwmonStatus::DriverBlocked {
                        wd.status = HwmonStatus::Ready;
                        wd.last_error = None;
                        wd.restart_count = 0;
                        wd.auto_restarts_exhausted = false;
                    }
                    if let Ok(mut cache) = telemetry_cache.lock() {
                        *cache = Some(parsed);
                    }
                }
            }
        }
    });

    Ok(())
}

fn accepts_hwmon_generation(wd: &HwmonWatchdogState, generation: u64) -> bool {
    !wd.shutdown_requested && wd.generation == generation
}

#[test]
fn hardware_package_provenance_and_watchdog_restart_are_independent() {
    let mut cpu = CpuTelemetry {
        package_temp_c: Some(52.0),
        max_core_temp_c: Some(65.0),
        package_temp_sensor: Some("Core #1".into()),
        ..Default::default()
    };
    validate_cpu_package(&mut cpu);
    assert_eq!(cpu.package_temp_c, None);
    assert_eq!(cpu.max_core_temp_c, Some(65.0));
    cpu.package_temp_sensor = Some("CPU Package".into());
    cpu.package_temp_c = Some(55.0);
    validate_cpu_package(&mut cpu);
    assert_eq!(cpu.package_temp_c, Some(55.0));

    let mut wd = HwmonWatchdogState {
        generation: 2,
        ..Default::default()
    };
    assert!(!accepts_hwmon_generation(&wd, 1));
    assert!(accepts_hwmon_generation(&wd, 2));
    wd.shutdown_requested = true;
    assert!(!accepts_hwmon_generation(&wd, 2));
    assert!(!is_driver_blocked_indicator(
        None,
        Some("driver telemetry initialized")
    ));
    assert!(is_driver_blocked_indicator(
        None,
        Some("WinRing0 driver blocked")
    ));
    assert!(is_driver_blocked_indicator(
        Some(0xC0000428u32 as i32),
        None
    ));
}

fn start_hwmon_watchdog(
    telemetry_cache: Arc<Mutex<Option<HardwareTelemetry>>>,
    child_holder: Arc<Mutex<Option<Child>>>,
    watchdog_state: Arc<Mutex<HwmonWatchdogState>>,
) {
    std::thread::Builder::new()
        .name("nexus-hwmon-watchdog".to_string())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(1));

                let now = Instant::now();

                let (action, generation, stopped_child) = {
                    let Ok(mut wd) = watchdog_state.lock() else {
                        continue;
                    };
                    let (child_alive, exit_status) = check_sidecar_child_live(&child_holder, true);
                    let action =
                        evaluate_hwmon_watchdog_step(&mut wd, child_alive, exit_status, now);
                    let stopped_child = match action {
                        HwmonWatchdogAction::RestartAfterBackoff {
                            kill_hung_child, ..
                        }
                        | HwmonWatchdogAction::StopWithFailure {
                            kill_hung_child, ..
                        } => {
                            wd.generation += 1;
                            if kill_hung_child {
                                child_holder.lock().ok().and_then(|mut guard| guard.take())
                            } else {
                                None
                            }
                        }
                        _ => None,
                    };
                    (action, wd.generation, stopped_child)
                };
                stop_sidecar_process(stopped_child);

                match action {
                    HwmonWatchdogAction::ExitThread => break,
                    HwmonWatchdogAction::Idle => continue,
                    HwmonWatchdogAction::StopWithFailure {
                        kill_hung_child: _,
                        driver_blocked: _,
                    } => {
                        continue;
                    }
                    HwmonWatchdogAction::RestartAfterBackoff {
                        delay_secs,
                        kill_hung_child: _,
                    } => {
                        let mut cancelled_or_shutdown = false;
                        for _ in 0..(delay_secs * 5) {
                            std::thread::sleep(Duration::from_millis(200));
                            if let Ok(wd) = watchdog_state.lock() {
                                if wd.shutdown_requested {
                                    return;
                                }
                                if !accepts_hwmon_generation(&wd, generation) {
                                    cancelled_or_shutdown = true;
                                    break;
                                }
                            }
                        }

                        if cancelled_or_shutdown {
                            continue;
                        }
                        if watchdog_state
                            .lock()
                            .map(|wd| !accepts_hwmon_generation(&wd, generation))
                            .unwrap_or(false)
                        {
                            continue;
                        }

                        let _ = spawn_hwmon_sidecar(
                            Arc::clone(&telemetry_cache),
                            Arc::clone(&child_holder),
                            Arc::clone(&watchdog_state),
                            generation,
                        );
                    }
                }
            }
        })
        .ok();
}

#[tauri::command]
fn get_hwmon_status(state: State<'_, AppState>) -> HwmonStatusResponse {
    let now = Instant::now();
    if let Ok(wd) = state.hwmon_watchdog.lock() {
        let (has_live_child, _) = check_sidecar_child_live(&state.hw_sidecar_child, false);
        let (telemetry_stale, sample_age_ms) = compute_hwmon_staleness(&wd, has_live_child, now);
        HwmonStatusResponse {
            status: wd.status,
            restart_count: wd.restart_count,
            last_error: wd.last_error.clone(),
            telemetry_stale,
            sample_age_ms,
        }
    } else {
        HwmonStatusResponse {
            status: HwmonStatus::Offline,
            restart_count: 0,
            last_error: Some("Не удалось прочитать статус Watchdog".to_string()),
            telemetry_stale: false,
            sample_age_ms: None,
        }
    }
}

#[tauri::command]
async fn restart_hwmon(state: State<'_, AppState>) -> Result<(), String> {
    let telemetry_cache = Arc::clone(&state.hw_telemetry);
    let child_holder = Arc::clone(&state.hw_sidecar_child);
    let watchdog_state = Arc::clone(&state.hwmon_watchdog);

    tauri::async_runtime::spawn_blocking(move || {
        let generation = {
            let mut wd = watchdog_state
                .lock()
                .map_err(|_| "Недоступно состояние службы датчиков")?;
            if wd.shutdown_requested || wd.manual_restart_in_progress {
                return Err("Перезапуск службы датчиков сейчас недоступен".into());
            }
            wd.generation += 1;
            wd.manual_restart_in_progress = true;
            wd.status = HwmonStatus::Restarting;
            wd.restart_count = 0;
            wd.auto_restarts_exhausted = false;
            wd.last_error = None;
            wd.last_stderr_line = None;
            wd.last_sample_at = None;
            if let Ok(mut cache) = telemetry_cache.lock() {
                *cache = None;
            }
            wd.generation
        };

        let res = spawn_hwmon_sidecar(
            Arc::clone(&telemetry_cache),
            Arc::clone(&child_holder),
            Arc::clone(&watchdog_state),
            generation,
        );

        if let Ok(mut wd) = watchdog_state.lock() {
            wd.manual_restart_in_progress = false;
        }

        res
    })
    .await
    .map_err(|e| format!("Ошибка потока перезапуска сайдкара: {e}"))?
}

fn build_storage_temp_items(lhm_items: &[StorageTempItem]) -> Vec<StorageTempItem> {
    static FALLBACK_CACHE: std::sync::OnceLock<Mutex<Option<(Instant, Vec<StorageTempItem>)>>> =
        std::sync::OnceLock::new();

    if lhm_items.is_empty() {
        let cache_mutex = FALLBACK_CACHE.get_or_init(|| Mutex::new(None));
        if let Ok(guard) = cache_mutex.lock() {
            if let Some((at, ref cached)) = *guard {
                if at.elapsed() < Duration::from_secs(5) {
                    return cached.clone();
                }
            }
        }
    }

    let smart_disks = storage_smart::query_physical_disks_smart_cached(false);
    let disks = Disks::new_with_refreshed_list();

    let mut total_vol_bytes: f64 = 0.0;
    let mut used_vol_bytes: f64 = 0.0;
    let mut volume_rows: Vec<StorageTempItem> = Vec::new();
    for d in disks.iter() {
        let total = d.total_space() as f64;
        if total <= 0.0 {
            continue;
        }
        let used = (total - (d.available_space() as f64)).max(0.0);
        total_vol_bytes += total;
        used_vol_bytes += used;
        let used_pct = Some(((used / total) * 100.0) as f32);
        let mount = d.mount_point().to_string_lossy().to_string();
        let disk_name = d.name().to_string_lossy().to_string();
        volume_rows.push(StorageTempItem {
            name: if disk_name.is_empty() {
                format!("Том ({mount})")
            } else {
                format!("{disk_name} ({mount})")
            },
            temp_c: None,
            used_percent: used_pct,
        });
    }
    let overall_used_pct = if total_vol_bytes > 0.0 {
        Some(((used_vol_bytes / total_vol_bytes) * 100.0) as f32)
    } else {
        None
    };

    if !lhm_items.is_empty() {
        return merge_lhm_storage_items(lhm_items, &smart_disks, overall_used_pct);
    }

    let result = if !smart_disks.is_empty() {
        let single_drive = smart_disks.len() == 1;
        let mut items: Vec<StorageTempItem> = smart_disks
            .iter()
            .map(|s| StorageTempItem {
                name: format!("{} ({})", s.model, s.kind),
                temp_c: s.temp_c.map(|t| t as f32),
                used_percent: if single_drive { overall_used_pct } else { None },
            })
            .collect();
        if !single_drive {
            items.extend(volume_rows);
        }
        items
    } else {
        volume_rows
    };

    let cache_mutex = FALLBACK_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cache_mutex.lock() {
        *guard = Some((Instant::now(), result.clone()));
    }
    result
}

pub(crate) fn merge_lhm_storage_items(
    lhm_items: &[StorageTempItem],
    smart_disks: &[storage_smart::SmartDiskMetrics],
    overall_used_pct: Option<f32>,
) -> Vec<StorageTempItem> {
    lhm_items
        .iter()
        .map(|item| {
            let mut cloned = item.clone();
            if cloned.temp_c.is_none() {
                let item_low = cloned.name.to_ascii_lowercase();
                if let Some(matched) = smart_disks
                    .iter()
                    .find(|s| {
                        let m = s.model.to_ascii_lowercase();
                        !m.is_empty() && (item_low.contains(&m) || m.contains(&item_low))
                    })
                    .or_else(|| {
                        if smart_disks.len() == 1 {
                            smart_disks.first()
                        } else {
                            None
                        }
                    })
                {
                    cloned.temp_c = matched.temp_c.map(|t| t as f32);
                }
            }
            if cloned.used_percent.is_none() && smart_disks.len() <= 1 {
                cloned.used_percent = overall_used_pct;
            }
            cloned
        })
        .collect()
}

#[tauri::command]
async fn get_hardware_telemetry(state: State<'_, AppState>) -> Result<HardwareTelemetry, String> {
    let sys_arc = Arc::clone(&state.sys);
    let hw_telemetry_arc = Arc::clone(&state.hw_telemetry);
    let hw_sidecar_child_arc = Arc::clone(&state.hw_sidecar_child);
    let hwmon_watchdog_arc = Arc::clone(&state.hwmon_watchdog);
    let gpu_pdh_arc = Arc::clone(&state.gpu_pdh);

    tauri::async_runtime::spawn_blocking(move || {
        // Читаем базовые данные и поточную загрузку процессора из sysinfo
        let (
            fallback_cpu_name,
            base_clock_mhz,
            usage_percent,
            physical_cores,
            logical_cores,
            core_loads,
        ) = if let Ok(mut sys) = sys_arc.lock() {
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
            let loads: Vec<f32> = cpus.iter().map(|c| c.cpu_usage()).collect();
            let phys = sys.physical_core_count().unwrap_or(cpus.len()) as u32;
            (
                name,
                avg_freq,
                sys.global_cpu_usage(),
                phys,
                cpus.len() as u32,
                loads,
            )
        } else {
            ("Процессор x64".to_string(), None, 0.0, 0, 0, Vec::new())
        };

        let hvci_enabled = gpu_fallback::is_hvci_enabled();
        let (has_live_child, watchdog_stale, watchdog_age_ms, existing_telemetry) =
            hwmon_watchdog_arc
                .lock()
                .map(|wd| {
                    let (live, _) = check_sidecar_child_live(&hw_sidecar_child_arc, false);
                    let (stale, age) = compute_hwmon_staleness(&wd, live, Instant::now());
                    (
                        live,
                        stale,
                        age,
                        hw_telemetry_arc.lock().ok().and_then(|guard| guard.clone()),
                    )
                })
                .unwrap_or((false, true, None, None));

        if let Some(mut data) = existing_telemetry {
            let needs_gpu_pdh =
                data.gpus.is_empty() || data.gpus.iter().any(|gpu| gpu.load_percent.is_none());
            let (pdh_gpu_load, pdh_cpu_clock) = gpu_pdh_arc
                .lock()
                .ok()
                .map(|mut s| s.sample_hardware_pdh(needs_gpu_pdh, base_clock_mhz))
                .unwrap_or((None, None));

            data.telemetry_stale = watchdog_stale;
            data.sample_age_ms = watchdog_age_ms;
            let heartbeat_expired = watchdog_age_ms
                .map(|ms| ms >= HWMON_HEARTBEAT_TIMEOUT.as_millis() as u64)
                .unwrap_or(false);
            data.sidecar_online = has_live_child && !heartbeat_expired;

            if data.cpu.name.is_empty() || data.cpu.name == "Процессор" {
                data.cpu.name = fallback_cpu_name;
            }
            data.cpu.usage_percent = usage_percent;
            data.cpu.base_clock_mhz = base_clock_mhz;
            data.cpu.physical_cores = physical_cores;
            data.cpu.logical_cores = logical_cores;
            data.cpu.core_loads = core_loads;
            data.cpu.hvci_enabled = hvci_enabled;
            if data.cpu.avg_clock_mhz.is_none() {
                data.cpu.avg_clock_mhz = pdh_cpu_clock;
            }

            gpu_fallback::enrich_gpus(&mut data.gpus, pdh_gpu_load);
            data.storage_temps = build_storage_temp_items(&data.storage_temps);

            if data.sidecar_online && !data.telemetry_stale {
                settings::consider_hardware(
                    data.cpu.package_temp_c,
                    data.gpus
                        .iter()
                        .filter_map(|gpu| gpu.core_temp_c)
                        .reduce(f32::max),
                );
            }
            return Ok(data);
        }

        // Если sidecar еще инициализируется, возвращаем доступные метрики ОС + DXGI + PDH + NVMe IOCTL
        let mut fallback_gpus = Vec::new();
        let (pdh_gpu_load, pdh_cpu_clock) = gpu_pdh_arc
            .lock()
            .ok()
            .map(|mut s| s.sample_hardware_pdh(true, base_clock_mhz))
            .unwrap_or((None, None));
        gpu_fallback::enrich_gpus(&mut fallback_gpus, pdh_gpu_load);

        let storage_temps = build_storage_temp_items(&[]);

        Ok(HardwareTelemetry {
            is_admin: check_is_elevated_admin(),
            sidecar_online: false,
            timestamp_ms: 0,
            telemetry_stale: watchdog_stale,
            sample_age_ms: watchdog_age_ms,
            cpu: CpuTelemetry {
                name: fallback_cpu_name,
                package_temp_c: None,
                package_temp_sensor: None,
                max_core_temp_c: None,
                avg_clock_mhz: pdh_cpu_clock,
                power_watts: None,
                voltage_v: None,
                core_temps: Vec::new(),
                usage_percent,
                base_clock_mhz,
                physical_cores,
                logical_cores,
                core_loads,
                hvci_enabled,
            },
            gpus: fallback_gpus,
            motherboard_name: "Ожидание инициализации датчиков LibreHardwareMonitor...".to_string(),
            motherboard_temps: Vec::new(),
            system_fans: Vec::new(),
            storage_temps,
        })
    })
    .await
    .map_err(|e| format!("Ошибка потока аппаратной телеметрии: {e}"))?
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
                    return OsString::from_wide(&buf[..end])
                        .to_string_lossy()
                        .into_owned();
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

#[cfg(target_os = "windows")]
fn restore_startup_approved_if_disabled(
    root: winreg::HKEY,
    subkey: &str,
    name: &str,
) -> Result<bool, String> {
    if !startup_approved_disabled(root, subkey, name) {
        return Ok(false);
    }
    let key = RegKey::predef(root)
        .open_subkey_with_flags(subkey, KEY_READ | KEY_SET_VALUE | KEY_WOW64_64KEY)
        .map_err(|e| {
            format!(
                "Не удалось открыть StartupApproved для включения записи (для HKLM требуются права Администратора): {e}"
            )
        })?;
    let mut raw = key.get_raw_value(name).unwrap_or(winreg::RegValue {
        bytes: vec![0u8; 12],
        vtype: RegType::REG_BINARY,
    });
    if raw.bytes.len() < 12 {
        raw.bytes.resize(12, 0);
    }
    raw.bytes[0] = 0x02;
    for byte in raw.bytes.iter_mut().skip(4) {
        *byte = 0;
    }
    key.set_raw_value(name, &raw)
        .map_err(|e| format!("Не удалось выставить флаг 0x02 в StartupApproved: {e}"))?;
    Ok(true)
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

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

fn is_reparse_meta(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        return (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn allowed_startup_folders() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            dirs.push(
                Path::new(&appdata)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
                    .join("Startup"),
            );
        }
    }
    if let Ok(program_data) =
        std::env::var("PROGRAMDATA").or_else(|_| std::env::var("ALLUSERSPROFILE"))
    {
        if !program_data.trim().is_empty() {
            dirs.push(
                Path::new(&program_data)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
                    .join("Startup"),
            );
        }
    }
    dirs
}

fn validate_startup_folder_item_paths(
    raw_base_path: &str,
    allowed_dirs: &[PathBuf],
) -> Result<(PathBuf, PathBuf, String), String> {
    let trimmed = raw_base_path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("Некорректный пустой путь элемента автозагрузки".to_string());
    }
    if trimmed.ends_with('\\') || trimmed.ends_with('/') {
        return Err("Путь автозагрузки не должен указывать на каталог".to_string());
    }

    let raw_path = Path::new(trimmed);
    for comp in raw_path.components() {
        if matches!(
            comp,
            std::path::Component::ParentDir | std::path::Component::CurDir
        ) {
            return Err("Запрещён обход каталогов (.. / .) в пути автозагрузки".to_string());
        }
    }

    let Some(parent) = raw_path.parent() else {
        return Err("Не удалось определить родительский каталог автозагрузки".to_string());
    };
    let Some(file_name_os) = raw_path.file_name() else {
        return Err("Не удалось определить имя файла автозагрузки".to_string());
    };
    let file_name = file_name_os.to_string_lossy().to_string();
    if file_name.is_empty()
        || file_name.contains('\\')
        || file_name.contains('/')
        || file_name.eq_ignore_ascii_case("desktop.ini")
    {
        return Err(format!("Недопустимое имя файла автозагрузки: {file_name}"));
    }
    if file_name.to_ascii_lowercase().ends_with(".disabled") {
        return Err(
            "Передайте базовый путь элемента автозагрузки без суффикса .disabled".to_string(),
        );
    }

    let parent_meta = std::fs::symlink_metadata(parent)
        .map_err(|e| format!("Разрешённая папка автозагрузки недоступна: {e}"))?;
    if !parent_meta.is_dir() || is_reparse_meta(&parent_meta) {
        return Err(
            "Каталог автозагрузки не является обычной директорией или является reparse point"
                .to_string(),
        );
    }
    let canon_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Не удалось канонизировать каталог автозагрузки: {e}"))?;

    let mut allowed_match = false;
    for allowed in allowed_dirs {
        let Ok(allowed_meta) = std::fs::symlink_metadata(allowed) else {
            continue;
        };
        if !allowed_meta.is_dir() || is_reparse_meta(&allowed_meta) {
            continue;
        }
        if let Ok(canon_allowed) = std::fs::canonicalize(allowed) {
            if canon_allowed == canon_parent {
                allowed_match = true;
                break;
            }
        }
    }
    if !allowed_match {
        return Err(
            "Путь находится за пределами разрешённых папок автозагрузки Windows".to_string(),
        );
    }

    let candidate_base = canon_parent.join(&file_name);
    let candidate_disabled = canon_parent.join(format!("{file_name}.disabled"));

    let mut any_exists = false;
    for candidate in [&candidate_base, &candidate_disabled] {
        match std::fs::symlink_metadata(candidate) {
            Ok(meta) => {
                any_exists = true;
                if meta.is_dir() {
                    return Err("Операции с подкаталогами в автозагрузке запрещены".to_string());
                }
                if is_reparse_meta(&meta) {
                    return Err(
                        "Симлинки, junction и reparse points в папке автозагрузки запрещены"
                            .to_string(),
                    );
                }
                let canon_file = std::fs::canonicalize(candidate).map_err(|e| {
                    format!("Не удалось проверить канонический путь файла автозагрузки: {e}")
                })?;
                if canon_file.parent() != Some(canon_parent.as_path()) {
                    return Err(
                        "Объект автозагрузки указывает за пределы разрешённой папки".to_string()
                    );
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!("Ошибка проверки файла автозагрузки: {err}"));
            }
        }
    }
    if !any_exists {
        return Err("Элемент автозагрузки не найден в разрешённой папке".to_string());
    }

    Ok((candidate_base, candidate_disabled, file_name))
}

fn scan_startup_folder(
    dir_path: &Path,
    location_label: &str,
    approved_root: Option<winreg::HKEY>,
    items: &mut Vec<StartupItem>,
    seen_ids: &mut HashSet<String>,
) {
    let Ok(dir_meta) = std::fs::symlink_metadata(dir_path) else {
        return;
    };
    if !dir_meta.is_dir() || is_reparse_meta(&dir_meta) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir_path) else {
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
        if meta.is_dir() || is_reparse_meta(&meta) {
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
        let clean_path = resolved_target
            .clone()
            .unwrap_or_else(|| actual_path_str.clone());
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
async fn get_startup_items() -> Result<Vec<StartupItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("Ошибка потока чтения автозагрузки: {e}"))?
}

fn pretty_store_name(family: &str) -> String {
    let base = family.split('_').next().unwrap_or(family);
    let short = base.rsplit('.').next().unwrap_or(base);
    short.replace('-', " ")
}

#[allow(dead_code)]
fn name_already_listed(items: &[StartupItem], name: &str) -> bool {
    items
        .iter()
        .any(|item| item.name.eq_ignore_ascii_case(name))
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
        (
            HKEY_LOCAL_MACHINE,
            RUN_WOW64_KEY_PATH,
            KEY_READ | KEY_WOW64_64KEY,
        ),
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
    if let Ok(program_data) =
        std::env::var("PROGRAMDATA").or_else(|_| std::env::var("ALLUSERSPROFILE"))
    {
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
    for var in [
        "ProgramFiles",
        "ProgramFiles(x86)",
        "LOCALAPPDATA",
        "APPDATA",
    ] {
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
        || bytes
            .windows(4)
            .take(8)
            .any(|chunk| chunk[1] == 0 && chunk[3] == 0);
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

fn toggle_startup_folder_entry_in_dirs(
    raw_base_path: &str,
    enable: bool,
    allowed_dirs: &[PathBuf],
) -> Result<String, String> {
    let (base_path, disabled_path, file_name) =
        validate_startup_folder_item_paths(raw_base_path, allowed_dirs)?;
    if enable {
        if disabled_path.exists() {
            let _ = validate_startup_folder_item_paths(raw_base_path, allowed_dirs)?;
            std::fs::rename(&disabled_path, &base_path).map_err(|e| {
                format!("Не удалось включить ярлык автозагрузки (проверьте права доступа): {e}")
            })?;
        }
    } else if base_path.exists() {
        let _ = validate_startup_folder_item_paths(raw_base_path, allowed_dirs)?;
        std::fs::rename(&base_path, &disabled_path).map_err(|e| {
            format!("Не удалось отключить ярлык автозагрузки (проверьте права доступа): {e}")
        })?;
    }
    Ok(file_name)
}

#[tauri::command]
fn toggle_startup_item(id: String, enable: bool) -> Result<(), String> {
    if id.starts_with("approved|") {
        return Err(
            "Осиротевшую запись реестра нельзя переключить — её можно только удалить".to_string(),
        );
    }

    if let Some(base_path) = id.strip_prefix("dir|") {
        let file_name =
            toggle_startup_folder_entry_in_dirs(base_path, enable, &allowed_startup_folders())?;
        if enable {
            #[cfg(target_os = "windows")]
            {
                let folder_approved = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder";
                let _ = restore_startup_approved_if_disabled(
                    HKEY_CURRENT_USER,
                    folder_approved,
                    &file_name,
                );
                let _ = restore_startup_approved_if_disabled(
                    HKEY_LOCAL_MACHINE,
                    folder_approved,
                    &file_name,
                );
            }
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    if let Some(rest) = id.strip_prefix("msix|") {
        let mut parts = rest.splitn(2, '|');
        let family = parts.next().ok_or("Не указано приложение Store")?;
        let task = parts.next().ok_or("Не указана задача Store")?;
        let task_path = format!(
            r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData\{family}\StartupTasks\{task}"
        );
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(&task_path, KEY_SET_VALUE)
            .map_err(|e| format!("Не удалось открыть задачу автозапуска Store: {e}"))?;
        let next_state: u32 = if enable { 2 } else { 1 };
        key.set_value("State", &next_state)
            .map_err(|e| format!("Не удалось изменить состояние задачи Store: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    if let Some(rest) = id.strip_prefix("reg|") {
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
            _ => return Err(format!("Неизвестный источник реестра: {}", source_tag)),
        };

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let active_hive = RegKey::predef(active_root);
        let backup_subkey_path = format!(r"{}\{}", NEXUS_DISABLED_REG_BASE, source_tag);

        if !enable {
            let active_key = active_hive
                .open_subkey_with_flags(active_subkey, KEY_READ | KEY_SET_VALUE | KEY_WOW64_64KEY)
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
                .map_err(|e| format!("Не удалось создать резервный ключ автозагрузки: {}", e))?;

            backup_key
                .set_value(value_name, &command)
                .map_err(|e| format!("Не удалось сохранить резервную копию записи: {}", e))?;

            if let Err(e) = active_key.delete_value(value_name) {
                let _ = backup_key.delete_value(value_name);
                return Err(format!("Не удалось удалить запись из автозагрузки: {}", e));
            }
        } else {
            // Сначала проверяем, не осталась ли запись в активной ветке Run,
            // будучи отключённой через стандартный Диспетчер задач Windows (StartupApproved\Run).
            let already_in_active = active_hive
                .open_subkey_with_flags(active_subkey, KEY_READ | KEY_WOW64_64KEY)
                .and_then(|key| key.get_value::<String, _>(value_name))
                .is_ok();

            let backup_entry = hkcu
                .open_subkey_with_flags(&backup_subkey_path, KEY_READ | KEY_SET_VALUE)
                .and_then(|key| key.get_value::<String, _>(value_name).map(|cmd| (key, cmd)))
                .or_else(|_| {
                    hkcu.open_subkey_with_flags(NEXUS_DISABLED_REG_BASE, KEY_READ | KEY_SET_VALUE)
                        .and_then(|key| {
                            key.get_value::<String, _>(value_name).map(|cmd| (key, cmd))
                        })
                });

            if let Ok((backup_key, command)) = backup_entry {
                let active_key = active_hive
                    .open_subkey_with_flags(active_subkey, KEY_SET_VALUE | KEY_WOW64_64KEY)
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
                let _ = restore_startup_approved_if_disabled(
                    approved_root,
                    approved_subkey,
                    value_name,
                );
            } else if already_in_active {
                restore_startup_approved_if_disabled(approved_root, approved_subkey, value_name)?;
            } else {
                return Err(format!(
                    "Резервная запись для '{}' не найдена в реестре",
                    value_name
                ));
            }
        }

        return Ok(());
    }

    Err("Данный тип записи автозагрузки не поддерживает переключение".to_string())
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
    let script =
        format!("(New-Object -ComObject WScript.Shell).CreateShortcut('{escaped}').TargetPath");
    let text = hidden_powershell(&script).ok()?;
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())?
        .trim()
        .to_string();
    if line.is_empty() { None } else { Some(line) }
}

fn read_cstr(bytes: &[u8], offset: usize) -> Option<String> {
    if offset == 0 || offset >= bytes.len() {
        return None;
    }
    let end = bytes[offset..]
        .iter()
        .position(|byte| *byte == 0)
        .map(|pos| offset + pos)?;
    let text = String::from_utf8_lossy(&bytes[offset..end])
        .trim()
        .to_string();
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
                if !base
                    .to_ascii_lowercase()
                    .ends_with(&suffix.to_ascii_lowercase())
                {
                    if !base.ends_with('\\') && !suffix.starts_with('\\') {
                        base.push('\\');
                    }
                    base.push_str(&suffix);
                }
            }
        }
    }
    target
        .filter(|value| value.contains(":\\") || value.contains(":/") || value.starts_with("\\\\"))
}

fn find_slice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn is_path_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'\\'
                | b'/'
                | b':'
                | b'.'
                | b' '
                | b'('
                | b')'
                | b'-'
                | b'_'
                | b'&'
                | b'\''
                | b'['
                | b']'
                | b'+'
                | b','
                | b'~'
        )
}

fn find_embedded_path(bytes: &[u8]) -> Option<String> {
    let lower: Vec<u8> = bytes
        .iter()
        .copied()
        .map(|byte| byte.to_ascii_lowercase())
        .collect();
    for ext in [b".exe".as_slice(), b".bat", b".cmd", b".com"] {
        let mut from = 0usize;
        while let Some(rel) = find_slice(&lower[from..], ext) {
            let end = from + rel + ext.len();
            let mut start = end - ext.len();
            while start > 0 && is_path_byte(bytes[start - 1]) {
                start -= 1;
            }
            if end - start > 5 {
                let text = String::from_utf8_lossy(&bytes[start..end])
                    .trim()
                    .to_string();
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
    key.delete_value(name).map_err(|e| startup_delete_error(&e))
}

fn remove_startup_folder_entry_in_dirs(
    raw_base_path: &str,
    allowed_dirs: &[PathBuf],
) -> Result<String, String> {
    let (base_path, disabled_path, file_name) =
        validate_startup_folder_item_paths(raw_base_path, allowed_dirs)?;
    for path in [&base_path, &disabled_path] {
        match std::fs::symlink_metadata(path) {
            Ok(meta) => {
                if meta.is_dir() || is_reparse_meta(&meta) {
                    return Err(
                        "Запрещено удаление подкаталогов, симлинков и reparse points".to_string(),
                    );
                }
                std::fs::remove_file(path)
                    .map_err(|e| format!("Не удалось удалить файл автозапуска: {e}"))?;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!("Ошибка доступа к файлу автозапуска: {err}"));
            }
        }
    }
    Ok(file_name)
}

#[tauri::command]
fn remove_startup_entry(entry_id: String, source: String) -> Result<(), String> {
    let entry_id = entry_id.trim().to_string();
    if entry_id.is_empty() {
        return Err("Не указана запись автозагрузки".to_string());
    }

    if let Some(base_path) = entry_id.strip_prefix("dir|") {
        let file_name = remove_startup_folder_entry_in_dirs(base_path, &allowed_startup_folders())?;
        settings::record_startup_removal(&entry_id, &source);
        let _ = delete_registry_value(
            HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder",
            &file_name,
        );
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
        settings::record_startup_removal(&entry_id, &source);
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
        settings::record_startup_removal(&entry_id, &source);
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
        settings::record_startup_removal(&entry_id, &source);
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
            if let Ok(key) =
                RegKey::predef(root).open_subkey_with_flags(subkey, KEY_READ | KEY_SET_VALUE)
            {
                let names: Vec<String> = key
                    .enum_values()
                    .filter_map(|item| item.ok().map(|(value_name, _)| value_name))
                    .collect();
                for value_name in names {
                    if value_name.eq_ignore_ascii_case(name) {
                        key.delete_value(&value_name).map_err(|e| {
                            format!("Не удалось удалить запись «{value_name}»: {e}")
                        })?;
                        removed = true;
                    }
                }
            }
        }
        if !removed {
            return Err(format!("Запись «{name}» не найдена в реестре ({source})"));
        }
        settings::record_startup_removal(&entry_id, &source);
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    if let Some(task) = entry_id.strip_prefix("task|") {
        let mut cmd = Command::new("schtasks");
        cmd.args(["/Delete", "/TN", task, "/F"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd
            .output()
            .map_err(|e| format!("Не удалось запустить schtasks: {e}"))?;
        if output.status.success() {
            settings::record_startup_removal(&entry_id, &source);
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

fn system_drive_prefix() -> String {
    let raw = std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".to_string())
        .trim()
        .to_uppercase();
    if raw.len() >= 2 && raw.as_bytes()[1] == b':' {
        raw[..2].to_string()
    } else {
        "C:".to_string()
    }
}

fn system_drive_space_gb(disks: &Disks) -> (u64, u64) {
    let sys_prefix = system_drive_prefix();
    let matched = disks
        .iter()
        .find(|disk| {
            let mount = disk.mount_point().to_string_lossy().to_uppercase();
            mount.starts_with(&sys_prefix)
        })
        .or_else(|| disks.first());

    matched
        .map(|disk| {
            (
                disk.available_space() / 1024 / 1024 / 1024,
                disk.total_space() / 1024 / 1024 / 1024,
            )
        })
        .unwrap_or((0, 0))
}

// Возвращает список доступных дисков системы (C:\, D:\ и т.д.) с их общим и свободным объёмом
#[tauri::command]
async fn get_available_drives() -> Result<Vec<DriveVolumeInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let disks = Disks::new_with_refreshed_list();
        let mut drives: Vec<DriveVolumeInfo> = Vec::new();

        for disk in disks.iter() {
            let mount = disk.mount_point().to_string_lossy().to_string();
            if !mount.is_empty()
                && !drives
                    .iter()
                    .any(|d| d.mount_point.eq_ignore_ascii_case(&mount))
            {
                drives.push(DriveVolumeInfo {
                    mount_point: mount,
                    total_bytes: disk.total_space(),
                    available_bytes: disk.available_space(),
                });
            }
        }

        drives.sort_by(|a, b| a.mount_point.cmp(&b.mount_point));
        if drives.is_empty() {
            drives.push(DriveVolumeInfo {
                mount_point: format!("{}\\", system_drive_prefix()),
                total_bytes: 0,
                available_bytes: 0,
            });
        }
        Ok(drives)
    })
    .await
    .map_err(|e| format!("Ошибка потока чтения томов: {e}"))?
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
        "pdf" | "docx" | "doc" | "xlsx" | "xls" | "pptx" | "ppt" | "txt" | "md" | "rtf" | "csv" => {
            "Документы"
        }
        _ => "Прочее",
    }
}

const SCAN_ENUMERATION: usize = 0;
const SCAN_METADATA: usize = 1;
const SCAN_COUNT: usize = 2;
const SCAN_AGGREGATION: usize = 3;
const SCAN_TREE: usize = 4;

struct ScanShared {
    folders: AtomicU64,
    excluded: AtomicU64,
    profiling: bool,
    timings_ns: [AtomicU64; 5],
    files: AtomicU64,
    bytes: AtomicU64,
    cats: [AtomicU64; 6],
    top: Mutex<BinaryHeap<Reverse<(u64, String, String, String)>>>,
    top_floor: AtomicU64,
    skipped_dirs: AtomicU64,
    access_denied_dirs: AtomicU64,
    skipped_files: AtomicU64,
    skipped_samples: Mutex<Vec<String>>,
}

fn record_skipped_sample(shared: &ScanShared, path: &Path, is_permission_denied: bool) {
    if is_permission_denied {
        shared.access_denied_dirs.fetch_add(1, Ordering::Relaxed);
    }
    if let Ok(mut samples) = shared.skipped_samples.lock() {
        if samples.len() < 5 {
            let text = path.to_string_lossy().into_owned();
            if !samples.iter().any(|existing| existing == &text) {
                samples.push(text);
            }
        }
    }
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
        if lower[index] == "steamapps" && lower.get(index + 1).map(String::as_str) == Some("common")
        {
            consider(&mut best, 100, index + 2);
        }
        if lower[index] == "gog galaxy" && lower.get(index + 1).map(String::as_str) == Some("games")
        {
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
        if matches!(
            lower[index].as_str(),
            "program files" | "program files (x86)"
        ) {
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

fn timed_scan_step<T>(enabled: bool, sum: &mut u64, work: impl FnOnce() -> T) -> T {
    if !enabled {
        return work();
    }
    let start = Instant::now();
    let result = work();
    *sum += start.elapsed().as_nanos() as u64;
    result
}

/// Параллельный обход без повторного запроса атрибутов безопасности.
/// Размер берётся из записи каталога, символические ссылки и точки повторной обработки не раскрываются.
fn scan_worker_loop(
    path: &Path,
    depth: usize,
    shared: &ScanShared,
    token: &AtomicBool,
) -> storage_index::ScannedFolder {
    use storage_index::{ScannedFile, ScannedFolder};
    let mut folder = ScannedFolder {
        name: path.file_name().map(Box::from).unwrap_or_default(),
        ..Default::default()
    };
    if token.load(Ordering::Relaxed) {
        return folder;
    }

    let mut times = [0; 5];
    let profile = shared.profiling;
    let mut entries = match timed_scan_step(profile, &mut times[SCAN_ENUMERATION], || {
        std::fs::read_dir(path)
    }) {
        Ok(rd) => rd,
        Err(err) => {
            if !token.load(Ordering::Relaxed) {
                let denied = err.kind() == std::io::ErrorKind::PermissionDenied;
                shared.skipped_dirs.fetch_add(1, Ordering::Relaxed);
                record_skipped_sample(shared, path, denied);
            }
            return folder;
        }
    };

    folder.readable = true;
    shared.folders.fetch_add(1, Ordering::Relaxed);
    let mut excluded = 0;
    let mut direct_bytes = 0u64;
    let mut local_files = 0u64;
    let mut local_cats = [0u64; 6];
    let mut subdirs: Vec<PathBuf> = Vec::new();
    let mut files = Vec::new();

    while let Some(item) = timed_scan_step(profile, &mut times[SCAN_ENUMERATION], || entries.next())
    {
        if token.load(Ordering::Relaxed) {
            return folder;
        }
        let entry = match item {
            Ok(e) => e,
            Err(err) => {
                if !token.load(Ordering::Relaxed) {
                    let denied = err.kind() == std::io::ErrorKind::PermissionDenied;
                    shared.skipped_files.fetch_add(1, Ordering::Relaxed);
                    record_skipped_sample(shared, path, denied);
                }
                continue;
            }
        };
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if skip_scan_name(&name_text) {
            excluded += 1;
            continue;
        }

        // Windows DirEntry metadata is already carried by directory enumeration.
        let meta = match timed_scan_step(profile, &mut times[SCAN_METADATA], || entry.metadata()) {
            Ok(metadata) => metadata,
            Err(err) => {
                if !token.load(Ordering::Relaxed) {
                    let denied = err.kind() == std::io::ErrorKind::PermissionDenied;
                    if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                        shared.skipped_dirs.fetch_add(1, Ordering::Relaxed);
                    } else {
                        shared.skipped_files.fetch_add(1, Ordering::Relaxed);
                    }
                    record_skipped_sample(shared, &path.join(&name), denied);
                }
                continue;
            }
        };
        if meta.is_symlink() || metadata_is_reparse(&meta) {
            excluded += 1;
            continue;
        }
        if meta.is_dir() {
            subdirs.push(path.join(&name));
            continue;
        }
        if !meta.is_file() {
            excluded += 1;
            continue;
        }
        let size = meta.len();
        timed_scan_step(profile, &mut times[SCAN_COUNT], || {
            local_files = local_files.saturating_add(1);
        });
        timed_scan_step(profile, &mut times[SCAN_AGGREGATION], || {
            direct_bytes = direct_bytes.saturating_add(size);
            let extension = Path::new(&name)
                .extension()
                .map(|value| value.to_string_lossy())
                .unwrap_or_default();
            let ext = if extension.bytes().any(|byte| byte.is_ascii_uppercase()) {
                std::borrow::Cow::Owned(extension.to_ascii_lowercase())
            } else {
                extension
            };
            let category = category_index(&ext);
            local_cats[category] = local_cats[category].saturating_add(size);

            let floor = shared.top_floor.load(Ordering::Relaxed);
            if size > 0 && (floor == 0 || size > floor) {
                push_top_file(
                    shared,
                    size,
                    path.join(&name).to_string_lossy().into_owned(),
                    name_text.into_owned(),
                    ext.into_owned(),
                );
            }
        });
        files.push(ScannedFile {
            name: name.into_boxed_os_str(),
            bytes: size,
        });
    }

    if token.load(Ordering::Relaxed) {
        return folder;
    }

    drop(entries);
    folder.files = files.into_boxed_slice();
    shared.excluded.fetch_add(excluded, Ordering::Relaxed);
    shared.bytes.fetch_add(direct_bytes, Ordering::Relaxed);
    shared.files.fetch_add(local_files, Ordering::Relaxed);
    for (idx, bytes) in local_cats.iter().enumerate() {
        if *bytes > 0 {
            shared.cats[idx].fetch_add(*bytes, Ordering::Relaxed);
        }
    }

    let scan_child = |sub: PathBuf| {
        (!token.load(Ordering::Relaxed)).then(|| scan_worker_loop(&sub, depth + 1, shared, token))
    };
    let children: Vec<_> = if (depth < 4 && subdirs.len() > 1) || (depth < 12 && subdirs.len() >= 4)
    {
        subdirs.into_par_iter().filter_map(scan_child).collect()
    } else {
        subdirs.into_iter().map_while(scan_child).collect()
    };
    folder.folders = children.into_boxed_slice();
    if token.load(Ordering::Relaxed) {
        return folder;
    }
    let tree_start = profile.then(Instant::now);
    folder.bytes = direct_bytes;
    folder.file_count = local_files;
    for child in &folder.folders {
        folder.bytes = folder.bytes.saturating_add(child.bytes);
        folder.file_count = folder.file_count.saturating_add(child.file_count);
        folder.folder_count = folder.folder_count.saturating_add(child.folder_count + 1);
    }
    if let Some(start) = tree_start {
        times[SCAN_TREE] += start.elapsed().as_nanos() as u64;
        for (counter, elapsed) in shared.timings_ns.iter().zip(times) {
            counter.fetch_add(elapsed, Ordering::Relaxed);
        }
    }
    folder
}

#[tauri::command]
fn cancel_storage_scan(state: State<'_, AppState>, scan_id: Option<u64>) -> Result<(), String> {
    let _ = state.storage_scanner.cancel_scan(scan_id);
    Ok(())
}

async fn execute_drive_storage_scan(
    coordinator: Arc<StorageScanCoordinator>,
    path: String,
    profile: bool,
) -> Result<ScanResult, String> {
    let start = Instant::now();
    let mut normalized = path.trim().to_string();
    if normalized.is_empty() {
        return Err("Не указан путь для сканирования".to_string());
    }
    if normalized.len() == 2 && normalized.ends_with(':') {
        normalized.push('\\');
    }

    let scan_guard = coordinator.begin_scan(normalized.clone());

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = &scan_guard;
        let token = &scan_guard.cancel_token;

        let root_path = PathBuf::from(&normalized);
        if !root_path.exists() {
            return Err(format!("Указанный путь не существует: {}", normalized));
        }
        if let Err(err) = std::fs::read_dir(&root_path) {
            return Err(format!(
                "Не удалось открыть каталог {}: {}",
                normalized, err
            ));
        }

        let shared = ScanShared {
            folders: AtomicU64::new(0),
            excluded: AtomicU64::new(0),
            profiling: profile,
            timings_ns: std::array::from_fn(|_| AtomicU64::new(0)),
            files: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            cats: std::array::from_fn(|_| AtomicU64::new(0)),
            top: Mutex::new(BinaryHeap::new()),
            top_floor: AtomicU64::new(0),
            skipped_dirs: AtomicU64::new(0),
            access_denied_dirs: AtomicU64::new(0),
            skipped_files: AtomicU64::new(0),
            skipped_samples: Mutex::new(Vec::new()),
        };
        let indexed_root = scan_worker_loop(&root_path, 0, &shared, token);

        if token.load(Ordering::Relaxed) {
            return Err("SCAN_CANCELLED".to_string());
        }

        let finalize_start = Instant::now();
        let total_scanned_bytes = shared.bytes.load(Ordering::Relaxed);
        let total_files_count = shared.files.load(Ordering::Relaxed);
        let skipped_dirs_count = shared.skipped_dirs.load(Ordering::Relaxed);
        let access_denied_count = shared.access_denied_dirs.load(Ordering::Relaxed);
        let skipped_files_count = shared.skipped_files.load(Ordering::Relaxed);
        let is_partial =
            skipped_dirs_count > 0 || access_denied_count > 0 || skipped_files_count > 0;
        let skipped_samples = shared
            .skipped_samples
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();

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

        let root_name = root_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| normalized.clone());

        let root_node = FolderNode {
            name: root_name,
            path: normalized.clone(),
            size_bytes: total_scanned_bytes,
            children: Vec::new(),
        };

        let category_sizes = vec![
            (
                "Игры и софт".to_string(),
                shared.cats[1].load(Ordering::Relaxed),
            ),
            ("Видео".to_string(), shared.cats[0].load(Ordering::Relaxed)),
            (
                "Архивы и образы".to_string(),
                shared.cats[2].load(Ordering::Relaxed),
            ),
            ("Аудио".to_string(), shared.cats[3].load(Ordering::Relaxed)),
            (
                "Документы".to_string(),
                shared.cats[4].load(Ordering::Relaxed),
            ),
            ("Прочее".to_string(), shared.cats[5].load(Ordering::Relaxed)),
        ];

        let mut result = ScanResult {
            target_path: normalized,
            total_scanned_bytes,
            total_files_count,
            root_node,
            top_files,
            category_sizes,
            scan_id: scan_guard.scan_id,
            skipped_dirs_count,
            access_denied_count,
            skipped_files_count,
            is_partial,
            skipped_samples,
            total_dirs_count: shared.folders.load(Ordering::Relaxed),
            excluded_count: shared.excluded.load(Ordering::Relaxed),
            diagnostics: None,
        };
        if profile {
            let finalize_ms = finalize_start.elapsed().as_secs_f64() * 1000.0;
            let serialization_start = Instant::now();
            let json_bytes = serde_json::to_vec(&result)
                .map_err(|err| err.to_string())?
                .len();
            let serialization_sample_ms = serialization_start.elapsed().as_secs_f64() * 1000.0;
            let ms = |index: usize| shared.timings_ns[index].load(Ordering::Relaxed) as f64 / 1e6;
            result.diagnostics = Some(StorageScanDiagnostics {
                elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
                enumeration_worker_ms: ms(SCAN_ENUMERATION),
                metadata_worker_ms: ms(SCAN_METADATA),
                counting_worker_ms: ms(SCAN_COUNT),
                aggregation_worker_ms: ms(SCAN_AGGREGATION),
                tree_worker_ms: ms(SCAN_TREE),
                finalize_ms,
                serialization_sample_ms,
                json_bytes,
            });
        }
        coordinator.store_index(
            scan_guard.scan_id,
            storage_index::StorageIndex {
                path: root_path,
                root: indexed_root,
            },
        )?;
        Ok(result)
    })
    .await
    .map_err(|e| format!("Ошибка выполнения фонового потока сканирования: {}", e))?
}

// Многопоточное сканирование выбранного диска или папки через rayon
#[tauri::command]
async fn scan_storage(
    state: State<'_, AppState>,
    path: String,
    profile: Option<bool>,
) -> Result<ScanResult, String> {
    let coordinator = Arc::clone(&state.storage_scanner);
    execute_drive_storage_scan(coordinator, path, profile.unwrap_or(false)).await
}

#[tauri::command]
async fn scan_drive_storage(
    state: State<'_, AppState>,
    path: String,
    profile: Option<bool>,
) -> Result<ScanResult, String> {
    let coordinator = Arc::clone(&state.storage_scanner);
    execute_drive_storage_scan(coordinator, path, profile.unwrap_or(false)).await
}

#[tauri::command]
async fn locate_storage_file(
    state: State<'_, AppState>,
    scan_id: u64,
    path: String,
) -> Result<(String, String), String> {
    let index = state.storage_scanner.index(scan_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        index
            .locate_file(Path::new(&path))
            .ok_or_else(|| "Файл отсутствует в снимке".to_owned())
    })
    .await
    .map_err(|err| format!("Не удалось прочитать индекс: {err}"))?
}

#[tauri::command]
async fn get_storage_directory(
    state: State<'_, AppState>,
    scan_id: u64,
    folder: String,
    offset: usize,
    sort: storage_index::SortBy,
    descending: bool,
) -> Result<storage_index::DirectoryPage, String> {
    let index = state.storage_scanner.index(scan_id)?;
    tauri::async_runtime::spawn_blocking(move || index.page(&folder, offset, sort, descending))
        .await
        .map_err(|err| format!("Не удалось прочитать индекс: {err}"))?
}

#[derive(Clone, Serialize)]
struct ExternalRtt {
    timestamp_ms: u64,
    host: Ipv4Addr,
    method: &'static str,
    route: Option<String>,
    rtt_ms: Option<u32>,
}

#[derive(Default)]
struct ExternalPingCache {
    sample: Option<ExternalRtt>,
    completed_at: Option<Instant>,
    pending: bool,
}

fn probe_external_rtt() -> ExternalRtt {
    let hosts = [Ipv4Addr::new(1, 1, 1, 1), Ipv4Addr::new(8, 8, 8, 8)];
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    for method in ["ICMP", "TCP:53"] {
        for host in hosts {
            let before = net_monitor::route_key(host);
            let rtt = if method == "ICMP" {
                net_monitor::icmp_ping_ipv4(host, 450)
            } else {
                let addr = SocketAddr::new(IpAddr::V4(host), 53);
                let start = Instant::now();
                TcpStream::connect_timeout(&addr, Duration::from_millis(450))
                    .ok()
                    .map(|_| start.elapsed().as_millis() as u32)
            };
            if let Some(rtt_ms) = rtt {
                return ExternalRtt {
                    timestamp_ms,
                    host,
                    method,
                    route: net_monitor::confirmed_route(host, before),
                    rtt_ms: Some(rtt_ms),
                };
            }
        }
    }
    ExternalRtt {
        timestamp_ms,
        host: hosts[0],
        method: "",
        route: None,
        rtt_ms: None,
    }
}

pub(crate) fn compute_throughput_kbps(
    delta_rx_bytes: u64,
    delta_tx_bytes: u64,
    elapsed: Duration,
) -> (f32, f32) {
    let dt_secs = elapsed.as_secs_f32();
    if dt_secs <= 0.01 {
        return (0.0, 0.0);
    }
    (
        (delta_rx_bytes as f32 / 1024.0) / dt_secs,
        (delta_tx_bytes as f32 / 1024.0) / dt_secs,
    )
}

fn measure_network_ping(state: &AppState) -> Option<ExternalRtt> {
    let mut guard = state.ping_cache.lock().ok()?;
    let elapsed = guard.completed_at.map(|last| last.elapsed());
    if elapsed.is_none_or(|age| age >= Duration::from_millis(2500)) && !guard.pending {
        guard.pending = true;
        let cache = Arc::clone(&state.ping_cache);
        tauri::async_runtime::spawn_blocking(move || {
            let sample = probe_external_rtt();
            if let Ok(mut guard) = cache.lock() {
                guard.sample = Some(sample);
                guard.completed_at = Some(Instant::now());
                guard.pending = false;
            }
        });
    }
    // Do not present a pre-suspend sample as current when the window is restored.
    guard
        .sample
        .clone()
        .filter(|_| elapsed.is_some_and(|age| age <= Duration::from_secs(8)))
}

#[tauri::command]
async fn get_system_metrics(state: State<'_, AppState>) -> Result<SystemMetrics, String> {
    let (cpu_usage, ram_used, ram_total, ram_percentage, swap_used_gb, swap_total_gb) = {
        let mut sys = state
            .sys
            .lock()
            .map_err(|_| "Системный монитор заблокирован".to_string())?;

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
        (
            cpu_usage,
            ram_used,
            ram_total,
            ram_percentage,
            swap_used_gb,
            swap_total_gb,
        )
    };

    let (net_rx_kbps, net_tx_kbps) = if let Some(rates) = state
        .net_monitor
        .lock()
        .ok()
        .and_then(|mut nm| nm.read_system_throughput_kbps().ok())
    {
        rates
    } else if let Ok(mut networks) = state.networks.lock() {
        let now = Instant::now();
        let prev_at = state
            .networks_last_refresh
            .lock()
            .ok()
            .and_then(|mut slot| slot.replace(now));
        networks.refresh(true);
        let mut total_rx_bytes: u64 = 0;
        let mut total_tx_bytes: u64 = 0;

        for (_interface_name, data) in networks.iter() {
            total_rx_bytes = total_rx_bytes.saturating_add(data.received());
            total_tx_bytes = total_tx_bytes.saturating_add(data.transmitted());
        }

        if let Some(prev) = prev_at {
            compute_throughput_kbps(
                total_rx_bytes,
                total_tx_bytes,
                now.saturating_duration_since(prev),
            )
        } else {
            (0.0, 0.0)
        }
    } else {
        (0.0, 0.0)
    };

    let net_ping_sample = measure_network_ping(&state);
    let net_ping_ms = net_ping_sample
        .as_ref()
        .and_then(|sample| sample.rtt_ms)
        .map(|ms| ms.max(1))
        .unwrap_or(0);
    let net_ping_method = net_ping_sample
        .as_ref()
        .map(|sample| sample.method)
        .unwrap_or("");
    update_tray_ping(&state, net_ping_ms, net_ping_method);

    let (mut disk_free_gb, mut disk_total_gb) =
        state.disk_space.lock().map(|slot| *slot).unwrap_or((0, 0));
    if disk_total_gb == 0 {
        let disks = Disks::new_with_refreshed_list();
        let sample = system_drive_space_gb(&disks);
        disk_free_gb = sample.0;
        disk_total_gb = sample.1;
        if let Ok(mut slot) = state.disk_space.lock() {
            *slot = sample;
        }
    }
    settings::consider_disk(disk_free_gb, disk_total_gb);

    Ok(SystemMetrics {
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
        net_ping_method: net_ping_method.to_owned(),
        net_ping_sample,
    })
}

#[tauri::command]
fn get_power_timer_state(
    state: State<'_, AppState>,
) -> Result<Option<power_manager::PowerTimerState>, String> {
    state.power_timer.get_state()
}

#[tauri::command]
async fn schedule_power_timer(
    state: State<'_, AppState>,
    seconds: u64,
    action: String,
) -> Result<power_manager::PowerTimerState, String> {
    let parsed_action = power_manager::PowerTimerAction::parse(&action)?;
    let power_timer = Arc::clone(&state.power_timer);
    tauri::async_runtime::spawn_blocking(move || power_timer.schedule_timer(seconds, parsed_action))
        .await
        .map_err(|e| format!("Ошибка потока планировщика питания: {e}"))?
}

#[tauri::command]
async fn cancel_power_timer(state: State<'_, AppState>) -> Result<(), String> {
    let power_timer = Arc::clone(&state.power_timer);
    tauri::async_runtime::spawn_blocking(move || power_timer.cancel_timer())
        .await
        .map_err(|e| format!("Ошибка потока отмены таймера питания: {e}"))?
}

#[tauri::command]
async fn schedule_shutdown(
    state: State<'_, AppState>,
    seconds: u64,
    restart: bool,
) -> Result<power_manager::PowerTimerState, String> {
    let action = if restart {
        power_manager::PowerTimerAction::Restart
    } else {
        power_manager::PowerTimerAction::Shutdown
    };
    let power_timer = Arc::clone(&state.power_timer);
    tauri::async_runtime::spawn_blocking(move || power_timer.schedule_timer(seconds, action))
        .await
        .map_err(|e| format!("Ошибка потока планировщика выключения: {e}"))?
}

#[tauri::command]
async fn system_power_action(state: State<'_, AppState>, action: String) -> Result<(), String> {
    let power_timer = Arc::clone(&state.power_timer);
    tauri::async_runtime::spawn_blocking(move || power_timer.execute_immediate_action(&action))
        .await
        .map_err(|e| format!("Ошибка потока действия питания: {e}"))?
}

#[tauri::command]
async fn cancel_shutdown(state: State<'_, AppState>) -> Result<(), String> {
    let power_timer = Arc::clone(&state.power_timer);
    tauri::async_runtime::spawn_blocking(move || power_timer.cancel_timer())
        .await
        .map_err(|e| format!("Ошибка потока отмены выключения: {e}"))?
}

// Проверка запуска с правами Администратора (чтение защищённого куста реестра S-1-5-19)
pub(crate) fn check_is_elevated_admin() -> bool {
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
    if let Ok(mut wd) = state.hwmon_watchdog.lock() {
        wd.shutdown_requested = true;
    }
    terminate_sidecar_child(&state.hw_sidecar_child);

    app.exit(0);
    Ok(())
}

fn cleanup_app_resources(app: &tauri::AppHandle) {
    archive::cancel_active_archive();
    if let Some(state) = app.try_state::<AppState>() {
        let _ = state.storage_scanner.cancel_scan(None);
        let _ = state.drop_hub.stop();
        state.drop_hub.wait_until_stopped();
        if let Ok(mut wd) = state.hwmon_watchdog.lock() {
            wd.shutdown_requested = true;
        }
        terminate_sidecar_child(&state.hw_sidecar_child);
    }
}

#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    cleanup_app_resources(&app);
    app.exit(0);
}

#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) {
    if let Some(hud) = app.get_webview_window("tray_hud") {
        let _ = hud.hide();
    }
    if let Some(window) = app.get_webview_window("main") {
        if window.hide().is_ok() {
            let _ = window.emit_to("main", "aurora-window-visibility", false);
        }
    }
}

#[tauri::command]
fn restore_from_tray(app: tauri::AppHandle) {
    reveal_main_window(&app);
}

fn flush_dns_cache() -> Result<(), String> {
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

#[tauri::command]
async fn flush_dns() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(flush_dns_cache)
        .await
        .map_err(|err| format!("Ошибка потока очистки кэша DNS: {err}"))?
}

#[derive(Serialize, Clone)]
struct RouteProbe {
    label: String,
    host: String,
    ping_ms: u32,
    rtt_range_ms: Option<u32>,
    method: String,
}

fn sample_tcp_route(ip: Ipv4Addr, port: u16) -> (u32, Option<u32>, &'static str) {
    if let Some(first) = net_monitor::icmp_ping_ipv4(ip, 500) {
        let mut samples = vec![first.max(1)];
        for _ in 0..2 {
            if let Some(ms) = net_monitor::icmp_ping_ipv4(ip, 500) {
                samples.push(ms.max(1));
            }
        }
        let fastest = *samples.iter().min().unwrap_or(&0);
        let slowest = *samples.iter().max().unwrap_or(&0);
        return (
            fastest,
            (samples.len() >= 2).then(|| slowest.saturating_sub(fastest)),
            "ICMP",
        );
    }

    let addr = SocketAddr::new(IpAddr::V4(ip), port);
    let mut samples = Vec::new();
    for _ in 0..3 {
        let started = Instant::now();
        if TcpStream::connect_timeout(&addr, Duration::from_millis(700)).is_ok() {
            samples.push(started.elapsed().as_millis().max(1) as u32);
        }
    }
    if samples.is_empty() {
        return (0, None, "");
    }
    let fastest = *samples.iter().min().unwrap_or(&0);
    let slowest = *samples.iter().max().unwrap_or(&0);
    (
        fastest,
        (samples.len() >= 2).then(|| slowest.saturating_sub(fastest)),
        "TCP",
    )
}

#[tauri::command]
async fn probe_game_routes() -> Result<Vec<RouteProbe>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let targets = [
            ("DNS / Магистраль", Ipv4Addr::new(1, 1, 1, 1), 53u16),
            ("СНГ / Москва", Ipv4Addr::new(162, 159, 135, 234), 443u16),
            ("Европа / Cloudflare", Ipv4Addr::new(1, 0, 0, 1), 53u16),
        ];
        std::thread::scope(|scope| {
            let mut handles = Vec::new();
            for (label, ip, port) in targets {
                handles.push(scope.spawn(move || {
                    let (ping_ms, rtt_range_ms, method) = sample_tcp_route(ip, port);
                    RouteProbe {
                        label: label.to_string(),
                        host: ip.to_string(),
                        ping_ms,
                        rtt_range_ms,
                        method: method.to_string(),
                    }
                }));
            }
            handles
                .into_iter()
                .map(|handle| {
                    handle.join().unwrap_or(RouteProbe {
                        label: String::new(),
                        host: String::new(),
                        ping_ms: 0,
                        rtt_range_ms: None,
                        method: String::new(),
                    })
                })
                .collect()
        })
    })
    .await
    .map_err(|e| format!("Ошибка потока проверки маршрутов: {e}"))
}

#[derive(Serialize, Clone)]
struct DiskHealthInfo {
    device_id: Option<u32>,
    serial_number: String,
    model: String,
    kind: String,
    firmware: String,
    health_percent: Option<u32>,
    health_label: String,
    available_spare: Option<u32>,
    power_on_hours: Option<u64>,
    power_cycles: Option<u64>,
    temp_c: Option<u32>,
    tbw_tb: Option<f64>,
    read_tb: Option<f64>,
}

#[derive(Deserialize)]
struct RawDiskHealth {
    device_id: Option<serde_json::Value>,
    serial_number: Option<String>,
    model: Option<String>,
    media: Option<String>,
    bus: Option<String>,
    health: Option<String>,
    temp_c: Option<f64>,
    power_on_hours: Option<f64>,
    power_cycles: Option<f64>,
    wear: Option<f64>,
    bytes_written: Option<f64>,
    bytes_read: Option<f64>,
}

fn parse_json_u32(val: Option<serde_json::Value>) -> Option<u32> {
    match val? {
        serde_json::Value::Number(n) => n.as_u64().and_then(|v| u32::try_from(v).ok()),
        serde_json::Value::String(s) => s.trim().parse::<u32>().ok(),
        _ => None,
    }
}

fn query_powershell_disk_fallback() -> Result<Vec<storage_smart::FallbackDiskRecord>, String> {
    let script = r#"
$ErrorActionPreference='SilentlyContinue'
$rows = New-Object System.Collections.Generic.List[object]
Get-PhysicalDisk | ForEach-Object {
  $rel = $_ | Get-StorageReliabilityCounter
  $written = $null
  $read = $null
  $cycles = $null
  if ($null -ne $rel) {
    foreach ($name in @('WriteBytesTotal','HostBytesWritten','NandBytesWritten')) {
      $prop = $rel.PSObject.Properties[$name]
      if ($null -ne $prop -and $null -ne $prop.Value) {
        $number = 0.0
        if ([double]::TryParse([string]$prop.Value, [ref]$number) -and $number -gt 0) { $written = $number; break }
      }
    }
    foreach ($name in @('ReadBytesTotal','HostBytesRead')) {
      $prop = $rel.PSObject.Properties[$name]
      if ($null -ne $prop -and $null -ne $prop.Value) {
        $number = 0.0
        if ([double]::TryParse([string]$prop.Value, [ref]$number) -and $number -gt 0) { $read = $number; break }
      }
    }
    $cyclesProp = $rel.PSObject.Properties['StartStopCycles']
    if ($null -ne $cyclesProp -and $null -ne $cyclesProp.Value) {
      $cnum = 0.0
      if ([double]::TryParse([string]$cyclesProp.Value, [ref]$cnum) -and $cnum -ge 0) { $cycles = $cnum }
    }
  }
  $rows.Add([pscustomobject]@{
    device_id = [string]$_.DeviceId
    serial_number = [string]$_.SerialNumber
    model = [string]$_.FriendlyName
    media = [string]$_.MediaType
    bus = [string]$_.BusType
    health = [string]$_.HealthStatus
    temp_c = if ($null -ne $rel) { $rel.Temperature } else { $null }
    power_on_hours = if ($null -ne $rel) { $rel.PowerOnHours } else { $null }
    power_cycles = $cycles
    wear = if ($null -ne $rel) { $rel.Wear } else { $null }
    bytes_written = $written
    bytes_read = $read
  }) | Out-Null
}
ConvertTo-Json -InputObject @($rows.ToArray()) -Compress
"#;
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|err| format!("Не удалось опросить накопители: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if stderr.trim().is_empty() {
            "Windows не вернула сведения S.M.A.R.T.".to_string()
        } else {
            stderr.trim().to_string()
        });
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(Vec::new());
    }
    let rows: Vec<RawDiskHealth> = serde_json::from_str(trimmed)
        .or_else(|_| serde_json::from_str::<RawDiskHealth>(trimmed).map(|row| vec![row]))
        .map_err(|err| format!("Не удалось разобрать ответ накопителей: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|row| storage_smart::FallbackDiskRecord {
            device_id: parse_json_u32(row.device_id),
            serial_number: row.serial_number.unwrap_or_default().trim().to_string(),
            model: row.model.unwrap_or_default().trim().to_string(),
            media: row.media.unwrap_or_default(),
            bus: row.bus.unwrap_or_default(),
            health_status: row.health.unwrap_or_default(),
            temp_c: row
                .temp_c
                .filter(|v| v.is_finite() && *v > 0.0 && *v < 120.0)
                .map(|v| v.round() as u32),
            power_on_hours: row
                .power_on_hours
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|v| v.round() as u64),
            power_cycles: row
                .power_cycles
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|v| v.round() as u64),
            wear: row
                .wear
                .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 100.0),
            bytes_written: row
                .bytes_written
                .filter(|v| v.is_finite() && *v > 0.0)
                .map(|v| v.round() as u64),
            bytes_read: row
                .bytes_read
                .filter(|v| v.is_finite() && *v > 0.0)
                .map(|v| v.round() as u64),
        })
        .collect())
}

fn to_disk_health_info(d: storage_smart::SmartDiskMetrics) -> DiskHealthInfo {
    DiskHealthInfo {
        device_id: d.device_id,
        serial_number: d.serial_number,
        model: d.model,
        kind: d.kind,
        firmware: d.firmware,
        health_percent: d.health_percent,
        health_label: d.health_label,
        available_spare: d.available_spare,
        power_on_hours: d.power_on_hours,
        power_cycles: d.power_cycles,
        temp_c: d.temp_c,
        tbw_tb: d.tbw_tb,
        read_tb: d.read_tb,
    }
}

#[tauri::command]
async fn get_disk_health_info() -> Result<Vec<DiskHealthInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Сначала пробуем прямой нативный Win32 IOCTL_STORAGE_QUERY_PROPERTY (работает без Администратора и без PowerShell).
        let native_disks = storage_smart::query_physical_disks_smart();
        let needs_fallback = native_disks.is_empty()
            || native_disks
                .iter()
                .any(|d| !storage_smart::has_usable_native_smart(d));

        let final_disks = if needs_fallback {
            match query_powershell_disk_fallback() {
                Ok(fallback_rows) => {
                    storage_smart::merge_native_and_fallback_disks(native_disks, fallback_rows)
                }
                Err(err) => {
                    if native_disks.is_empty() {
                        return Err(err);
                    }
                    native_disks
                }
            }
        } else {
            native_disks
        };

        Ok(final_disks.into_iter().map(to_disk_health_info).collect())
    })
    .await
    .map_err(|e| format!("Ошибка потока опроса SMART: {e}"))?
}

#[derive(Serialize, Clone)]
struct StabilityReport {
    sent: u32,
    received: u32,
    loss_percent: f32,
    min_ms: Option<u32>,
    avg_ms: Option<f32>,
    max_ms: Option<u32>,
    jitter_ms: Option<f32>,
}

fn summarize_stability(samples: &[u32], sent: u32) -> StabilityReport {
    let received = samples.len() as u32;
    let avg_ms = (!samples.is_empty())
        .then(|| samples.iter().map(|&value| value as f32).sum::<f32>() / received as f32);
    let jitter_ms = avg_ms.filter(|_| received > 1).map(|avg| {
        let variance = samples
            .iter()
            .map(|&value| (value as f32 - avg).powi(2))
            .sum::<f32>()
            / received as f32;
        variance.sqrt()
    });
    StabilityReport {
        sent,
        received,
        loss_percent: ((sent - received) as f32 / sent as f32) * 100.0,
        min_ms: samples.iter().min().copied(),
        avg_ms,
        max_ms: samples.iter().max().copied(),
        jitter_ms,
    }
}

static STABILITY_DONE: AtomicU32 = AtomicU32::new(0);

fn allowed_probe_host(host: &str) -> bool {
    matches!(host, "162.159.135.234" | "1.0.0.1" | "1.1.1.1")
}

fn parse_ping_ms(stdout: &[u8]) -> Option<u32> {
    let lower: Vec<u8> = stdout
        .iter()
        .map(|byte| byte.to_ascii_lowercase())
        .collect();
    let ttl = lower.windows(4).position(|window| window == b"ttl=")?;
    if let Some(pos) = lower.windows(5).position(|window| window == b"time=") {
        return Some(read_leading_u32(&lower[pos + 5..]).unwrap_or(1));
    }
    if lower.windows(5).any(|window| window == b"time<") {
        return Some(1);
    }
    let head = &lower[..ttl];
    let eq = head.iter().rposition(|byte| *byte == b'=')?;
    read_leading_u32(&head[eq + 1..])
}

fn read_leading_u32(bytes: &[u8]) -> Option<u32> {
    let digits: String = bytes
        .iter()
        .copied()
        .take_while(|byte| byte.is_ascii_digit())
        .map(char::from)
        .collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

fn ping_once(host: &str) -> Option<u32> {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return net_monitor::icmp_ping_ipv4(ip, 1000).map(|ms| ms.max(1));
    }
    let mut cmd = Command::new("ping");
    cmd.args(["-4", "-n", "1", "-w", "1000", host]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().ok()?;
    parse_ping_ms(&output.stdout)
}

#[tauri::command]
async fn get_network_telemetry(
    state: State<'_, AppState>,
    selected_adapter_id: Option<String>,
    reset_session: Option<bool>,
) -> Result<net_monitor::NetworkTelemetrySnapshot, String> {
    let monitor = Arc::clone(&state.net_monitor);
    tauri::async_runtime::spawn_blocking(move || {
        monitor
            .lock()
            .map_err(|_| "Монитор сетевых интерфейсов заблокирован".to_string())?
            .snapshot(
                selected_adapter_id.as_deref(),
                reset_session.unwrap_or(false),
            )
    })
    .await
    .map_err(|e| format!("Ошибка потока опроса сетевых интерфейсов: {e}"))?
}

#[tauri::command]
async fn probe_network_health(
    gateway_ip: Option<String>,
    external_host: Option<String>,
) -> Result<net_monitor::NetworkHealthProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        net_monitor::probe_network_health(gateway_ip, external_host)
    })
    .await
    .map_err(|e| format!("Ошибка потока диагностики сети: {e}"))
}

#[tauri::command]
fn get_stability_progress() -> u32 {
    STABILITY_DONE.load(Ordering::Relaxed)
}

#[tauri::command]
async fn run_stability_probe(host: String) -> Result<StabilityReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !allowed_probe_host(&host) {
            return Err("Неизвестный узел диагностики".to_string());
        }
        STABILITY_DONE.store(0, Ordering::Relaxed);
        let mut samples = Vec::new();
        let sent = 30u32;
        for index in 1..=sent {
            if let Some(ms) = ping_once(&host) {
                samples.push(ms);
            }
            STABILITY_DONE.store(index, Ordering::Relaxed);
        }
        Ok(summarize_stability(&samples, sent))
    })
    .await
    .map_err(|e| format!("Ошибка потока теста стабильности: {e}"))?
}

#[derive(Serialize, Clone)]
struct DnsBenchRow {
    name: String,
    server: String,
    ms: Option<u32>,
    method: String,
}

fn build_dns_query_packet(tx_id: u16, domain: &str) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(32);
    pkt.extend_from_slice(&tx_id.to_be_bytes());
    pkt.extend_from_slice(&0x0100u16.to_be_bytes()); // RD=1
    pkt.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT=1
    pkt.extend_from_slice(&0u16.to_be_bytes()); // ANCOUNT=0
    pkt.extend_from_slice(&0u16.to_be_bytes()); // NSCOUNT=0
    pkt.extend_from_slice(&0u16.to_be_bytes()); // ARCOUNT=0
    for label in domain.split('.').filter(|part| !part.is_empty()) {
        let bytes = label.as_bytes();
        let len = bytes.len().min(63);
        pkt.push(len as u8);
        pkt.extend_from_slice(&bytes[..len]);
    }
    pkt.push(0); // root label
    pkt.extend_from_slice(&1u16.to_be_bytes()); // QTYPE = A
    pkt.extend_from_slice(&1u16.to_be_bytes()); // QCLASS = IN
    pkt
}

fn is_valid_dns_response(pkt: &[u8], query: &[u8]) -> bool {
    const HEADER_LEN: usize = 12;
    if pkt.len() < query.len() {
        return false;
    }
    pkt[..2] == query[..2]
        && pkt[2] & 0xFA == 0x80 // Response to QUERY, without truncation
        && pkt[3] & 0x0F == 0
        && pkt[4..6] == [0, 1]
        && pkt[HEADER_LEN..query.len()].eq_ignore_ascii_case(&query[HEADER_LEN..])
}

pub(crate) fn query_dns_udp_ms(addr: SocketAddr, domain: &str, timeout: Duration) -> Option<u32> {
    static NEXT_TX_ID: AtomicU32 = AtomicU32::new(0x4E58);
    let tx_id = (NEXT_TX_ID.fetch_add(1, Ordering::Relaxed) & 0xFFFF) as u16;
    let packet = build_dns_query_packet(tx_id, domain);

    let bind_addr = if addr.is_ipv6() {
        "[::]:0"
    } else {
        "0.0.0.0:0"
    };
    let socket = UdpSocket::bind(bind_addr).ok()?;
    let _ = socket.set_read_timeout(Some(timeout));
    let _ = socket.set_write_timeout(Some(timeout));
    socket.connect(addr).ok()?;

    let started = Instant::now();
    socket.send(&packet).ok()?;
    let mut buf = [0u8; 512];
    let n = socket.recv(&mut buf).ok()?;
    if !is_valid_dns_response(&buf[..n], &packet) {
        return None;
    }
    Some(started.elapsed().as_millis().max(1) as u32)
}

fn time_dns_nslookup(server: Option<&str>) -> Option<u32> {
    let mut cmd = Command::new("nslookup");
    cmd.arg("-timeout=2").arg("google.com");
    if let Some(server) = server {
        cmd.arg(server);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let started = Instant::now();
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    if text.contains("timed out") || text.contains("превышен") || !text.contains("google.com")
    {
        return None;
    }
    Some(started.elapsed().as_millis().max(1) as u32)
}

fn detect_system_dns_socket() -> Option<SocketAddr> {
    let mut mon = net_monitor::NetworkMonitorState::new();
    let snap = mon.snapshot(None, false).ok()?;
    let active = snap
        .active_adapter_id
        .as_deref()
        .and_then(|id| snap.adapters.iter().find(|a| a.id == id))
        .or_else(|| snap.adapters.iter().find(|a| a.is_connected));
    let adapter = active?;
    for dns in &adapter.dns_servers {
        if let Ok(ip) = dns.trim().parse::<Ipv4Addr>() {
            return Some(SocketAddr::new(IpAddr::V4(ip), 53));
        }
    }
    None
}

#[tauri::command]
async fn benchmark_dns() -> Result<Vec<DnsBenchRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let system_dns = detect_system_dns_socket();
        let timeout = Duration::from_millis(1800);
        let mut rows = Vec::with_capacity(4);
        for (name, ip) in [
            ("Cloudflare DNS", Ipv4Addr::new(1, 1, 1, 1)),
            ("Google Public DNS", Ipv4Addr::new(8, 8, 8, 8)),
            ("Quad9", Ipv4Addr::new(9, 9, 9, 9)),
        ] {
            let addr = SocketAddr::new(IpAddr::V4(ip), 53);
            rows.push(DnsBenchRow {
                name: name.to_string(),
                server: ip.to_string(),
                ms: query_dns_udp_ms(addr, "google.com", timeout),
                method: "UDP DNS".to_string(),
            });
        }

        if let Some(sys_addr) = system_dns {
            rows.push(DnsBenchRow {
                name: "Текущий провайдер".to_string(),
                server: format!("{} (Системный)", sys_addr.ip()),
                ms: query_dns_udp_ms(sys_addr, "google.com", timeout),
                method: "UDP DNS".to_string(),
            });
        } else {
            rows.push(DnsBenchRow {
                name: "Текущий провайдер".to_string(),
                server: "Системный".to_string(),
                ms: time_dns_nslookup(None),
                method: "nslookup CLI".to_string(),
            });
        }
        rows
    })
    .await
    .map_err(|e| format!("Ошибка потока замера DNS: {e}"))
}

#[tauri::command]
async fn get_network_optimizer_status(
    state: State<'_, AppState>,
) -> Result<net_optimizer::NetworkOptimizerStatus, String> {
    let optimizer = Arc::clone(&state.net_optimizer);
    tauri::async_runtime::spawn_blocking(move || optimizer.get_status())
        .await
        .map_err(|e| format!("Ошибка потока проверки Network Optimizer: {e}"))?
}

#[tauri::command]
fn get_packet_priority(state: State<'_, AppState>) -> Result<bool, String> {
    state.net_optimizer.get_packet_priority()
}

#[tauri::command]
async fn set_packet_priority(state: State<'_, AppState>, enabled: bool) -> Result<String, String> {
    let opt = Arc::clone(&state.net_optimizer);
    tauri::async_runtime::spawn_blocking(move || opt.set_packet_priority(enabled))
        .await
        .map_err(|err| format!("Ошибка потока настройки приоритета пакетов: {err}"))?
}

#[tauri::command]
async fn tune_ethernet_adapter(state: State<'_, AppState>) -> Result<String, String> {
    let opt = Arc::clone(&state.net_optimizer);
    tauri::async_runtime::spawn_blocking(move || opt.tune_ethernet_adapter())
        .await
        .map_err(|e| format!("Ошибка потока настройки адаптера: {e}"))?
}

#[tauri::command]
async fn get_ethernet_tuned(state: State<'_, AppState>) -> Result<bool, String> {
    let opt = Arc::clone(&state.net_optimizer);
    tauri::async_runtime::spawn_blocking(move || opt.get_ethernet_tuned())
        .await
        .map_err(|e| format!("Ошибка потока проверки адаптера: {e}"))?
}

#[tauri::command]
async fn set_ethernet_tuned(state: State<'_, AppState>, enabled: bool) -> Result<String, String> {
    let opt = Arc::clone(&state.net_optimizer);
    tauri::async_runtime::spawn_blocking(move || opt.set_ethernet_tuned(enabled))
        .await
        .map_err(|e| format!("Ошибка потока переключения адаптера: {e}"))?
}

fn update_tray_ping(state: &AppState, ping_ms: u32, method: &str) {
    let Ok(guard) = state.tray_ping_item.lock() else {
        return;
    };
    let Some(item) = guard.as_ref() else {
        return;
    };
    let label = if ping_ms > 0 {
        if method.is_empty() {
            format!("Ping: {ping_ms} ms")
        } else {
            format!("Ping ({method}): {ping_ms} ms")
        }
    } else {
        "Ping: нет сети".to_string()
    };
    let _ = item.set_text(label);
}

fn reveal_main_window(app: &tauri::AppHandle) {
    app.state::<ShowMainOnReady>()
        .0
        .store(false, Ordering::Relaxed);
    if let Some(hud) = app.get_webview_window("tray_hud") {
        let _ = hud.hide();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.set_focus();
        let _ = window.emit_to("main", "aurora-window-visibility", true);
    }
}

struct ShowMainOnReady(AtomicBool);

#[tauri::command]
fn main_window_ready(window: tauri::WebviewWindow, show: State<'_, ShowMainOnReady>) {
    if window.label() == "main" && show.0.swap(false, Ordering::Relaxed) {
        reveal_main_window(window.app_handle());
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
        push_chromium_caches(
            &mut browser_dirs,
            base.join(r"Yandex\YandexBrowser\User Data"),
        );
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
fn scan_category_dir_recursive(
    category_id: &str,
    dir: &Path,
    size_acc: &mut u64,
    count_acc: &mut u64,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry_res in entries {
        let Ok(entry) = entry_res else {
            continue;
        };
        let path = entry.path();
        if matches!(category_id, "browser_cache" | "discord_cache")
            && is_protected_browser_entry(&path)
        {
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
        if matches!(category_id, "browser_cache" | "discord_cache")
            && is_protected_browser_entry(&path)
        {
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
    .map_err(|e| format!("Ошибка потока очистки диска: {}", e))
    .and_then(|report| {
        if let Ok(done) = &report {
            settings::record_cleanup(done.freed_bytes);
        }
        report
    })
}

// ===================== Process Explorer =====================

#[derive(Default)]
struct ProcessNativeCounters {
    threads: u32,
    handles: u32,
    io: Option<Result<process_io::Observation, process_io::Failure>>,
}

#[cfg(target_os = "windows")]
mod win_proc_counters {
    use super::ProcessNativeCounters;
    use super::process_io::{Failure, Observation};
    use super::win_process_ffi::{FILETIME, GetLastError, GetProcessTimes, filetime_to_unix_secs};
    use std::collections::HashMap;
    use std::ffi::c_void;

    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct PROCESSENTRY32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operations: u64,
        write_operations: u64,
        other_operations: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> isize;
        fn Process32FirstW(h_snapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(h_snapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
        fn GetProcessHandleCount(h_process: *mut c_void, pdw_handle_count: *mut u32) -> i32;
        fn GetProcessIoCounters(h_process: *mut c_void, counters: *mut IoCounters) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    fn read_io(handle: *mut c_void) -> Result<Observation, Failure> {
        let mut counts = IoCounters::default();
        let (mut creation, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        unsafe {
            if GetProcessIoCounters(handle, &mut counts) == 0
                || GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) == 0
            {
                return Err(Failure::windows(GetLastError()));
            }
        }
        Ok(Observation {
            started: filetime_to_unix_secs(creation),
            creation_ticks: (u64::from(creation.dwHighDateTime) << 32)
                | u64::from(creation.dwLowDateTime),
            read_bytes: counts.read_bytes,
            written_bytes: counts.write_bytes,
        })
    }

    pub(super) fn collect(pids: &[u32], with_io: bool) -> HashMap<u32, ProcessNativeCounters> {
        let mut threads_by_pid: HashMap<u32, u32> = HashMap::with_capacity(pids.len());
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap != 0 && snap != INVALID_HANDLE_VALUE {
                let mut entry = std::mem::zeroed::<PROCESSENTRY32W>();
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                if Process32FirstW(snap, &mut entry) != 0 {
                    loop {
                        threads_by_pid.insert(entry.th32ProcessID, entry.cntThreads);
                        if Process32NextW(snap, &mut entry) == 0 {
                            break;
                        }
                    }
                }
                CloseHandle(snap as *mut c_void);
            }
        }

        let mut out = HashMap::with_capacity(pids.len());
        for &pid in pids {
            let mut values = ProcessNativeCounters {
                threads: threads_by_pid.get(&pid).copied().unwrap_or(0),
                ..Default::default()
            };
            if pid > 4 {
                unsafe {
                    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                    if !h.is_null() {
                        let _ = GetProcessHandleCount(h, &mut values.handles);
                        if with_io {
                            values.io = Some(read_io(h));
                        }
                        CloseHandle(h);
                    } else if with_io {
                        values.io = Some(Err(Failure::windows(GetLastError())));
                    }
                }
            }
            out.insert(pid, values);
        }
        out
    }
}

#[cfg(not(target_os = "windows"))]
mod win_proc_counters {
    use super::ProcessNativeCounters;
    use std::collections::HashMap;
    pub(super) fn collect(_pids: &[u32], _with_io: bool) -> HashMap<u32, ProcessNativeCounters> {
        HashMap::new()
    }
}

fn process_status_ru(status: sysinfo::ProcessStatus) -> String {
    match status {
        sysinfo::ProcessStatus::Run => "Активен".to_string(),
        sysinfo::ProcessStatus::Sleep | sysinfo::ProcessStatus::Idle => "Ожидание".to_string(),
        sysinfo::ProcessStatus::Stop => "Приостановлен".to_string(),
        sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead => "Завершается".to_string(),
        other => format!("{other:?}"),
    }
}

#[cfg(windows)]
fn process_window_pids() -> HashSet<u32> {
    use std::ffi::c_void;
    type Window = *mut c_void;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(
            callback: unsafe extern "system" fn(Window, isize) -> i32,
            data: isize,
        ) -> i32;
        fn IsWindowVisible(window: Window) -> i32;
        fn GetWindow(window: Window, command: u32) -> Window;
        fn GetWindowLongW(window: Window, index: i32) -> i32;
        fn GetWindowThreadProcessId(window: Window, pid: *mut u32) -> u32;
    }
    unsafe extern "system" fn collect(window: Window, data: isize) -> i32 {
        const GW_OWNER: u32 = 4;
        const GWL_EXSTYLE: i32 = -20;
        const WS_EX_TOOLWINDOW: i32 = 0x80;
        unsafe {
            if IsWindowVisible(window) != 0
                && GetWindow(window, GW_OWNER).is_null()
                && GetWindowLongW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW == 0
            {
                let mut pid = 0;
                if GetWindowThreadProcessId(window, &mut pid) != 0 && pid > 0 {
                    (&mut *(data as *mut HashSet<u32>)).insert(pid);
                }
            }
        }
        1
    }
    let mut pids = HashSet::new();
    // EnumWindows calls the callback synchronously, while the set is alive.
    unsafe { EnumWindows(collect, &mut pids as *mut _ as isize) };
    pids
}

#[cfg(not(windows))]
fn process_window_pids() -> HashSet<u32> {
    HashSet::new()
}

fn compute_process_tree_counts(
    procs: &[(u32, Option<u32>, u64, String)],
    target_pid: u32,
) -> (Option<u32>, usize, usize) {
    let mut by_pid: HashMap<u32, (Option<u32>, u64, &str)> = HashMap::with_capacity(procs.len());
    for (pid, ppid, start_time, name) in procs {
        if *pid == 0 {
            continue;
        }
        let replace = by_pid
            .get(pid)
            .map(|&(_, prev_start, _)| *start_time >= prev_start)
            .unwrap_or(true);
        if replace {
            by_pid.insert(*pid, (*ppid, *start_time, name.as_str()));
        }
    }

    let mut pids: Vec<u32> = by_pid.keys().copied().collect();
    pids.sort_unstable();

    let mut tree_parent_of: HashMap<u32, u32> = HashMap::with_capacity(by_pid.len());
    let mut children_of: HashMap<u32, Vec<u32>> = HashMap::new();

    for &pid in &pids {
        let Some(&(ppid_opt, child_start, _)) = by_pid.get(&pid) else {
            continue;
        };
        let Some(ppid) = ppid_opt else {
            continue;
        };
        if ppid == 0 || ppid == pid {
            continue;
        }
        let Some(&(_, parent_start, _)) = by_pid.get(&ppid) else {
            continue;
        };
        // Защита от переиспользования PID: родитель не мог стартовать позже дочернего процесса
        if parent_start != 0 && child_start != 0 && parent_start > child_start {
            continue;
        }
        // Проверка на циклы по уже принятой цепи предков
        let mut creates_cycle = false;
        let mut cursor = Some(ppid);
        let mut steps = 0usize;
        while let Some(curr) = cursor {
            if curr == pid || steps > pids.len() {
                creates_cycle = true;
                break;
            }
            cursor = tree_parent_of.get(&curr).copied();
            steps += 1;
        }
        if creates_cycle {
            continue;
        }
        tree_parent_of.insert(pid, ppid);
        children_of.entry(ppid).or_default().push(pid);
    }

    let validated_real_parent = tree_parent_of.get(&target_pid).copied();
    let direct_children = children_of.get(&target_pid).map(|v| v.len()).unwrap_or(0);

    let mut total_descendants = 0usize;
    if let Some(direct_list) = children_of.get(&target_pid) {
        let mut visited: HashSet<u32> = HashSet::new();
        visited.insert(target_pid);
        let mut stack: Vec<u32> = direct_list.clone();
        while let Some(curr) = stack.pop() {
            if !visited.insert(curr) {
                continue;
            }
            total_descendants += 1;
            if let Some(grandkids) = children_of.get(&curr) {
                stack.extend_from_slice(grandkids);
            }
        }
    }

    (validated_real_parent, direct_children, total_descendants)
}

#[tauri::command]
async fn get_process_list(state: State<'_, AppState>) -> Result<Vec<ProcessItem>, String> {
    let io_sample = Arc::clone(&state.process_io_sample);
    let sys_arc = Arc::clone(&state.sys);
    let pid_cache_arc = Arc::clone(&state.pid_cache);
    let icon_cache_arc = Arc::clone(&state.icon_cache);

    tauri::async_runtime::spawn_blocking(move || {
        let mut list: Vec<ProcessItem> = {
            let mut sys = sys_arc
                .lock()
                .map_err(|_| "Системный монитор заблокирован".to_string())?;

            sys.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::All,
                true,
                sysinfo::ProcessRefreshKind::nothing()
                    .with_memory()
                    .with_cpu()
                    .with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
            );
            let cpu_count = sys.cpus().len().max(1) as f32;

            sys.processes()
                .values()
                .filter(|p| p.pid().as_u32() != 0)
                .map(|p| ProcessItem {
                    has_main_window: false,
                    pid: p.pid().as_u32(),
                    parent_pid: p.parent().map(|pp| pp.as_u32()),
                    name: p.name().to_string_lossy().to_string(),
                    exe_path: p
                        .exe()
                        .map(|e| e.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    cpu_usage: (p.cpu_usage() / cpu_count).clamp(0.0, 100.0),
                    memory_mb: p.memory() as f64 / 1024.0 / 1024.0,
                    disk_read_bytes_sec: 0.0,
                    disk_write_bytes_sec: 0.0,
                    disk_status: process_io::Status::Unavailable,
                    disk_error_code: None,
                    run_time_sec: p.run_time(),
                    start_time: p.start_time(),
                    thread_count: 0,
                    handle_count: 0,
                    status: process_status_ru(p.status()),
                    icon_base64: None,
                })
                .collect()
        };

        let all_pids: Vec<u32> = list.iter().map(|item| item.pid).collect();
        let visible_windows = process_window_pids();
        {
            let mut previous = io_sample
                .lock()
                .map_err(|_| "Состояние процессов заблокировано".to_string())?;
            let at = Instant::now();
            let counters = win_proc_counters::collect(&all_pids, true);
            let live: HashMap<_, _> = list
                .iter()
                .map(|item| (item.pid, item.start_time))
                .collect();
            previous.retain(|pid, started| live.get(&pid) == Some(&started));
            for item in &mut list {
                item.has_main_window = visible_windows.contains(&item.pid);
                if let Some(counters) = counters.get(&item.pid) {
                    item.thread_count = counters.threads;
                    item.handle_count = counters.handles;
                    let rates = previous.measure(item.pid, item.start_time, counters.io, at);
                    item.disk_read_bytes_sec = rates.read;
                    item.disk_write_bytes_sec = rates.written;
                    item.disk_status = rates.status;
                    item.disk_error_code = rates.code;
                }
            }
        }

        if let Ok(mut pid_guard) = pid_cache_arc.lock() {
            pid_guard.clear();
            pid_guard.insert(0, ("System Idle Process".to_string(), String::new()));
            pid_guard.insert(4, ("System".to_string(), String::new()));
            for item in &list {
                pid_guard.insert(item.pid, (item.name.clone(), item.exe_path.clone()));
            }
        }

        for item in &mut list {
            item.icon_base64 = cached_process_icon(&icon_cache_arc, &item.exe_path);
        }

        Ok(list)
    })
    .await
    .map_err(|e| format!("Ошибка потока чтения процессов: {e}"))?
}

#[tauri::command]
async fn get_process_labels(
    state: State<'_, AppState>,
    targets: Vec<ProcessTargetIdentity>,
) -> Result<Vec<process_labels::ProcessLabels>, String> {
    if targets.len() > 128 {
        return Err("Слишком много процессов в запросе".into());
    }
    let system = Arc::clone(&state.sys);
    tauri::async_runtime::spawn_blocking(move || {
        let inputs: Vec<_> = {
            let system = system.lock().map_err(|e| e.to_string())?;
            targets
                .iter()
                .map(|target| {
                    let process = system.process(sysinfo::Pid::from_u32(target.pid))?;
                    (target.start_time != 0
                        && process.start_time() == target.start_time
                        && process
                            .name()
                            .to_string_lossy()
                            .eq_ignore_ascii_case(&target.name))
                    .then(|| {
                        (
                            target.pid,
                            target.start_time,
                            process.exe().map(Path::to_path_buf),
                        )
                    })
                })
                .collect()
        };
        Ok(inputs
            .into_iter()
            .map(|input| {
                #[cfg(windows)]
                if let Some((pid, start_time, path)) = input {
                    return process_labels::ProcessLabels {
                        owner: process_labels::windows_labels::owner(pid, start_time),
                        description: path
                            .as_deref()
                            .and_then(process_labels::windows_labels::description),
                    };
                }
                #[cfg(not(windows))]
                let _ = input;
                process_labels::ProcessLabels::default()
            })
            .collect())
    })
    .await
    .map_err(|e| format!("Не удалось прочитать сведения о процессах: {e}"))?
}

#[tauri::command]
async fn get_process_details(
    state: State<'_, AppState>,
    target: ProcessTargetIdentity,
) -> Result<ProcessDetails, String> {
    let system = Arc::clone(&state.sys);
    tauri::async_runtime::spawn_blocking(move || {
        let mut details = read_process_details(&system, &target)?;
        let counters = win_proc_counters::collect(&[target.pid], false);
        if let Some(counters) = counters.get(&target.pid) {
            details.thread_count = counters.threads;
            details.handle_count = counters.handles;
        }
        Ok(details)
    })
    .await
    .map_err(|err| format!("Ошибка потока чтения свойств процесса: {err}"))?
}

fn matches_details_target(
    target: &ProcessTargetIdentity,
    start_time: u64,
    name: &str,
    path: &str,
) -> bool {
    target.start_time == start_time
        && target.name.eq_ignore_ascii_case(name)
        && target
            .exe_path
            .as_deref()
            .is_none_or(|expected| expected.eq_ignore_ascii_case(path))
}

#[cfg(test)]
#[test]
fn process_details_reject_reused_pids_and_mismatched_executables() {
    let target = ProcessTargetIdentity {
        pid: 12_345,
        name: "worker.exe".into(),
        start_time: 1000,
        exe_path: Some(r"C:\Apps\worker.exe".into()),
    };
    assert!(matches_details_target(
        &target,
        1000,
        "Worker.exe",
        r"C:\apps\WORKER.EXE"
    ));
    assert!(!matches_details_target(
        &target,
        1001,
        "worker.exe",
        r"C:\Apps\worker.exe"
    ));
    assert!(!matches_details_target(
        &target,
        1000,
        "worker.exe",
        r"C:\Other\worker.exe"
    ));
}

fn read_process_details(
    system: &Mutex<System>,
    target: &ProcessTargetIdentity,
) -> Result<ProcessDetails, String> {
    let pid = target.pid;
    let sys = system
        .lock()
        .map_err(|_| "Системный монитор заблокирован".to_string())?;
    let key = sysinfo::Pid::from_u32(pid);
    let proc_ref = sys
        .processes()
        .get(&key)
        .ok_or_else(|| format!("Процесс PID {pid} уже завершён или не найден"))?;
    let name = proc_ref.name().to_string_lossy().into_owned();
    let exe_path = proc_ref
        .exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !matches_details_target(target, proc_ref.start_time(), &name, &exe_path) {
        return Err(format!("PID {pid} теперь принадлежит другому процессу"));
    }
    let cpu_count = sys.cpus().len().max(1) as f32;

    let tree_snapshot: Vec<(u32, Option<u32>, u64, String)> = sys
        .processes()
        .values()
        .map(|p| {
            (
                p.pid().as_u32(),
                p.parent().map(|pp| pp.as_u32()),
                p.start_time(),
                p.name().to_string_lossy().to_string(),
            )
        })
        .collect();
    let (parent_pid, child_count, total_descendants) =
        compute_process_tree_counts(&tree_snapshot, pid);
    let parent_name = parent_pid.and_then(|ppid| {
        sys.processes()
            .get(&sysinfo::Pid::from_u32(ppid))
            .map(|p| p.name().to_string_lossy().to_string())
    });
    let command_line = proc_ref
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" ");

    Ok(ProcessDetails {
        pid,
        parent_pid,
        parent_name,
        name,
        exe_path,
        command_line,
        working_dir: proc_ref
            .cwd()
            .map(|c| c.to_string_lossy().to_string())
            .unwrap_or_default(),
        status: process_status_ru(proc_ref.status()),
        cpu_usage: (proc_ref.cpu_usage() / cpu_count).clamp(0.0, 100.0),
        memory_mb: proc_ref.memory() as f64 / 1024.0 / 1024.0,
        virtual_memory_mb: proc_ref.virtual_memory() as f64 / 1024.0 / 1024.0,
        run_time_sec: proc_ref.run_time(),
        start_time: proc_ref.start_time(),
        thread_count: 0,
        handle_count: 0,
        child_count,
        total_descendants,
    })
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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProcessTargetIdentity {
    pub pid: u32,
    pub start_time: u64,
    pub name: String,
    #[serde(default)]
    pub exe_path: Option<String>,
}

const PROTECTED_PROCESS_STEMS: &[&str] = &[
    "system",
    "system idle process",
    "idle",
    "registry",
    "memory compression",
    "secure system",
    "smss",
    "csrss",
    "wininit",
    "services",
    "lsass",
    "lsaiso",
    "winlogon",
    "dwm",
    "fontdrvhost",
    "sihost",
    "svchost",
    "explorer",
    "nexus",
    "nexus-hwmon",
    "aurora",
    "aurora-hwmon",
];

fn normalize_process_stem(raw: &str) -> String {
    let base = raw.trim().rsplit(['\\', '/']).next().unwrap_or("");
    let lower = base.to_ascii_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

fn active_hwmon_sidecar_pid(state: &AppState) -> Option<u32> {
    state
        .hw_sidecar_child
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.id()))
}

fn check_process_not_protected(
    pid: u32,
    name: &str,
    exe_path: Option<&str>,
    sidecar_pid: Option<u32>,
) -> Result<(), String> {
    if pid == 0 || pid == 4 {
        return Err("Системный процесс ядра Windows защищён от изменения".to_string());
    }
    if pid == std::process::id() {
        return Err("Нельзя применить действие к самой AURORA".to_string());
    }
    if sidecar_pid == Some(pid) {
        return Err("Системный сервис телеметрии AURORA защищён от изменения".to_string());
    }

    let stem_from_name = normalize_process_stem(name);
    if !stem_from_name.is_empty() && PROTECTED_PROCESS_STEMS.contains(&stem_from_name.as_str()) {
        return Err(format!(
            "Системный процесс Windows ({name}) защищён от завершения и приостановки"
        ));
    }

    if let Some(path) = exe_path {
        if !path.trim().is_empty() {
            let stem_from_path = normalize_process_stem(path);
            if !stem_from_path.is_empty()
                && PROTECTED_PROCESS_STEMS.contains(&stem_from_path.as_str())
            {
                return Err(format!(
                    "Исполняемый файл системы Windows ({path}) защищён от изменения"
                ));
            }
        }
    }

    Ok(())
}

// Минимальный FFI к kernel32 для проверки идентичности/критичности процесса и работы через verified HANDLE
#[cfg(target_os = "windows")]
mod win_process_ffi {
    use std::ffi::c_void;

    pub type Handle = *mut c_void;
    pub const PROCESS_TERMINATE: u32 = 0x0001;
    pub const PROCESS_SUSPEND_RESUME: u32 = 0x0800;
    pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    pub const STILL_ACTIVE: u32 = 259;

    #[repr(C)]
    #[derive(Copy, Clone, Default)]
    #[allow(non_snake_case)]
    pub struct FILETIME {
        pub dwLowDateTime: u32,
        pub dwHighDateTime: u32,
    }

    pub struct ScopedHandle(pub Handle);

    impl Drop for ScopedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
                self.0 = std::ptr::null_mut();
            }
        }
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        pub fn CloseHandle(handle: Handle) -> i32;
        pub fn TerminateProcess(handle: Handle, exit_code: u32) -> i32;
        pub fn GetProcessTimes(
            handle: Handle,
            creation_time: *mut FILETIME,
            exit_time: *mut FILETIME,
            kernel_time: *mut FILETIME,
            user_time: *mut FILETIME,
        ) -> i32;
        pub fn QueryFullProcessImageNameW(
            handle: Handle,
            flags: u32,
            exe_name: *mut u16,
            size: *mut u32,
        ) -> i32;
        pub fn IsProcessCritical(handle: Handle, critical: *mut i32) -> i32;
        pub fn GetExitCodeProcess(handle: Handle, exit_code: *mut u32) -> i32;
        pub fn GetModuleHandleW(module_name: *const u16) -> Handle;
        pub fn GetProcAddress(module: Handle, proc_name: *const u8) -> *mut c_void;
        pub fn GetLastError() -> u32;
    }

    pub type NtProcessFn = unsafe extern "system" fn(process_handle: Handle) -> i32;

    pub fn filetime_to_unix_secs(ft: FILETIME) -> u64 {
        const WINDOWS_TICK: u64 = 10_000_000;
        const SEC_TO_UNIX_EPOCH: u64 = 11_644_473_600;
        let ticks = ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64);
        (ticks / WINDOWS_TICK).saturating_sub(SEC_TO_UNIX_EPOCH)
    }

    pub fn query_handle_image_path(handle: Handle) -> Option<String> {
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size) };
        if ok != 0 && size > 0 {
            Some(String::from_utf16_lossy(&buf[..size as usize]))
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
fn open_and_verify_process_target(
    target: &ProcessTargetIdentity,
    desired_access: u32,
    sidecar_pid: Option<u32>,
) -> Result<win_process_ffi::ScopedHandle, String> {
    use win_process_ffi::*;

    check_process_not_protected(
        target.pid,
        &target.name,
        target.exe_path.as_deref(),
        sidecar_pid,
    )?;

    if target.start_time == 0 {
        return Err(format!(
            "Невозможно безопасно подтвердить время запуска процесса {} (PID {})",
            target.name, target.pid
        ));
    }

    let handle_raw = unsafe {
        OpenProcess(
            desired_access | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            target.pid,
        )
    };
    if handle_raw.is_null() {
        let err = unsafe { GetLastError() };
        if err == 87 {
            return Err(format!("Процесс PID {} уже завершён", target.pid));
        }
        return Err(format!(
            "Нет доступа к процессу {} (PID {}, Win32 код {}). Запустите AURORA от имени Администратора",
            target.name, target.pid, err
        ));
    }
    let handle = ScopedHandle(handle_raw);

    let mut exit_code: u32 = 0;
    if unsafe { GetExitCodeProcess(handle.0, &mut exit_code) } != 0 && exit_code != STILL_ACTIVE {
        return Err(format!("Процесс PID {} уже завершился", target.pid));
    }

    let mut critical_flag: i32 = 0;
    if unsafe { IsProcessCritical(handle.0, &mut critical_flag) } != 0 && critical_flag != 0 {
        return Err(format!(
            "Процесс {} (PID {}) помечен Windows как критический (IsProcessCritical)",
            target.name, target.pid
        ));
    }

    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe { GetProcessTimes(handle.0, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        let err = unsafe { GetLastError() };
        return Err(format!(
            "Не удалось проверить время запуска процесса PID {} (Win32 код {})",
            target.pid, err
        ));
    }
    let actual_start_time = filetime_to_unix_secs(creation);
    if actual_start_time != target.start_time {
        return Err(format!(
            "Идентичность PID {} изменилась (PID был переиспользован ОС): ожидалось время {}, фактически {}",
            target.pid, target.start_time, actual_start_time
        ));
    }

    let actual_image_path = query_handle_image_path(handle.0);
    if let Some(ref actual_path) = actual_image_path {
        check_process_not_protected(target.pid, &target.name, Some(actual_path), sidecar_pid)?;

        let expected_stem = normalize_process_stem(&target.name);
        let actual_stem = normalize_process_stem(actual_path);
        if !expected_stem.is_empty() && expected_stem != actual_stem {
            return Err(format!(
                "Идентичность процесса PID {} не совпадает: ожидался '{}', фактически '{}'",
                target.pid, target.name, actual_path
            ));
        }

        if let Some(ref expected_path) = target.exe_path {
            let trimmed = expected_path.trim();
            if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case(actual_path) {
                return Err(format!(
                    "Путь исполняемого файла PID {} изменился (ожидался '{}', фактически '{}')",
                    target.pid, trimmed, actual_path
                ));
            }
        }
    }

    Ok(handle)
}

#[derive(Clone, Debug)]
struct LiveProcSnap {
    pid: u32,
    ppid: Option<u32>,
    start_time: u64,
    name: String,
    exe_path: String,
}

fn validate_tree_kill_batch(
    root_target: &ProcessTargetIdentity,
    batch: &[ProcessTargetIdentity],
    snapshot: &[LiveProcSnap],
    self_pid: u32,
    sidecar_pid: Option<u32>,
) -> Result<Vec<ProcessTargetIdentity>, String> {
    if batch.is_empty() {
        return Err("Список процессов для завершения дерева пуст".to_string());
    }
    if root_target.pid == 0 || root_target.pid == 4 || root_target.pid == self_pid {
        return Err("Системный или собственный процесс защищён от завершения дерева".to_string());
    }
    check_process_not_protected(
        root_target.pid,
        &root_target.name,
        root_target.exe_path.as_deref(),
        sidecar_pid,
    )?;

    let mut by_pid: HashMap<u32, &LiveProcSnap> = HashMap::with_capacity(snapshot.len());
    for item in snapshot {
        if item.pid == 0 {
            continue;
        }
        let replace = by_pid
            .get(&item.pid)
            .map(|prev| item.start_time >= prev.start_time)
            .unwrap_or(true);
        if replace {
            by_pid.insert(item.pid, item);
        }
    }

    let Some(live_root) = by_pid.get(&root_target.pid).copied() else {
        return Err(format!(
            "Корневой процесс {} (PID {}) уже завершён",
            root_target.name, root_target.pid
        ));
    };
    if live_root.start_time != root_target.start_time
        || normalize_process_stem(&live_root.name) != normalize_process_stem(&root_target.name)
    {
        return Err(format!(
            "Идентичность корневого процесса PID {} изменилась — завершение дерева заблокировано",
            root_target.pid
        ));
    }

    // Validate against real PPIDs; the display mode does not participate in mutations.
    let mut pids: Vec<u32> = by_pid.keys().copied().collect();
    pids.sort_unstable();
    let mut tree_parent_of: HashMap<u32, u32> = HashMap::with_capacity(by_pid.len());
    let mut children_of: HashMap<u32, Vec<u32>> = HashMap::new();

    for &pid in &pids {
        let Some(proc_snap) = by_pid.get(&pid) else {
            continue;
        };
        let Some(ppid) = proc_snap.ppid else {
            continue;
        };
        if ppid == 0 || ppid == pid {
            continue;
        }
        let Some(parent_snap) = by_pid.get(&ppid) else {
            continue;
        };
        if parent_snap.start_time != 0
            && proc_snap.start_time != 0
            && parent_snap.start_time > proc_snap.start_time
        {
            continue;
        }
        let mut creates_cycle = false;
        let mut cursor = Some(ppid);
        let mut steps = 0usize;
        while let Some(curr) = cursor {
            if curr == pid || steps > pids.len() {
                creates_cycle = true;
                break;
            }
            cursor = tree_parent_of.get(&curr).copied();
            steps += 1;
        }
        if creates_cycle {
            continue;
        }
        tree_parent_of.insert(pid, ppid);
        children_of.entry(ppid).or_default().push(pid);
    }

    let mut allowed_subtree_pids: HashSet<u32> = HashSet::new();
    let mut stack = vec![root_target.pid];
    while let Some(curr) = stack.pop() {
        if !allowed_subtree_pids.insert(curr) {
            continue;
        }
        if let Some(live_node) = by_pid.get(&curr) {
            if curr == self_pid {
                return Err("Ветка содержит процесс AURORA — завершение заблокировано".to_string());
            }
            check_process_not_protected(
                live_node.pid,
                &live_node.name,
                Some(live_node.exe_path.as_str()),
                sidecar_pid,
            )?;
        }
        if let Some(kids) = children_of.get(&curr) {
            stack.extend_from_slice(kids);
        }
    }

    let mut seen_pids: HashSet<u32> = HashSet::new();
    let mut verified_targets: Vec<ProcessTargetIdentity> = Vec::with_capacity(batch.len());
    let mut root_included = false;

    for item in batch {
        if !seen_pids.insert(item.pid) {
            continue;
        }
        if item.pid == self_pid {
            return Err("Нельзя завершить AURORA через дерево процессов".to_string());
        }
        check_process_not_protected(item.pid, &item.name, item.exe_path.as_deref(), sidecar_pid)?;
        if item.pid == root_target.pid {
            root_included = true;
        }

        if let Some(live_item) = by_pid.get(&item.pid) {
            if !allowed_subtree_pids.contains(&item.pid) {
                return Err(format!(
                    "Процесс {} (PID {}) не относится к подтверждённой ветке {} — операция заблокирована",
                    item.name, item.pid, root_target.name
                ));
            }
            if live_item.start_time != item.start_time
                || normalize_process_stem(&live_item.name) != normalize_process_stem(&item.name)
            {
                return Err(format!(
                    "Идентичность процесса PID {} изменилась (PID reuse) — завершение дерева заблокировано",
                    item.pid
                ));
            }
            verified_targets.push(item.clone());
        }
    }

    if !root_included {
        return Err("Подтверждённый список не содержит корневой процесс ветки".to_string());
    }

    Ok(verified_targets)
}

#[tauri::command]
fn kill_process(
    state: State<'_, AppState>,
    target: ProcessTargetIdentity,
    tree: bool,
    targets: Option<Vec<ProcessTargetIdentity>>,
) -> Result<(), String> {
    let sidecar_pid = active_hwmon_sidecar_pid(&state);
    check_process_not_protected(
        target.pid,
        &target.name,
        target.exe_path.as_deref(),
        sidecar_pid,
    )?;

    #[cfg(target_os = "windows")]
    {
        use win_process_ffi::*;

        if !tree {
            let handle = open_and_verify_process_target(&target, PROCESS_TERMINATE, sidecar_pid)?;
            let ok = unsafe { TerminateProcess(handle.0, 1) };
            if ok != 0 {
                return Ok(());
            }
            let err = unsafe { GetLastError() };
            return Err(format!(
                "Не удалось завершить процесс {} (PID {}, Win32 код {}). Возможно, требуются права Администратора",
                target.name, target.pid, err
            ));
        }

        let batch = targets.ok_or_else(|| {
            "Для завершения ветки процессов необходим явно подтверждённый список целей".to_string()
        })?;

        let snapshot: Vec<LiveProcSnap> = {
            let mut sys = state
                .sys
                .lock()
                .map_err(|_| "Системный монитор заблокирован".to_string())?;
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            sys.processes()
                .values()
                .filter(|p| p.pid().as_u32() != 0)
                .map(|p| LiveProcSnap {
                    pid: p.pid().as_u32(),
                    ppid: p.parent().map(|pp| pp.as_u32()),
                    start_time: p.start_time(),
                    name: p.name().to_string_lossy().to_string(),
                    exe_path: p
                        .exe()
                        .map(|e| e.to_string_lossy().to_string())
                        .unwrap_or_default(),
                })
                .collect()
        };

        let validated_targets =
            validate_tree_kill_batch(&target, &batch, &snapshot, std::process::id(), sidecar_pid)?;

        let mut handles: Vec<(ProcessTargetIdentity, ScopedHandle)> =
            Vec::with_capacity(validated_targets.len());
        for item in validated_targets {
            match open_and_verify_process_target(&item, PROCESS_TERMINATE, sidecar_pid) {
                Ok(h) => handles.push((item, h)),
                Err(err) => {
                    if err.contains("уже заверш") {
                        continue;
                    }
                    return Err(err);
                }
            }
        }

        let mut terminated = 0usize;
        let mut last_err: Option<String> = None;
        for (item, handle) in handles {
            let ok = unsafe { TerminateProcess(handle.0, 1) };
            if ok != 0 {
                terminated += 1;
            } else {
                let code = unsafe { GetLastError() };
                last_err = Some(format!(
                    "Не удалось завершить {} (PID {}, Win32 код {})",
                    item.name, item.pid, code
                ));
            }
        }

        if let Some(err) = last_err {
            if terminated == 0 {
                return Err(err);
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = targets;
        Err("Управление процессами поддерживается только в Windows".to_string())
    }
}

#[tauri::command]
fn suspend_process(
    state: State<'_, AppState>,
    target: ProcessTargetIdentity,
    suspend: bool,
) -> Result<(), String> {
    let sidecar_pid = active_hwmon_sidecar_pid(&state);
    check_process_not_protected(
        target.pid,
        &target.name,
        target.exe_path.as_deref(),
        sidecar_pid,
    )?;

    #[cfg(target_os = "windows")]
    {
        use win_process_ffi::*;

        let handle = open_and_verify_process_target(&target, PROCESS_SUSPEND_RESUME, sidecar_pid)?;

        let ntdll_name: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
        let fn_name: &[u8] = if suspend {
            b"NtSuspendProcess\0"
        } else {
            b"NtResumeProcess\0"
        };

        let status = unsafe {
            let ntdll = GetModuleHandleW(ntdll_name.as_ptr());
            if ntdll.is_null() {
                return Err("Не удалось получить дескриптор ntdll.dll".to_string());
            }

            let proc_addr = GetProcAddress(ntdll, fn_name.as_ptr());
            if proc_addr.is_null() {
                return Err("Функция NtSuspendProcess/NtResumeProcess недоступна".to_string());
            }
            let nt_fn: NtProcessFn = std::mem::transmute(proc_addr);
            nt_fn(handle.0)
        };

        drop(handle);

        if status < 0 {
            return Err(format!(
                "{} завершился с NTSTATUS 0x{:08X}",
                if suspend {
                    "NtSuspendProcess"
                } else {
                    "NtResumeProcess"
                },
                status as u32
            ));
        }

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = suspend;
        Err("Заморозка процессов поддерживается только в Windows".to_string())
    }
}

#[tauri::command]
fn resume_process(state: State<'_, AppState>, target: ProcessTargetIdentity) -> Result<(), String> {
    suspend_process(state, target, false)
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
        return Err(format!(
            "Не удалось прочитать таблицу сокетов (код {})",
            code
        ));
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
            let Some(state) = read_u32(&tcp4, offset) else {
                break;
            };
            let Some(local_addr) = read_u32(&tcp4, offset + 4) else {
                break;
            };
            let Some(local_port) = read_u32(&tcp4, offset + 8) else {
                break;
            };
            let Some(remote_addr) = read_u32(&tcp4, offset + 12) else {
                break;
            };
            let Some(remote_port) = read_u32(&tcp4, offset + 16) else {
                break;
            };
            let Some(pid) = read_u32(&tcp4, offset + 20) else {
                break;
            };
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
            let Some(local_addr) = read_u32(&udp4, offset) else {
                break;
            };
            let Some(local_port) = read_u32(&udp4, offset + 4) else {
                break;
            };
            let Some(pid) = read_u32(&udp4, offset + 8) else {
                break;
            };
            rows.push((
                "UDP".to_string(),
                format_socket(
                    &ipv4_from_dword(local_addr),
                    port_from_net_dword(local_port),
                    false,
                ),
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
fn get_drop_history(
    state: State<'_, AppState>,
) -> Result<Vec<drop_server::DroppedFileItem>, String> {
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
fn get_settings() -> Result<settings::NexusSettings, String> {
    settings::get_settings()
}

#[tauri::command]
fn save_settings(settings: settings::NexusSettings) -> Result<(), String> {
    settings::save_settings(settings)
}

#[tauri::command]
fn get_windows_autostart() -> Result<settings::AutostartStatus, String> {
    settings::get_windows_autostart()
}

#[tauri::command]
fn set_windows_autostart(enabled: bool) -> Result<settings::AutostartStatus, String> {
    settings::set_windows_autostart(enabled)
}

#[tauri::command]
fn get_event_log() -> Result<Vec<settings::NexusEvent>, String> {
    settings::get_event_log()
}

#[tauri::command]
fn clear_event_log() -> Result<(), String> {
    settings::clear_event_log()
}

#[tauri::command]
fn get_telemetry_history(
    state: State<'_, AppState>,
    minutes: u32,
) -> Vec<telemetry::TelemetrySnapshot> {
    telemetry::history_since(&state.history_buffer, minutes)
}

#[tauri::command]
fn get_diagnostics_verdict(
    state: State<'_, AppState>,
    minutes: u32,
) -> telemetry::DiagnosticsReport {
    telemetry::diagnose(&state.history_buffer, minutes)
}

#[tauri::command]
fn export_telemetry_csv(state: State<'_, AppState>) -> Result<String, String> {
    telemetry::export_csv(&state.history_buffer)
}

#[cfg(target_os = "windows")]
fn query_pid_name_and_exe(pid: u32) -> Option<(String, String)> {
    if pid == 0 {
        return Some(("System Idle Process".to_string(), String::new()));
    }
    if pid == 4 {
        return Some(("System".to_string(), String::new()));
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(
            desired_access: u32,
            inherit_handle: i32,
            process_id: u32,
        ) -> *mut std::ffi::c_void;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        fn QueryFullProcessImageNameW(
            process: *mut std::ffi::c_void,
            flags: u32,
            exe_name: *mut u16,
            size: *mut u32,
        ) -> i32;
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 || len == 0 {
            return None;
        }
        let exe_path = String::from_utf16_lossy(&buf[..len as usize]);
        let name = Path::new(&exe_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| exe_path.clone());
        Some((name, exe_path))
    }
}

#[cfg(not(target_os = "windows"))]
fn query_pid_name_and_exe(_pid: u32) -> Option<(String, String)> {
    None
}

#[tauri::command]
async fn get_network_connections(
    state: State<'_, AppState>,
) -> Result<Vec<NetworkConnection>, String> {
    let pid_cache_arc = Arc::clone(&state.pid_cache);
    let sys_arc = Arc::clone(&state.sys);
    let icon_cache_arc = Arc::clone(&state.icon_cache);

    tauri::async_runtime::spawn_blocking(move || {
        let sockets = collect_socket_rows()?;

        // Читаем кэш PID -> (Name, ExePath) без вызова sys.refresh_processes(),
        // чтобы не сбрасывать дельты CPU% и Disk I/O для диспетчера процессов.
        let mut names: HashMap<u32, (String, String)> = pid_cache_arc
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        if let Ok(sys) = sys_arc.lock() {
            for process in sys.processes().values() {
                let pid = process.pid().as_u32();
                names.entry(pid).or_insert_with(|| {
                    (
                        process.name().to_string_lossy().to_string(),
                        process
                            .exe()
                            .map(|path| path.to_string_lossy().to_string())
                            .unwrap_or_default(),
                    )
                });
            }
        }

        let mut newly_resolved: Vec<(u32, (String, String))> = Vec::new();
        for (_protocol, _local_addr, _remote_addr, _socket_state, pid) in &sockets {
            if !names.contains_key(pid) {
                if let Some(resolved) = query_pid_name_and_exe(*pid) {
                    names.insert(*pid, resolved.clone());
                    newly_resolved.push((*pid, resolved));
                }
            }
        }

        if !newly_resolved.is_empty() {
            if let Ok(mut pid_guard) = pid_cache_arc.lock() {
                for (pid, info) in newly_resolved {
                    pid_guard.insert(pid, info);
                }
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
                    .or_insert_with(|| cached_process_icon(&icon_cache_arc, &exe_path))
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
    })
    .await
    .map_err(|e| format!("Ошибка потока чтения сетевых подключений: {e}"))?
}

fn hwnd_to_isize<T: Copy>(hwnd: T) -> isize {
    assert_eq!(std::mem::size_of::<T>(), std::mem::size_of::<isize>());
    unsafe { std::mem::transmute_copy(&hwnd) }
}

#[cfg(target_os = "windows")]
fn apply_dwm_rounded_corners(hwnd: isize) {
    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const u32, size: u32) -> i32;
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
    networks_last_refresh: Arc<Mutex<Option<Instant>>>,
    disk_space: Arc<Mutex<(u64, u64)>>,
    hw_telemetry: Arc<Mutex<Option<HardwareTelemetry>>>,
    hw_sidecar_child: Arc<Mutex<Option<Child>>>,
    hwmon_watchdog: Arc<Mutex<HwmonWatchdogState>>,
) {
    start_hwmon_watchdog(
        Arc::clone(&hw_telemetry),
        Arc::clone(&hw_sidecar_child),
        Arc::clone(&hwmon_watchdog),
    );
    let wd_for_bg = Arc::clone(&hwmon_watchdog);
    std::thread::spawn(move || {
        let _ = spawn_hwmon_sidecar(
            hw_telemetry,
            Arc::clone(&hw_sidecar_child),
            hwmon_watchdog,
            0,
        );
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
            if let Ok(mut ts) = networks_last_refresh.lock() {
                *ts = Some(Instant::now());
            }
        }
        loop {
            if wd_for_bg
                .lock()
                .map(|wd| wd.shutdown_requested)
                .unwrap_or(false)
            {
                break;
            }
            let disks = Disks::new_with_refreshed_list();
            let sample = system_drive_space_gb(&disks);
            if let Ok(mut slot) = disk_space.lock() {
                *slot = sample;
            }
            for _ in 0..8 {
                if wd_for_bg
                    .lock()
                    .map(|wd| wd.shutdown_requested)
                    .unwrap_or(false)
                {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    settings::init_settings();
    let startup_settings = settings::load_settings();
    let start_in_tray = settings::should_start_in_tray(
        startup_settings.start_minimized,
        std::env::args_os().skip(1),
    );

    let sys = Arc::new(Mutex::new(System::new()));
    let networks = Arc::new(Mutex::new(Networks::new()));
    let networks_last_refresh = Arc::new(Mutex::new(None));
    let disk_space = Arc::new(Mutex::new((0u64, 0u64)));
    let hw_telemetry = Arc::new(Mutex::new(None));
    let hw_sidecar_child = Arc::new(Mutex::new(None));
    let hwmon_watchdog = Arc::new(Mutex::new(HwmonWatchdogState::default()));
    let storage_scanner = Arc::new(StorageScanCoordinator::new());
    let power_timer = Arc::new(power_manager::PowerTimerManager::new());
    let net_optimizer = Arc::new(net_optimizer::NetworkOptimizerManager::new());
    let history_buffer = Arc::new(RwLock::new(VecDeque::new()));
    telemetry::start_sampler(Arc::clone(&hw_telemetry), Arc::clone(&history_buffer));

    start_background_services(
        Arc::clone(&sys),
        Arc::clone(&networks),
        Arc::clone(&networks_last_refresh),
        Arc::clone(&disk_space),
        Arc::clone(&hw_telemetry),
        Arc::clone(&hw_sidecar_child),
        Arc::clone(&hwmon_watchdog),
    );

    tauri::Builder::default()
        .manage(ShowMainOnReady(AtomicBool::new(!start_in_tray)))
        .manage(AppState {
            sys,
            networks,
            networks_last_refresh,
            disk_space,
            ping_cache: Arc::new(Mutex::new(ExternalPingCache::default())),
            process_io_sample: Arc::new(Mutex::new(process_io::History::default())),
            pid_cache: Arc::new(Mutex::new(HashMap::new())),
            hw_telemetry,
            hw_sidecar_child,
            hwmon_watchdog,
            storage_scanner,
            power_timer,
            net_optimizer,
            icon_cache: Arc::new(Mutex::new(HashMap::new())),
            drop_hub: Arc::new(drop_server::DropHub::new()),
            tray_ping_item: Mutex::new(None),
            history_buffer,
            gpu_pdh: Arc::new(Mutex::new(gpu_fallback::GpuPdhSampler::new())),
            net_monitor: Arc::new(Mutex::new(net_monitor::NetworkMonitorState::new())),
        })
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main")
                && let Ok(hwnd) = window.hwnd()
            {
                apply_dwm_rounded_corners(hwnd_to_isize(hwnd));
            }

            let ping_item =
                tauri::menu::MenuItem::with_id(app, "ping", "Ping: —", false, None::<&str>)?;
            let title_item =
                tauri::menu::MenuItem::with_id(app, "title", "AURORA", false, None::<&str>)?;
            let show_item =
                tauri::menu::MenuItem::with_id(app, "show", "Открыть AURORA", true, None::<&str>)?;
            let quit_item =
                tauri::menu::MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(
                app,
                &[&title_item, &ping_item, &show_item, &quit_item],
            )?;
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut slot) = state.tray_ping_item.lock() {
                    *slot = Some(ping_item);
                }
            }
            if let Some(icon) = app.default_window_icon() {
                let _tray = tauri::tray::TrayIconBuilder::with_id("nexus")
                    .icon(icon.clone())
                    .tooltip("AURORA")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => reveal_main_window(app),
                        "quit" => {
                            cleanup_app_resources(app);
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
                if window.label() == "main" {
                    if let Some(hud) = window.app_handle().get_webview_window("tray_hud") {
                        let _ = hud.hide();
                    }
                }
                if window.hide().is_ok() && window.label() == "main" {
                    let _ = window.emit_to("main", "aurora-window-visibility", false);
                }
            }
            tauri::WindowEvent::Destroyed => {
                if window.label() == "main" {
                    cleanup_app_resources(window.app_handle());
                    window.app_handle().exit(0);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            main_window_ready,
            get_system_metrics,
            get_power_timer_state,
            schedule_power_timer,
            cancel_power_timer,
            schedule_shutdown,
            cancel_shutdown,
            system_power_action,
            get_startup_items,
            toggle_startup_item,
            remove_startup_entry,
            open_item_location,
            get_available_drives,
            scan_storage,
            scan_drive_storage,
            get_storage_directory,
            locate_storage_file,
            cancel_storage_scan,
            get_hardware_telemetry,
            get_hwmon_status,
            restart_hwmon,
            is_elevated_admin,
            restart_as_admin,
            app_exit,
            hide_to_tray,
            restore_from_tray,
            flush_dns,
            probe_game_routes,
            get_network_optimizer_status,
            get_packet_priority,
            set_packet_priority,
            tune_ethernet_adapter,
            get_ethernet_tuned,
            set_ethernet_tuned,
            scan_cleanup_targets,
            execute_cleanup,
            get_process_list,
            get_process_details,
            get_process_labels,
            kill_process,
            suspend_process,
            resume_process,
            get_network_telemetry,
            probe_network_health,
            get_network_connections,
            start_drop_session,
            stop_drop_session,
            get_drop_session,
            get_drop_history,
            get_drop_texts,
            open_drop_folder,
            get_settings,
            save_settings,
            get_windows_autostart,
            set_windows_autostart,
            get_event_log,
            clear_event_log,
            get_telemetry_history,
            get_diagnostics_verdict,
            export_telemetry_csv,
            get_disk_health_info,
            get_stability_progress,
            run_stability_probe,
            benchmark_dns,
            scripts::get_user_scripts,
            scripts::save_user_script,
            scripts::delete_user_script,
            scripts::run_user_script,
            scripts::run_user_script_details,
            archive::archive_get_capabilities,
            archive::archive_get_progress,
            archive::archive_cancel,
            archive::archive_inspect_paths,
            archive::archive_pick_files,
            archive::archive_pick_folder,
            archive::archive_create
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_path_resolves_to_clean_absolute_file() {
        let resolved = find_hwmon_sidecar_exe().expect("nexus-hwmon.exe should be found");
        println!("Resolved sidecar path: {:?}", resolved);
        assert!(resolved.is_absolute(), "Sidecar path must be absolute");
        assert!(
            resolved.is_file(),
            "Resolved sidecar path must point to a file"
        );
        let text = resolved.to_string_lossy();
        assert!(
            !text.starts_with(r"\\?\"),
            "Path should not have verbatim UNC prefix"
        );
        let parent = resolved
            .parent()
            .expect("Sidecar must have parent directory");
        assert!(
            parent.is_dir(),
            "Sidecar parent must be an existing directory"
        );
    }

    #[test]
    fn storage_temp_fallback_includes_nvme_smart_temperatures() {
        let mock_lhm = vec![StorageTempItem {
            name: "Samsung SSD 980 PRO".to_string(),
            temp_c: None,
            used_percent: None,
        }];
        let mock_smart = vec![storage_smart::SmartDiskMetrics {
            device_id: Some(0),
            serial_number: "SN-980".to_string(),
            model: "Samsung SSD 980 PRO".to_string(),
            firmware: "5B2Q".to_string(),
            kind: "NVMe M.2".to_string(),
            health_percent: Some(99),
            health_label: "Отличное".to_string(),
            available_spare: Some(100),
            power_on_hours: Some(500),
            power_cycles: Some(50),
            temp_c: Some(42),
            tbw_tb: Some(5.0),
            read_tb: Some(6.0),
        }];
        let merged = merge_lhm_storage_items(&mock_lhm, &mock_smart, Some(64.5));
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].temp_c, Some(42.0));
        assert_eq!(merged[0].used_percent, Some(64.5));

        let items = build_storage_temp_items(&[]);
        println!("Storage temp items: {:#?}", items);
        assert!(
            !items.is_empty(),
            "Expected at least one volume or storage item"
        );
    }

    #[test]
    fn process_tree_counts_separate_direct_and_total_and_reject_reused_pids() {
        let procs = vec![
            // Оболочка Windows explorer.exe
            (6704, Some(4000), 100, "explorer.exe".to_string()),
            // Дочерний системный подпроцесс explorer.exe
            (1000, Some(6704), 150, "explorer.exe".to_string()),
            // Независимые приложения, запущенные пользователем через оболочку explorer.exe
            (25936, Some(6704), 200, "chrome.exe".to_string()),
            (25937, Some(25936), 210, "chrome.exe".to_string()),
            (25938, Some(25936), 211, "chrome.exe".to_string()),
            (22044, Some(6704), 220, "Antigravity.exe".to_string()),
            (22045, Some(22044), 221, "Antigravity.exe".to_string()),
            // Обычное дерево (не оболочка)
            (1001, Some(500), 100, "steam.exe".to_string()),
            (2001, Some(1001), 220, "steamwebhelper.exe".to_string()),
            (2002, Some(2001), 230, "steamwebhelper.exe".to_string()),
            // Повторное использование PID: процесс 3001 имеет parent_pid=1001,
            // но 3001 стартовал (50) раньше 1001 (100) — не должен крепиться!
            (3001, Some(1001), 50, "old.exe".to_string()),
        ];

        // The system branch includes apps directly launched by Explorer.
        let (exp_parent, exp_direct, exp_total) = compute_process_tree_counts(&procs, 6704);
        assert_eq!(exp_parent, None);
        assert_eq!(exp_direct, 3);
        assert_eq!(exp_total, 6);

        // chrome.exe сохраняет свой настоящий parent_pid (6704) и своё поддерево (2)
        let (chr_parent, chr_direct, chr_total) = compute_process_tree_counts(&procs, 25936);
        assert_eq!(chr_parent, Some(6704));
        assert_eq!(chr_direct, 2);
        assert_eq!(chr_total, 2);

        // steam.exe сохраняет полное поддерево 1 прямой + 1 внук = 2
        let (_, stm_direct, stm_total) = compute_process_tree_counts(&procs, 1001);
        assert_eq!(stm_direct, 1);
        assert_eq!(stm_total, 2);

        let (reused_parent, _, _) = compute_process_tree_counts(&procs, 3001);
        assert_eq!(
            reused_parent, None,
            "Process older than its apparent PPID must not link to reused PID"
        );
    }

    struct TempTestDir(std::path::PathBuf);

    impl TempTestDir {
        fn new(prefix: &str) -> Self {
            let unique = format!(
                "nexus_stage1_test_{}_{}_{}",
                prefix,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            std::fs::create_dir_all(&path).expect("failed to create temp test root");
            Self(path)
        }
    }

    impl Drop for TempTestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(target_os = "windows")]
    struct ChildCleanupGuard(Option<std::process::Child>);

    #[cfg(target_os = "windows")]
    impl Drop for ChildCleanupGuard {
        fn drop(&mut self) {
            if let Some(mut child) = self.0.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    #[test]
    fn critical_process_guard_blocks_system_and_self_processes() {
        for pid in [0u32, 4u32, std::process::id()] {
            assert!(
                check_process_not_protected(pid, "custom.exe", None, None).is_err(),
                "PID {pid} must be blocked by backend guard"
            );
        }
        assert!(
            check_process_not_protected(99991, "custom.exe", None, Some(99991)).is_err(),
            "Active telemetry sidecar PID must be blocked"
        );

        let protected = [
            "System",
            "System Idle Process",
            "csrss.exe",
            "wininit.exe",
            "services.exe",
            "lsass.exe",
            "winlogon.exe",
            "smss.exe",
            "Registry",
            "dwm.exe",
            "svchost.exe",
            "explorer.exe",
            "nexus.exe",
            "nexus-hwmon.exe",
        ];
        for name in protected {
            assert!(
                check_process_not_protected(44444, name, None, None).is_err(),
                "Protected process name '{name}' must be rejected"
            );
            let fake_path = format!(r"C:\Windows\System32\{name}");
            assert!(
                check_process_not_protected(44444, "renamed_client.exe", Some(&fake_path), None)
                    .is_err(),
                "Protected exe path '{fake_path}' must be rejected even with spoofed name"
            );
        }

        assert!(
            check_process_not_protected(
                44445,
                "notepad.exe",
                Some(r"C:\Windows\System32\notepad.exe"),
                Some(99991),
            )
            .is_ok(),
            "Ordinary non-critical process must be allowed"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn pid_reuse_verification_rejects_mismatched_start_time_and_name() {
        use std::os::windows::process::CommandExt;
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let child = std::process::Command::new("ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("ping.exe test child should spawn cleanly");
        let pid = child.id();
        let mut guard = ChildCleanupGuard(Some(child));

        let mut sys = System::new();
        let mut observed_start_time = 0u64;
        let mut observed_exe_path = String::new();
        for _ in 0..20 {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
                true,
                ProcessRefreshKind::everything(),
            );
            if let Some(p) = sys.process(Pid::from_u32(pid)) {
                observed_start_time = p.start_time();
                observed_exe_path = p
                    .exe()
                    .map(|e| e.to_string_lossy().to_string())
                    .unwrap_or_default();
                if observed_start_time > 0 {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            observed_start_time > 0,
            "Child start_time must be readable via sysinfo"
        );

        // Mismatched start_time -> rejected (simulates PID reuse)
        let wrong_time = ProcessTargetIdentity {
            pid,
            start_time: observed_start_time + 5,
            name: "ping.exe".to_string(),
            exe_path: Some(observed_exe_path.clone()),
        };
        assert!(
            open_and_verify_process_target(&wrong_time, win_process_ffi::PROCESS_TERMINATE, None)
                .is_err(),
            "Mismatched start_time must fail anti-PID-reuse verification"
        );

        // Zero start_time -> rejected
        let zero_time = ProcessTargetIdentity {
            pid,
            start_time: 0,
            name: "ping.exe".to_string(),
            exe_path: None,
        };
        assert!(
            open_and_verify_process_target(&zero_time, win_process_ffi::PROCESS_TERMINATE, None)
                .is_err(),
            "Zero start_time must fail anti-PID-reuse verification"
        );

        // Wrong process name -> rejected
        let wrong_name = ProcessTargetIdentity {
            pid,
            start_time: observed_start_time,
            name: "completely_different.exe".to_string(),
            exe_path: Some(observed_exe_path.clone()),
        };
        assert!(
            open_and_verify_process_target(&wrong_name, win_process_ffi::PROCESS_TERMINATE, None)
                .is_err(),
            "Mismatched process name must fail verification"
        );

        // Wrong exe_path -> rejected
        let wrong_exe = ProcessTargetIdentity {
            pid,
            start_time: observed_start_time,
            name: "ping.exe".to_string(),
            exe_path: Some(r"C:\Temp\evil_fake_ping.exe".to_string()),
        };
        assert!(
            open_and_verify_process_target(&wrong_exe, win_process_ffi::PROCESS_TERMINATE, None)
                .is_err(),
            "Mismatched exe_path must fail verification"
        );

        // Exact identity -> verified HANDLE opens and terminates cleanly without taskkill
        let exact = ProcessTargetIdentity {
            pid,
            start_time: observed_start_time,
            name: "ping.exe".to_string(),
            exe_path: if observed_exe_path.is_empty() {
                None
            } else {
                Some(observed_exe_path)
            },
        };
        let handle =
            open_and_verify_process_target(&exact, win_process_ffi::PROCESS_TERMINATE, None)
                .expect("Exact ProcessTargetIdentity must open a verified handle");
        let term_ok = unsafe { win_process_ffi::TerminateProcess(handle.0, 1) };
        drop(handle);
        assert_ne!(
            term_ok, 0,
            "TerminateProcess via verified handle should succeed"
        );
        if let Some(ref mut ch) = guard.0 {
            let _ = ch.wait();
        }
        guard.0 = None;
    }

    #[test]
    fn tree_kill_validator_rejects_shell_promoted_unrelated_reused_and_protected_targets() {
        let snapshot = vec![
            LiveProcSnap {
                pid: 6704,
                ppid: Some(4000),
                start_time: 100,
                name: "explorer.exe".to_string(),
                exe_path: r"C:\Windows\explorer.exe".to_string(),
            },
            LiveProcSnap {
                pid: 25936,
                ppid: Some(6704),
                start_time: 200,
                name: "chrome.exe".to_string(),
                exe_path: r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string(),
            },
            LiveProcSnap {
                pid: 25937,
                ppid: Some(25936),
                start_time: 210,
                name: "chrome.exe".to_string(),
                exe_path: r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string(),
            },
            LiveProcSnap {
                pid: 1001,
                ppid: Some(6704),
                start_time: 300,
                name: "steam.exe".to_string(),
                exe_path: r"C:\Program Files (x86)\Steam\steam.exe".to_string(),
            },
            LiveProcSnap {
                pid: 1002,
                ppid: Some(1001),
                start_time: 310,
                name: "steamwebhelper.exe".to_string(),
                exe_path: r"C:\Program Files (x86)\Steam\bin\cef\steamwebhelper.exe".to_string(),
            },
            LiveProcSnap {
                pid: 9001,
                ppid: Some(1001),
                start_time: 400,
                name: "svchost.exe".to_string(),
                exe_path: r"C:\Windows\System32\svchost.exe".to_string(),
            },
        ];

        let explorer_root = ProcessTargetIdentity {
            pid: 6704,
            start_time: 100,
            name: "explorer.exe".to_string(),
            exe_path: None,
        };
        assert!(
            validate_tree_kill_batch(
                &explorer_root,
                std::slice::from_ref(&explorer_root),
                &snapshot,
                55555,
                None,
            )
            .is_err(),
            "Killing explorer.exe tree must always be rejected"
        );

        let chrome_root = ProcessTargetIdentity {
            pid: 25936,
            start_time: 200,
            name: "chrome.exe".to_string(),
            exe_path: Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string()),
        };
        let chrome_child = ProcessTargetIdentity {
            pid: 25937,
            start_time: 210,
            name: "chrome.exe".to_string(),
            exe_path: Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string()),
        };
        let valid_chrome = validate_tree_kill_batch(
            &chrome_root,
            &[chrome_child.clone(), chrome_root.clone()],
            &snapshot,
            55555,
            None,
        )
        .expect("Clean app subtree targets in displayed NEXUS tree must be accepted");
        assert_eq!(valid_chrome.len(), 2);

        // Smuggling an unrelated process (steam.exe) into chrome_root's kill batch -> rejected
        let unrelated_steam = ProcessTargetIdentity {
            pid: 1001,
            start_time: 300,
            name: "steam.exe".to_string(),
            exe_path: None,
        };
        assert!(
            validate_tree_kill_batch(
                &chrome_root,
                &[chrome_child.clone(), unrelated_steam, chrome_root.clone()],
                &snapshot,
                55555,
                None,
            )
            .is_err(),
            "Targets outside verified subtree must be rejected"
        );

        // PID reuse on child -> rejected
        let reused_child = ProcessTargetIdentity {
            pid: 25937,
            start_time: 999,
            name: "chrome.exe".to_string(),
            exe_path: None,
        };
        assert!(
            validate_tree_kill_batch(
                &chrome_root,
                &[reused_child, chrome_root.clone()],
                &snapshot,
                55555,
                None,
            )
            .is_err(),
            "Child with mismatched start_time must be rejected"
        );

        // Subtree containing protected descendant (svchost.exe under steam.exe) -> rejected
        let steam_root = ProcessTargetIdentity {
            pid: 1001,
            start_time: 300,
            name: "steam.exe".to_string(),
            exe_path: None,
        };
        let steam_child = ProcessTargetIdentity {
            pid: 1002,
            start_time: 310,
            name: "steamwebhelper.exe".to_string(),
            exe_path: None,
        };
        assert!(
            validate_tree_kill_batch(
                &steam_root,
                &[steam_child, steam_root.clone()],
                &snapshot,
                55555,
                None,
            )
            .is_err(),
            "Subtree containing any protected descendant must abort whole tree kill"
        );
    }

    #[test]
    fn startup_folder_validation_allows_toggle_and_remove_in_allowed_dir() {
        let root = TempTestDir::new("startup_allowed");
        let startup_dir = root.0.join("Startup");
        std::fs::create_dir_all(&startup_dir).unwrap();
        let lnk = startup_dir.join("MyApp.lnk");
        let disabled_lnk = startup_dir.join("MyApp.lnk.disabled");
        std::fs::write(&lnk, b"dummy shortcut").unwrap();

        let base_str = lnk.to_string_lossy().to_string();
        let allowed = vec![startup_dir.clone()];

        let toggled_name = toggle_startup_folder_entry_in_dirs(&base_str, false, &allowed)
            .expect("Disable in allowed Startup dir must succeed");
        assert_eq!(toggled_name, "MyApp.lnk");
        assert!(!lnk.exists());
        assert!(disabled_lnk.exists());

        toggle_startup_folder_entry_in_dirs(&base_str, true, &allowed)
            .expect("Enable from .disabled in allowed Startup dir must succeed");
        assert!(lnk.exists());
        assert!(!disabled_lnk.exists());

        // Also test removing when disabled
        toggle_startup_folder_entry_in_dirs(&base_str, false, &allowed).unwrap();
        remove_startup_folder_entry_in_dirs(&base_str, &allowed)
            .expect("Remove in allowed Startup dir must succeed");
        assert!(!lnk.exists());
        assert!(!disabled_lnk.exists());
    }

    #[test]
    fn startup_folder_validation_rejects_outside_and_fake_dirs() {
        let root = TempTestDir::new("startup_outside");
        let startup_dir = root.0.join("Startup");
        let fake_dir = root.0.join("Startup_fake");
        let sub_dir = startup_dir.join("Nested");
        std::fs::create_dir_all(&startup_dir).unwrap();
        std::fs::create_dir_all(&fake_dir).unwrap();
        std::fs::create_dir_all(&sub_dir).unwrap();

        let outside_file = root.0.join("secret.txt");
        let fake_file = fake_dir.join("evil.lnk");
        let nested_file = sub_dir.join("nested.lnk");
        std::fs::write(&outside_file, b"keep").unwrap();
        std::fs::write(&fake_file, b"keep").unwrap();
        std::fs::write(&nested_file, b"keep").unwrap();

        let allowed = vec![startup_dir.clone()];
        for raw in [&outside_file, &fake_file, &nested_file, &sub_dir] {
            let s = raw.to_string_lossy().to_string();
            assert!(
                toggle_startup_folder_entry_in_dirs(&s, false, &allowed).is_err(),
                "Toggle outside allowed Startup dir must be rejected: {s}"
            );
            assert!(
                remove_startup_folder_entry_in_dirs(&s, &allowed).is_err(),
                "Remove outside allowed Startup dir must be rejected: {s}"
            );
        }
        assert!(outside_file.exists());
        assert!(fake_file.exists());
        assert!(nested_file.exists());
        assert!(sub_dir.exists());
    }

    #[test]
    fn startup_folder_validation_rejects_dot_dot_traversal() {
        let root = TempTestDir::new("startup_traversal");
        let startup_dir = root.0.join("Startup");
        std::fs::create_dir_all(&startup_dir).unwrap();
        let outside_secret = root.0.join("secret.txt");
        std::fs::write(&outside_secret, b"must remain untouched").unwrap();

        let traversal = format!("{}\\..\\secret.txt", startup_dir.to_string_lossy());
        let allowed = vec![startup_dir];
        assert!(toggle_startup_folder_entry_in_dirs(&traversal, false, &allowed).is_err());
        assert!(remove_startup_folder_entry_in_dirs(&traversal, &allowed).is_err());
        assert!(outside_secret.exists());
    }

    #[test]
    fn startup_folder_validation_handles_disabled_and_blocks_invalid_names() {
        let root = TempTestDir::new("startup_names");
        let startup_dir = root.0.join("Startup");
        std::fs::create_dir_all(&startup_dir).unwrap();

        let desktop_ini = startup_dir.join("desktop.ini");
        let double_disabled = startup_dir.join("App.lnk.disabled.disabled");
        let already_disabled_arg = startup_dir.join("App.lnk.disabled");
        let nonexistent = startup_dir.join("DoesNotExist.lnk");
        std::fs::write(&desktop_ini, b"[.ShellClassInfo]").unwrap();
        std::fs::write(&double_disabled, b"bad").unwrap();
        std::fs::write(&already_disabled_arg, b"disabled").unwrap();

        let allowed = vec![startup_dir];
        for bad in [
            &desktop_ini,
            &double_disabled,
            &already_disabled_arg,
            &nonexistent,
        ] {
            let s = bad.to_string_lossy().to_string();
            assert!(
                toggle_startup_folder_entry_in_dirs(&s, false, &allowed).is_err(),
                "Must reject invalid filename or missing target: {s}"
            );
            assert!(
                remove_startup_folder_entry_in_dirs(&s, &allowed).is_err(),
                "Must reject remove for invalid filename or missing target: {s}"
            );
        }
        assert!(desktop_ini.exists());
        assert!(double_disabled.exists());
        assert!(already_disabled_arg.exists());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn startup_folder_validation_rejects_reparse_points_and_symlinks() {
        use std::os::windows::process::CommandExt;

        let root = TempTestDir::new("startup_reparse");
        let startup_dir = root.0.join("Startup");
        let external_dir = root.0.join("External");
        std::fs::create_dir_all(&startup_dir).unwrap();
        std::fs::create_dir_all(&external_dir).unwrap();

        let external_file = external_dir.join("victim.txt");
        std::fs::write(&external_file, b"important").unwrap();

        // NTFS directory junction inside Startup works without elevation and triggers FILE_ATTRIBUTE_REPARSE_POINT
        let junction_path = startup_dir.join("LinkDir.lnk");
        let junction_disabled = startup_dir.join("LinkDir.lnk.disabled");
        let mklink_status = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &junction_path.to_string_lossy(),
                &external_dir.to_string_lossy(),
            ])
            .creation_flags(0x0800_0000)
            .status()
            .expect("cmd mklink /J should execute");
        assert!(
            mklink_status.success(),
            "NTFS junction creation must succeed"
        );

        let allowed = vec![startup_dir.clone()];
        let j_str = junction_path.to_string_lossy().to_string();
        assert!(
            toggle_startup_folder_entry_in_dirs(&j_str, false, &allowed).is_err(),
            "Reparse point/junction in Startup dir must be rejected by toggle"
        );
        assert!(
            remove_startup_folder_entry_in_dirs(&j_str, &allowed).is_err(),
            "Reparse point/junction in Startup dir must be rejected by remove"
        );
        assert!(junction_path.exists());
        assert!(!junction_disabled.exists());
        assert!(external_file.exists());

        // File symlink test if Developer Mode / SeCreateSymbolicLinkPrivilege allows it
        let symlink_path = startup_dir.join("SymApp.lnk");
        if std::os::windows::fs::symlink_file(&external_file, &symlink_path).is_ok() {
            let s_str = symlink_path.to_string_lossy().to_string();
            assert!(
                toggle_startup_folder_entry_in_dirs(&s_str, false, &allowed).is_err(),
                "File symlink in Startup dir must be rejected by toggle"
            );
            assert!(
                remove_startup_folder_entry_in_dirs(&s_str, &allowed).is_err(),
                "File symlink in Startup dir must be rejected by remove"
            );
            assert!(symlink_path.exists());
            assert!(external_file.exists());
        }

        // Remove junction itself cleanly before TempTestDir drops
        let _ = std::fs::remove_dir(&junction_path);
    }

    #[test]
    fn storage_scanner_isolated_tokens_prevent_new_scan_from_resuming_cancelled_scan() {
        let coordinator = Arc::new(StorageScanCoordinator::new());

        // Запускаем Сканирование #1 и отменяем его по его собственному scan_id
        let guard1 = coordinator.begin_scan(r"C:\".to_string());
        assert_eq!(
            coordinator.active_scan_snapshot(),
            Some((guard1.scan_id, r"C:\".to_string()))
        );
        assert!(coordinator.cancel_scan(Some(guard1.scan_id)));
        assert!(guard1.cancel_token.load(Ordering::SeqCst));

        // Запускаем Сканирование #2, пока guard1 еще не освободился:
        // токен guard1 должен остаться отменённым (true), а токен guard2 должен быть активным (false)
        let guard2 = coordinator.begin_scan(r"D:\".to_string());
        assert_ne!(guard1.scan_id, guard2.scan_id);
        assert!(
            guard1.cancel_token.load(Ordering::SeqCst),
            "Starting a new scan must NEVER reset cancellation token of old scan #1"
        );
        assert!(
            !guard2.cancel_token.load(Ordering::SeqCst),
            "New scan #2 must start with its own fresh non-cancelled token"
        );
        assert_eq!(
            coordinator.active_scan_snapshot(),
            Some((guard2.scan_id, r"D:\".to_string()))
        );

        // Освобождение guard1 по Drop НЕ должно сбрасывать активное сканирование #2
        drop(guard1);
        assert_eq!(
            coordinator.active_scan_snapshot(),
            Some((guard2.scan_id, r"D:\".to_string()))
        );

        // Отмена несуществующего scan_id не должна трогать активный guard2
        assert!(!coordinator.cancel_scan(Some(999_999)));
        assert!(!guard2.cancel_token.load(Ordering::SeqCst));

        // Завершение / Drop guard2 полностью освобождает состояние координатора
        drop(guard2);
        assert_eq!(coordinator.active_scan_snapshot(), None);
    }

    #[test]
    fn storage_scanner_reports_partial_results_and_skipped_items() {
        let root = TempTestDir::new("storage_partial");
        let docs_dir = root.0.join("Docs");
        let denied_dir = root.0.join("LockedFolder");
        std::fs::create_dir_all(&docs_dir).unwrap();
        std::fs::create_dir_all(&denied_dir).unwrap();

        let f1 = docs_dir.join("movie.mp4");
        let f2 = docs_dir.join("notes.txt");
        std::fs::write(&f1, vec![b'a'; 2048]).unwrap();
        std::fs::write(&f2, vec![b'b'; 512]).unwrap();

        let coordinator = Arc::new(StorageScanCoordinator::new());

        // 1. Полное сканирование доступного каталога -> is_partial == false
        let clean = tauri::async_runtime::block_on(execute_drive_storage_scan(
            Arc::clone(&coordinator),
            docs_dir.to_string_lossy().to_string(),
            true,
        ))
        .expect("Clean directory scan must succeed");
        assert!(!clean.is_partial);
        assert_eq!(clean.total_files_count, 2);
        assert_eq!(clean.total_scanned_bytes, 2560);
        assert_eq!(clean.total_dirs_count, 1);
        assert_eq!(clean.excluded_count, 0);
        assert!(clean.diagnostics.unwrap().json_bytes > 0);
        assert!(clean.scan_id >= 1);
        assert_eq!(clean.skipped_dirs_count, 0);
        assert_eq!(coordinator.active_scan_snapshot(), None);

        // 2. Прямая проверка фиксации недоступного/исчезнувшего каталога в scan_worker_loop
        let shared = ScanShared {
            folders: AtomicU64::new(0),
            excluded: AtomicU64::new(0),
            profiling: false,
            timings_ns: std::array::from_fn(|_| AtomicU64::new(0)),
            files: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            cats: std::array::from_fn(|_| AtomicU64::new(0)),
            top: Mutex::new(BinaryHeap::new()),
            top_floor: AtomicU64::new(0),
            skipped_dirs: AtomicU64::new(0),
            access_denied_dirs: AtomicU64::new(0),
            skipped_files: AtomicU64::new(0),
            skipped_samples: Mutex::new(Vec::new()),
        };
        let token = AtomicBool::new(false);
        let missing_dir = root.0.join("DoesNotExistAnymore");
        let _ = scan_worker_loop(&missing_dir, 1, &shared, &token);
        assert_eq!(shared.skipped_dirs.load(Ordering::Relaxed), 1);
        assert!(!shared.skipped_samples.lock().unwrap().is_empty());

        // 3. Проверка Access Denied на Windows поддиректории через icacls + RAII-восстановление прав
        #[cfg(target_os = "windows")]
        {
            struct AclResetGuard {
                path: PathBuf,
                user: String,
            }
            impl Drop for AclResetGuard {
                fn drop(&mut self) {
                    use std::os::windows::process::CommandExt;
                    let _ = std::process::Command::new("icacls")
                        .args([
                            &self.path.to_string_lossy().to_string(),
                            "/remove:d",
                            &self.user,
                        ])
                        .creation_flags(0x0800_0000)
                        .output();
                }
            }

            if let Ok(user) = std::env::var("USERNAME") {
                use std::os::windows::process::CommandExt;
                let denied_str = denied_dir.to_string_lossy().to_string();
                let deny_rule = format!("{user}:(OI)(CI)R");
                let status = std::process::Command::new("icacls")
                    .args([&denied_str, "/deny", &deny_rule])
                    .creation_flags(0x0800_0000)
                    .output();
                let _acl_guard = AclResetGuard {
                    path: denied_dir.clone(),
                    user,
                };
                if let Ok(out) = status {
                    if out.status.success() && std::fs::read_dir(&denied_dir).is_err() {
                        let partial = tauri::async_runtime::block_on(execute_drive_storage_scan(
                            Arc::clone(&coordinator),
                            root.0.to_string_lossy().to_string(),
                            false,
                        ))
                        .expect(
                            "Parent scan with unreadable subdir should still return partial result",
                        );
                        assert!(
                            partial.is_partial,
                            "Scan must report is_partial when subdir denied"
                        );
                        assert!(partial.skipped_dirs_count >= 1);
                        assert!(partial.access_denied_count >= 1);
                        assert!(!partial.skipped_samples.is_empty());
                    }
                }
            }
        }
    }

    #[test]
    fn hwmon_watchdog_detects_missing_child_and_stale_heartbeat_while_respecting_driver_blocked() {
        let base = Instant::now();

        // 1. Первоначальный сбой запуска (child == None, initial_spawn_attempted == true) -> автоматический рестарт
        let mut wd = HwmonWatchdogState {
            status: HwmonStatus::Offline,
            initial_spawn_attempted: true,
            last_error: Some("spawn failed".to_string()),
            last_spawn_at: Some(base),
            ..HwmonWatchdogState::default()
        };
        assert_eq!(
            evaluate_hwmon_watchdog_step(&mut wd, false, None, base + Duration::from_secs(2)),
            HwmonWatchdogAction::RestartAfterBackoff {
                delay_secs: 1,
                kill_hung_child: false,
            }
        );
        assert_eq!(wd.status, HwmonStatus::Restarting);
        assert_eq!(wd.restart_count, 1);

        // 2. Живой сайдкар со свежей телеметрией -> Idle и stale == false
        wd.restart_count = 0;
        wd.status = HwmonStatus::Ready;
        wd.last_sample_at = Some(base + Duration::from_secs(10));
        let (stale_fresh, age_fresh) =
            compute_hwmon_staleness(&wd, true, base + Duration::from_secs(12));
        assert!(!stale_fresh);
        assert_eq!(age_fresh, Some(2_000));
        assert_eq!(
            evaluate_hwmon_watchdog_step(&mut wd, true, None, base + Duration::from_secs(12)),
            HwmonWatchdogAction::Idle
        );

        // 3. Данные старше 5с -> определяются как устаревшие (telemetry_stale == true), пока ещё до таймаута heartbeat
        let (stale_warn, age_warn) =
            compute_hwmon_staleness(&wd, true, base + Duration::from_secs(16));
        assert!(stale_warn);
        assert_eq!(age_warn, Some(6_000));
        assert_eq!(
            evaluate_hwmon_watchdog_step(&mut wd, true, None, base + Duration::from_secs(16)),
            HwmonWatchdogAction::Idle
        );

        // 4. Отсутствие свежей телеметрии > 10с при живом процессе -> watchdog убивает подвисший Child и перезапускает
        assert_eq!(
            evaluate_hwmon_watchdog_step(&mut wd, true, None, base + Duration::from_secs(21)),
            HwmonWatchdogAction::RestartAfterBackoff {
                delay_secs: 1,
                kill_hung_child: true,
            }
        );

        // 5. Подвисший стартовый запуск (child жив >= 12с, но ни одного снимка не пришло) -> kill_hung_child + рестарт
        let mut wd_boot_hang = HwmonWatchdogState {
            initial_spawn_attempted: true,
            last_spawn_at: Some(base),
            last_sample_at: None,
            ..HwmonWatchdogState::default()
        };
        assert_eq!(
            evaluate_hwmon_watchdog_step(&mut wd_boot_hang, false, None, base),
            HwmonWatchdogAction::Idle
        );
        assert_eq!(
            evaluate_hwmon_watchdog_step(
                &mut wd_boot_hang,
                true,
                None,
                base + Duration::from_secs(13)
            ),
            HwmonWatchdogAction::RestartAfterBackoff {
                delay_secs: 1,
                kill_hung_child: true,
            }
        );

        // 6. Заблокированный драйвер (HVCI / WinRing0) -> DriverBlocked без бесконечных перезапусков
        let mut wd_blocked = HwmonWatchdogState {
            initial_spawn_attempted: true,
            last_stderr_line: Some("WinRing0 driver blocked by HVCI".to_string()),
            ..HwmonWatchdogState::default()
        };
        assert_eq!(
            evaluate_hwmon_watchdog_step(
                &mut wd_blocked,
                false,
                Some(Some(1275)),
                base + Duration::from_secs(1)
            ),
            HwmonWatchdogAction::StopWithFailure {
                kill_hung_child: false,
                driver_blocked: true,
            }
        );
        assert_eq!(wd_blocked.status, HwmonStatus::DriverBlocked);
        assert_eq!(
            evaluate_hwmon_watchdog_step(
                &mut wd_blocked,
                false,
                None,
                base + Duration::from_secs(5)
            ),
            HwmonWatchdogAction::Idle
        );

        // 7. Лимит автоматических перезапусков (не более 5)
        let mut wd_cap = HwmonWatchdogState {
            initial_spawn_attempted: true,
            ..HwmonWatchdogState::default()
        };
        let expected_delays = [1u64, 3, 5, 10, 10];
        for expected_delay in expected_delays {
            assert_eq!(
                evaluate_hwmon_watchdog_step(&mut wd_cap, false, None, base),
                HwmonWatchdogAction::RestartAfterBackoff {
                    delay_secs: expected_delay,
                    kill_hung_child: false,
                }
            );
        }
        assert_eq!(
            evaluate_hwmon_watchdog_step(&mut wd_cap, false, None, base),
            HwmonWatchdogAction::StopWithFailure {
                kill_hung_child: false,
                driver_blocked: false,
            }
        );
        assert_eq!(wd_cap.status, HwmonStatus::Offline);
        assert!(wd_cap.auto_restarts_exhausted);
        assert_eq!(
            evaluate_hwmon_watchdog_step(&mut wd_cap, false, None, base),
            HwmonWatchdogAction::Idle
        );

        // 8. Корректное завершение watchdog при закрытии приложения
        wd_cap.shutdown_requested = true;
        assert_eq!(
            evaluate_hwmon_watchdog_step(&mut wd_cap, false, None, base),
            HwmonWatchdogAction::ExitThread
        );
    }

    #[test]
    fn fallback_network_throughput_normalizes_by_elapsed_time() {
        // 512 КБ за 2 секунды == 256 КБ/с
        let (rx, tx) = compute_throughput_kbps(512 * 1024, 128 * 1024, Duration::from_secs(2));
        assert!((rx - 256.0).abs() < 0.01, "Expected 256 KB/s, got {rx}");
        assert!((tx - 64.0).abs() < 0.01, "Expected 64 KB/s, got {tx}");

        // 1024 КБ за 500 мс == 2048 КБ/с
        let (rx_half, tx_half) =
            compute_throughput_kbps(1024 * 1024, 0, Duration::from_millis(500));
        assert!(
            (rx_half - 2048.0).abs() < 1.0,
            "Expected 2048 KB/s, got {rx_half}"
        );
        assert_eq!(tx_half, 0.0);

        // Нулевой / микроинтервал не приводит к делению на ноль и Infinity
        let (rx_zero, tx_zero) = compute_throughput_kbps(4096, 4096, Duration::from_millis(2));
        assert_eq!((rx_zero, tx_zero), (0.0, 0.0));
    }

    #[test]
    fn stability_reports_missing_rtt_and_needs_two_samples_for_jitter() {
        let lost = summarize_stability(&[], 30);
        assert_eq!(lost.loss_percent, 100.0);
        assert_eq!(
            (lost.min_ms, lost.avg_ms, lost.max_ms, lost.jitter_ms),
            (None, None, None, None)
        );

        let one = summarize_stability(&[21], 30);
        assert_eq!(one.avg_ms, Some(21.0));
        assert_eq!(one.jitter_ms, None);
        let stable = summarize_stability(&[21, 21], 2);
        assert_eq!(stable.jitter_ms, Some(0.0));
        let varied = summarize_stability(&[20, 24], 2);
        assert_eq!(varied.avg_ms, Some(22.0));
        assert_eq!(varied.jitter_ms, Some(2.0));
    }

    #[test]
    fn udp_dns_benchmark_rejects_unrelated_and_truncated_replies() {
        let query = build_dns_query_packet(0x1234, "google.com");
        let mut response = query.clone();
        response[2] = 0x81;
        response[3] = 0x80;
        assert!(is_valid_dns_response(&response, &query));
        assert!(!is_valid_dns_response(&response[..12], &query));

        response[13] = b'x';
        assert!(!is_valid_dns_response(&response, &query));
        response[13] = b'G';
        assert!(is_valid_dns_response(&response, &query));
        response[2] |= 0x02;
        assert!(!is_valid_dns_response(&response, &query));
    }

    #[test]
    fn udp_dns_benchmark_sends_valid_rfc1035_query_and_validates_response() {
        let srv = UdpSocket::bind("127.0.0.1:0").expect("bind mock dns udp");
        let srv_addr = srv.local_addr().unwrap();
        let _ = srv.set_read_timeout(Some(Duration::from_secs(2)));

        let handle = std::thread::spawn(move || {
            let mut req = [0u8; 512];
            let (len, peer) = srv.recv_from(&mut req).expect("recv dns query");
            assert!(len > 12);
            // Проверяем флаг RD=1 и QDCOUNT=1
            assert_eq!(req[4..6], [0, 1]);
            // Формируем минимальный валидный DNS-ответ с тем же TxID и QR=1, RCODE=0
            let mut resp = req[..len].to_vec();
            resp[2] = 0x81; // QR=1, RD=1
            resp[3] = 0x80; // RA=1, RCODE=0
            srv.send_to(&resp, peer).expect("send dns resp");
        });

        let latency = query_dns_udp_ms(srv_addr, "google.com", Duration::from_secs(2))
            .expect("UDP DNS query against local mock server must succeed");
        assert!(latency >= 1);
        handle.join().unwrap();
    }
}
