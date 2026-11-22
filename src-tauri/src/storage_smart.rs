#[derive(Clone, Debug, PartialEq)]
pub struct SmartDiskMetrics {
    pub device_id: Option<u32>,
    pub serial_number: String,
    pub model: String,
    pub firmware: String,
    pub kind: String,
    pub health_percent: Option<u32>,
    pub health_label: String,
    pub available_spare: Option<u32>,
    pub power_on_hours: Option<u64>,
    pub power_cycles: Option<u64>,
    pub temp_c: Option<u32>,
    pub tbw_tb: Option<f64>,
    pub read_tb: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct FallbackDiskRecord {
    pub device_id: Option<u32>,
    pub serial_number: String,
    pub model: String,
    pub media: String,
    pub bus: String,
    pub health_status: String,
    pub temp_c: Option<u32>,
    pub power_on_hours: Option<u64>,
    pub power_cycles: Option<u64>,
    pub wear: Option<f64>,
    pub bytes_written: Option<u64>,
    pub bytes_read: Option<u64>,
}

pub fn has_usable_native_smart(disk: &SmartDiskMetrics) -> bool {
    disk.health_percent.is_some() && disk.temp_c.is_some() && disk.power_on_hours.is_some()
}

pub fn disk_kind_from_bus(media: &str, bus: &str) -> String {
    let media_low = media.trim().to_ascii_lowercase();
    let bus_low = bus.trim().to_ascii_lowercase();
    if bus_low.contains("nvme") {
        "NVMe M.2".to_string()
    } else if media_low.contains("hdd") || media_low == "3" {
        "HDD".to_string()
    } else if media_low.contains("ssd") || media_low == "4" || bus_low.contains("sata") {
        "SATA SSD".to_string()
    } else if media_low.is_empty() && bus_low.is_empty() {
        "Накопитель".to_string()
    } else {
        format!("{} {}", media.trim(), bus.trim())
            .trim()
            .to_string()
    }
}

pub fn compute_health_label(percent: Option<u32>, status: &str) -> String {
    if let Some(value) = percent {
        if value >= 90 {
            return "Отличное".to_string();
        }
        if value >= 70 {
            return "Хорошее".to_string();
        }
        if value >= 40 {
            return "Износ".to_string();
        }
        return "Критично".to_string();
    }
    match status.trim().to_ascii_lowercase().as_str() {
        "healthy" => "Исправен".to_string(),
        "warning" => "Внимание".to_string(),
        "unhealthy" => "Критично".to_string(),
        _ => "Нет данных".to_string(),
    }
}

fn normalize_serial(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if cleaned.len() >= 4 && !cleaned.chars().all(|c| c == '0') {
        Some(cleaned)
    } else {
        None
    }
}

fn normalize_model(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn apply_fallback_enrichment(disk: &mut SmartDiskMetrics, fb: &FallbackDiskRecord) {
    if disk.serial_number.is_empty() && !fb.serial_number.trim().is_empty() {
        disk.serial_number = fb.serial_number.trim().to_string();
    }
    if disk.device_id.is_none() {
        disk.device_id = fb.device_id;
    }
    if (disk.model.is_empty() || disk.model.starts_with("Физический диск #"))
        && !fb.model.trim().is_empty()
    {
        disk.model = fb.model.trim().to_string();
    }

    let fb_kind = disk_kind_from_bus(&fb.media, &fb.bus);
    if fb_kind != "Накопитель"
        && matches!(
            disk.kind.as_str(),
            "Накопитель" | "SCSI / SSD" | "ATA / SATA" | "RAID Массив"
        )
    {
        disk.kind = fb_kind;
    }

    // Не придумываем фиктивные 100%, если контроллер не отдаёт Wear
    if disk.health_percent.is_none() {
        disk.health_percent = fb
            .wear
            .filter(|w| w.is_finite() && (0.0..=100.0).contains(w))
            .map(|w| (100.0 - w).round() as u32);
    }
    if disk.health_label == "Нет данных"
        || (disk.health_percent.is_some() && !fb.health_status.trim().is_empty())
    {
        let computed = compute_health_label(disk.health_percent, &fb.health_status);
        if disk.health_label == "Нет данных" && computed != "Нет данных" {
            disk.health_label = computed;
        } else if disk.health_percent.is_some() && !disk.health_label.contains("S.M.A.R.T.") {
            disk.health_label = compute_health_label(disk.health_percent, &fb.health_status);
        }
    }

    if disk.temp_c.is_none() {
        disk.temp_c = fb.temp_c.filter(|&t| (1..120).contains(&t));
    }
    if disk.power_on_hours.is_none() {
        disk.power_on_hours = fb.power_on_hours;
    }
    if disk.power_cycles.is_none() {
        disk.power_cycles = fb.power_cycles;
    }
    if disk.tbw_tb.is_none() {
        disk.tbw_tb = fb
            .bytes_written
            .filter(|&b| b > 0)
            .map(|b| b as f64 / 1_000_000_000_000.0);
    }
    if disk.read_tb.is_none() {
        disk.read_tb = fb
            .bytes_read
            .filter(|&b| b > 0)
            .map(|b| b as f64 / 1_000_000_000_000.0);
    }
}

fn fallback_to_smart_metrics(fb: FallbackDiskRecord) -> SmartDiskMetrics {
    let health_percent = fb
        .wear
        .filter(|w| w.is_finite() && (0.0..=100.0).contains(w))
        .map(|w| (100.0 - w).round() as u32);
    SmartDiskMetrics {
        device_id: fb.device_id,
        serial_number: fb.serial_number.trim().to_string(),
        model: if fb.model.trim().is_empty() {
            fb.device_id
                .map(|id| format!("Физический диск #{id}"))
                .unwrap_or_else(|| "Накопитель".to_string())
        } else {
            fb.model.trim().to_string()
        },
        firmware: String::new(),
        kind: disk_kind_from_bus(&fb.media, &fb.bus),
        health_percent,
        health_label: compute_health_label(health_percent, &fb.health_status),
        available_spare: None,
        power_on_hours: fb.power_on_hours,
        power_cycles: fb.power_cycles,
        temp_c: fb.temp_c.filter(|&t| (1..120).contains(&t)),
        tbw_tb: fb
            .bytes_written
            .filter(|&b| b > 0)
            .map(|b| b as f64 / 1_000_000_000_000.0),
        read_tb: fb
            .bytes_read
            .filter(|&b| b > 0)
            .map(|b| b as f64 / 1_000_000_000_000.0),
    }
}

/// Объединяет результаты нативного Win32 IOCTL-опроса и PowerShell fallback без дубликатов.
/// Идентификация выполняется по `device_id` (PhysicalDrive index), затем по серийному номеру,
/// и только при отсутствии конфликтов ID/SN — по уникальному имени модели.
pub fn merge_native_and_fallback_disks(
    mut native: Vec<SmartDiskMetrics>,
    fallback: Vec<FallbackDiskRecord>,
) -> Vec<SmartDiskMetrics> {
    let mut matched_fb = vec![false; fallback.len()];
    let mut matched_native = vec![false; native.len()];

    // 1. Точное сопоставление по DeviceId (PhysicalDrive{N})
    for (nat_idx, disk) in native.iter_mut().enumerate() {
        let Some(dev_id) = disk.device_id else {
            continue;
        };
        if let Some((fb_idx, fb)) = fallback
            .iter()
            .enumerate()
            .find(|(idx, fb)| !matched_fb[*idx] && fb.device_id == Some(dev_id))
        {
            apply_fallback_enrichment(disk, fb);
            matched_fb[fb_idx] = true;
            matched_native[nat_idx] = true;
        }
    }

    // 2. Сопоставление по нормализованному серийному номеру (при отсутствии конфликтующих device_id)
    for (nat_idx, disk) in native.iter_mut().enumerate() {
        if matched_native[nat_idx] {
            continue;
        }
        let Some(native_sn) = normalize_serial(&disk.serial_number) else {
            continue;
        };
        if let Some((fb_idx, fb)) = fallback.iter().enumerate().find(|(idx, fb)| {
            if matched_fb[*idx] {
                return false;
            }
            if let (Some(a), Some(b)) = (disk.device_id, fb.device_id) {
                if a != b {
                    return false;
                }
            }
            normalize_serial(&fb.serial_number).as_deref() == Some(native_sn.as_str())
        }) {
            apply_fallback_enrichment(disk, fb);
            matched_fb[fb_idx] = true;
            matched_native[nat_idx] = true;
        }
    }

    // 3. Осторожное сопоставление по модели (только когда модель уникальна и нет конфликта device_id / serial)
    let mut native_model_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for disk in &native {
        let m = normalize_model(&disk.model);
        if !m.is_empty() {
            *native_model_counts.entry(m).or_insert(0) += 1;
        }
    }
    let mut fb_model_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for fb in &fallback {
        let m = normalize_model(&fb.model);
        if !m.is_empty() {
            *fb_model_counts.entry(m).or_insert(0) += 1;
        }
    }

    for (nat_idx, disk) in native.iter_mut().enumerate() {
        if matched_native[nat_idx] || has_usable_native_smart(disk) {
            continue;
        }
        let native_model = normalize_model(&disk.model);
        if native_model.is_empty()
            || native_model_counts.get(&native_model).copied().unwrap_or(0) != 1
            || fb_model_counts.get(&native_model).copied().unwrap_or(0) != 1
        {
            continue;
        }
        if let Some((fb_idx, fb)) = fallback.iter().enumerate().find(|(idx, fb)| {
            if matched_fb[*idx] || normalize_model(&fb.model) != native_model {
                return false;
            }
            if let (Some(a), Some(b)) = (disk.device_id, fb.device_id) {
                if a != b {
                    return false;
                }
            }
            if let (Some(sa), Some(sb)) = (
                normalize_serial(&disk.serial_number),
                normalize_serial(&fb.serial_number),
            ) {
                if sa != sb {
                    return false;
                }
            }
            true
        }) {
            apply_fallback_enrichment(disk, fb);
            matched_fb[fb_idx] = true;
            matched_native[nat_idx] = true;
        }
    }

    // 4. Добавляем физические накопители, обнаруженные только в fallback
    for (idx, fb) in fallback.into_iter().enumerate() {
        if !matched_fb[idx] {
            native.push(fallback_to_smart_metrics(fb));
        }
    }

    native.sort_by_key(|d| (d.device_id.unwrap_or(u32::MAX), d.model.clone()));
    native
}

#[cfg(target_os = "windows")]
mod imp {
    use super::SmartDiskMetrics;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    type Handle = *mut c_void;
    const INVALID_HANDLE: Handle = (-1isize) as Handle;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const OPEN_EXISTING: u32 = 3;

    const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D_1400;
    const STORAGE_DEVICE_PROPERTY: i32 = 0;
    const STORAGE_ADAPTER_PROTOCOL_SPECIFIC_PROPERTY: i32 = 49;
    const STORAGE_DEVICE_PROTOCOL_SPECIFIC_PROPERTY: i32 = 50;
    const PROTOCOL_TYPE_NVME: u32 = 3;
    const NVME_DATA_TYPE_LOG_PAGE: u32 = 2;
    const NVME_LOG_PAGE_HEALTH_INFO: u32 = 2;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: *const c_void,
            dw_creation_disposition: u32,
            dw_flags_and_attributes: u32,
            h_template_file: Handle,
        ) -> Handle;

        fn DeviceIoControl(
            h_device: Handle,
            dw_io_control_code: u32,
            lp_in_buffer: *const c_void,
            n_in_buffer_size: u32,
            lp_out_buffer: *mut c_void,
            n_out_buffer_size: u32,
            lp_bytes_returned: *mut u32,
            lp_overlapped: *mut c_void,
        ) -> i32;

        fn CloseHandle(h_object: Handle) -> i32;
    }

    struct OwnedHandle(Handle);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    fn open_physical_drive(index: u32) -> Option<OwnedHandle> {
        let path_str = format!(r"\\.\PhysicalDrive{index}");
        let wide: Vec<u16> = Path::new(&path_str)
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // Права dwDesiredAccess = 0 позволяют открывать дескриптор для IOCTL_STORAGE_QUERY_PROPERTY без прав Администратора.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle.is_null() || handle == INVALID_HANDLE {
            None
        } else {
            Some(OwnedHandle(handle))
        }
    }

    fn read_cstr_at(buf: &[u8], offset: usize) -> String {
        if offset == 0 || offset >= buf.len() {
            return String::new();
        }
        let end = buf[offset..]
            .iter()
            .position(|&b| b == 0)
            .map(|rel| offset + rel)
            .unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[offset..end])
            .trim()
            .to_string()
    }

    fn read_u32_le(buf: &[u8], offset: usize) -> Option<u32> {
        let bytes: [u8; 4] = buf.get(offset..offset + 4)?.try_into().ok()?;
        Some(u32::from_le_bytes(bytes))
    }

    fn read_u64_le(buf: &[u8], offset: usize) -> Option<u64> {
        let bytes: [u8; 8] = buf.get(offset..offset + 8)?.try_into().ok()?;
        Some(u64::from_le_bytes(bytes))
    }

    fn write_u32_le(buf: &mut [u8], offset: usize, val: u32) {
        buf[offset..offset + 4].copy_from_slice(&val.to_le_bytes());
    }

    fn bus_type_label(bus_type: u32, model: &str) -> String {
        let model_lower = model.to_ascii_lowercase();
        match bus_type {
            17 => "NVMe M.2".to_string(),
            11 => "SATA SSD".to_string(),
            3 | 2 => "ATA / SATA".to_string(),
            7 => "USB Накопитель".to_string(),
            8 => "RAID Массив".to_string(),
            10 | 1 => {
                if model_lower.contains("nvme") {
                    "NVMe M.2".to_string()
                } else {
                    "SCSI / SSD".to_string()
                }
            }
            14 | 15 | 16 => "Виртуальный диск".to_string(),
            _ => {
                if model_lower.contains("nvme") {
                    "NVMe M.2".to_string()
                } else {
                    "Накопитель".to_string()
                }
            }
        }
    }

    struct DeviceDescriptorInfo {
        model: String,
        firmware: String,
        serial_number: String,
        bus_type: u32,
    }

    fn query_device_descriptor(handle: Handle) -> Option<DeviceDescriptorInfo> {
        let mut query = [0u8; 12];
        write_u32_le(&mut query, 0, STORAGE_DEVICE_PROPERTY as u32);
        write_u32_le(&mut query, 4, 0);

        let mut out = vec![0u8; 1024];
        let mut bytes_returned: u32 = 0;
        let ok = unsafe {
            DeviceIoControl(
                handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                query.as_ptr() as *const c_void,
                query.len() as u32,
                out.as_mut_ptr() as *mut c_void,
                out.len() as u32,
                &mut bytes_returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 || (bytes_returned as usize) < 32 {
            return None;
        }
        let slice = &out[..(bytes_returned as usize).min(out.len())];
        let vendor_off = read_u32_le(slice, 12).unwrap_or(0) as usize;
        let product_off = read_u32_le(slice, 16).unwrap_or(0) as usize;
        let rev_off = read_u32_le(slice, 20).unwrap_or(0) as usize;
        let serial_off = read_u32_le(slice, 24).unwrap_or(0) as usize;
        let bus_type = read_u32_le(slice, 28).unwrap_or(0);

        let vendor = read_cstr_at(slice, vendor_off);
        let product = read_cstr_at(slice, product_off);
        let firmware = read_cstr_at(slice, rev_off);
        let serial_number = read_cstr_at(slice, serial_off);

        let model = match (vendor.is_empty(), product.is_empty()) {
            (false, false) => {
                if product
                    .to_ascii_lowercase()
                    .starts_with(&vendor.to_ascii_lowercase())
                {
                    product
                } else {
                    format!("{vendor} {product}")
                }
            }
            (true, false) => product,
            (false, true) => vendor,
            (true, true) => String::new(),
        };

        Some(DeviceDescriptorInfo {
            model,
            firmware,
            serial_number,
            bus_type,
        })
    }

    struct NvmeSmartRaw {
        critical_warning: u8,
        temp_c: Option<u32>,
        available_spare: u32,
        percentage_used: u32,
        read_tb: Option<f64>,
        tbw_tb: Option<f64>,
        power_cycles: Option<u64>,
        power_on_hours: Option<u64>,
        media_errors: Option<u64>,
    }

    fn query_nvme_health_log(handle: Handle) -> Option<NvmeSmartRaw> {
        const LOG_OFFSET: usize = 8 + 40;
        const LOG_LEN: usize = 512;

        for prop_id in [
            STORAGE_ADAPTER_PROTOCOL_SPECIFIC_PROPERTY,
            STORAGE_DEVICE_PROTOCOL_SPECIFIC_PROPERTY,
        ] {
            let mut buf = vec![0u8; LOG_OFFSET + LOG_LEN];
            write_u32_le(&mut buf, 0, prop_id as u32);
            write_u32_le(&mut buf, 4, 0); // PropertyStandardQuery
            write_u32_le(&mut buf, 8, PROTOCOL_TYPE_NVME);
            write_u32_le(&mut buf, 12, NVME_DATA_TYPE_LOG_PAGE);
            write_u32_le(&mut buf, 16, NVME_LOG_PAGE_HEALTH_INFO);
            write_u32_le(&mut buf, 20, 0);
            write_u32_le(&mut buf, 24, 40); // sizeof(STORAGE_PROTOCOL_SPECIFIC_DATA)
            write_u32_le(&mut buf, 28, LOG_LEN as u32);

            let mut returned: u32 = 0;
            let ok = unsafe {
                DeviceIoControl(
                    handle,
                    IOCTL_STORAGE_QUERY_PROPERTY,
                    buf.as_ptr() as *const c_void,
                    buf.len() as u32,
                    buf.as_mut_ptr() as *mut c_void,
                    buf.len() as u32,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            if ok != 0 && (returned as usize) >= LOG_OFFSET + 176 {
                let log = &buf[LOG_OFFSET..];
                let critical_warning = log[0];
                let temp_k = u16::from_le_bytes([log[1], log[2]]);
                let temp_c = if (200..=393).contains(&temp_k) {
                    Some((temp_k - 273) as u32)
                } else {
                    None
                };
                let available_spare = (log[3] as u32).min(100);
                let percentage_used = log[5] as u32;

                // NVMe spec: 1 Data Unit = 512,000 bytes (1000 * 512B blocks)
                let read_units = read_u64_le(log, 32).unwrap_or(0);
                let written_units = read_u64_le(log, 48).unwrap_or(0);
                let read_tb = if read_units > 0 {
                    Some((read_units as f64 * 512_000.0) / 1_000_000_000_000.0)
                } else {
                    None
                };
                let tbw_tb = if written_units > 0 {
                    Some((written_units as f64 * 512_000.0) / 1_000_000_000_000.0)
                } else {
                    None
                };
                let power_cycles = read_u64_le(log, 112);
                let power_on_hours = read_u64_le(log, 128);
                let media_errors = read_u64_le(log, 160);

                return Some(NvmeSmartRaw {
                    critical_warning,
                    temp_c,
                    available_spare,
                    percentage_used,
                    read_tb,
                    tbw_tb,
                    power_cycles,
                    power_on_hours,
                    media_errors,
                });
            }
        }
        None
    }

    fn compute_nvme_health_label(
        health_percent: Option<u32>,
        critical_warning: u8,
        media_errors: u64,
    ) -> String {
        if critical_warning != 0 || media_errors > 0 {
            return "Внимание (S.M.A.R.T.)".to_string();
        }
        super::compute_health_label(health_percent, "")
    }

    pub fn query_physical_disks_smart_uncached() -> Vec<SmartDiskMetrics> {
        let mut results = Vec::new();
        for index in 0..16u32 {
            let Some(owned) = open_physical_drive(index) else {
                continue;
            };
            let Some(desc) = query_device_descriptor(owned.0) else {
                continue;
            };
            // Исключаем пустые виртуальные слоты без имени и с шиной Virtual/Spaces
            if desc.bus_type == 14 || desc.bus_type == 15 {
                continue;
            }
            let model = if desc.model.is_empty() {
                format!("Физический диск #{index}")
            } else {
                desc.model
            };
            let mut kind = bus_type_label(desc.bus_type, &model);

            if let Some(nvme) = query_nvme_health_log(owned.0) {
                if kind == "SCSI / SSD" || kind == "Накопитель" || kind == "RAID Массив"
                {
                    kind = "NVMe M.2".to_string();
                }
                let health_pct = 100u32.saturating_sub(nvme.percentage_used.min(100));
                results.push(SmartDiskMetrics {
                    device_id: Some(index),
                    serial_number: desc.serial_number,
                    model,
                    firmware: desc.firmware,
                    kind,
                    health_percent: Some(health_pct),
                    health_label: compute_nvme_health_label(
                        Some(health_pct),
                        nvme.critical_warning,
                        nvme.media_errors.unwrap_or(0),
                    ),
                    available_spare: Some(nvme.available_spare),
                    power_on_hours: nvme.power_on_hours,
                    power_cycles: nvme.power_cycles,
                    temp_c: nvme.temp_c,
                    tbw_tb: nvme.tbw_tb,
                    read_tb: nvme.read_tb,
                });
            } else {
                results.push(SmartDiskMetrics {
                    device_id: Some(index),
                    serial_number: desc.serial_number,
                    model,
                    firmware: desc.firmware,
                    kind,
                    health_percent: None,
                    health_label: "Нет данных".to_string(),
                    available_spare: None,
                    power_on_hours: None,
                    power_cycles: None,
                    temp_c: None,
                    tbw_tb: None,
                    read_tb: None,
                });
            }
        }
        results
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::SmartDiskMetrics;

    pub fn query_physical_disks_smart_uncached() -> Vec<SmartDiskMetrics> {
        Vec::new()
    }
}

pub fn query_physical_disks_smart_cached(force_refresh: bool) -> Vec<SmartDiskMetrics> {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    static CACHE: OnceLock<Mutex<Option<(Instant, Vec<SmartDiskMetrics>)>>> = OnceLock::new();
    let mutex = CACHE.get_or_init(|| Mutex::new(None));
    if !force_refresh {
        if let Ok(guard) = mutex.lock() {
            if let Some((captured_at, ref cached)) = *guard {
                if captured_at.elapsed() < Duration::from_secs(5) {
                    return cached.clone();
                }
            }
        }
    }
    let fresh = imp::query_physical_disks_smart_uncached();
    if let Ok(mut guard) = mutex.lock() {
        *guard = Some((Instant::now(), fresh.clone()));
    }
    fresh
}

pub fn query_physical_disks_smart() -> Vec<SmartDiskMetrics> {
    query_physical_disks_smart_cached(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_admin_nvme_smart_query_does_not_fail_when_hardware_sensors_absent() {
        let disks = query_physical_disks_smart();
        println!("Discovered physical disks (native IOCTL): {:#?}", disks);
        for d in &disks {
            assert!(!d.model.is_empty());
            assert!(d.device_id.is_some());
        }
    }

    #[test]
    #[ignore = "requires physical NVMe drive exposing Health Info Log 0x02"]
    fn hardware_live_nvme_smart_probe() {
        let disks = query_physical_disks_smart();
        let nvme_disks: Vec<_> = disks.iter().filter(|d| d.kind.contains("NVMe")).collect();
        assert!(
            !nvme_disks.is_empty(),
            "Expected at least one NVMe drive on hardware test host"
        );
        for d in nvme_disks {
            assert!(d.temp_c.is_some(), "NVMe {} should expose temp_c", d.model);
            assert!(
                d.health_percent.is_some(),
                "NVMe {} should expose health_percent",
                d.model
            );
            assert!(
                d.power_on_hours.is_some(),
                "NVMe {} should expose power_on_hours",
                d.model
            );
        }
    }

    #[test]
    fn merge_enriches_incomplete_native_sata_and_preserves_native_nvme() {
        let native = vec![
            SmartDiskMetrics {
                device_id: Some(0),
                serial_number: "NVME-001".to_string(),
                model: "Samsung SSD 980 PRO 1TB".to_string(),
                firmware: "5B2QGXA7".to_string(),
                kind: "NVMe M.2".to_string(),
                health_percent: Some(98),
                health_label: "Отличное".to_string(),
                available_spare: Some(100),
                power_on_hours: Some(1200),
                power_cycles: Some(85),
                temp_c: Some(41),
                tbw_tb: Some(12.5),
                read_tb: Some(19.2),
            },
            SmartDiskMetrics {
                device_id: Some(1),
                serial_number: "SATA-002".to_string(),
                model: "Crucial MX500 1TB".to_string(),
                firmware: "M3CR045".to_string(),
                kind: "SATA SSD".to_string(),
                health_percent: None,
                health_label: "Нет данных".to_string(),
                available_spare: None,
                power_on_hours: None,
                power_cycles: None,
                temp_c: None,
                tbw_tb: None,
                read_tb: None,
            },
        ];

        let fallback = vec![
            FallbackDiskRecord {
                device_id: Some(0),
                serial_number: "NVME-001".to_string(),
                model: "Samsung SSD 980 PRO 1TB".to_string(),
                media: "SSD".to_string(),
                bus: "NVMe".to_string(),
                health_status: "Healthy".to_string(),
                temp_c: Some(99), // не должно перезаписывать нативное 41
                power_on_hours: Some(9999),
                power_cycles: Some(9999),
                wear: Some(50.0), // не должно перезаписывать нативные 98%
                bytes_written: Some(999_000_000_000_000),
                bytes_read: None,
            },
            FallbackDiskRecord {
                device_id: Some(1),
                serial_number: "SATA-002".to_string(),
                model: "Crucial MX500 1TB".to_string(),
                media: "SSD".to_string(),
                bus: "SATA".to_string(),
                health_status: "Healthy".to_string(),
                temp_c: Some(34),
                power_on_hours: Some(4500),
                power_cycles: Some(310),
                wear: Some(7.0),
                bytes_written: Some(25_000_000_000_000),
                bytes_read: Some(18_000_000_000_000),
            },
        ];

        assert!(has_usable_native_smart(&native[0]));
        assert!(!has_usable_native_smart(&native[1]));

        let merged = merge_native_and_fallback_disks(native, fallback);
        assert_eq!(merged.len(), 2);

        // NVMe сохранил нативные значения
        assert_eq!(merged[0].health_percent, Some(98));
        assert_eq!(merged[0].temp_c, Some(41));
        assert_eq!(merged[0].power_on_hours, Some(1200));

        // SATA обогащён из fallback, прошивка сохранена
        assert_eq!(merged[1].firmware, "M3CR045");
        assert_eq!(merged[1].health_percent, Some(93));
        assert_eq!(merged[1].health_label, "Отличное");
        assert_eq!(merged[1].temp_c, Some(34));
        assert_eq!(merged[1].power_on_hours, Some(4500));
        assert_eq!(merged[1].power_cycles, Some(310));
        assert_eq!(merged[1].tbw_tb, Some(25.0));
        assert_eq!(merged[1].read_tb, Some(18.0));
    }

    #[test]
    fn merge_keeps_two_identical_model_drives_distinct_and_does_not_invent_missing_wear() {
        let native = vec![
            SmartDiskMetrics {
                device_id: Some(1),
                serial_number: "S4CZNF0N111111".to_string(),
                model: "Samsung SSD 870 EVO 1TB".to_string(),
                firmware: "SVT02B6Q".to_string(),
                kind: "SATA SSD".to_string(),
                health_percent: None,
                health_label: "Нет данных".to_string(),
                available_spare: None,
                power_on_hours: None,
                power_cycles: None,
                temp_c: None,
                tbw_tb: None,
                read_tb: None,
            },
            SmartDiskMetrics {
                device_id: Some(2),
                serial_number: "S4CZNF0N222222".to_string(),
                model: "Samsung SSD 870 EVO 1TB".to_string(),
                firmware: "SVT02B6Q".to_string(),
                kind: "SATA SSD".to_string(),
                health_percent: None,
                health_label: "Нет данных".to_string(),
                available_spare: None,
                power_on_hours: None,
                power_cycles: None,
                temp_c: None,
                tbw_tb: None,
                read_tb: None,
            },
        ];

        let fallback = vec![
            FallbackDiskRecord {
                device_id: Some(1),
                serial_number: "S4CZNF0N111111".to_string(),
                model: "Samsung SSD 870 EVO 1TB".to_string(),
                media: "SSD".to_string(),
                bus: "SATA".to_string(),
                health_status: "Healthy".to_string(),
                temp_c: Some(33),
                power_on_hours: Some(1100),
                power_cycles: None,
                wear: Some(2.0),
                bytes_written: None,
                bytes_read: None,
            },
            FallbackDiskRecord {
                device_id: Some(2),
                serial_number: "S4CZNF0N222222".to_string(),
                model: "Samsung SSD 870 EVO 1TB".to_string(),
                media: "HDD".to_string(),
                bus: "SATA".to_string(),
                health_status: "Healthy".to_string(),
                temp_c: Some(37),
                power_on_hours: Some(8200),
                power_cycles: None,
                // Контроллер не отдаёт Wear — health_percent должен остаться None, без 100%!
                wear: None,
                bytes_written: None,
                bytes_read: None,
            },
            FallbackDiskRecord {
                device_id: Some(3),
                serial_number: "WD-EXTRA-3".to_string(),
                model: "WDC WD20EZBX".to_string(),
                media: "HDD".to_string(),
                bus: "SATA".to_string(),
                health_status: "Healthy".to_string(),
                temp_c: Some(36),
                power_on_hours: Some(500),
                power_cycles: Some(40),
                wear: None,
                bytes_written: None,
                bytes_read: None,
            },
        ];

        let merged = merge_native_and_fallback_disks(native, fallback);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].device_id, Some(1));
        assert_eq!(merged[0].health_percent, Some(98));
        assert_eq!(merged[0].temp_c, Some(33));

        assert_eq!(merged[1].device_id, Some(2));
        assert_eq!(merged[1].health_percent, None);
        assert_eq!(merged[1].health_label, "Исправен");
        assert_eq!(merged[1].temp_c, Some(37));
        assert_eq!(merged[1].power_on_hours, Some(8200));

        assert_eq!(merged[2].device_id, Some(3));
        assert_eq!(merged[2].kind, "HDD");
        assert_eq!(merged[2].health_percent, None);
    }
}
