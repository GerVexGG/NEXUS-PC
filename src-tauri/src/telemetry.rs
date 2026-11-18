use serde::Serialize;
use std::collections::{HashMap, VecDeque};
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
    if cpu_peak > 88.0 {
        incidents.push(DiagnosticsIncident {
            level: if cpu_peak >= 95.0 { "critical".to_string() } else { "warning".to_string() },
            message: format!("Предупреждение: Высокая температура процессора (пик {cpu_peak:.0}°C)"),
        });
    }

    let gpu_peak = points.iter().filter_map(|point| point.gpu_temp).fold(0.0_f32, f32::max);
    if gpu_peak > 83.0 {
        incidents.push(DiagnosticsIncident {
            level: if gpu_peak >= 90.0 { "critical".to_string() } else { "warning".to_string() },
            message: format!("Предупреждение: Высокая температура видеокарты GPU (пик {gpu_peak:.0}°C)"),
        });
    }

    let hot_samples = points.iter().filter(|point| point.cpu_usage > 95.0).count();
    if hot_samples * 2 >= 180 {
        let hot_points: Vec<&TelemetrySnapshot> = points.iter().filter(|point| point.cpu_usage > 95.0).collect();
        let culprit = analyze_cpu_contributor_refs(&hot_points)
            .map(|c| c.name)
            .unwrap_or_else(|| "распределённая нагрузка (единый процесс не выделяется)".to_string());
        incidents.push(DiagnosticsIncident {
            level: "critical".to_string(),
            message: format!("Загрузка CPU держалась выше 95% более 3 минут. Наибольший вклад: {culprit}"),
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
    let load_points: Vec<&TelemetrySnapshot> = points
        .iter()
        .filter(|point| point.cpu_usage >= 35.0 || point.cpu_temp.is_some_and(|temp| temp >= 80.0))
        .collect();
    let contributor = analyze_cpu_contributor_refs(&load_points);

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
    } else if cpu_peak > 88.0 {
        if let Some(c) = contributor {
            format!(
                "Пиковая температура CPU достигала {cpu_peak:.0} °C. Наиболее заметную нагрузку на CPU в нагруженных замерах создавал процесс {} (в среднем {:.0}% CPU в {} из {} замеров). Средняя нагрузка GPU: {gpu_avg:.0}%",
                c.name, c.avg_cpu, c.hits, c.total_loaded
            )
        } else {
            format!(
                "Пиковая температура CPU достигала {cpu_peak:.0} °C; однозначно выделить один процесс-источник нагрузки по серии замеров нельзя (нагрузка распределена или кратковременна). Средняя нагрузка GPU: {gpu_avg:.0}%"
            )
        }
    } else if gpu_peak > 83.0 {
        format!("Пиковая температура видеокарты GPU достигала {gpu_peak:.0} °C. Средняя нагрузка GPU составила {gpu_avg:.0}%")
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

struct CpuContributor {
    name: String,
    avg_cpu: f32,
    hits: usize,
    total_loaded: usize,
}

fn analyze_cpu_contributor_refs(points: &[&TelemetrySnapshot]) -> Option<CpuContributor> {
    let total_loaded = points.len();
    if total_loaded < 2 {
        return None;
    }

    let mut stats: HashMap<String, (usize, f32)> = HashMap::new();
    for point in points {
        let name = point.top_process_name.trim();
        if name.is_empty() || point.top_process_cpu < 15.0 {
            continue;
        }
        let entry = stats.entry(name.to_string()).or_insert((0, 0.0));
        entry.0 += 1;
        entry.1 += point.top_process_cpu;
    }

    let (best_name, (hits, cpu_sum)) = stats
        .into_iter()
        .max_by(|a, b| {
            a.1 .1
                .total_cmp(&b.1 .1)
                .then_with(|| a.1 .0.cmp(&b.1 .0))
        })?;

    let avg_cpu = cpu_sum / hits as f32;
    let min_hits = if total_loaded >= 6 { 3 } else { 2 };
    if hits < min_hits || hits * 5 < total_loaded * 2 || avg_cpu < 20.0 {
        return None;
    }

    Some(CpuContributor {
        name: best_name,
        avg_cpu,
        hits,
        total_loaded,
    })
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
    hw_telemetry: Arc<Mutex<Option<HardwareTelemetry>>>,
    buffer: Arc<RwLock<VecDeque<TelemetrySnapshot>>>,
) {
    std::thread::spawn(move || {
        // Изолированный экземпляр System для фоновой истории телеметрии,
        // чтобы не сбрасывать дельты CPU% и Disk I/O основного диспетчера процессов.
        let mut system = System::new();
        system.refresh_cpu_usage();
        let _ = system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu(),
        );
        loop {
            std::thread::sleep(SAMPLE_GAP);
            let snapshot = capture(&mut system, &hw_telemetry);
            push_snapshot(&buffer, snapshot);
        }
    });
}

fn capture(system: &mut System, hw_telemetry: &Mutex<Option<HardwareTelemetry>>) -> TelemetrySnapshot {
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

    TelemetrySnapshot {
        timestamp: unix_now(),
        cpu_usage,
        cpu_temp,
        gpu_usage,
        gpu_temp,
        ram_used_percent,
        top_process_name,
        top_process_cpu,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_snap(ts: u64, cpu_usage: f32, cpu_temp: Option<f32>, proc_name: &str, proc_cpu: f32) -> TelemetrySnapshot {
        TelemetrySnapshot {
            timestamp: ts,
            cpu_usage,
            cpu_temp,
            gpu_usage: 12.0,
            gpu_temp: Some(50.0),
            ram_used_percent: 45.0,
            top_process_name: proc_name.to_string(),
            top_process_cpu: proc_cpu,
        }
    }

    #[test]
    fn diagnose_ignores_random_low_cpu_process_at_single_temp_peak() {
        let now = unix_now();
        let buffer = RwLock::new(VecDeque::from([
            mk_snap(now - 20, 62.0, Some(84.0), "blender.exe", 58.0),
            mk_snap(now - 16, 65.0, Some(86.0), "blender.exe", 61.0),
            mk_snap(now - 12, 68.0, Some(88.0), "blender.exe", 63.0),
            mk_snap(now - 8, 64.0, Some(89.0), "blender.exe", 59.0),
            // В точке самого пика температуры на долю секунды попал фоновый notifier.exe с 4% CPU
            mk_snap(now - 4, 22.0, Some(91.0), "notifier.exe", 4.0),
        ]));

        let report = diagnose(&buffer, 15);
        assert!(report.verdict.contains("blender.exe"), "Expected sustained contributor blender.exe, got: {}", report.verdict);
        assert!(!report.verdict.contains("notifier.exe"), "Single low-CPU peak sample must not blame notifier.exe: {}", report.verdict);
    }

    #[test]
    fn diagnose_states_uncertainty_when_no_dominant_process_exists() {
        let now = unix_now();
        let buffer = RwLock::new(VecDeque::from([
            mk_snap(now - 16, 40.0, Some(82.0), "a.exe", 10.0),
            mk_snap(now - 12, 42.0, Some(85.0), "b.exe", 11.0),
            mk_snap(now - 8, 38.0, Some(89.0), "c.exe", 9.0),
            mk_snap(now - 4, 41.0, Some(90.0), "d.exe", 12.0),
        ]));

        let report = diagnose(&buffer, 15);
        assert!(
            report.verdict.contains("однозначно выделить один процесс-источник нагрузки"),
            "Distributed/low per-process load must state uncertainty, got: {}",
            report.verdict
        );
    }
}
