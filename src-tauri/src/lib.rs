use serde::Serialize;
use std::process::Command;
use std::sync::Mutex;
use sysinfo::{Disks, Networks, System};
use tauri::State;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// Структура данных, которую мы отправляем в интерфейс
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

// Хранилище состояния sysinfo в памяти, чтобы не пересоздавать его каждую секунду
pub struct AppState {
    pub sys: Mutex<System>,
    pub networks: Mutex<Networks>,
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
            cancel_shutdown
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
