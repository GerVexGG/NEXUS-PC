use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::HardwareTelemetry;

pub const HISTORY_LIMIT: usize = 1800;
const SAMPLE_GAP: Duration = Duration::from_secs(2);

#[derive(Serialize, Clone, Debug)]
pub struct TelemetrySnapshot {
    pub timestamp: u64,
    pub cpu_usage: f32,
    pub cpu_temp: Option<f32>,
    pub gpu_usage: f32,
    pub gpu_temp: Option<f32>,
    pub ram_used_percent: f32,
    pub top_process_name: String,
    pub top_process_cpu: f32,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiagnosticsIncident {
    pub level: String,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiagnosticsReport {
    pub status: String,
    pub stability: String,
    pub incidents: Vec<DiagnosticsIncident>,
    pub verdict: String,
}

pub fn push_snapshot(buffer: &RwLock<VecDeque<TelemetrySnapshot>>, snapshot: TelemetrySnapshot) {
    let Ok(mut guard) = buffer.write() else {
        return;
    };
    if let Some(last) = guard.back() {
        if snapshot.timestamp.saturating_sub(last.timestamp) < 2 {
            return;
        }
    }
    guard.push_back(snapshot);
    while guard.len() > HISTORY_LIMIT {
        guard.pop_front();
    }
}

pub fn history_since(buffer: &RwLock<VecDeque<TelemetrySnapshot>>, minutes: u32) -> Vec<TelemetrySnapshot> {
    let minutes = minutes.clamp(15, 60);
    let now = unix_now();
    let from = now.saturating_sub(minutes as u64 * 60);
    buffer
        .read()
        .map(|guard| guard.iter().filter(|point| point.timestamp >= from).cloned().collect())
        .unwrap_or_default()
}

pub fn diagnose(buffer: &RwLock<VecDeque<TelemetrySnapshot>>, minutes: u32) -> DiagnosticsReport {
    let points = history_since(buffer, minutes);
    if points.is_empty() {
        return DiagnosticsReport {
            status: "Сбор данных".to_string(),
            stability: "Внимание".to_string(),
            incidents: Vec::new(),
            verdict: "История ещё короткая. Диагностика появится после первых точек телеметрии.".to_string(),
        };
    }

    let mut incidents = Vec::new();
    let cpu_peak = points.iter().filter_map(|point| point.cpu_temp).fold(0.0_f32, f32::max);
    let cpu_peak_point = points.iter().filter_map(|point| point.cpu_temp.map(|temp| (temp, point))).max_by(|a, b| a.0.total_cmp(&b.0));
    if cpu_peak > 88.0 {
        incidents.push(DiagnosticsIncident {
            level: if cpu_peak >= 95.0 { "critical".to_string() } else { "warning".to_string() },
            message: format!("Предупреждение: Высокая температура процессора (пик {cpu_peak:.0}°C)"),
        });
    }

    let hot_samples = points.iter().filter(|point| point.cpu_usage > 95.0).count();
    if hot_samples * 2 >= 180 {
        let culprit = busiest_name(points.iter().filter(|point| point.cpu_usage > 95.0));
        incidents.push(DiagnosticsIncident {
            level: "critical".to_string(),
            message: format!("Загрузка CPU держалась выше 95% более 3 минут. Основной процесс: {culprit}"),
        });
    }

    let ram_peak = points.iter().map(|point| point.ram_used_percent).fold(0.0_f32, f32::max);
    if ram_peak > 90.0 {
        incidents.push(DiagnosticsIncident {
            level: "warning".to_string(),
            message: format!("Предупреждение: дефицит оперативной памяти, пик занятости {ram_peak:.0}%"),
        });
    }

    let gpu_avg = average(points.iter().map(|point| point.gpu_usage));
    let process = cpu_peak_point
        .map(|(_, point)| point.top_process_name.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "не определён".to_string());

    let stability = if incidents.iter().any(|item| item.level == "critical") {
        "Критично"
    } else if incidents.is_empty() {
        "Отлично"
    } else {
        "Внимание"
    };
    let status = if incidents.is_empty() {
        "Стабильно"
    } else if stability == "Критично" {
        "Обнаружен перегрев/просадка"
    } else {
        "Внимание"
    };

    let verdict = if incidents.is_empty() {
        "Система работает стабильно, аппаратных ограничений не зафиксировано".to_string()
    } else if cpu_peak > 0.0 {
        format!("Пиковая температура CPU достигала {cpu_peak:.0} °C во время активности {process}. Средняя нагрузка GPU составила {gpu_avg:.0}%")
    } else {
        format!("Средняя нагрузка GPU составила {gpu_avg:.0}%. {}", incidents[0].message)
    };

    DiagnosticsReport {
        status: status.to_string(),
        stability: stability.to_string(),
        incidents,
        verdict,
    }
}

fn busiest_name<'a>(points: impl Iterator<Item = &'a TelemetrySnapshot>) -> String {
    let mut best_name = String::from("не определён");
    let mut best_cpu = -1.0_f32;
    for point in points {
        if point.top_process_cpu > best_cpu && !point.top_process_name.is_empty() {
            best_cpu = point.top_process_cpu;
            best_name = point.top_process_name.clone();
        }
    }
    best_name
}

fn average(values: impl Iterator<Item = f32>) -> f32 {
    let mut sum = 0.0_f32;
    let mut count = 0.0_f32;
    for value in values {
        sum += value;
        count += 1.0;
    }
    if count == 0.0 { 0.0 } else { sum / count }
}

pub fn export_csv(buffer: &RwLock<VecDeque<TelemetrySnapshot>>) -> Result<String, String> {
    let points = buffer.read().map_err(|_| "Буфер телеметрии недоступен".to_string())?;
    let mut csv = String::from("timestamp,cpu_usage,cpu_temp,gpu_usage,gpu_temp,ram_used_percent,top_process_name,top_process_cpu\n");
    for point in points.iter() {
        let cpu_temp = point.cpu_temp.map(|value| format!("{value:.1}")).unwrap_or_default();
        let gpu_temp = point.gpu_temp.map(|value| format!("{value:.1}")).unwrap_or_default();
        let name = point.top_process_name.replace('"', "\"\"");
        csv.push_str(&format!(
            "{},{:.1},{},{:.1},{},{:.1},\"{}\",{:.1}\n",
            point.timestamp, point.cpu_usage, cpu_temp, point.gpu_usage, gpu_temp, point.ram_used_percent, name, point.top_process_cpu
        ));
    }
    let path = desktop_dir()?.join("nexus_telemetry_export.csv");
    fs::write(&path, csv).map_err(|err| format!("Не удалось записать CSV: {err}"))?;
    Ok(path.display().to_string())
}

fn desktop_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "Не найден профиль пользователя".to_string())?;
    let direct = PathBuf::from(&home).join("Desktop");
    if direct.is_dir() {
        return Ok(direct);
    }
    let onedrive = PathBuf::from(&home).join("OneDrive").join("Desktop");
    if onedrive.is_dir() {
        return Ok(onedrive);
    }
    fs::create_dir_all(&direct).map_err(|err| format!("Не удалось открыть Рабочий стол: {err}"))?;
    Ok(direct)
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_secs()).unwrap_or(0)
}

pub fn start_sampler(
    sys: Arc<Mutex<System>>,
    hw_telemetry: Arc<Mutex<Option<HardwareTelemetry>>>,
    buffer: Arc<RwLock<VecDeque<TelemetrySnapshot>>>,
) {
    std::thread::spawn(move || {
        if let Ok(mut guard) = sys.lock() {
            guard.refresh_cpu_usage();
            let _ = guard.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_cpu(),
            );
        }
        loop {
            std::thread::sleep(SAMPLE_GAP);
            let Some(snapshot) = capture(&sys, &hw_telemetry) else {
                continue;
            };
            push_snapshot(&buffer, snapshot);
        }
    });
}

fn capture(sys: &Mutex<System>, hw_telemetry: &Mutex<Option<HardwareTelemetry>>) -> Option<TelemetrySnapshot> {
    let mut system = sys.lock().ok()?;
    system.refresh_cpu_usage();
    system.refresh_memory();
    let _ = system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu(),
    );
    let cpu_usage = system.global_cpu_usage().clamp(0.0, 100.0);
    let total = system.total_memory() as f32;
    let ram_used_percent = if total > 0.0 {
        (system.used_memory() as f32 / total) * 100.0
    } else {
        0.0
    };
    let cores = system.cpus().len().max(1) as f32;
    let mut top_process_name = String::new();
    let mut top_process_cpu = 0.0_f32;
    for process in system.processes().values() {
        if process.pid() == Pid::from_u32(0) {
            continue;
        }
        let name = process.name().to_string_lossy();
        if name.eq_ignore_ascii_case("System Idle Process") || name.eq_ignore_ascii_case("Idle") {
            continue;
        }
        let cpu = (process.cpu_usage() / cores).clamp(0.0, 100.0);
        if cpu > top_process_cpu {
            top_process_cpu = cpu;
            top_process_name = name.into_owned();
        }
    }
    drop(system);

    let (cpu_temp, gpu_temp, gpu_usage) = hw_telemetry
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .map(|data| {
            let cpu_temp = data.cpu.package_temp_c.or(data.cpu.max_core_temp_c);
            let gpu = data.gpus.first();
            let gpu_temp = gpu.and_then(|item| item.core_temp_c);
            let gpu_usage = gpu.and_then(|item| item.load_percent).unwrap_or(0.0);
            (cpu_temp, gpu_temp, gpu_usage)
        })
        .unwrap_or((None, None, 0.0));

    Some(TelemetrySnapshot {
        timestamp: unix_now(),
        cpu_usage,
        cpu_temp,
        gpu_usage,
        gpu_temp,
        ram_used_percent,
        top_process_name,
        top_process_cpu,
    })
}
