import type { RttSample } from "./latencyHistory";
import type { ReactNode, MouseEvent } from "react";
import { motion, type Variants } from "framer-motion";
import { getLoadBarStyles } from "./metricsFormatters";
export {
  HISTORY_LENGTH,
  type HistoryPoint,
  createInitialHistory,
  formatCountdown,
  formatSpeedParts,
  formatRate,
  formatUptime,
  getPingHudStyle,
  formatBytes,
  getTempBadgeStyle,
  getLoadBarStyles,
  evaluateZipLimits,
  parseScriptConsoleStatus,
} from "./metricsFormatters";

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
  net_ping_method?: string;
  net_ping_sample?: RttSample | null;
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
  scan_id?: number;
  skipped_dirs_count?: number;
  access_denied_count?: number;
  skipped_files_count?: number;
  is_partial?: boolean;
  skipped_samples?: string[];
  total_dirs_count?: number;
  excluded_count?: number;
  diagnostics?: {
    elapsed_ms: number;
    enumeration_worker_ms: number;
    metadata_worker_ms: number;
    counting_worker_ms: number;
    aggregation_worker_ms: number;
    tree_worker_ms: number;
    finalize_ms: number;
    serialization_sample_ms: number;
    json_bytes: number;
  };
  ipc_roundtrip_ms?: number;
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
  package_temp_sensor?: string | null;
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
  external_route?: string | null;
}

export interface NetworkOptimizerStatus {
  packet_priority_enabled: boolean;
  packet_priority_has_backup: boolean;
  ethernet_tuned: boolean;
  ethernet_has_backup: boolean;
  backed_up_adapters_count: number;
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
  telemetry_stale?: boolean;
  sample_age_ms?: number | null;
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
  telemetry_stale?: boolean;
  sample_age_ms?: number | null;
}

export interface TelemetrySnapshot {
  timestamp: number;
  cpu_usage: number;
  cpu_temp: number | null;
  gpu_usage: number | null;
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
  has_main_window?: boolean;
  pid: number;
  parent_pid: number | null;
  name: string;
  exe_path: string;
  cpu_usage: number;
  memory_mb: number;
  disk_read_bytes_sec: number;
  disk_write_bytes_sec: number;
  disk_status?: "ready" | "pending" | "unavailable" | "error";
  disk_error_code?: number;
  run_time_sec: number;
  start_time: number;
  thread_count: number;
  handle_count: number;
  status: string;
  icon_base64: string | null;
  owner?: string | null;
  description?: string | null;
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
  | "handles"
  | "owner"
  | "description"
  | "path"
  | "status";

export interface ProcessContextMenuState {
  x: number;
  y: number;
  process: ProcessItem;
}

export const PROCESS_REFRESH_MS = 1500;

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const previous = document.activeElement;
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    try {
      area.select();
      if (!document.execCommand("copy")) throw new Error("Не удалось скопировать текст в буфер обмена");
    } finally {
      area.remove();
      if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
    }
  }
}

export type PowerTimerAction = "shutdown" | "restart" | "sleep";

export interface BackendPowerTimerState {
  timer_id: string;
  action: PowerTimerAction;
  start_time_ms: number;
  end_time_ms: number;
  total_seconds: number;
  remaining_seconds: number;
  restart: boolean;
  sleep: boolean;
}

export interface StoredTimerState {
  timerId?: string;
  action?: PowerTimerAction;
  endTime: number;
  totalSeconds: number;
  restart: boolean;
  sleep?: boolean;
}

export const TIMER_STORAGE_KEY = "nexus_power_timer";
export const PRESET_MINUTES = [15, 30, 45, 60];

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
    <header className="nexus-page-header">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-2xl font-semibold leading-tight tracking-tight">
            {title}
          </h2>
          {badge}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--nexus-muted)]">
          {description}
        </p>
      </div>
      {actions && (
        <div className="nexus-page-actions">
          {actions}
        </div>
      )}
    </header>
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
