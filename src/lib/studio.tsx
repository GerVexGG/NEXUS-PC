import { useEffect, useRef, memo, type ReactNode, type MouseEvent } from "react";
import { motion, type Variants } from "framer-motion";
import {
  Sparkles,
} from "lucide-react";

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
  icon_base64: string | null;
}

export type ProcessSortKey = "name" | "cpu" | "memory" | "disk" | "runtime";

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
    // Фоллбэк для WebView без доступа к Clipboard API
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
}

export const TIMER_STORAGE_KEY = "nexus_power_timer";
export const PRESET_MINUTES = [15, 30, 45, 60];
export const HISTORY_LENGTH = 60;

export const TREEMAP_PALETTE = [
  "from-sky-500/30 to-teal-600/20 border-sky-400/35 hover:border-sky-300/70 text-sky-200",
  "from-cyan-500/30 to-sky-600/20 border-cyan-400/35 hover:border-cyan-300/70 text-cyan-200",
  "from-indigo-500/30 to-blue-600/20 border-indigo-400/35 hover:border-indigo-300/70 text-indigo-200",
  "from-amber-500/30 to-orange-600/20 border-amber-400/35 hover:border-amber-300/70 text-amber-200",
  "from-violet-500/30 to-purple-600/20 border-violet-400/35 hover:border-violet-300/70 text-violet-200",
  "from-teal-500/25 to-sky-700/20 border-teal-400/30 hover:border-teal-300/70 text-teal-200",
  "from-sky-500/25 to-cyan-700/20 border-sky-400/30 hover:border-sky-300/70 text-sky-200",
  "from-rose-500/25 to-pink-700/20 border-rose-400/30 hover:border-rose-300/70 text-rose-200",
  "from-lime-500/25 to-sky-700/20 border-lime-400/30 hover:border-lime-300/70 text-lime-200",
  "from-zinc-700/40 to-zinc-800/40 border-zinc-600/40 hover:border-zinc-400/60 text-[#d5dde8]",
];

// Варианты упругой каскадной анимации приборных модулей Obsidian Cyber-HUD
export const cardsContainerVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.045,
      delayChildren: 0.01,
    },
  },
};

export const cardItemVariants: Variants = {
  hidden: { opacity: 0, y: 10, scale: 0.985 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: "spring",
      stiffness: 440,
      damping: 28,
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
      colorClass: "text-[#8793a5]",
      badgeClass: "bg-zinc-800/90 text-[#8793a5] border-white/[0.08]",
      dotClass: "bg-zinc-600",
      barPercent: 0,
    };
  }
  if (pingMs <= 80) {
    return {
      valueText: `${pingMs}`,
      statusLabel: pingMs <= 40 ? "ОТЛИЧНО" : "НОРМА",
      colorClass: "text-emerald-400",
      badgeClass: "bg-emerald-500/15 text-emerald-300 border-emerald-500/35",
      dotClass: "bg-emerald-400",
      barPercent: Math.max(12, Math.min(100, (1 - pingMs / 150) * 100)),
    };
  }
  if (pingMs <= 120) {
    return {
      valueText: `${pingMs}`,
      statusLabel: "СРЕДНЕ",
      colorClass: "text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.35)]",
      badgeClass:
        "bg-amber-500/15 text-amber-300 border-amber-500/35 shadow-[0_0_12px_rgba(251,191,36,0.2)]",
      dotClass: "bg-amber-400 shadow-[0_0_8px_#fbbf24]",
      barPercent: Math.max(20, Math.min(100, (1 - pingMs / 160) * 100)),
    };
  }
  return {
    valueText: `${pingMs}`,
    statusLabel: "ВЫСОКИЙ ПИНГ",
    colorClass: "text-rose-400 drop-shadow-[0_0_12px_rgba(244,63,94,0.4)]",
    badgeClass:
      "bg-rose-500/15 text-rose-300 border-rose-500/40 shadow-[0_0_14px_rgba(244,63,94,0.25)]",
    dotClass: "bg-rose-500 shadow-[0_0_8px_#f43f5e]",
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

// Цветовая индикация температуры (<65°C — зеленый, 65-80°C — янтарный, >80°C — рубиновый)
export function getTempBadgeStyle(tempC: number | null | undefined): {
  badgeClass: string;
  textClass: string;
  barClass: string;
  label: string;
} {
  if (tempC === null || tempC === undefined || !Number.isFinite(tempC)) {
    return {
      badgeClass: "bg-zinc-900/90 text-[#8793a5] border-white/[0.08]",
      textClass: "text-[#8793a5]",
      barClass: "bg-zinc-600",
      label: "Н/Д",
    };
  }
  if (tempC > 80) {
    return {
      badgeClass:
        "bg-rose-500/15 text-rose-300 border-rose-500/40 shadow-[0_0_14px_rgba(244,63,94,0.25)]",
      textClass: "text-rose-400",
      barClass:
        "bg-gradient-to-r from-rose-500 to-red-400 shadow-[0_0_12px_rgba(244,63,94,0.6)]",
      label: "CRITICAL",
    };
  }
  if (tempC >= 65) {
    return {
      badgeClass:
        "bg-amber-500/15 text-amber-300 border-amber-500/40 shadow-[0_0_14px_rgba(245,158,11,0.2)]",
      textClass: "text-amber-400",
      barClass:
        "bg-gradient-to-r from-amber-500 to-yellow-400 shadow-[0_0_12px_rgba(245,158,11,0.5)]",
      label: "WARM",
    };
  }
  return {
    badgeClass:
      "bg-sky-500/15 text-sky-300 border-sky-500/35 shadow-[0_0_14px_rgba(56,189,248,0.18)]",
    textClass: "text-sky-400",
    barClass:
      "bg-gradient-to-r from-sky-500 to-teal-400 shadow-[0_0_12px_rgba(56,189,248,0.45)]",
    label: "OPTIMAL",
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
        barClass: "bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.5)]",
        dotClass: "bg-cyan-400",
        textClass: "text-cyan-400",
      };
    case "Игры и софт":
      return {
        barClass: "bg-indigo-400 shadow-[0_0_10px_rgba(129,140,248,0.5)]",
        dotClass: "bg-indigo-400",
        textClass: "text-indigo-300",
      };
    case "Архивы и образы":
      return {
        barClass: "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.5)]",
        dotClass: "bg-amber-400",
        textClass: "text-amber-400",
      };
    case "Аудио":
      return {
        barClass: "bg-violet-400 shadow-[0_0_10px_rgba(167,139,250,0.5)]",
        dotClass: "bg-violet-400",
        textClass: "text-violet-400",
      };
    case "Документы":
      return {
        barClass: "bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.5)]",
        dotClass: "bg-sky-400",
        textClass: "text-sky-400",
      };
    default:
      return {
        barClass: "bg-zinc-500",
        dotClass: "bg-zinc-500",
        textClass: "text-[#8793a5]",
      };
  }
}

// Алгоритм пропорционального разбиения прямоугольника (Binary Split Treemap)
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

// Динамический цвет прогресс-бара и свечения в зависимости от нагрузки
export function getLoadBarStyles(
  percentage: number,
  defaultTheme: "emerald" | "cyan" = "emerald"
): { barClass: string; badgeTextClass: string; activeSegmentClass: string } {
  if (percentage > 90) {
    return {
      barClass:
        "bg-gradient-to-r from-rose-500 to-red-400 shadow-[0_0_12px_rgba(244,63,94,0.65)]",
      badgeTextClass: "text-rose-400",
      activeSegmentClass: "bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.7)]",
    };
  }
  if (percentage > 70) {
    return {
      barClass:
        "bg-gradient-to-r from-amber-500 to-yellow-400 shadow-[0_0_12px_rgba(245,158,11,0.55)]",
      badgeTextClass: "text-amber-400",
      activeSegmentClass: "bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.6)]",
    };
  }
  if (defaultTheme === "cyan") {
    return {
      barClass:
        "bg-gradient-to-r from-cyan-500 to-sky-400 shadow-[0_0_12px_rgba(34,211,238,0.45)]",
      badgeTextClass: "text-cyan-400",
      activeSegmentClass: "bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.55)]",
    };
  }
  return {
    barClass:
      "bg-gradient-to-r from-sky-500 to-teal-400 shadow-[0_0_12px_rgba(56,189,248,0.45)]",
    badgeTextClass: "text-sky-400",
    activeSegmentClass: "bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.55)]",
  };
}

export function SegmentedHudBar({
  percentage,
  theme = "emerald",
}: {
  percentage: number;
  segments?: number;
  theme?: "emerald" | "cyan";
}) {
  const clamped = Math.min(100, Math.max(0, percentage));
  const styles = getLoadBarStyles(clamped, theme);

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div
        className={`relative h-full overflow-hidden rounded-full ${styles.barClass}`}
        style={{
          width: `${clamped}%`,
          transition: "width 0.5s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <span className="bar-shimmer pointer-events-none absolute inset-y-0 left-0 w-2/5" />
      </div>
    </div>
  );
}

export function getLocationBadgeStyles(location: string): string {
  if (location.includes("HKCU")) {
    return "bg-cyan-500/10 text-cyan-400 border-cyan-500/25";
  }
  if (location.includes("HKLM")) {
    return "bg-indigo-500/10 text-indigo-400 border-indigo-500/25";
  }
  return "bg-sky-500/10 text-sky-400 border-sky-500/25";
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
  spotlightColor = "rgba(56, 189, 248, 0.12)",
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
      className={`group relative transform-gpu rounded-xl border border-[#222b38] bg-[#111722] transition-colors duration-300 hover:border-slate-700/80 ${className}`}
    >
      <div
        className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(400px circle at var(--mouse-x, -200px) var(--mouse-y, -200px), var(--spotlight-color), transparent 80%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          padding: "1px",
          background:
            "radial-gradient(400px circle at var(--mouse-x, -200px) var(--mouse-y, -200px), rgba(56, 189, 248, 0.55), transparent 80%)",
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

// Изолированный компонент графика истории нагрузки за последние 60 секунд
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
    dotRef.current.style.background = hit.series === "cpu" ? "#38bdf8" : "#2dd4bf";
    dotRef.current.style.boxShadow =
      hit.series === "cpu"
        ? "0 0 8px rgba(56, 189, 248, 0.85)"
        : "0 0 8px rgba(45, 212, 191, 0.8)";
    badgeRef.current.style.opacity = "1";
    badgeRef.current.style.left = `${Math.min(84, Math.max(16, xPct))}%`;
    tipRef.current.textContent = `${point.timestamp}  ${hit.series === "cpu" ? "CPU" : "RAM"} ${value.toFixed(1)}%`;
    tipRef.current.style.color = hit.series === "cpu" ? "#38bdf8" : "#5eead4";
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
      spotlightColor="rgba(56, 189, 248, 0.12)"
      className="p-5 sm:p-6"
    >
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold tracking-tight text-slate-100">
                Производительность (последние 60 сек)
              </h3>
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-400">
                <Sparkles size={10} /> Live
              </span>
            </div>
            <p className="mt-0.5 text-sm text-slate-400">
              Обновление каждую секунду · <span className="font-mono">{activePoint?.timestamp ?? "—"}</span>
            </p>
          </div>

          <div className="flex items-center gap-5 rounded-xl border border-white/5 bg-[#0e1118] px-3.5 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.85)]"></span>
              <span className="text-[#8793a5]">CPU:</span>
              <span className="w-12 text-right font-mono font-semibold text-sky-400">
                {activePoint ? `${activePoint.cpu.toFixed(1)}%` : "0.0%"}
              </span>
            </div>
            <div className="h-3.5 w-px bg-zinc-800" />
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-teal-400 shadow-[0_0_10px_rgba(45,212,191,0.75)]"></span>
              <span className="text-[#8793a5]">RAM:</span>
              <span className="w-12 text-right font-mono font-semibold text-teal-300">
                {activePoint ? `${activePoint.ram.toFixed(1)}%` : "0.0%"}
              </span>
            </div>
          </div>
        </div>

        <div>
          <div
            ref={plotRef}
            className="relative h-[260px] w-full select-none"
            onMouseMove={(e) => moveHover(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect())}
            onMouseLeave={hideHover}
          >
            <div className="pointer-events-none absolute inset-y-0 left-2 z-10 flex flex-col justify-between py-2 font-mono text-xs text-slate-500">
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
              className="pointer-events-none absolute top-2.5 z-20 -translate-x-1/2 whitespace-nowrap rounded-lg border border-[#222b38] bg-[#0e1118] px-2.5 py-1 font-mono text-xs opacity-0 shadow-lg"
            >
              <span ref={tipRef} className="font-semibold" />
            </div>

            <svg
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              className="pointer-events-none h-full w-full transform-gpu overflow-visible rounded-xl border border-white/5 bg-[#151c27]/90"
            >
              <defs>
                <linearGradient id="cpuStroke" x1="0" y1="0" x2={width} y2="0" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#6366f1" />
                </linearGradient>
                <linearGradient id="ramStroke" x1="0" y1="0" x2={width} y2="0" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#2dd4bf" />
                  <stop offset="100%" stopColor="#10b981" />
                </linearGradient>
                <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="ramGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                </linearGradient>
              </defs>

              {[0.25, 0.5, 0.75].map((ratio) => (
                <line
                  key={ratio}
                  x1={0}
                  y1={height * ratio}
                  x2={width}
                  y2={height * ratio}
                  stroke="#27272a"
                  strokeOpacity="0.65"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
              ))}

              <path d={ramPaths.area} fill="url(#ramGrad)" />
              <path
                d={ramPaths.line}
                fill="none"
                stroke="url(#ramStroke)"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.28"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={ramPaths.line}
                fill="none"
                stroke="url(#ramStroke)"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                style={{
                  filter:
                    "drop-shadow(0 0 2px rgba(45,212,191,0.7)) drop-shadow(0 0 8px rgba(16,185,129,0.35))",
                }}
              />

              <path d={cpuPaths.area} fill="url(#cpuGrad)" />
              <path
                d={cpuPaths.line}
                fill="none"
                stroke="url(#cpuStroke)"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.32"
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
                style={{ filter: "drop-shadow(0 0 8px rgba(56, 189, 248, 0.45))" }}
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
                <div className="relative h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 transform-gpu">
                  <span className="absolute inset-0 animate-ping rounded-full bg-teal-300/70" />
                  <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-teal-200 shadow-[0_0_8px_rgba(45,212,191,0.9)]" />
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
                <div className="relative h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 transform-gpu">
                  <span className="absolute inset-0 animate-ping rounded-full bg-sky-400/75" />
                  <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-200 shadow-[0_0_8px_rgba(56,189,248,0.95)]" />
                </div>
              </div>
            )}
          </div>

          <div className="mt-1.5 flex justify-between px-1 text-xs text-slate-500">
            <span>-60 сек</span>
            <span>-30 сек</span>
            <span>Сейчас</span>
          </div>
        </div>
      </div>
    </SpotlightCard>
  );
});

