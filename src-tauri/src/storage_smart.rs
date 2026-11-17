#[derive(Clone, Debug)]
pub struct SmartDiskMetrics {
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
        String::from_utf8_lossy(&buf[offset..end]).trim().to_string()
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

    fn query_device_descriptor(handle: Handle) -> Option<(String, String, u32)> {
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
        let bus_type = read_u32_le(slice, 28).unwrap_or(0);

        let vendor = read_cstr_at(slice, vendor_off);
        let product = read_cstr_at(slice, product_off);
        let firmware = read_cstr_at(slice, rev_off);

        let model = match (vendor.is_empty(), product.is_empty()) {
            (false, false) => {
                if product.to_ascii_lowercase().starts_with(&vendor.to_ascii_lowercase()) {
                    product
                } else {
                    format!("{vendor} {product}")
                }
            }
            (true, false) => product,
            (false, true) => vendor,
            (true, true) => String::new(),
        };

        Some((model, firmware, bus_type))
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

    fn compute_health_label(
        health_percent: Option<u32>,
        critical_warning: u8,
        media_errors: u64,
    ) -> String {
        if critical_warning != 0 || media_errors > 0 {
            return "Внимание (S.M.A.R.T.)".to_string();
        }
        match health_percent {
            Some(pct) if pct >= 90 => "Отличное".to_string(),
            Some(pct) if pct >= 70 => "Хорошее".to_string(),
            Some(pct) if pct >= 40 => "Износ".to_string(),
            Some(_) => "Критично".to_string(),
            None => "Нет данных".to_string(),
        }
    }

    pub fn query_physical_disks_smart_uncached() -> Vec<SmartDiskMetrics> {
        let mut results = Vec::new();
        for index in 0..16u32 {
            let Some(owned) = open_physical_drive(index) else {
                continue;
            };
            let Some((raw_model, firmware, bus_type)) = query_device_descriptor(owned.0) else {
                continue;
            };
            // Исключаем пустые виртуальные слоты без имени и с шиной Virtual/Spaces
            if bus_type == 14 || bus_type == 15 {
                continue;
            }
            let model = if raw_model.is_empty() {
                format!("Физический диск #{index}")
            } else {
                raw_model
            };
            let mut kind = bus_type_label(bus_type, &model);

            if let Some(nvme) = query_nvme_health_log(owned.0) {
                if kind == "SCSI / SSD" || kind == "Накопитель" || kind == "RAID Массив" {
                    kind = "NVMe M.2".to_string();
                }
                let health_pct = 100u32.saturating_sub(nvme.percentage_used.min(100));
                results.push(SmartDiskMetrics {
                    model,
                    firmware,
                    kind,
                    health_percent: Some(health_pct),
                    health_label: compute_health_label(
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
                    model,
                    firmware,
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
    fn non_admin_nvme_smart_query_discovers_drives() {
        let disks = query_physical_disks_smart();
        println!("Discovered physical disks (native IOCTL): {:#?}", disks);
        assert!(
            !disks.is_empty(),
            "Expected at least one physical drive via IOCTL_STORAGE_QUERY_PROPERTY"
        );
        for d in &disks {
            assert!(!d.model.is_empty());
            if d.kind.contains("NVMe") {
                assert!(
                    d.temp_c.is_some(),
                    "NVMe drive {} should expose temperature",
                    d.model
                );
                assert!(
                    d.health_percent.is_some(),
                    "NVMe drive {} should expose health %",
                    d.model
                );
                assert!(
                    d.power_on_hours.is_some(),
                    "NVMe drive {} should expose power_on_hours",
                    d.model
                );
            }
        }
    }
}
