use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct NetworkAdapterInfo {
    pub id: String,
    pub interface_index: u32,
    pub name: String,
    pub description: String,
    pub manufacturer: String,
    pub adapter_kind: String,
    pub adapter_type_label: String,
    pub is_physical: bool,
    pub is_system_tunnel: bool,
    pub status: String,
    pub status_label: String,
    pub is_connected: bool,
    pub is_primary: bool,
    pub link_speed_bps: u64,
    pub mac_address: String,
    pub ipv4_addresses: Vec<String>,
    pub ipv6_addresses: Vec<String>,
    pub gateways: Vec<String>,
    pub dns_servers: Vec<String>,
    pub rx_bytes_per_sec: f64,
    pub tx_bytes_per_sec: f64,
    pub total_rx_bytes: u64,
    pub total_tx_bytes: u64,
    pub session_rx_bytes: u64,
    pub session_tx_bytes: u64,
    pub rx_packets: u64,
    pub tx_packets: u64,
    pub rx_errors: u64,
    pub tx_errors: u64,
    pub rx_dropped: u64,
    pub tx_dropped: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct NetworkTelemetrySnapshot {
    pub timestamp_ms: u64,
    pub adapters: Vec<NetworkAdapterInfo>,
    pub active_adapter_id: Option<String>,
    pub total_rx_bytes_per_sec: f64,
    pub total_tx_bytes_per_sec: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct NetworkHealthProbe {
    pub timestamp_ms: u64,
    pub gateway_ip: Option<String>,
    pub gateway_reachable: bool,
    pub gateway_ping_ms: Option<u32>,
    pub external_host: String,
    pub external_reachable: bool,
    pub external_ping_ms: Option<u32>,
    pub external_method: String,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{NetworkAdapterInfo, NetworkHealthProbe, NetworkTelemetrySnapshot};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use windows::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
    use windows::Win32::NetworkManagement::IpHelper::{
        FreeMibTable, GAA_FLAG_INCLUDE_ALL_INTERFACES, GAA_FLAG_INCLUDE_GATEWAYS,
        GetAdaptersAddresses, GetIfTable2, ICMP_ECHO_REPLY, IP_ADAPTER_ADDRESSES_LH,
        IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, MIB_IF_TABLE2,
    };
    use windows::Win32::NetworkManagement::Ndis::{
        IfOperStatusDormant, IfOperStatusDown, IfOperStatusLowerLayerDown,
        IfOperStatusNotPresent, IfOperStatusTesting, IfOperStatusUp, MediaConnectStateConnected,
    };
    use windows::Win32::Networking::WinSock::{
        AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6, SOCKET_ADDRESS,
    };
    use winreg::RegKey;
    use winreg::enums::HKEY_LOCAL_MACHINE;

    #[derive(Clone, Debug)]
    struct NicRegMeta {
        characteristics: u32,
        provider_name: String,
        device_instance_id: String,
    }

    #[derive(Clone, Debug)]
    struct CounterSample {
        in_octets: u64,
        out_octets: u64,
        at: Instant,
    }

    pub struct NetworkMonitorState {
        prev_counters: HashMap<u64, CounterSample>,
        last_rates: HashMap<u64, (f64, f64)>,
        sys_prev_counters: HashMap<u64, CounterSample>,
        sys_last_rates: (f32, f32),
        session_baselines: HashMap<u64, (u64, u64)>,
    }

    impl NetworkMonitorState {
        pub fn new() -> Self {
            Self {
                prev_counters: HashMap::new(),
                last_rates: HashMap::new(),
                sys_prev_counters: HashMap::new(),
                sys_last_rates: (0.0, 0.0),
                session_baselines: HashMap::new(),
            }
        }

        pub fn read_system_throughput_kbps(&mut self) -> Result<(f32, f32), String> {
            let now = Instant::now();
            let if_rows = read_if_table()?;
            let mut total_rx_bps = 0.0f64;
            let mut total_tx_bps = 0.0f64;
            let mut updated_any = false;

            for row in if_rows {
                // Пропускаем NDIS-фильтры, loopback и неактивные виртуальные минипорты
                if (row.flags & 0x02) != 0 || row.if_type == 24 || row.if_type == 131 {
                    continue;
                }
                if (row.flags & 0x01) == 0 && !(row.oper_status == IfOperStatusUp.0 || row.media_connected) {
                    continue;
                }
                if let Some(prev) = self.sys_prev_counters.get(&row.luid) {
                    let dt = now.duration_since(prev.at).as_secs_f64();
                    if dt >= 0.2 {
                        total_rx_bps += row.in_octets.saturating_sub(prev.in_octets) as f64 / dt;
                        total_tx_bps += row.out_octets.saturating_sub(prev.out_octets) as f64 / dt;
                        self.sys_prev_counters.insert(
                            row.luid,
                            CounterSample {
                                in_octets: row.in_octets,
                                out_octets: row.out_octets,
                                at: now,
                            },
                        );
                        updated_any = true;
                    }
                } else {
                    self.sys_prev_counters.insert(
                        row.luid,
                        CounterSample {
                            in_octets: row.in_octets,
                            out_octets: row.out_octets,
                            at: now,
                        },
                    );
                }
            }

            if updated_any {
                self.sys_last_rates = ((total_rx_bps / 1024.0) as f32, (total_tx_bps / 1024.0) as f32);
            }
            Ok(self.sys_last_rates)
        }

        pub fn snapshot(
            &mut self,
            selected_adapter_id: Option<&str>,
            reset_session: bool,
        ) -> Result<NetworkTelemetrySnapshot, String> {
            if reset_session {
                self.session_baselines.clear();
            }

            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let now = Instant::now();

            let if_rows = read_if_table()?;
            let addrs = read_adapter_addresses()?;
            let nic_meta = nic_registry_metadata();

            let mut row_by_luid: HashMap<u64, IfRowSnapshot> = HashMap::new();
            for row in &if_rows {
                // Исключаем промежуточные NDIS-фильтры (Kaspersky, QoS, WFP LightWeight),
                // чтобы не дублировать реальный адаптер.
                if (row.flags & 0x02) != 0 {
                    continue;
                }
                row_by_luid.entry(row.luid).or_insert_with(|| row.clone());
            }

            let mut seen_luids = std::collections::HashSet::new();
            let mut adapters = Vec::new();

            for addr in addrs {
                if !seen_luids.insert(addr.luid) {
                    continue;
                }
                let Some(row) = row_by_luid.get(&addr.luid) else {
                    continue;
                };
                if (row.flags & 0x02) != 0 {
                    continue;
                }

                let name = if !addr.friendly_name.is_empty() {
                    addr.friendly_name
                } else {
                    row.alias.clone()
                };
                let description = if !addr.description.is_empty() {
                    addr.description
                } else {
                    row.description.clone()
                };

                let reg_key_guid = addr.adapter_guid.trim().to_ascii_lowercase();
                let meta = nic_meta.get(&reg_key_guid);
                let is_loopback = addr.if_type == 24 || row.if_type == 24;
                let desc_lower = description.to_ascii_lowercase();
                let name_lower = name.to_ascii_lowercase();

                let is_system_tunnel = is_loopback
                    || addr.if_type == 131
                    || desc_lower.contains("wan miniport")
                    || desc_lower.contains("kernel debug")
                    || desc_lower.contains("отладчик ядра")
                    || desc_lower.contains("ras async")
                    || desc_lower.contains("teredo")
                    || desc_lower.contains("6to4")
                    || desc_lower.contains("ip-https");

                let is_bluetooth = desc_lower.contains("bluetooth") || name_lower.contains("bluetooth");
                let is_vpn_or_virt = desc_lower.contains("wireguard")
                    || desc_lower.contains("openvpn")
                    || desc_lower.contains("tap-windows")
                    || desc_lower.contains("wintun")
                    || desc_lower.contains("zerotier")
                    || desc_lower.contains("tailscale")
                    || desc_lower.contains("radmin")
                    || desc_lower.contains("hamachi")
                    || desc_lower.contains("vpn")
                    || desc_lower.contains("hyper-v")
                    || desc_lower.contains("vmware")
                    || desc_lower.contains("virtualbox")
                    || desc_lower.contains("vbox")
                    || desc_lower.contains("wsl")
                    || desc_lower.contains("virtual");

                let ndis_hw = (row.flags & 0x01) != 0;
                let reg_hw = meta.map(|m| (m.characteristics & 0x04) != 0).unwrap_or(false);
                let is_physical = (ndis_hw || reg_hw) && !is_bluetooth && !is_vpn_or_virt && !is_system_tunnel;

                let (adapter_kind, adapter_type_label) = classify_adapter(
                    addr.if_type,
                    row.physical_medium,
                    is_loopback,
                    is_bluetooth,
                    is_vpn_or_virt,
                    is_system_tunnel,
                    &desc_lower,
                );

                let manufacturer = resolve_manufacturer(&description, meta);

                let is_connected = if is_loopback {
                    false
                } else {
                    row.oper_status == IfOperStatusUp.0 || row.media_connected
                };

                let (status, status_label) = map_oper_status(row.oper_status, is_connected);

                let raw_speed = row.tx_link_speed.max(row.rx_link_speed);
                let link_speed_bps = if is_connected && raw_speed < (u64::MAX / 2) {
                    raw_speed
                } else {
                    0
                };

                let (rx_bytes_per_sec, tx_bytes_per_sec) = if let Some(prev) = self.prev_counters.get(&addr.luid) {
                    let dt = now.duration_since(prev.at).as_secs_f64();
                    if dt >= 0.15 {
                        let rates = (
                            row.in_octets.saturating_sub(prev.in_octets) as f64 / dt,
                            row.out_octets.saturating_sub(prev.out_octets) as f64 / dt,
                        );
                        self.last_rates.insert(addr.luid, rates);
                        self.prev_counters.insert(
                            addr.luid,
                            CounterSample {
                                in_octets: row.in_octets,
                                out_octets: row.out_octets,
                                at: now,
                            },
                        );
                        rates
                    } else {
                        *self.last_rates.get(&addr.luid).unwrap_or(&(0.0, 0.0))
                    }
                } else {
                    self.prev_counters.insert(
                        addr.luid,
                        CounterSample {
                            in_octets: row.in_octets,
                            out_octets: row.out_octets,
                            at: now,
                        },
                    );
                    (0.0, 0.0)
                };

                let baseline = self
                    .session_baselines
                    .entry(addr.luid)
                    .or_insert((row.in_octets, row.out_octets));
                let session_rx_bytes = row.in_octets.saturating_sub(baseline.0);
                let session_tx_bytes = row.out_octets.saturating_sub(baseline.1);

                adapters.push(NetworkAdapterInfo {
                    id: if !addr.adapter_guid.is_empty() {
                        addr.adapter_guid
                    } else {
                        format!("luid:{:016x}", addr.luid)
                    },
                    interface_index: addr.if_index.max(row.if_index),
                    name,
                    description,
                    manufacturer,
                    adapter_kind,
                    adapter_type_label,
                    is_physical,
                    is_system_tunnel,
                    status,
                    status_label,
                    is_connected,
                    is_primary: false,
                    link_speed_bps,
                    mac_address: addr.mac_address,
                    ipv4_addresses: addr.ipv4_addresses,
                    ipv6_addresses: addr.ipv6_addresses,
                    gateways: addr.gateways,
                    dns_servers: addr.dns_servers,
                    rx_bytes_per_sec,
                    tx_bytes_per_sec,
                    total_rx_bytes: row.in_octets,
                    total_tx_bytes: row.out_octets,
                    session_rx_bytes,
                    session_tx_bytes,
                    rx_packets: row.in_packets,
                    tx_packets: row.out_packets,
                    rx_errors: row.in_errors,
                    tx_errors: row.out_errors,
                    rx_dropped: row.in_discards,
                    tx_dropped: row.out_discards,
                });
            }

            // Определяем основной активный адаптер: подключён + есть шлюз + не системный туннель + физический.
            if let Some(best_idx) = adapters
                .iter()
                .enumerate()
                .filter(|(_, a)| !a.is_system_tunnel)
                .max_by_key(|(_, a)| {
                    (
                        a.is_connected as u8,
                        (!a.gateways.is_empty()) as u8,
                        a.is_physical as u8,
                        (!a.ipv4_addresses.is_empty()) as u8,
                        a.link_speed_bps,
                    )
                })
                .map(|(i, _)| i)
            {
                adapters[best_idx].is_primary = true;
            }

            adapters.sort_by(|a, b| {
                b.is_primary
                    .cmp(&a.is_primary)
                    .then(a.is_system_tunnel.cmp(&b.is_system_tunnel))
                    .then(b.is_connected.cmp(&a.is_connected))
                    .then(b.is_physical.cmp(&a.is_physical))
                    .then(b.link_speed_bps.cmp(&a.link_speed_bps))
                    .then(a.name.cmp(&b.name))
            });

            let selected = selected_adapter_id
                .and_then(|id| adapters.iter().find(|a| a.id == id))
                .or_else(|| adapters.iter().find(|a| a.is_primary))
                .or_else(|| adapters.iter().find(|a| !a.is_system_tunnel && a.is_connected))
                .or_else(|| adapters.iter().find(|a| !a.is_system_tunnel));

            let active_adapter_id = selected.map(|a| a.id.clone());
            let (total_rx_bytes_per_sec, total_tx_bytes_per_sec) = selected
                .map(|a| (a.rx_bytes_per_sec, a.tx_bytes_per_sec))
                .unwrap_or((0.0, 0.0));

            Ok(NetworkTelemetrySnapshot {
                timestamp_ms: now_ms,
                adapters,
                active_adapter_id,
                total_rx_bytes_per_sec,
                total_tx_bytes_per_sec,
            })
        }
    }

    #[derive(Clone)]
    struct IfRowSnapshot {
        luid: u64,
        if_index: u32,
        alias: String,
        description: String,
        if_type: u32,
        physical_medium: i32,
        flags: u8,
        oper_status: i32,
        media_connected: bool,
        tx_link_speed: u64,
        rx_link_speed: u64,
        in_octets: u64,
        out_octets: u64,
        in_packets: u64,
        out_packets: u64,
        in_errors: u64,
        out_errors: u64,
        in_discards: u64,
        out_discards: u64,
    }

    struct AddrSnapshot {
        luid: u64,
        if_index: u32,
        if_type: u32,
        adapter_guid: String,
        friendly_name: String,
        description: String,
        mac_address: String,
        ipv4_addresses: Vec<String>,
        ipv6_addresses: Vec<String>,
        gateways: Vec<String>,
        dns_servers: Vec<String>,
    }

    fn utf16_slice_to_string(slice: &[u16]) -> String {
        let len = slice.iter().position(|c| *c == 0).unwrap_or(slice.len());
        String::from_utf16_lossy(&slice[..len]).trim().to_string()
    }

    unsafe fn pwstr_to_string(ptr: windows::core::PWSTR) -> String {
        if ptr.is_null() {
            String::new()
        } else {
            unsafe { ptr.to_string().unwrap_or_default().trim().to_string() }
        }
    }

    unsafe fn pstr_to_string(ptr: windows::core::PSTR) -> String {
        if ptr.is_null() {
            String::new()
        } else {
            unsafe { ptr.to_string().unwrap_or_default().trim().to_string() }
        }
    }

    unsafe fn sockaddr_to_ip(sockaddr: &SOCKET_ADDRESS) -> Option<IpAddr> {
        if sockaddr.lpSockaddr.is_null() || sockaddr.iSockaddrLength < 4 {
            return None;
        }
        let sa = unsafe { &*(sockaddr.lpSockaddr as *const SOCKADDR) };
        if sa.sa_family == AF_INET && sockaddr.iSockaddrLength as usize >= std::mem::size_of::<SOCKADDR_IN>() {
            let sin = unsafe { &*(sockaddr.lpSockaddr as *const SOCKADDR_IN) };
            let bytes = unsafe { sin.sin_addr.S_un.S_addr }.to_ne_bytes();
            return Some(IpAddr::V4(Ipv4Addr::from(bytes)));
        }
        if sa.sa_family == AF_INET6 && sockaddr.iSockaddrLength as usize >= std::mem::size_of::<SOCKADDR_IN6>() {
            let sin6 = unsafe { &*(sockaddr.lpSockaddr as *const SOCKADDR_IN6) };
            let bytes = unsafe { sin6.sin6_addr.u.Byte };
            return Some(IpAddr::V6(Ipv6Addr::from(bytes)));
        }
        None
    }

    fn push_unique(vec: &mut Vec<String>, val: String) {
        if !val.is_empty() && !vec.contains(&val) {
            vec.push(val);
        }
    }

    fn read_if_table() -> Result<Vec<IfRowSnapshot>, String> {
        unsafe {
            let mut table_ptr: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
            let err = GetIfTable2(&mut table_ptr);
            if err.0 != 0 || table_ptr.is_null() {
                return Err(format!("GetIfTable2 failed: {}", err.0));
            }
            let num = (*table_ptr).NumEntries as usize;
            let first = (*table_ptr).Table.as_ptr();
            let slice = std::slice::from_raw_parts(first, num);
            let mut rows = Vec::with_capacity(num);
            for row in slice {
                rows.push(IfRowSnapshot {
                    luid: row.InterfaceLuid.Value,
                    if_index: row.InterfaceIndex,
                    alias: utf16_slice_to_string(&row.Alias),
                    description: utf16_slice_to_string(&row.Description),
                    if_type: row.Type,
                    physical_medium: row.PhysicalMediumType.0,
                    flags: row.InterfaceAndOperStatusFlags._bitfield,
                    oper_status: row.OperStatus.0,
                    media_connected: row.MediaConnectState == MediaConnectStateConnected,
                    tx_link_speed: row.TransmitLinkSpeed,
                    rx_link_speed: row.ReceiveLinkSpeed,
                    in_octets: row.InOctets,
                    out_octets: row.OutOctets,
                    in_packets: row.InUcastPkts.saturating_add(row.InNUcastPkts),
                    out_packets: row.OutUcastPkts.saturating_add(row.OutNUcastPkts),
                    in_errors: row.InErrors,
                    out_errors: row.OutErrors,
                    in_discards: row.InDiscards,
                    out_discards: row.OutDiscards,
                });
            }
            FreeMibTable(table_ptr as *const c_void);
            Ok(rows)
        }
    }

    fn read_adapter_addresses() -> Result<Vec<AddrSnapshot>, String> {
        unsafe {
            let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_INCLUDE_ALL_INTERFACES;
            let mut size: u32 = 64 * 1024;
            let mut buf: Vec<u8> = vec![0; size as usize];

            for _ in 0..4 {
                let ptr = buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
                let code = GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(ptr), &mut size);
                if code == 0 {
                    let mut out = Vec::new();
                    let mut cur = ptr;
                    while !cur.is_null() {
                        let item = &*cur;
                        let if_index = item.Anonymous1.Anonymous.IfIndex;
                        let mac_len = (item.PhysicalAddressLength as usize).min(item.PhysicalAddress.len());
                        let mac_address = if mac_len > 0 {
                            item.PhysicalAddress[..mac_len]
                                .iter()
                                .map(|b| format!("{b:02X}"))
                                .collect::<Vec<_>>()
                                .join(":")
                        } else {
                            String::new()
                        };

                        let mut ipv4_addresses = Vec::new();
                        let mut ipv6_addresses = Vec::new();
                        let mut u_cur = item.FirstUnicastAddress;
                        while !u_cur.is_null() {
                            if let Some(ip) = sockaddr_to_ip(&(*u_cur).Address) {
                                match ip {
                                    IpAddr::V4(v4) => push_unique(&mut ipv4_addresses, v4.to_string()),
                                    IpAddr::V6(v6) => push_unique(&mut ipv6_addresses, v6.to_string()),
                                }
                            }
                            u_cur = (*u_cur).Next;
                        }

                        let mut gateways = Vec::new();
                        let mut gw_cur = item.FirstGatewayAddress;
                        while !gw_cur.is_null() {
                            if let Some(ip) = sockaddr_to_ip(&(*gw_cur).Address) {
                                push_unique(&mut gateways, ip.to_string());
                            }
                            gw_cur = (*gw_cur).Next;
                        }

                        let mut dns_servers = Vec::new();
                        let mut dns_cur = item.FirstDnsServerAddress;
                        while !dns_cur.is_null() {
                            if let Some(ip) = sockaddr_to_ip(&(*dns_cur).Address) {
                                // Отфильтровываем устаревшие site-local IPv6 DNS fec0:0:0:ffff::* от Windows по умолчанию
                                let ip_str = ip.to_string();
                                if !ip_str.starts_with("fec0:") {
                                    push_unique(&mut dns_servers, ip_str);
                                }
                            }
                            dns_cur = (*dns_cur).Next;
                        }

                        out.push(AddrSnapshot {
                            luid: item.Luid.Value,
                            if_index,
                            if_type: item.IfType,
                            adapter_guid: pstr_to_string(item.AdapterName),
                            friendly_name: pwstr_to_string(item.FriendlyName),
                            description: pwstr_to_string(item.Description),
                            mac_address,
                            ipv4_addresses,
                            ipv6_addresses,
                            gateways,
                            dns_servers,
                        });
                        cur = item.Next;
                    }
                    return Ok(out);
                }
                if code == ERROR_BUFFER_OVERFLOW.0 {
                    buf.resize(size.max(64 * 1024) as usize, 0);
                    continue;
                }
                return Err(format!("GetAdaptersAddresses failed: {code}"));
            }
            Err("GetAdaptersAddresses buffer retry limit reached".to_string())
        }
    }

    fn nic_registry_metadata() -> &'static HashMap<String, NicRegMeta> {
        static CACHE: OnceLock<HashMap<String, NicRegMeta>> = OnceLock::new();
        CACHE.get_or_init(|| {
            let mut map = HashMap::new();
            let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
            let Ok(class_key) = hklm.open_subkey(
                r"SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}",
            ) else {
                return map;
            };
            for sub_name in class_key.enum_keys().flatten() {
                if !sub_name.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let Ok(sub) = class_key.open_subkey(&sub_name) else {
                    continue;
                };
                let Ok(guid): Result<String, _> = sub.get_value("NetCfgInstanceId") else {
                    continue;
                };
                let characteristics: u32 = sub.get_value("Characteristics").unwrap_or(0);
                let provider_name: String = sub.get_value("ProviderName").unwrap_or_default();
                let device_instance_id: String = sub.get_value("DeviceInstanceID").unwrap_or_default();
                map.insert(
                    guid.trim().to_ascii_lowercase(),
                    NicRegMeta {
                        characteristics,
                        provider_name: provider_name.trim().to_string(),
                        device_instance_id: device_instance_id.trim().to_string(),
                    },
                );
            }
            map
        })
    }

    fn resolve_manufacturer(description: &str, meta: Option<&NicRegMeta>) -> String {
        if let Some(m) = meta {
            let dev_upper = m.device_instance_id.to_ascii_uppercase();
            if dev_upper.contains("VEN_10EC") {
                return "Realtek Semiconductor".to_string();
            }
            if dev_upper.contains("VEN_8086") {
                return "Intel Corporation".to_string();
            }
            if dev_upper.contains("VEN_1969") || dev_upper.contains("VEN_17CB") {
                return "Qualcomm / Killer".to_string();
            }
            if dev_upper.contains("VEN_14E4") {
                return "Broadcom".to_string();
            }
            if dev_upper.contains("VEN_14C3") {
                return "MediaTek".to_string();
            }
            if dev_upper.contains("VEN_1022") {
                return "AMD".to_string();
            }
            if dev_upper.contains("VEN_15B3") {
                return "NVIDIA Mellanox".to_string();
            }
            if !m.provider_name.is_empty() && !m.provider_name.eq_ignore_ascii_case("Microsoft") {
                return m.provider_name.clone();
            }
        }

        let dl = description.to_ascii_lowercase();
        if dl.contains("realtek") {
            "Realtek Semiconductor".to_string()
        } else if dl.contains("intel") {
            "Intel Corporation".to_string()
        } else if dl.contains("killer") || dl.contains("qualcomm") || dl.contains("atheros") {
            "Qualcomm / Killer".to_string()
        } else if dl.contains("broadcom") {
            "Broadcom".to_string()
        } else if dl.contains("mediatek") {
            "MediaTek".to_string()
        } else if dl.contains("vmware") {
            "VMware".to_string()
        } else if dl.contains("virtualbox") {
            "Oracle VirtualBox".to_string()
        } else if dl.contains("wireguard") {
            "WireGuard".to_string()
        } else if dl.contains("openvpn") || dl.contains("tap-windows") {
            "OpenVPN".to_string()
        } else if dl.contains("samsung") {
            "Samsung".to_string()
        } else if let Some(m) = meta {
            if !m.provider_name.is_empty() {
                m.provider_name.clone()
            } else {
                "Не указан".to_string()
            }
        } else {
            "Не указан".to_string()
        }
    }

    fn classify_adapter(
        if_type: u32,
        physical_medium: i32,
        is_loopback: bool,
        is_bluetooth: bool,
        is_vpn_or_virt: bool,
        is_system_tunnel: bool,
        desc_lower: &str,
    ) -> (String, String) {
        if is_loopback {
            return ("loopback".to_string(), "Loopback".to_string());
        }
        if is_bluetooth {
            return ("bluetooth".to_string(), "Bluetooth PAN".to_string());
        }
        if if_type == 131 || desc_lower.contains("wireguard") || desc_lower.contains("openvpn") || desc_lower.contains("vpn") || desc_lower.contains("wintun") || desc_lower.contains("zerotier") || desc_lower.contains("tailscale") {
            return ("vpn".to_string(), if is_system_tunnel { "Системный туннель".to_string() } else { "VPN / Туннель".to_string() });
        }
        if is_vpn_or_virt || is_system_tunnel {
            return ("virtual".to_string(), "Виртуальный адаптер".to_string());
        }
        // NdisPhysicalMediumNative802_11 = 9, NdisPhysicalMediumWirelessLan = 1, IF_TYPE_IEEE80211 = 71
        if if_type == 71 || physical_medium == 1 || physical_medium == 9 || desc_lower.contains("wi-fi") || desc_lower.contains("wireless") || desc_lower.contains("wlan") {
            return ("wifi".to_string(), "Wi-Fi (802.11)".to_string());
        }
        if desc_lower.contains("usb") || desc_lower.contains("rndis") {
            return ("ethernet".to_string(), "USB / RNDIS".to_string());
        }
        ("ethernet".to_string(), "Ethernet (Проводная)".to_string())
    }

    fn map_oper_status(oper_status: i32, is_connected: bool) -> (String, String) {
        if oper_status == IfOperStatusUp.0 || is_connected {
            ("Up".to_string(), "Подключён".to_string())
        } else if oper_status == IfOperStatusDormant.0 {
            ("Dormant".to_string(), "Ожидание".to_string())
        } else if oper_status == IfOperStatusNotPresent.0 {
            ("NotPresent".to_string(), "Отсутствует".to_string())
        } else if oper_status == IfOperStatusTesting.0 {
            ("Testing".to_string(), "Проверка".to_string())
        } else if oper_status == IfOperStatusDown.0 || oper_status == IfOperStatusLowerLayerDown.0 {
            ("Down".to_string(), "Отключён".to_string())
        } else {
            ("Unknown".to_string(), "Неизвестно".to_string())
        }
    }

    pub fn icmp_ping_ipv4(ip: Ipv4Addr, timeout_ms: u32) -> Option<u32> {
        unsafe {
            let Ok(handle) = IcmpCreateFile() else {
                return None;
            };
            let payload = b"NEXUS-HUD-PING";
            let reply_size = (std::mem::size_of::<ICMP_ECHO_REPLY>() + payload.len() + 32) as u32;
            let mut reply_buf = vec![0u8; reply_size as usize];
            let dest_addr = u32::from_ne_bytes(ip.octets());
            let count = IcmpSendEcho(
                handle,
                dest_addr,
                payload.as_ptr() as *const c_void,
                payload.len() as u16,
                None,
                reply_buf.as_mut_ptr() as *mut c_void,
                reply_size,
                timeout_ms,
            );
            let _ = IcmpCloseHandle(handle);
            if count == 0 {
                return None;
            }
            let reply = &*(reply_buf.as_ptr() as *const ICMP_ECHO_REPLY);
            if reply.Status != 0 {
                return None;
            }
            Some(reply.RoundTripTime)
        }
    }

    pub fn probe_network_health(
        gateway_ip: Option<String>,
        external_host: Option<String>,
    ) -> NetworkHealthProbe {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let gw_clean = gateway_ip
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let ext_target_str = external_host
            .map(|s| s.trim().to_string())
            .filter(|s| matches!(s.as_str(), "1.1.1.1" | "8.8.8.8" | "1.0.0.1" | "9.9.9.9"))
            .unwrap_or_else(|| "1.1.1.1".to_string());
        let ext_ip: Ipv4Addr = ext_target_str.parse().unwrap_or(Ipv4Addr::new(1, 1, 1, 1));

        let gw_for_thread = gw_clean.clone();
        let gw_handle = std::thread::spawn(move || {
            let Some(gw_str) = gw_for_thread else {
                return (false, None);
            };
            if let Ok(ip) = gw_str.parse::<Ipv4Addr>() {
                match icmp_ping_ipv4(ip, 650) {
                    Some(ms) => (true, Some(ms)),
                    None => (false, None),
                }
            } else {
                (false, None)
            }
        });

        let (external_reachable, external_ping_ms, external_method) =
            if let Some(ms) = icmp_ping_ipv4(ext_ip, 850) {
                (true, Some(ms.max(1)), "ICMP".to_string())
            } else {
                let addr = SocketAddr::new(IpAddr::V4(ext_ip), 53);
                let start = Instant::now();
                if TcpStream::connect_timeout(&addr, Duration::from_millis(750)).is_ok() {
                    let ms = (start.elapsed().as_millis() as u32).max(1);
                    (true, Some(ms), "TCP:53".to_string())
                } else {
                    (false, None, "ICMP".to_string())
                }
            };

        let (gateway_reachable, gateway_ping_ms) = gw_handle.join().unwrap_or((false, None));

        NetworkHealthProbe {
            timestamp_ms: now_ms,
            gateway_ip: gw_clean,
            gateway_reachable,
            gateway_ping_ms,
            external_host: ext_target_str,
            external_reachable,
            external_ping_ms,
            external_method,
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{NetworkHealthProbe, NetworkTelemetrySnapshot};
    pub struct NetworkMonitorState;
    impl NetworkMonitorState {
        pub fn new() -> Self {
            Self
        }
        pub fn read_system_throughput_kbps(&mut self) -> Result<(f32, f32), String> {
            Err("Доступно только в Windows".to_string())
        }
        pub fn snapshot(
            &mut self,
            _selected_adapter_id: Option<&str>,
            _reset_session: bool,
        ) -> Result<NetworkTelemetrySnapshot, String> {
            Err("Доступно только в Windows".to_string())
        }
    }
    pub fn icmp_ping_ipv4(_ip: std::net::Ipv4Addr, _timeout_ms: u32) -> Option<u32> {
        None
    }
    pub fn probe_network_health(
        gateway_ip: Option<String>,
        external_host: Option<String>,
    ) -> NetworkHealthProbe {
        NetworkHealthProbe {
            timestamp_ms: 0,
            gateway_ip,
            gateway_reachable: false,
            gateway_ping_ms: None,
            external_host: external_host.unwrap_or_else(|| "1.1.1.1".to_string()),
            external_reachable: false,
            external_ping_ms: None,
            external_method: "Unavailable".to_string(),
        }
    }
}

pub use imp::{NetworkMonitorState, icmp_ping_ipv4, probe_network_health};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_snapshot_discovers_clean_adapters_and_probes_health() {
        let mut state = NetworkMonitorState::new();
        let snap = state
            .snapshot(None, false)
            .expect("NetworkMonitorState::snapshot should succeed on Windows");

        println!(
            "Network snapshot: adapters={}, active={:?}, dl={:.2} KB/s, ul={:.2} KB/s",
            snap.adapters.len(),
            snap.active_adapter_id,
            snap.total_rx_bytes_per_sec / 1024.0,
            snap.total_tx_bytes_per_sec / 1024.0
        );
        for a in &snap.adapters {
            println!(
                "  Adapter: name='{}' desc='{}' mfr='{}' kind={} ({}) phys={} tunnel={} conn={} status={} link={}bps ipv4={:?} gw={:?} dns={:?} mac={}",
                a.name,
                a.description,
                a.manufacturer,
                a.adapter_kind,
                a.adapter_type_label,
                a.is_physical,
                a.is_system_tunnel,
                a.is_connected,
                a.status,
                a.link_speed_bps,
                a.ipv4_addresses,
                a.gateways,
                a.dns_servers,
                a.mac_address
            );
            assert!(
                !a.description.to_ascii_lowercase().contains("ndis 6 filter"),
                "Unexpected duplicate NDIS filter adapter: {}",
                a.description
            );
            assert!(
                !a.description.to_ascii_lowercase().contains("qos packet scheduler"),
                "Unexpected duplicate QoS scheduler adapter: {}",
                a.description
            );
        }

        assert!(
            !snap.adapters.is_empty(),
            "Expected at least one network adapter"
        );
        assert!(
            snap.adapters.iter().any(|a| a.is_physical && !a.is_system_tunnel),
            "Expected at least one physical network adapter"
        );

        let primary_gw = snap
            .active_adapter_id
            .as_deref()
            .and_then(|id| snap.adapters.iter().find(|a| a.id == id))
            .and_then(|a| a.gateways.first().cloned());

        let probe = probe_network_health(primary_gw, Some("1.1.1.1".to_string()));
        println!("Network health probe: {:#?}", probe);
        assert_eq!(probe.external_host, "1.1.1.1");
    }
}
