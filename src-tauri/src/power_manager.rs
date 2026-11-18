use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x0000_0008;

const MAX_TIMER_SECONDS: u64 = 315_360_000; // Максимум Windows shutdown /t (10 лет)
const LEGACY_SLEEP_TASK_NAME: &str = "NexusPC_SleepTimer";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PowerTimerAction {
    Shutdown,
    Restart,
    Sleep,
}

impl PowerTimerAction {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "shutdown" => Ok(Self::Shutdown),
            "restart" => Ok(Self::Restart),
            "sleep" => Ok(Self::Sleep),
            other => Err(format!("Неизвестный режим таймера питания: {other}")),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PersistedPowerTimer {
    pub timer_id: String,
    pub action: PowerTimerAction,
    pub start_time_ms: u64,
    pub end_time_ms: u64,
    pub total_seconds: u64,
    #[serde(default)]
    pub worker_pid: Option<u32>,
    #[serde(default)]
    pub worker_start_time: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PowerTimerState {
    pub timer_id: String,
    pub action: PowerTimerAction,
    pub start_time_ms: u64,
    pub end_time_ms: u64,
    pub total_seconds: u64,
    pub remaining_seconds: u64,
    pub restart: bool,
    pub sleep: bool,
}

impl PersistedPowerTimer {
    fn to_public_state(&self, now_ms: u64) -> PowerTimerState {
        let diff_ms = self.end_time_ms.saturating_sub(now_ms);
        let remaining_seconds = if diff_ms == 0 {
            0
        } else {
            ((diff_ms.saturating_add(999)) / 1000).max(1)
        };
        PowerTimerState {
            timer_id: self.timer_id.clone(),
            action: self.action,
            start_time_ms: self.start_time_ms,
            end_time_ms: self.end_time_ms,
            total_seconds: self.total_seconds,
            remaining_seconds,
            restart: self.action == PowerTimerAction::Restart,
            sleep: self.action == PowerTimerAction::Sleep,
        }
    }
}

pub trait PowerSystemOps: Send + Sync {
    fn now_ms(&self) -> u64;
    fn os_boot_time_ms(&self) -> Option<u64>;
    fn schedule_shutdown(&self, seconds: u64, restart: bool) -> Result<(), String>;
    fn abort_shutdown(&self, strict_missing_ok: bool) -> Result<(), String>;
    fn spawn_sleep_worker(&self, seconds: u64) -> Result<(u32, Option<u64>), String>;
    fn is_worker_alive(&self, pid: u32, expected_start_time: Option<u64>) -> bool;
    fn terminate_worker(&self, pid: u32, expected_start_time: Option<u64>) -> Result<(), String>;
    fn cleanup_legacy_tasks(&self);
    fn execute_immediate(&self, action: &str) -> Result<(), String>;
}

pub struct WindowsPowerOps;

impl WindowsPowerOps {
    fn run_command(program: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
    }
}

#[cfg(target_os = "windows")]
mod win_proc_ffi {
    use std::ffi::c_void;

    pub type Handle = *mut c_void;
    pub const PROCESS_TERMINATE: u32 = 0x0001;
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
        pub fn GetExitCodeProcess(handle: Handle, exit_code: *mut u32) -> i32;
        pub fn GetTickCount64() -> u64;
    }

    pub fn filetime_to_unix_secs(ft: FILETIME) -> u64 {
        let ticks = ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64);
        (ticks / 10_000_000).saturating_sub(11_644_473_600)
    }

    pub fn query_process_start_time_by_handle(handle: Handle) -> Option<u64> {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let ok = unsafe {
            GetProcessTimes(
                handle,
                &mut creation as *mut FILETIME,
                &mut exit as *mut FILETIME,
                &mut kernel as *mut FILETIME,
                &mut user as *mut FILETIME,
            )
        };
        if ok == 0 {
            None
        } else {
            Some(filetime_to_unix_secs(creation))
        }
    }

    pub fn query_process_start_time_pid(pid: u32) -> Option<u64> {
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if raw.is_null() {
            return None;
        }
        let handle = ScopedHandle(raw);
        query_process_start_time_by_handle(handle.0)
    }

    pub fn is_pid_alive_with_start(pid: u32, expected_start_time: Option<u64>) -> bool {
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if raw.is_null() {
            return false;
        }
        let handle = ScopedHandle(raw);
        let mut exit_code: u32 = 0;
        if unsafe { GetExitCodeProcess(handle.0, &mut exit_code as *mut u32) } == 0
            || exit_code != STILL_ACTIVE
        {
            return false;
        }
        if let Some(expected) = expected_start_time {
            if let Some(actual) = query_process_start_time_by_handle(handle.0) {
                if actual != expected {
                    return false;
                }
            }
        }
        true
    }

    pub fn terminate_pid_with_start(pid: u32, expected_start_time: Option<u64>) -> Result<(), String> {
        let raw =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, pid) };
        if raw.is_null() {
            if !is_pid_alive_with_start(pid, expected_start_time) {
                return Ok(());
            }
            return Err(format!(
                "Не удалось открыть фоновый процесс таймера сна (PID {pid}): {}",
                std::io::Error::last_os_error()
            ));
        }
        let handle = ScopedHandle(raw);

        let mut exit_code: u32 = 0;
        if unsafe { GetExitCodeProcess(handle.0, &mut exit_code as *mut u32) } != 0
            && exit_code != STILL_ACTIVE
        {
            return Ok(());
        }

        if let Some(expected) = expected_start_time {
            if let Some(actual) = query_process_start_time_by_handle(handle.0) {
                if actual != expected {
                    // PID уже переиспользован другим процессом, исходный таймер завершился
                    return Ok(());
                }
            }
        }

        let term_ok = unsafe { TerminateProcess(handle.0, 1) };
        if term_ok == 0 {
            let mut after_exit: u32 = 0;
            if unsafe { GetExitCodeProcess(handle.0, &mut after_exit as *mut u32) } != 0
                && after_exit != STILL_ACTIVE
            {
                return Ok(());
            }
            return Err(format!(
                "Не удалось остановить фоновый процесс таймера сна (PID {pid}): {}",
                std::io::Error::last_os_error()
            ));
        }

        Ok(())
    }
}

impl PowerSystemOps for WindowsPowerOps {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn os_boot_time_ms(&self) -> Option<u64> {
        #[cfg(target_os = "windows")]
        {
            let uptime_ms = unsafe { win_proc_ffi::GetTickCount64() };
            let now = self.now_ms();
            return Some(now.saturating_sub(uptime_ms));
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }

    fn schedule_shutdown(&self, seconds: u64, restart: bool) -> Result<(), String> {
        let mode_flag = if restart { "/r" } else { "/s" };
        let sec_arg = seconds.to_string();
        let output = Self::run_command("shutdown", &[mode_flag, "/t", &sec_arg])
            .map_err(|e| format!("Не удалось запустить системный shutdown: {e}"))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if !stderr.is_empty() { stderr } else { stdout };
            Err(if detail.is_empty() {
                format!(
                    "Команда shutdown завершилась с кодом {:?}",
                    output.status.code()
                )
            } else {
                detail
            })
        }
    }

    fn abort_shutdown(&self, _strict_missing_ok: bool) -> Result<(), String> {
        let output = Self::run_command("shutdown", &["/a"])
            .map_err(|e| format!("Не удалось вызвать отмену выключения: {e}"))?;
        // 1116 = ERROR_NO_SHUTDOWN_IN_PROGRESS
        if output.status.success() || output.status.code() == Some(1116) {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                format!(
                    "Не удалось отменить системный таймер (код {:?})",
                    output.status.code()
                )
            } else {
                stderr
            })
        }
    }

    fn spawn_sleep_worker(&self, seconds: u64) -> Result<(u32, Option<u64>), String> {
        // Независимый detached PowerShell-воркер: переживает закрытие/выход NEXUS,
        // не требует прав администратора и не оставляет бесхозных задач в Task Scheduler.
        let script = format!(
            "Start-Sleep -Seconds {seconds}; Start-Process -FilePath 'rundll32.exe' -ArgumentList 'powrprof.dll,SetSuspendState 0,1,0' -WindowStyle Hidden"
        );
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);

        let child = cmd
            .spawn()
            .map_err(|e| format!("Не удалось запустить системный таймер сна: {e}"))?;
        let pid = child.id();

        #[cfg(target_os = "windows")]
        let start_time = win_proc_ffi::query_process_start_time_pid(pid);
        #[cfg(not(target_os = "windows"))]
        let start_time = None;

        drop(child);
        Ok((pid, start_time))
    }

    fn is_worker_alive(&self, pid: u32, expected_start_time: Option<u64>) -> bool {
        #[cfg(target_os = "windows")]
        {
            win_proc_ffi::is_pid_alive_with_start(pid, expected_start_time)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (pid, expected_start_time);
            false
        }
    }

    fn terminate_worker(&self, pid: u32, expected_start_time: Option<u64>) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            win_proc_ffi::terminate_pid_with_start(pid, expected_start_time)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (pid, expected_start_time);
            Ok(())
        }
    }

    fn cleanup_legacy_tasks(&self) {
        let _ = Self::run_command("schtasks", &["/Delete", "/TN", LEGACY_SLEEP_TASK_NAME, "/F"]);
    }

    fn execute_immediate(&self, action: &str) -> Result<(), String> {
        let output = match action {
            "shutdown" => Self::run_command("shutdown", &["/s", "/t", "0"]),
            "restart" => Self::run_command("shutdown", &["/r", "/t", "0"]),
            "sleep" => Self::run_command("rundll32.exe", &["powrprof.dll,SetSuspendState 0,1,0"]),
            "lock" => Self::run_command("rundll32.exe", &["user32.dll,LockWorkStation"]),
            other => return Err(format!("Неизвестное действие питания: {other}")),
        }
        .map_err(|err| format!("Не удалось выполнить действие питания: {err}"))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                format!(
                    "Действие питания завершилось с кодом {:?}",
                    output.status.code()
                )
            } else {
                stderr
            })
        }
    }
}

pub fn default_timer_state_path() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            return PathBuf::from(appdata).join("nexus").join("power_timer.json");
        }
    }
    PathBuf::from("nexus-data").join("power_timer.json")
}

pub struct PowerTimerManager {
    state_path: PathBuf,
    ops: Arc<dyn PowerSystemOps>,
    guard: Mutex<Option<PersistedPowerTimer>>,
    seq: AtomicU64,
}

impl PowerTimerManager {
    pub fn new() -> Self {
        Self::with_path_and_ops(default_timer_state_path(), Arc::new(WindowsPowerOps))
    }

    pub fn with_path_and_ops(state_path: PathBuf, ops: Arc<dyn PowerSystemOps>) -> Self {
        let initial = Self::load_persisted(&state_path);
        let mgr = Self {
            state_path,
            ops,
            guard: Mutex::new(initial),
            seq: AtomicU64::new(1),
        };
        let _ = mgr.get_state();
        mgr
    }

    fn load_persisted(path: &Path) -> Option<PersistedPowerTimer> {
        let raw = fs::read_to_string(path).ok()?;
        serde_json::from_str::<PersistedPowerTimer>(&raw).ok()
    }

    fn write_persisted(&self, record: &PersistedPowerTimer) -> Result<(), String> {
        if let Some(parent) = self.state_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Не удалось создать каталог состояния таймера: {e}"))?;
            }
        }
        let body = serde_json::to_string_pretty(record)
            .map_err(|e| format!("Не удалось сериализовать таймер питания: {e}"))?;
        let tmp_path = self.state_path.with_extension("json.tmp");
        fs::write(&tmp_path, &body)
            .map_err(|e| format!("Не удалось записать временный файл таймера: {e}"))?;
        if let Err(rename_err) = fs::rename(&tmp_path, &self.state_path) {
            let _ = fs::remove_file(&tmp_path);
            fs::write(&self.state_path, body)
                .map_err(|e| format!("Не удалось сохранить таймер ({rename_err}; {e})"))?;
        }
        Ok(())
    }

    fn remove_persisted_file(&self) {
        if self.state_path.exists() {
            let _ = fs::remove_file(&self.state_path);
        }
    }

    fn timer_is_stale_or_dead(&self, record: &PersistedPowerTimer, now_ms: u64) -> bool {
        if now_ms >= record.end_time_ms {
            return true;
        }
        if let Some(boot_ms) = self.ops.os_boot_time_ms() {
            if record.start_time_ms.saturating_add(5_000) < boot_ms {
                return true;
            }
        }
        if record.action == PowerTimerAction::Sleep {
            if let Some(pid) = record.worker_pid {
                if !self.ops.is_worker_alive(pid, record.worker_start_time) {
                    return true;
                }
            } else {
                return true;
            }
        }
        false
    }

    fn cancel_locked(&self, slot: &mut Option<PersistedPowerTimer>) -> Result<(), String> {
        let active = slot
            .clone()
            .or_else(|| Self::load_persisted(&self.state_path));

        if let Some(ref timer) = active {
            if let Some(pid) = timer.worker_pid {
                self.ops.terminate_worker(pid, timer.worker_start_time)?;
            }
        }

        self.ops.abort_shutdown(true)?;
        self.ops.cleanup_legacy_tasks();

        *slot = None;
        self.remove_persisted_file();
        Ok(())
    }

    pub fn get_state(&self) -> Result<Option<PowerTimerState>, String> {
        let mut slot = self
            .guard
            .lock()
            .map_err(|_| "Хранилище таймера питания заблокировано".to_string())?;

        let record = slot
            .clone()
            .or_else(|| Self::load_persisted(&self.state_path));

        let Some(rec) = record else {
            return Ok(None);
        };

        let now_ms = self.ops.now_ms();
        if self.timer_is_stale_or_dead(&rec, now_ms) {
            if rec.action == PowerTimerAction::Sleep && now_ms >= rec.end_time_ms {
                if let Some(pid) = rec.worker_pid {
                    // На случай если воркер подвис после наступления времени сна — аккуратно подчищаем
                    if now_ms >= rec.end_time_ms.saturating_add(15_000) {
                        let _ = self.ops.terminate_worker(pid, rec.worker_start_time);
                    }
                }
            }
            *slot = None;
            self.remove_persisted_file();
            return Ok(None);
        }

        let public = rec.to_public_state(now_ms);
        *slot = Some(rec);
        Ok(Some(public))
    }

    pub fn schedule_timer(
        &self,
        seconds: u64,
        action: PowerTimerAction,
    ) -> Result<PowerTimerState, String> {
        if seconds == 0 {
            return Err("Время таймера должно быть больше 0 секунд".to_string());
        }
        if seconds > MAX_TIMER_SECONDS {
            return Err(format!(
                "Время таймера превышает допустимый максимум Windows ({MAX_TIMER_SECONDS} сек)"
            ));
        }

        let mut slot = self
            .guard
            .lock()
            .map_err(|_| "Хранилище таймера питания заблокировано".to_string())?;

        self.cancel_locked(&mut slot)?;

        let (worker_pid, worker_start_time) = match action {
            PowerTimerAction::Shutdown => {
                self.ops.schedule_shutdown(seconds, false)?;
                (None, None)
            }
            PowerTimerAction::Restart => {
                self.ops.schedule_shutdown(seconds, true)?;
                (None, None)
            }
            PowerTimerAction::Sleep => {
                let (pid, start_time) = self.ops.spawn_sleep_worker(seconds)?;
                (Some(pid), start_time)
            }
        };

        let start_time_ms = self.ops.now_ms();
        let end_time_ms = start_time_ms.saturating_add(seconds.saturating_mul(1000));
        let timer_id = format!(
            "pwr-{}-{}",
            start_time_ms,
            self.seq.fetch_add(1, Ordering::Relaxed)
        );

        let record = PersistedPowerTimer {
            timer_id,
            action,
            start_time_ms,
            end_time_ms,
            total_seconds: seconds,
            worker_pid,
            worker_start_time,
        };

        if let Err(err) = self.write_persisted(&record) {
            if let Some(pid) = worker_pid {
                let _ = self.ops.terminate_worker(pid, worker_start_time);
            }
            if matches!(
                action,
                PowerTimerAction::Shutdown | PowerTimerAction::Restart
            ) {
                let _ = self.ops.abort_shutdown(true);
            }
            return Err(err);
        }

        let public = record.to_public_state(start_time_ms);
        *slot = Some(record);
        Ok(public)
    }

    pub fn cancel_timer(&self) -> Result<(), String> {
        let mut slot = self
            .guard
            .lock()
            .map_err(|_| "Хранилище таймера питания заблокировано".to_string())?;
        self.cancel_locked(&mut slot)
    }

    pub fn execute_immediate_action(&self, action: &str) -> Result<(), String> {
        let normalized = action.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "shutdown" | "restart" | "sleep" => {
                self.cancel_timer()?;
                self.ops.execute_immediate(&normalized)
            }
            "lock" => {
                // Блокировка экрана не должна неожиданно отменять запланированное действие питания.
                self.ops.execute_immediate("lock")
            }
            _ => Err("Неизвестное действие питания".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    struct MockPowerOps {
        now: AtomicU64,
        boot_ms: u64,
        next_pid: AtomicU64,
        calls: Mutex<Vec<String>>,
        alive_workers: Mutex<HashSet<u32>>,
        fail_abort: Mutex<bool>,
    }

    impl MockPowerOps {
        fn new(initial_now_ms: u64) -> Self {
            Self {
                now: AtomicU64::new(initial_now_ms),
                boot_ms: initial_now_ms.saturating_sub(100_000),
                next_pid: AtomicU64::new(40_000),
                calls: Mutex::new(Vec::new()),
                alive_workers: Mutex::new(HashSet::new()),
                fail_abort: Mutex::new(false),
            }
        }

        fn advance_ms(&self, delta_ms: u64) {
            self.now.fetch_add(delta_ms, Ordering::SeqCst);
        }

        fn take_calls(&self) -> Vec<String> {
            let mut g = self.calls.lock().unwrap();
            std::mem::take(&mut *g)
        }
    }

    impl PowerSystemOps for MockPowerOps {
        fn now_ms(&self) -> u64 {
            self.now.load(Ordering::SeqCst)
        }

        fn os_boot_time_ms(&self) -> Option<u64> {
            Some(self.boot_ms)
        }

        fn schedule_shutdown(&self, seconds: u64, restart: bool) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("schedule_shutdown({seconds}, restart={restart})"));
            Ok(())
        }

        fn abort_shutdown(&self, _strict_missing_ok: bool) -> Result<(), String> {
            self.calls.lock().unwrap().push("abort_shutdown".to_string());
            if *self.fail_abort.lock().unwrap() {
                return Err("mock abort failure".to_string());
            }
            Ok(())
        }

        fn spawn_sleep_worker(&self, seconds: u64) -> Result<(u32, Option<u64>), String> {
            let pid = self.next_pid.fetch_add(1, Ordering::SeqCst) as u32;
            self.alive_workers.lock().unwrap().insert(pid);
            self.calls
                .lock()
                .unwrap()
                .push(format!("spawn_sleep_worker({seconds}) -> {pid}"));
            Ok((pid, Some(1_700_000_000)))
        }

        fn is_worker_alive(&self, pid: u32, _expected_start_time: Option<u64>) -> bool {
            self.alive_workers.lock().unwrap().contains(&pid)
        }

        fn terminate_worker(&self, pid: u32, _expected_start_time: Option<u64>) -> Result<(), String> {
            self.alive_workers.lock().unwrap().remove(&pid);
            self.calls
                .lock()
                .unwrap()
                .push(format!("terminate_worker({pid})"));
            Ok(())
        }

        fn cleanup_legacy_tasks(&self) {
            self.calls
                .lock()
                .unwrap()
                .push("cleanup_legacy_tasks".to_string());
        }

        fn execute_immediate(&self, action: &str) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("execute_immediate({action})"));
            Ok(())
        }
    }

    struct TempStateDir(PathBuf);

    impl TempStateDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nexus_power_test_{tag}_{}_{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempStateDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn power_timer_lifecycle_persists_restores_replaces_and_cancels() {
        let dir = TempStateDir::new("lifecycle");
        let path = dir.0.join("power_timer.json");
        let ops = Arc::new(MockPowerOps::new(1_700_000_000_000));

        // 1. Запускаем таймер сна и проверяем сохранённый state + живого воркера
        let mgr1 = PowerTimerManager::with_path_and_ops(path.clone(), ops.clone());
        let sleep_state = mgr1.schedule_timer(600, PowerTimerAction::Sleep).unwrap();
        assert_eq!(sleep_state.action, PowerTimerAction::Sleep);
        assert!(sleep_state.sleep);
        assert!(!sleep_state.restart);
        assert_eq!(sleep_state.remaining_seconds, 600);
        assert!(path.exists(), "power_timer.json must persist on disk");
        let sleep_pid = ops
            .alive_workers
            .lock()
            .unwrap()
            .iter()
            .copied()
            .next()
            .expect("sleep worker pid recorded");

        // 2. Имитация полного выхода и повторного запуска NEXUS спустя 120 секунд
        drop(mgr1);
        ops.advance_ms(120_000);
        let mgr2 = PowerTimerManager::with_path_and_ops(path.clone(), ops.clone());
        let restored = mgr2
            .get_state()
            .unwrap()
            .expect("timer must be restored from backend disk state after restart");
        assert_eq!(restored.timer_id, sleep_state.timer_id);
        assert_eq!(restored.action, PowerTimerAction::Sleep);
        assert_eq!(restored.remaining_seconds, 480);

        // 3. Повторное создание таймера (перезагрузка) должно завершить воркер сна и заменить расписание
        let _ = ops.take_calls();
        let restart_state = mgr2.schedule_timer(300, PowerTimerAction::Restart).unwrap();
        assert_eq!(restart_state.action, PowerTimerAction::Restart);
        assert!(restart_state.restart);
        assert!(!ops.is_worker_alive(sleep_pid, Some(1_700_000_000)));
        let calls = ops.take_calls();
        assert!(calls.contains(&format!("terminate_worker({sleep_pid})")));
        assert!(calls.contains(&"schedule_shutdown(300, restart=true)".to_string()));

        // 4. Отмена сбоем не должна очищать состояние при неудаче системной отмены
        *ops.fail_abort.lock().unwrap() = true;
        assert!(mgr2.cancel_timer().is_err());
        assert!(mgr2.get_state().unwrap().is_some());
        *ops.fail_abort.lock().unwrap() = false;

        // 5. Успешная отмена очищает и память, и файл
        mgr2.cancel_timer().unwrap();
        assert!(mgr2.get_state().unwrap().is_none());
        assert!(!path.exists());

        // 6. Истёкший таймер автоматически очищается при чтении/старте
        let _ = mgr2.schedule_timer(30, PowerTimerAction::Shutdown).unwrap();
        ops.advance_ms(31_000);
        let mgr3 = PowerTimerManager::with_path_and_ops(path.clone(), ops.clone());
        assert!(mgr3.get_state().unwrap().is_none());
        assert!(!path.exists());
    }

    #[test]
    fn power_immediate_actions_coordinate_with_active_schedule() {
        let dir = TempStateDir::new("immediate");
        let path = dir.0.join("power_timer.json");
        let ops = Arc::new(MockPowerOps::new(1_700_000_500_000));
        let mgr = PowerTimerManager::with_path_and_ops(path.clone(), ops.clone());

        // Блокировка экрана не должна отменять запланированное действие
        mgr.schedule_timer(600, PowerTimerAction::Shutdown).unwrap();
        let _ = ops.take_calls();
        mgr.execute_immediate_action("lock").unwrap();
        let lock_calls = ops.take_calls();
        assert_eq!(lock_calls, vec!["execute_immediate(lock)"]);
        assert!(
            mgr.get_state().unwrap().is_some(),
            "lock must keep active power timer intact"
        );

        // Немедленный сон отменяет конфликтующее расписание выключения/перезагрузки
        mgr.execute_immediate_action("sleep").unwrap();
        let sleep_calls = ops.take_calls();
        assert!(sleep_calls.contains(&"abort_shutdown".to_string()));
        assert!(sleep_calls.contains(&"execute_immediate(sleep)".to_string()));
        assert!(mgr.get_state().unwrap().is_none());

        // Немедленное выключение / перезагрузка отменяют запланированный таймер сна
        mgr.schedule_timer(900, PowerTimerAction::Sleep).unwrap();
        let sleep_pid = *ops.alive_workers.lock().unwrap().iter().next().unwrap();
        let _ = ops.take_calls();
        mgr.execute_immediate_action("shutdown").unwrap();
        let shutdown_calls = ops.take_calls();
        assert!(shutdown_calls.contains(&format!("terminate_worker({sleep_pid})")));
        assert!(shutdown_calls.contains(&"execute_immediate(shutdown)".to_string()));
        assert!(mgr.get_state().unwrap().is_none());

        mgr.schedule_timer(900, PowerTimerAction::Shutdown).unwrap();
        let _ = ops.take_calls();
        mgr.execute_immediate_action("restart").unwrap();
        let restart_calls = ops.take_calls();
        assert!(restart_calls.contains(&"abort_shutdown".to_string()));
        assert!(restart_calls.contains(&"execute_immediate(restart)".to_string()));
        assert!(mgr.get_state().unwrap().is_none());
    }
}
