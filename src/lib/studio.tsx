import { useEffect, useRef, memo, type ReactNode, type MouseEvent } from "react";
import { motion, type Variants } from "framer-motion";

export interface Metrics {
  cpu_usage: number;
  ram_used_gb: number;
  ram_total_gb: number;
  ram_percentage: number;
  swap_used_gb: number;
  swap_total_gb: number;
  disk_free_gb: number;
  disk_total_gb: number;
  net_rx_kbps: number;
  net_tx_kbps: number;
  net_ping_ms: number;
}

export interface DriveVolumeInfo {
  mount_point: string;
  total_bytes: number;
  available_bytes: number;
}

export interface StartupItem {
  id: string;
  name: string;
  command: string;
  clean_path: string;
  location: string;
  enabled: boolean;
  file_exists: boolean;
  phantom: boolean;
}

export interface FileEntry {
  path: string;
  name: string;
  size_bytes: number;
  extension: string;
  app_label: string;
}

export interface FolderNode {
  name: string;
  path: string;
  size_bytes: number;
  children: FolderNode[];
}

export interface ScanResult {
  target_path: string;
  total_scanned_bytes: number;
  total_files_count: number;
  root_node: FolderNode;
  top_files: FileEntry[];
  category_sizes: [string, number][];
}

export interface TreemapRect {
  node: FolderNode;
  x: number;
  y: number;
  w: number;
  h: number;
  colorIndex: number;
}

export interface CoreTemp {
  name: string;
  temp_c: number;
}

export interface CpuTelemetry {
  name: string;
  package_temp_c: number | null;
  max_core_temp_c: number | null;
  avg_clock_mhz: number | null;
  power_watts: number | null;
  voltage_v: number | null;
  core_temps: CoreTemp[];
  usage_percent?: number;
  base_clock_mhz?: number | null;
  physical_cores?: number;
  logical_cores?: number;
  core_loads?: number[];
  hvci_enabled?: boolean;
}

export interface GpuTelemetry {
  name: string;
  core_temp_c: number | null;
  hotspot_temp_c: number | null;
  memory_temp_c: number | null;
  core_clock_mhz: number | null;
  memory_clock_mhz: number | null;
  fan_rpm: number | null;
  fan_percent: number | null;
  power_watts: number | null;
  voltage_v: number | null;
  load_percent?: number | null;
  vendor?: string;
  vram_used_mb?: number | null;
  vram_total_mb?: number | null;
  vram_used_percent?: number | null;
  d3d_shared_mb?: number | null;
  memory_controller_load_percent?: number | null;
  video_engine_load_percent?: number | null;
  power_limit_percent?: number | null;
  pcie_rx_mb_s?: number | null;
  pcie_tx_mb_s?: number | null;
  fans?: FanSensorItem[];
  telemetry_source?: string;
}

export interface NetworkAdapterInfo {
  id: string;
  interface_index: number;
  name: string;
  description: string;
  manufacturer: string;
  adapter_kind: string;
  adapter_type_label: string;
  is_physical: boolean;
  is_system_tunnel: boolean;
  status: string;
  status_label: string;
  is_connected: boolean;
  is_primary: boolean;
  link_speed_bps: number;
  mac_address: string;
  ipv4_addresses: string[];
  ipv6_addresses: string[];
  gateways: string[];
  dns_servers: string[];
  rx_bytes_per_sec: number;
  tx_bytes_per_sec: number;
  total_rx_bytes: number;
  total_tx_bytes: number;
  session_rx_bytes: number;
  session_tx_bytes: number;
  rx_packets: number;
  tx_packets: number;
  rx_errors: number;
  tx_errors: number;
  rx_dropped: number;
  tx_dropped: number;
}

export interface NetworkTelemetrySnapshot {
  timestamp_ms: number;
  adapters: NetworkAdapterInfo[];
  active_adapter_id: string | null;
  total_rx_bytes_per_sec: number;
  total_tx_bytes_per_sec: number;
}

export interface NetworkHealthProbe {
  timestamp_ms: number;
  gateway_ip: string | null;
  gateway_reachable: boolean;
  gateway_ping_ms: number | null;
  external_host: string;
  external_reachable: boolean;
  external_ping_ms: number | null;
  external_method: string;
}

export function formatLinkSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "Не подключён";
  if (bps >= 1_000_000_000) {
    const gbps = bps / 1_000_000_000;
    return `${Number.isInteger(gbps) ? gbps : gbps.toFixed(1)} Гбит/с`;
  }
  if (bps >= 1_000_000) {
    const mbps = bps / 1_000_000;
    return `${mbps >= 100 ? Math.round(mbps) : mbps.toFixed(1)} Мбит/с`;
  }
  if (bps >= 1_000) {
    return `${Math.round(bps / 1_000)} Кбит/с`;
  }
  return `${Math.round(bps)} бит/с`;
}

export function formatThroughputRate(
  bytesPerSec: number,
  unitMode: "mbps" | "mbs"
): { value: string; unit: string } {
  const safe = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? bytesPerSec : 0;
  if (unitMode === "mbps") {
    const bitsPerSec = safe * 8;
    if (bitsPerSec >= 1_000_000_000) {
      return { value: (bitsPerSec / 1_000_000_000).toFixed(2), unit: "Гбит/с" };
    }
    if (bitsPerSec >= 1_000_000) {
      return { value: (bitsPerSec / 1_000_000).toFixed(2), unit: "Мбит/с" };
    }
    if (bitsPerSec >= 1_000) {
      return { value: (bitsPerSec / 1_000).toFixed(1), unit: "Кбит/с" };
    }
    return { value: Math.round(bitsPerSec).toString(), unit: "бит/с" };
  }

  if (safe >= 1024 * 1024 * 1024) {
    return { value: (safe / (1024 * 1024 * 1024)).toFixed(2), unit: "ГБ/с" };
  }
  if (safe >= 1024 * 1024) {
    return { value: (safe / (1024 * 1024)).toFixed(2), unit: "МБ/с" };
  }
  if (safe >= 1024) {
    return { value: (safe / 1024).toFixed(1), unit: "КБ/с" };
  }
  return { value: Math.round(safe).toString(), unit: "Б/с" };
}

export interface FanSensorItem {
  name: string;
  rpm: number;
  percent: number | null;
}

export interface TempSensorItem {
  name: string;
  temp_c: number;
}

export interface StorageTempItem {
  name: string;
  temp_c: number | null;
  used_percent: number | null;
}

export interface HardwareTelemetry {
  is_admin: boolean;
  sidecar_online: boolean;
  timestamp_ms: number;
  cpu: CpuTelemetry;
  gpus: GpuTelemetry[];
  motherboard_name: string;
  motherboard_temps: TempSensorItem[];
  system_fans: FanSensorItem[];
  storage_temps: StorageTempItem[];
}

export type HwmonStatus = "ready" | "restarting" | "driver_blocked" | "offline";

export interface HwmonStatusResponse {
  status: HwmonStatus;
  restart_count: number;
  last_error: string | null;
}

export interface TelemetrySnapshot {
  timestamp: number;
  cpu_usage: number;
  cpu_temp: number | null;
  gpu_usage: number;
  gpu_temp: number | null;
  ram_used_percent: number;
  top_process_name: string;
  top_process_cpu: number;
}

export interface DiagnosticsIncident {
  level: string;
  message: string;
}

export interface DiagnosticsReport {
  status: string;
  stability: string;
  incidents: DiagnosticsIncident[];
  verdict: string;
}

export interface CleanupCategory {
  id: string;
  name: string;
  description: string;
  paths_hint: string;
  size_bytes: number;
  files_count: number;
  requires_admin: boolean;
}

export interface CleanupCategoryReport {
  id: string;
  name: string;
  deleted_files: number;
  skipped_files: number;
  freed_bytes: number;
}

export interface CleanupReport {
  deleted_files_count: number;
  skipped_files_count: number;
  freed_bytes: number;
  categories: CleanupCategoryReport[];
}

export interface ProcessItem {
  pid: number;
  parent_pid: number | null;
  name: string;
  exe_path: string;
  cpu_usage: number;
  memory_mb: number;
  disk_read_bytes_sec: number;
  disk_write_bytes_sec: number;
  run_time_sec: number;
  start_time: number;
  thread_count: number;
  handle_count: number;
  status: string;
  icon_base64: string | null;
}

export interface ProcessTargetIdentity {
  pid: number;
  start_time: number;
  name: string;
  exe_path?: string;
}

export function toProcessTargetIdentity(
  proc: Pick<ProcessItem, "pid" | "start_time" | "name" | "exe_path">
): ProcessTargetIdentity {
  return {
    pid: proc.pid,
    start_time: proc.start_time,
    name: proc.name,
    exe_path: proc.exe_path || undefined,
  };
}

export function getProcessIdentityKey(
  proc: Pick<ProcessItem, "pid" | "start_time" | "name">
): string {
  return `${proc.pid}:${proc.start_time}:${proc.name.toLowerCase()}`;
}

export interface ProcessDetails {
  pid: number;
  parent_pid: number | null;
  parent_name: string | null;
  name: string;
  exe_path: string;
  command_line: string;
  working_dir: string;
  status: string;
  cpu_usage: number;
  memory_mb: number;
  virtual_memory_mb: number;
  run_time_sec: number;
  start_time: number;
  thread_count: number;
  handle_count: number;
  child_count: number;
  total_descendants?: number;
}

export type ProcessSortKey =
  | "name"
  | "pid"
  | "cpu"
  | "memory"
  | "disk"
  | "runtime"
  | "threads"
  | "handles";

export interface ProcessContextMenuState {
  x: number;
  y: number;
  process: ProcessItem;
}

export const PROCESS_REFRESH_MS = 1500;

export function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0";
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec} B/s`;
}

export function formatUptime(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return "—";
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m.toString().padStart(2, "0")}м`;
  return `${m}м ${s.toString().padStart(2, "0")}с`;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    document.body.removeChild(area);
  }
}

export interface HistoryPoint {
  timestamp: string;
  cpu: number;
  ram: number;
}

export interface StoredTimerState {
  endTime: number;
  totalSeconds: number;
  restart: boolean;
  sleep?: boolean;
}

export const TIMER_STORAGE_KEY = "nexus_power_timer";
export const PRESET_MINUTES = [15, 30, 45, 60];
export const HISTORY_LENGTH = 60;

export const TREEMAP_PALETTE = [
  "from-[#00D5E8]/28 to-[#0B0E14]/90 border-[#00D5E8]/40 hover:border-[#00D5E8]/80 text-[#E5EDF5]",
  "from-[#36AFC0]/28 to-[#0B0E14]/90 border-[#36AFC0]/40 hover:border-[#36AFC0]/80 text-[#E5EDF5]",
  "from-indigo-500/26 to-[#0B0E14]/90 border-indigo-400/35 hover:border-indigo-300/75 text-indigo-100",
  "from-sky-500/26 to-[#0B0E14]/90 border-sky-400/35 hover:border-sky-300/75 text-sky-100",
  "from-amber-500/24 to-[#0B0E14]/90 border-amber-400/35 hover:border-amber-300/75 text-amber-100",
  "from-violet-500/24 to-[#0B0E14]/90 border-violet-400/35 hover:border-violet-300/75 text-violet-100",
  "from-cyan-600/25 to-[#0B0E14]/90 border-cyan-500/35 hover:border-cyan-300/75 text-cyan-100",
  "from-blue-500/24 to-[#0B0E14]/90 border-blue-400/35 hover:border-blue-300/75 text-blue-100",
  "from-rose-500/22 to-[#0B0E14]/90 border-rose-400/35 hover:border-rose-300/75 text-rose-100",
  "from-[#151C26]/90 to-[#10151D]/95 border-[#202B38] hover:border-[#36AFC0]/60 text-[#E5EDF5]",
];

export const cardsContainerVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.04,
      delayChildren: 0.01,
    },
  },
};

export const cardItemVariants: Variants = {
  hidden: { opacity: 0, y: 8, scale: 0.99 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: "spring",
      stiffness: 460,
      damping: 30,
    },
  },
};

export function createInitialHistory(): HistoryPoint[] {
  const now = Date.now();
  return Array.from({ length: HISTORY_LENGTH }, (_, idx) => {
    const t = new Date(now - (HISTORY_LENGTH - 1 - idx) * 1000);
    return {
      timestamp: t.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
      cpu: 0,
      ram: 0,
    };
  });
}

export function formatCountdown(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(safeSeconds / 3600);
  const mins = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;

  const pad = (n: number) => n.toString().padStart(2, "0");
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

export function formatSpeedParts(kbps: number): { value: string; unit: string } {
  if (!Number.isFinite(kbps) || kbps <= 0) {
    return { value: "0.0", unit: "KB/S" };
  }
  if (kbps >= 1024) {
    return { value: (kbps / 1024).toFixed(2), unit: "MB/S" };
  }
  return { value: kbps.toFixed(1), unit: "KB/S" };
}

export function getPingHudStyle(pingMs: number): {
  valueText: string;
  statusLabel: string;
  colorClass: string;
  badgeClass: string;
  dotClass: string;
  barPercent: number;
} {
  if (!Number.isFinite(pingMs) || pingMs <= 0 || pingMs >= 999) {
    return {
      valueText: "—",
      statusLabel: "НЕТ СВЯЗИ",
      colorClass: "text-[#8292A3]",
      badgeClass: "bg-[#151C26] text-[#8292A3] border-[#202B38]",
      dotClass: "bg-[#526170]",
      barPercent: 0,
    };
  }
  if (pingMs <= 80) {
    return {
      valueText: `${pingMs}`,
      statusLabel: pingMs <= 40 ? "ОТЛИЧНО" : "НОРМА",
      colorClass: "text-[#00D5E8]",
      badgeClass: "bg-[#00D5E8]/10 text-[#00D5E8] border-[#00D5E8]/30",
      dotClass: "bg-[#00D5E8]",
      barPercent: Math.max(12, Math.min(100, (1 - pingMs / 150) * 100)),
    };
  }
  if (pingMs <= 120) {
    return {
      valueText: `${pingMs}`,
      statusLabel: "СРЕДНЕ",
      colorClass: "text-amber-400",
      badgeClass: "bg-amber-500/12 text-amber-300 border-amber-500/35",
      dotClass: "bg-amber-400",
      barPercent: Math.max(20, Math.min(100, (1 - pingMs / 160) * 100)),
    };
  }
  return {
    valueText: `${pingMs}`,
    statusLabel: "ВЫСОКИЙ ПИНГ",
    colorClass: "text-rose-400",
    badgeClass: "bg-rose-500/12 text-rose-300 border-rose-500/35",
    dotClass: "bg-rose-500",
    barPercent: 100,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Б";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} ГБ`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} МБ`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${kb.toFixed(0)} КБ`;
  return `${bytes} Б`;
}

export function getTempBadgeStyle(tempC: number | null | undefined): {
  badgeClass: string;
  textClass: string;
  barClass: string;
  label: string;
} {
  if (tempC === null || tempC === undefined || !Number.isFinite(tempC)) {
    return {
      badgeClass: "bg-[#151C26] text-[#8292A3] border-[#202B38]",
      textClass: "text-[#8292A3]",
      barClass: "bg-[#202B38]",
      label: "Недоступно",
    };
  }
  if (tempC > 80) {
    return {
      badgeClass: "bg-rose-500/12 text-rose-300 border-rose-500/35",
      textClass: "text-rose-400",
      barClass: "bg-gradient-to-r from-rose-500 to-red-400",
      label: "КРИТИЧНО",
    };
  }
  if (tempC >= 65) {
    return {
      badgeClass: "bg-amber-500/12 text-amber-300 border-amber-500/35",
      textClass: "text-amber-400",
      barClass: "bg-gradient-to-r from-amber-500 to-yellow-400",
      label: "НАГРЕВ",
    };
  }
  return {
    badgeClass: "bg-[#00D5E8]/10 text-[#00D5E8] border-[#00D5E8]/30",
    textClass: "text-[#00D5E8]",
    barClass: "bg-gradient-to-r from-[#00D5E8] to-[#36AFC0]",
    label: "НОРМА",
  };
}

export function getCategoryStyle(category: string): {
  barClass: string;
  dotClass: string;
  textClass: string;
} {
  switch (category) {
    case "Видео":
      return {
        barClass: "bg-[#00D5E8]",
        dotClass: "bg-[#00D5E8]",
        textClass: "text-[#00D5E8]",
      };
    case "Игры и софт":
      return {
        barClass: "bg-indigo-400",
        dotClass: "bg-indigo-400",
        textClass: "text-indigo-300",
      };
    case "Архивы и образы":
      return {
        barClass: "bg-amber-400",
        dotClass: "bg-amber-400",
        textClass: "text-amber-400",
      };
    case "Аудио":
      return {
        barClass: "bg-violet-400",
        dotClass: "bg-violet-400",
        textClass: "text-violet-300",
      };
    case "Документы":
      return {
        barClass: "bg-[#36AFC0]",
        dotClass: "bg-[#36AFC0]",
        textClass: "text-[#36AFC0]",
      };
    default:
      return {
        barClass: "bg-[#526170]",
        dotClass: "bg-[#526170]",
        textClass: "text-[#8292A3]",
      };
  }
}

export function computeTreemapRects(nodes: FolderNode[]): TreemapRect[] {
  const valid = nodes.filter((n) => n.size_bytes > 0);
  if (valid.length === 0) return [];

  const results: TreemapRect[] = [];

  function subdivide(
    items: { node: FolderNode; colorIndex: number }[],
    x: number,
    y: number,
    w: number,
    h: number
  ) {
    if (items.length === 0) return;
    if (items.length === 1) {
      results.push({
        node: items[0].node,
        colorIndex: items[0].colorIndex,
        x,
        y,
        w,
        h,
      });
      return;
    }

    const total = items.reduce((acc, it) => acc + it.node.size_bytes, 0);
    if (total <= 0) return;

    let accum = 0;
    let splitIdx = 0;
    for (let i = 0; i < items.length - 1; i++) {
      accum += items[i].node.size_bytes;
      splitIdx = i + 1;
      if (accum >= total / 2) break;
    }

    const leftItems = items.slice(0, splitIdx);
    const rightItems = items.slice(splitIdx);
    const leftSum = leftItems.reduce((acc, it) => acc + it.node.size_bytes, 0);
    const ratio = Math.min(0.88, Math.max(0.12, leftSum / total));

    if (w >= h) {
      const leftW = w * ratio;
      subdivide(leftItems, x, y, leftW, h);
      subdivide(rightItems, x + leftW, y, w - leftW, h);
    } else {
      const topH = h * ratio;
      subdivide(leftItems, x, y, w, topH);
      subdivide(rightItems, x, y + topH, w, h - topH);
    }
  }

  subdivide(
    valid.map((node, idx) => ({ node, colorIndex: idx % TREEMAP_PALETTE.length })),
    0,
    0,
    100,
    100
  );

  return results;
}

export function getLoadBarStyles(
  percentage: number,
  defaultTheme: "emerald" | "cyan" = "cyan"
): { barClass: string; badgeTextClass: string; activeSegmentClass: string } {
  if (percentage > 90) {
    return {
      barClass:
        "bg-gradient-to-r from-rose-500 to-red-400 shadow-[0_0_10px_rgba(244,63,94,0.45)]",
      badgeTextClass: "text-rose-400",
      activeSegmentClass: "bg-rose-400",
    };
  }
  if (percentage > 70) {
    return {
      barClass:
        "bg-gradient-to-r from-amber-500 to-yellow-400 shadow-[0_0_10px_rgba(245,158,11,0.4)]",
      badgeTextClass: "text-amber-400",
      activeSegmentClass: "bg-amber-400",
    };
  }
  if (defaultTheme === "cyan") {
    return {
      barClass:
        "bg-gradient-to-r from-[#00D5E8] to-[#36AFC0] shadow-[0_0_10px_rgba(0,213,232,0.35)]",
      badgeTextClass: "text-[#00D5E8]",
      activeSegmentClass: "bg-[#00D5E8]",
    };
  }
  return {
    barClass:
      "bg-gradient-to-r from-[#36AFC0] to-[#00D5E8] shadow-[0_0_10px_rgba(54,175,192,0.35)]",
    badgeTextClass: "text-[#36AFC0]",
    activeSegmentClass: "bg-[#36AFC0]",
  };
}

export function SegmentedHudBar({
  percentage,
  theme = "cyan",
}: {
  percentage: number;
  segments?: number;
  theme?: "emerald" | "cyan";
}) {
  const clamped = Math.min(100, Math.max(0, percentage));
  const styles = getLoadBarStyles(clamped, theme);

  return (
    <div className="relative h-2 w-full overflow-hidden rounded-sm border border-[#202B38] bg-[#0B0E14] p-[1px]">
      <div
        className={`shimmer-bar relative h-full overflow-hidden rounded-[1px] ${styles.barClass}`}
        style={{
          width: `${clamped}%`,
          transition: "width 0.45s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      />
      <div className="hud-scale-ticks pointer-events-none absolute inset-0 z-10" />
    </div>
  );
}

export function getLocationBadgeStyles(location: string): string {
  if (location.includes("HKCU")) {
    return "bg-[#00D5E8]/10 text-[#00D5E8] border-[#00D5E8]/25";
  }
  if (location.includes("HKLM")) {
    return "bg-indigo-500/10 text-indigo-300 border-indigo-500/25";
  }
  return "bg-[#36AFC0]/10 text-[#36AFC0] border-[#36AFC0]/25";
}

export interface PageHeaderProps {
  title: string;
  description: string;
  badge?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, description, badge, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 border-b border-[#202B38] pb-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-[22px] font-semibold tracking-tight text-[#E5EDF5]">
            {title}
          </h2>
          {badge}
        </div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-[#8292A3]">
          {description}
        </p>
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2.5">
          {actions}
        </div>
      )}
    </div>
  );
}

export interface SpotlightCardProps {
  children: ReactNode;
  className?: string;
  spotlightColor?: string;
  variants?: Variants;
  accentColor?: "emerald" | "cyan" | "amber" | "rose";
}

export function SpotlightCard({
  children,
  className = "",
  spotlightColor = "rgba(0, 213, 232, 0.08)",
  variants,
}: SpotlightCardProps) {
  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mouse-x", `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty("--mouse-y", `${e.clientY - rect.top}px`);
  };

  return (
    <motion.div
      variants={variants}
      onMouseMove={handleMouseMove}
      whileHover={{
        y: -1,
        transition: { type: "spring", stiffness: 420, damping: 32 },
      }}
      style={{ "--spotlight-color": spotlightColor } as React.CSSProperties}
      className={`tactical-card tactical-brackets group relative transform-gpu rounded-xl transition-colors duration-300 ${className}`}
    >
      <div
        className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(380px circle at var(--mouse-x, -200px) var(--mouse-y, -200px), var(--spotlight-color), transparent 80%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          padding: "1px",
          background:
            "radial-gradient(380px circle at var(--mouse-x, -200px) var(--mouse-y, -200px), rgba(0, 213, 232, 0.45), transparent 80%)",
          mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
          maskComposite: "exclude",
          WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
          WebkitMaskComposite: "xor",
        }}
      />
      <div className="relative z-10 flex h-full flex-col justify-between">{children}</div>
    </motion.div>
  );
}

function smoothSeriesPath(
  coords: { x: number; y: number }[],
  baseline: number
): { line: string; area: string } {
  if (coords.length === 0) return { line: "", area: "" };

  const fmt = (n: number) => n.toFixed(2);
  let line = `M ${fmt(coords[0].x)} ${fmt(coords[0].y)}`;

  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(0, i - 1)];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[Math.min(coords.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    line += ` C ${fmt(cp1x)} ${fmt(cp1y)} ${fmt(cp2x)} ${fmt(cp2y)} ${fmt(p2.x)} ${fmt(p2.y)}`;
  }

  const firstX = fmt(coords[0].x);
  const lastX = fmt(coords[coords.length - 1].x);
  const area = `${line} L ${lastX} ${fmt(baseline)} L ${firstX} ${fmt(baseline)} Z`;
  return { line, area };
}

function nearestSeries(
  history: HistoryPoint[],
  relX: number,
  relY: number,
  widthPx: number,
  heightPx: number,
  plotWidth: number,
  plotHeight: number,
  maxPoints: number
): { idx: number; series: "cpu" | "ram"; x: number; y: number } | null {
  if (history.length === 0 || widthPx <= 0 || heightPx <= 0) return null;
  const slot = Math.round(relX * (maxPoints - 1));
  const center = Math.max(0, Math.min(history.length - 1, slot));
  const mouseX = relX * widthPx;
  const mouseY = relY * heightPx;
  let best: { idx: number; series: "cpu" | "ram"; x: number; y: number; dist: number } | null = null;

  for (let idx = Math.max(0, center - 2); idx <= Math.min(history.length - 1, center + 2); idx++) {
    const point = history[idx];
    const x = (idx / Math.max(1, maxPoints - 1)) * plotWidth;
    const xPx = (x / plotWidth) * widthPx;
    const samples: Array<{ series: "cpu" | "ram"; value: number }> = [
      { series: "cpu", value: point.cpu },
      { series: "ram", value: point.ram },
    ];
    for (const sample of samples) {
      const clamped = Math.min(100, Math.max(0, sample.value));
      const y = plotHeight - (clamped / 100) * (plotHeight - 16) - 8;
      const yPx = (y / plotHeight) * heightPx;
      const dist = Math.hypot(mouseX - xPx, mouseY - yPx);
      if (!best || dist < best.dist) {
        best = { idx, series: sample.series, x, y, dist };
      }
    }
  }

  if (!best || best.dist > 22) return null;
  return best;
}

export const LoadHistoryChart = memo(function LoadHistoryChart({
  history,
}: {
  history: HistoryPoint[];
}) {
  const width = 600;
  const height = 180;
  const maxPoints = HISTORY_LENGTH;
  const plotRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<{ relX: number; relY: number } | null>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);

  const getCoord = (idx: number, val: number) => {
    const x = (idx / Math.max(1, maxPoints - 1)) * width;
    const clampedVal = Math.min(100, Math.max(0, val));
    const y = height - (clampedVal / 100) * (height - 16) - 8;
    return { x, y };
  };

  const buildPaths = (key: "cpu" | "ram") => {
    const coords = history.map((pt, idx) => getCoord(idx, pt[key]));
    return smoothSeriesPath(coords, height);
  };

  const cpuPaths = buildPaths("cpu");
  const ramPaths = buildPaths("ram");
  const activePoint = history[history.length - 1];
  const lastIndex = history.length - 1;
  const cpuBeacon = activePoint ? getCoord(lastIndex, activePoint.cpu) : null;
  const ramBeacon = activePoint ? getCoord(lastIndex, activePoint.ram) : null;

  const paintHover = (relX: number, relY: number) => {
    const plot = plotRef.current;
    const rect = plot?.getBoundingClientRect();
    const hit =
      rect &&
      nearestSeries(history, relX, relY, rect.width, rect.height, width, height, maxPoints);
    if (!hit || !dotRef.current || !badgeRef.current || !tipRef.current) {
      if (dotRef.current) dotRef.current.style.opacity = "0";
      if (badgeRef.current) badgeRef.current.style.opacity = "0";
      return;
    }
    const point = history[hit.idx];
    const value = hit.series === "cpu" ? point.cpu : point.ram;
    const xPct = (hit.x / width) * 100;
    const yPct = (hit.y / height) * 100;
    dotRef.current.style.opacity = "1";
    dotRef.current.style.left = `${xPct}%`;
    dotRef.current.style.top = `${yPct}%`;
    dotRef.current.style.background = hit.series === "cpu" ? "#00D5E8" : "#6366F1";
    dotRef.current.style.boxShadow =
      hit.series === "cpu"
        ? "0 0 8px rgba(0, 213, 232, 0.85)"
        : "0 0 8px rgba(99, 102, 241, 0.8)";
    badgeRef.current.style.opacity = "1";
    badgeRef.current.style.left = `${Math.min(84, Math.max(16, xPct))}%`;
    tipRef.current.textContent = `${point.timestamp}  ${hit.series === "cpu" ? "CPU" : "RAM"} ${value.toFixed(1)}%`;
    tipRef.current.style.color = hit.series === "cpu" ? "#00D5E8" : "#A5B4FC";
  };

  const hideHover = () => {
    hoverRef.current = null;
    if (dotRef.current) dotRef.current.style.opacity = "0";
    if (badgeRef.current) badgeRef.current.style.opacity = "0";
  };

  const moveHover = (clientX: number, clientY: number, rect: DOMRect) => {
    if (history.length === 0 || rect.width <= 0 || rect.height <= 0) return;
    const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const relY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    hoverRef.current = { relX, relY };
    paintHover(relX, relY);
  };

  useEffect(() => {
    const hover = hoverRef.current;
    if (!hover) return;
    paintHover(hover.relX, hover.relY);
  }, [history, maxPoints]);

  return (
    <SpotlightCard
      variants={cardItemVariants}
      spotlightColor="rgba(0, 213, 232, 0.08)"
      className="p-4 sm:p-5"
    >
      <div className="space-y-4">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <div className="flex items-center gap-2.5">
              <h3 className="text-[15px] font-semibold tracking-tight text-[#E5EDF5]">
                Динамика нагрузки системы
              </h3>
              <span className="rounded border border-[#202B38] bg-[#151C26] px-2 py-0.5 font-mono text-[11px] font-medium text-[#8292A3]">
                60 сек
              </span>
            </div>
            <p className="mt-0.5 text-xs text-[#8292A3]">
              Интервал опроса 1 сек · Срез: <span className="font-mono text-[#E5EDF5]">{activePoint?.timestamp ?? "—"}</span>
            </p>
          </div>

          <div className="flex items-center gap-4 rounded-lg border border-[#202B38] bg-[#0B0E14] px-3.5 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#00D5E8] shadow-[0_0_8px_rgba(0,213,232,0.75)]"></span>
              <span className="text-[#8292A3]">CPU</span>
              <span className="w-12 text-right font-mono font-semibold text-[#00D5E8]">
                {activePoint ? `${activePoint.cpu.toFixed(1)}%` : "0.0%"}
              </span>
            </div>
            <div className="h-3.5 w-px bg-[#202B38]" />
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-indigo-400 shadow-[0_0_8px_rgba(99,102,241,0.7)]"></span>
              <span className="text-[#8292A3]">RAM</span>
              <span className="w-12 text-right font-mono font-semibold text-indigo-300">
                {activePoint ? `${activePoint.ram.toFixed(1)}%` : "0.0%"}
              </span>
            </div>
          </div>
        </div>

        <div>
          <div
            ref={plotRef}
            className="relative h-[220px] w-full select-none xl:h-[260px] 2xl:h-[320px]"
            onMouseMove={(e) => moveHover(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect())}
            onMouseLeave={hideHover}
          >
            <div className="pointer-events-none absolute inset-y-0 left-2.5 z-10 flex flex-col justify-between py-2 font-mono text-[11px] text-[#526170]">
              <span>100%</span>
              <span>75%</span>
              <span>50%</span>
              <span>25%</span>
              <span>0%</span>
            </div>

            <div
              ref={dotRef}
              className="pointer-events-none absolute z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0"
            />
            <div
              ref={badgeRef}
              className="pointer-events-none absolute top-2.5 z-20 -translate-x-1/2 whitespace-nowrap rounded-lg border border-[#202B38] bg-[#151C26] px-2.5 py-1 font-mono text-xs opacity-0 shadow-lg"
            >
              <span ref={tipRef} className="font-semibold" />
            </div>

            <svg
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              className="pointer-events-none h-full w-full transform-gpu overflow-visible rounded-xl border border-[#202B38] bg-[#0B0E14]"
            >
              <defs>
                <linearGradient id="cpuStroke" x1="0" y1="0" x2={width} y2="0" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#00D5E8" />
                  <stop offset="100%" stopColor="#36AFC0" />
                </linearGradient>
                <linearGradient id="ramStroke" x1="0" y1="0" x2={width} y2="0" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#818CF8" />
                  <stop offset="100%" stopColor="#38BDF8" />
                </linearGradient>
                <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00D5E8" stopOpacity="0.28" />
                  <stop offset="60%" stopColor="#36AFC0" stopOpacity="0.1" />
                  <stop offset="100%" stopColor="#36AFC0" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="ramGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#818CF8" stopOpacity="0.2" />
                  <stop offset="100%" stopColor="#38BDF8" stopOpacity="0" />
                </linearGradient>
              </defs>

              {[0.2, 0.4, 0.6, 0.8].map((ratio) => (
                <line
                  key={`v-${ratio}`}
                  x1={width * ratio}
                  y1={0}
                  x2={width * ratio}
                  y2={height}
                  stroke="#202B38"
                  strokeOpacity="0.55"
                  strokeDasharray="2 4"
                  strokeWidth="1"
                />
              ))}

              {[0.25, 0.5, 0.75].map((ratio) => (
                <line
                  key={ratio}
                  x1={0}
                  y1={height * ratio}
                  x2={width}
                  y2={height * ratio}
                  stroke="#202B38"
                  strokeOpacity="0.75"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
              ))}

              <path d={ramPaths.area} fill="url(#ramGrad)" />
              <path
                d={ramPaths.line}
                fill="none"
                stroke="url(#ramStroke)"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.24"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={ramPaths.line}
                fill="none"
                stroke="url(#ramStroke)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                style={{
                  filter: "drop-shadow(0 0 6px rgba(129, 140, 248, 0.35))",
                }}
              />

              <path d={cpuPaths.area} fill="url(#cpuGrad)" />
              <path
                d={cpuPaths.line}
                fill="none"
                stroke="url(#cpuStroke)"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.28"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={cpuPaths.line}
                fill="none"
                stroke="url(#cpuStroke)"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                style={{ filter: "drop-shadow(0 0 6px rgba(0, 213, 232, 0.45))" }}
              />
            </svg>

            {ramBeacon && (
              <div
                className="pointer-events-none absolute z-10"
                style={{
                  left: `${(ramBeacon.x / width) * 100}%`,
                  top: `${(ramBeacon.y / height) * 100}%`,
                }}
              >
                <div className="relative h-3 w-3 -translate-x-1/2 -translate-y-1/2 transform-gpu">
                  <span className="absolute inset-0 animate-ping rounded-full bg-indigo-400/60" />
                  <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-300 shadow-[0_0_6px_rgba(129,140,248,0.85)]" />
                </div>
              </div>
            )}
            {cpuBeacon && (
              <div
                className="pointer-events-none absolute z-10"
                style={{
                  left: `${(cpuBeacon.x / width) * 100}%`,
                  top: `${(cpuBeacon.y / height) * 100}%`,
                }}
              >
                <div className="relative h-3 w-3 -translate-x-1/2 -translate-y-1/2 transform-gpu">
                  <span className="absolute inset-0 animate-ping rounded-full bg-[#00D5E8]/65" />
                  <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#00D5E8] shadow-[0_0_6px_rgba(0,213,232,0.9)]" />
                </div>
              </div>
            )}
          </div>

          <div className="mt-1.5 flex justify-between px-1 font-mono text-[11px] text-[#526170]">
            <span>-60 сек</span>
            <span>-30 сек</span>
            <span>Сейчас</span>
          </div>
        </div>
      </div>
    </SpotlightCard>
  );
});
