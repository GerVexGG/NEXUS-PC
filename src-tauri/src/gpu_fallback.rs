#[cfg(target_os = "windows")]
mod imp {
    use std::collections::HashMap;
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
        DXGI_QUERY_VIDEO_MEMORY_INFO, IDXGIAdapter3, IDXGIFactory1,
    };
    use windows::Win32::System::Performance::{
        PDH_FMT_COUNTERVALUE, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData,
        PdhGetFormattedCounterArrayW, PdhGetFormattedCounterValue, PdhOpenQueryW,
    };
    use winreg::RegKey;
    use winreg::enums::HKEY_LOCAL_MACHINE;

    #[derive(Clone, Debug)]
    pub struct DxgiAdapterTelemetry {
        pub name: String,
        pub vendor: String,
        pub vram_total_mb: Option<f32>,
        pub vram_used_mb: Option<f32>,
        pub is_software: bool,
    }

    pub struct GpuPdhSampler {
        query: isize,
        gpu_counter: isize,
        cpu_perf_counter: isize,
        cpu_freq_counter: isize,
        primed: bool,
    }

    unsafe impl Send for GpuPdhSampler {}

    fn add_counter(query: windows::Win32::System::Performance::PDH_HQUERY, path: &str) -> isize {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut counter = unsafe { std::mem::zeroed() };
        let res = unsafe {
            PdhAddEnglishCounterW(query, windows::core::PCWSTR(wide.as_ptr()), 0, &mut counter)
        };
        if res == 0 {
            counter.0 as isize
        } else {
            0
        }
    }

    fn read_scalar_double(counter_handle: isize) -> Option<f64> {
        if counter_handle == 0 {
            return None;
        }
        unsafe {
            let counter = std::mem::transmute::<
                isize,
                windows::Win32::System::Performance::PDH_HCOUNTER,
            >(counter_handle);
            let mut val = PDH_FMT_COUNTERVALUE::default();
            if PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut val) != 0 {
                return None;
            }
            if val.CStatus != 0 {
                return None;
            }
            let dbl = val.Anonymous.doubleValue;
            if dbl.is_finite() { Some(dbl) } else { None }
        }
    }

    impl GpuPdhSampler {
        pub fn new() -> Self {
            unsafe {
                let mut query = std::mem::zeroed();
                if PdhOpenQueryW(None, 0, &mut query) != 0 {
                    return Self {
                        query: 0,
                        gpu_counter: 0,
                        cpu_perf_counter: 0,
                        cpu_freq_counter: 0,
                        primed: false,
                    };
                }
                let gpu_counter = add_counter(query, "\\GPU Engine(*)\\Utilization Percentage");
                let cpu_perf_counter =
                    add_counter(query, "\\Processor Information(_Total)\\% Processor Performance");
                let cpu_freq_counter =
                    add_counter(query, "\\Processor Information(_Total)\\Processor Frequency");

                if gpu_counter == 0 && cpu_perf_counter == 0 {
                    let _ = PdhCloseQuery(query);
                    return Self {
                        query: 0,
                        gpu_counter: 0,
                        cpu_perf_counter: 0,
                        cpu_freq_counter: 0,
                        primed: false,
                    };
                }
                let _ = PdhCollectQueryData(query);
                Self {
                    query: query.0 as isize,
                    gpu_counter,
                    cpu_perf_counter,
                    cpu_freq_counter,
                    primed: true,
                }
            }
        }

        pub fn sample_hardware_pdh(
            &mut self,
            need_gpu_load: bool,
            base_freq_mhz: Option<f32>,
        ) -> (Option<f32>, Option<f32>) {
            if self.query == 0 {
                return (None, None);
            }
            unsafe {
                let query = std::mem::transmute::<
                    isize,
                    windows::Win32::System::Performance::PDH_HQUERY,
                >(self.query);
                if PdhCollectQueryData(query) != 0 {
                    return (None, None);
                }
                if !self.primed {
                    self.primed = true;
                    return (None, None);
                }

                let gpu_load = if need_gpu_load && self.gpu_counter != 0 {
                    self.read_gpu_load_array()
                } else {
                    None
                };

                let cpu_freq = read_scalar_double(self.cpu_freq_counter)
                    .filter(|v| *v > 100.0)
                    .map(|v| v as f32)
                    .or(base_freq_mhz);
                let cpu_clock_mhz = match (read_scalar_double(self.cpu_perf_counter), cpu_freq) {
                    (Some(perf_pct), Some(base_mhz)) if perf_pct > 10.0 && base_mhz > 100.0 => {
                        Some(((base_mhz as f64) * (perf_pct / 100.0)).clamp(200.0, 9000.0) as f32)
                    }
                    _ => cpu_freq,
                };

                (gpu_load, cpu_clock_mhz)
            }
        }

        pub fn sample_load_percent(&mut self) -> Option<f32> {
            self.sample_hardware_pdh(true, None).0
        }

        unsafe fn read_gpu_load_array(&self) -> Option<f32> {
            if self.gpu_counter == 0 {
                return None;
            }
            let counter = unsafe {
                std::mem::transmute::<
                    isize,
                    windows::Win32::System::Performance::PDH_HCOUNTER,
                >(self.gpu_counter)
            };

            let mut buf_size: u32 = 0;
            let mut item_count: u32 = 0;
            let status = unsafe {
                PdhGetFormattedCounterArrayW(
                    counter,
                    PDH_FMT_DOUBLE,
                    &mut buf_size,
                    &mut item_count,
                    None,
                )
            };
            // PDH_MORE_DATA = 0x800007D2
            if status != 0x8000_07D2 || buf_size == 0 || item_count == 0 {
                return None;
            }

            let mut raw = vec![0u8; buf_size as usize];
            let ptr = raw.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if unsafe {
                PdhGetFormattedCounterArrayW(
                    counter,
                    PDH_FMT_DOUBLE,
                    &mut buf_size,
                    &mut item_count,
                    Some(ptr),
                )
            } != 0
            {
                return None;
            }

            let items = unsafe { std::slice::from_raw_parts(ptr, item_count as usize) };
            // Суммируем загрузку по каждому типу движка (engtype_3D, Compute, Copy, VideoDecode...)
            // и берём максимум среди движков (как делает Диспетчер задач Windows).
            let mut per_engine: HashMap<String, f64> = HashMap::new();
            for item in items {
                if item.FmtValue.CStatus != 0 {
                    continue;
                }
                let val = unsafe { item.FmtValue.Anonymous.doubleValue };
                if !val.is_finite() || val < 0.0 {
                    continue;
                }
                let name = if item.szName.is_null() {
                    String::new()
                } else {
                    unsafe { item.szName.to_string().unwrap_or_default() }
                };
                let engine_key = name
                    .split('_')
                    .skip_while(|part| *part != "engtype")
                    .take(2)
                    .collect::<Vec<_>>()
                    .join("_");
                let bucket = if engine_key.is_empty() {
                    "engtype_3D".to_string()
                } else {
                    engine_key
                };
                *per_engine.entry(bucket).or_insert(0.0) += val;
            }

            per_engine
                .into_values()
                .reduce(f64::max)
                .map(|v| (v as f32).clamp(0.0, 100.0))
        }
    }

    pub fn is_hvci_enabled() -> bool {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(key) = hklm.open_subkey(
            r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
        ) {
            if let Ok(enabled) = key.get_value::<u32, _>("Enabled") {
                return enabled == 1;
            }
        }
        false
    }

    impl Drop for GpuPdhSampler {
        fn drop(&mut self) {
            if self.query != 0 {
                unsafe {
                    let query = std::mem::transmute::<isize, windows::Win32::System::Performance::PDH_HQUERY>(self.query);
                    let _ = PdhCloseQuery(query);
                }
                self.query = 0;
            }
        }
    }

    fn utf16_z_to_string(slice: &[u16]) -> String {
        let len = slice.iter().position(|c| *c == 0).unwrap_or(slice.len());
        String::from_utf16_lossy(&slice[..len]).trim().to_string()
    }

    fn vendor_from_pci_id(vendor_id: u32) -> &'static str {
        match vendor_id {
            0x10DE => "NVIDIA",
            0x1002 | 0x1022 => "AMD",
            0x8086 => "Intel",
            0x1414 => "Microsoft",
            _ => "",
        }
    }

    pub fn query_dxgi_gpus() -> Vec<DxgiAdapterTelemetry> {
        let mut results = Vec::new();
        unsafe {
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
                return results;
            };
            let mut idx = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(idx) {
                idx += 1;
                let Ok(desc) = adapter.GetDesc1() else {
                    continue;
                };
                let is_software = (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0;
                let name = utf16_z_to_string(&desc.Description);
                if name.is_empty() {
                    continue;
                }
                let total_mb = if desc.DedicatedVideoMemory > 0 {
                    Some(desc.DedicatedVideoMemory as f32 / (1024.0 * 1024.0))
                } else {
                    None
                };

                let mut used_mb = None;
                if let Ok(adapter3) = adapter.cast::<IDXGIAdapter3>() {
                    let mut mem_info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
                    if adapter3
                        .QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut mem_info)
                        .is_ok()
                        && mem_info.Budget > 0
                    {
                        used_mb = Some(mem_info.CurrentUsage as f32 / (1024.0 * 1024.0));
                    }
                }

                results.push(DxgiAdapterTelemetry {
                    name,
                    vendor: vendor_from_pci_id(desc.VendorId).to_string(),
                    vram_total_mb: total_mb,
                    vram_used_mb: used_mb,
                    is_software,
                });
            }
        }

        let hardware_only: Vec<_> = results.iter().filter(|g| !g.is_software).cloned().collect();
        if !hardware_only.is_empty() {
            hardware_only
        } else {
            results
        }
    }

    fn normalize_gpu_name(name: &str) -> String {
        name.to_ascii_lowercase()
            .replace("nvidia ", "")
            .replace("amd ", "")
            .replace("intel(r) ", "")
            .replace("intel ", "")
            .replace("(tm)", "")
            .replace("(r)", "")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn enrich_gpus(gpus: &mut Vec<crate::GpuTelemetry>, pdh_load: Option<f32>) {
        let dxgi = query_dxgi_gpus();
        if gpus.is_empty() {
            for (idx, item) in dxgi.iter().enumerate() {
                let vram_used_percent = match (item.vram_used_mb, item.vram_total_mb) {
                    (Some(used), Some(total)) if total > 0.0 => Some(((used / total) * 100.0).clamp(0.0, 100.0)),
                    _ => None,
                };
                gpus.push(crate::GpuTelemetry {
                    name: item.name.clone(),
                    vendor: item.vendor.clone(),
                    load_percent: if idx == 0 { pdh_load } else { None },
                    vram_used_mb: item.vram_used_mb,
                    vram_total_mb: item.vram_total_mb,
                    vram_used_percent,
                    telemetry_source: "DXGI / Windows PDH".to_string(),
                    ..Default::default()
                });
            }
            return;
        }

        for (idx, gpu) in gpus.iter_mut().enumerate() {
            if gpu.vendor.is_empty() {
                let lower = gpu.name.to_ascii_lowercase();
                if lower.contains("nvidia") || lower.contains("geforce") || lower.contains("rtx") || lower.contains("gtx") || lower.contains("quadro") {
                    gpu.vendor = "NVIDIA".to_string();
                } else if lower.contains("amd") || lower.contains("radeon") {
                    gpu.vendor = "AMD".to_string();
                } else if lower.contains("intel") || lower.contains("arc") || lower.contains("uhd") || lower.contains("iris") {
                    gpu.vendor = "Intel".to_string();
                }
            }

            let gpu_norm = normalize_gpu_name(&gpu.name);
            let matched = dxgi
                .iter()
                .find(|d| {
                    let dn = normalize_gpu_name(&d.name);
                    !dn.is_empty() && !gpu_norm.is_empty() && (dn == gpu_norm || dn.contains(&gpu_norm) || gpu_norm.contains(&dn))
                })
                .or_else(|| if dxgi.len() == 1 && idx == 0 { Some(&dxgi[0]) } else { None });

            if let Some(d) = matched {
                if gpu.vendor.is_empty() && !d.vendor.is_empty() {
                    gpu.vendor = d.vendor.clone();
                }
                let mut used_dxgi = false;
                if gpu.vram_total_mb.is_none() && d.vram_total_mb.is_some() {
                    gpu.vram_total_mb = d.vram_total_mb;
                    used_dxgi = true;
                }
                if gpu.vram_used_mb.is_none() && d.vram_used_mb.is_some() {
                    gpu.vram_used_mb = d.vram_used_mb;
                    used_dxgi = true;
                }
                if used_dxgi && !gpu.telemetry_source.contains("DXGI") {
                    if gpu.telemetry_source.is_empty() {
                        gpu.telemetry_source = "DXGI".to_string();
                    } else {
                        gpu.telemetry_source.push_str(" + DXGI");
                    }
                }
            }

            if gpu.vram_used_percent.is_none() {
                if let (Some(used), Some(total)) = (gpu.vram_used_mb, gpu.vram_total_mb) {
                    if total > 0.0 {
                        gpu.vram_used_percent = Some(((used / total) * 100.0).clamp(0.0, 100.0));
                    }
                }
            }

            if idx == 0 && gpu.load_percent.is_none() && pdh_load.is_some() {
                gpu.load_percent = pdh_load;
                if !gpu.telemetry_source.contains("PDH") {
                    if gpu.telemetry_source.is_empty() {
                        gpu.telemetry_source = "Windows PDH".to_string();
                    } else {
                        gpu.telemetry_source.push_str(" + PDH");
                    }
                }
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub struct GpuPdhSampler;
    impl GpuPdhSampler {
        pub fn new() -> Self {
            Self
        }
        pub fn sample_hardware_pdh(
            &mut self,
            _need_gpu_load: bool,
            _base_freq_mhz: Option<f32>,
        ) -> (Option<f32>, Option<f32>) {
            (None, None)
        }
        pub fn sample_load_percent(&mut self) -> Option<f32> {
            None
        }
    }
    pub fn is_hvci_enabled() -> bool {
        false
    }
    pub fn enrich_gpus(_gpus: &mut Vec<crate::GpuTelemetry>, _pdh_load: Option<f32>) {}
}

pub use imp::{GpuPdhSampler, enrich_gpus, is_hvci_enabled};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dxgi_and_pdh_enrich_populates_real_gpu() {
        let mut sampler = GpuPdhSampler::new();
        std::thread::sleep(std::time::Duration::from_millis(120));
        let (pdh_load, cpu_clock_mhz) = sampler.sample_hardware_pdh(true, Some(3600.0));
        println!(
            "PDH cpu_clock_mhz={cpu_clock_mhz:?}, hvci_enabled={}",
            is_hvci_enabled()
        );

        let mut empty: Vec<crate::GpuTelemetry> = Vec::new();
        enrich_gpus(&mut empty, pdh_load);
        println!("DXGI/PDH fallback GPUs: {:#?}", empty);

        assert!(!empty.is_empty(), "Expected at least one DXGI GPU adapter");
        let gpu = &empty[0];
        assert!(!gpu.name.trim().is_empty(), "GPU name should not be empty");
        assert!(gpu.vram_total_mb.unwrap_or(0.0) > 0.0, "VRAM total MB should be > 0");
        assert!(gpu.telemetry_source.contains("DXGI"));

        // Verify partial LHM enrichment preserves existing sensors and fills missing VRAM/load
        let mut partial = vec![crate::GpuTelemetry {
            name: gpu.name.clone(),
            core_temp_c: Some(45.0),
            telemetry_source: "LibreHardwareMonitor".to_string(),
            ..Default::default()
        }];
        enrich_gpus(&mut partial, Some(12.5));
        assert_eq!(partial[0].core_temp_c, Some(45.0));
        assert_eq!(partial[0].load_percent, Some(12.5));
        assert!(partial[0].vram_total_mb.unwrap_or(0.0) > 0.0);
        assert!(partial[0].telemetry_source.contains("LibreHardwareMonitor"));
        assert!(partial[0].telemetry_source.contains("DXGI"));
        assert!(partial[0].telemetry_source.contains("PDH"));
    }
}
