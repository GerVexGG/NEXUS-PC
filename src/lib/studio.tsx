import { useState, memo, type ReactNode, MouseEvent } from "react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
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
}

export interface FileEntry {
  path: string;
  name: string;
  size_bytes: number;
  extension: string;
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
  if (pingMs < 40) {
    return {
      valueText: `${pingMs}`,
      statusLabel: "ИДЕАЛЬНО",
      colorClass: "text-sky-400 drop-shadow-[0_0_12px_rgba(56,189,248,0.35)]",
      badgeClass:
        "bg-sky-500/15 text-sky-300 border-sky-500/35 shadow-[0_0_12px_rgba(56,189,248,0.2)]",
      dotClass: "bg-sky-400 shadow-[0_0_8px_#38bdf8]",
      barPercent: Math.max(12, Math.min(100, (1 - pingMs / 150) * 100)),
    };
  }
  if (pingMs <= 90) {
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

// Сегментированный индикатор приборной шкалы Obsidian Cyber-HUD
export function SegmentedHudBar({
  percentage,
  segments = 20,
  theme = "emerald",
}: {
  percentage: number;
  segments?: number;
  theme?: "emerald" | "cyan";
}) {
  const clamped = Math.min(100, Math.max(0, percentage));
  const activeCount = Math.round((clamped / 100) * segments);
  const styles = getLoadBarStyles(clamped, theme);

  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${segments}, minmax(0, 1fr))` }}>
      {Array.from({ length: segments }, (_, i) => {
        const isActive = i < activeCount;
        return (
          <div
            key={i}
            className={`h-2 rounded-[2px] transition-all duration-300 ${
              isActive ? styles.activeSegmentClass : "bg-white/[0.06]"
            }`}
          />
        );
      })}
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

// Приборный модуль Obsidian Cyber-HUD с угловыми метками (HUD corner brackets) и Spotlight-свечением
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
  accentColor = "emerald",
}: SpotlightCardProps) {
  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    e.currentTarget.style.setProperty("--mouse-x", `${x}px`);
    e.currentTarget.style.setProperty("--mouse-y", `${y}px`);
  };

  const cornerClass =
    accentColor === "cyan"
      ? "border-cyan-400/40 group-hover:border-cyan-300/80"
      : accentColor === "amber"
      ? "border-amber-400/45 group-hover:border-amber-300/85"
      : accentColor === "rose"
      ? "border-rose-400/50 group-hover:border-rose-300/90"
      : "border-sky-400/40 group-hover:border-sky-300/80";

  return (
    <motion.div
      variants={variants}
      onMouseMove={handleMouseMove}
      style={
        {
          "--spotlight-color": spotlightColor,
        } as React.CSSProperties
      }
      className={`group relative overflow-hidden rounded-xl backdrop-blur-2xl bg-[#111722]/95 border border-[#222b38] hover:border-sky-400/25 transition-all duration-300 shadow-[0_12px_36px_rgba(0,0,0,0.65)] ${className}`}
    >
      {/* Направленный радиальный свет за курсором */}
      <div
        className="pointer-events-none absolute -inset-px opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          background:
            "radial-gradient(360px circle at var(--mouse-x, 0px) var(--mouse-y, 0px), var(--spotlight-color), transparent 80%)",
        }}
      />
      {/* Верхний металлический лазерный блик */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

      {/* Неоновые угловые метки приборного модуля (HUD Corner Brackets) */}
      <span
        className={`pointer-events-none absolute top-1.5 left-1.5 w-2.5 h-2.5 border-t border-l transition-colors duration-300 ${cornerClass}`}
      />
      <span
        className={`pointer-events-none absolute top-1.5 right-1.5 w-2.5 h-2.5 border-t border-r transition-colors duration-300 ${cornerClass}`}
      />
      <span
        className={`pointer-events-none absolute bottom-1.5 left-1.5 w-2.5 h-2.5 border-b border-l transition-colors duration-300 ${cornerClass}`}
      />
      <span
        className={`pointer-events-none absolute bottom-1.5 right-1.5 w-2.5 h-2.5 border-b border-r transition-colors duration-300 ${cornerClass}`}
      />

      <div className="relative z-10 h-full flex flex-col justify-between">{children}</div>
    </motion.div>
  );
}

// Изолированный компонент графика истории нагрузки за последние 60 секунд
export const LoadHistoryChart = memo(function LoadHistoryChart({
  history,
}: {
  history: HistoryPoint[];
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 600;
  const height = 180;
  const maxPoints = HISTORY_LENGTH;

  const getCoord = (idx: number, val: number) => {
    const x = (idx / Math.max(1, maxPoints - 1)) * width;
    const clampedVal = Math.min(100, Math.max(0, val));
    const y = height - (clampedVal / 100) * (height - 16) - 8;
    return { x, y };
  };

  const buildPaths = (key: "cpu" | "ram") => {
    if (history.length === 0) return { line: "", area: "" };

    const coords = history.map((pt, idx) => getCoord(idx, pt[key]));

    const line = coords
      .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(" ");

    const firstX = coords[0].x.toFixed(1);
    const lastX = coords[coords.length - 1].x.toFixed(1);
    const area = `${line} L ${lastX} ${height} L ${firstX} ${height} Z`;

    return { line, area };
  };

  const cpuPaths = buildPaths("cpu");
  const ramPaths = buildPaths("ram");

  const activePoint =
    hoverIndex !== null && history[hoverIndex]
      ? history[hoverIndex]
      : history[history.length - 1];

  const hoverCoordCpu =
    hoverIndex !== null && history[hoverIndex]
      ? getCoord(hoverIndex, history[hoverIndex].cpu)
      : null;

  const hoverCoordRam =
    hoverIndex !== null && history[hoverIndex]
      ? getCoord(hoverIndex, history[hoverIndex].ram)
      : null;

  const hoverPercentX =
    hoverIndex !== null ? (hoverIndex / Math.max(1, maxPoints - 1)) * 100 : 50;

  return (
    <SpotlightCard
      variants={cardItemVariants}
      spotlightColor="rgba(34, 211, 238, 0.09)"
      className="p-5 sm:p-6"
    >
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-[#e8edf4] tracking-tight">
                История нагрузки (последние 60 сек)
              </h3>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-sky-500/10 text-sky-400 border border-sky-500/20">
                <Sparkles size={10} /> LIVE
              </span>
            </div>
            <p className="text-xs text-[#8793a5] font-mono mt-0.5">
              Интервал обновления: 1 сек • Отметка: {activePoint?.timestamp ?? "—"}
            </p>
          </div>

          {/* Легенда */}
          <div className="flex items-center gap-5 text-xs font-mono bg-zinc-950/60 px-3.5 py-2 rounded-xl border border-white/5">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.85)]"></span>
              <span className="text-[#8793a5]">CPU:</span>
              <span className="text-sky-400 font-semibold w-12 text-right">
                {activePoint ? `${activePoint.cpu.toFixed(1)}%` : "0.0%"}
              </span>
            </div>
            <div className="h-3.5 w-px bg-zinc-800" />
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.85)]"></span>
              <span className="text-[#8793a5]">RAM:</span>
              <span className="text-cyan-400 font-semibold w-12 text-right">
                {activePoint ? `${activePoint.ram.toFixed(1)}%` : "0.0%"}
              </span>
            </div>
          </div>
        </div>

        {/* Область SVG-графика */}
        <div className="relative h-52 w-full select-none">
          <div className="pointer-events-none absolute inset-y-0 left-2 flex flex-col justify-between text-[10px] font-mono text-[#8793a5]/80 py-2 z-10">
            <span>100%</span>
            <span>75%</span>
            <span>50%</span>
            <span>25%</span>
            <span>0%</span>
          </div>

          <AnimatePresence>
            {hoverIndex !== null && history[hoverIndex] && (
              <motion.div
                initial={{ opacity: 0, y: 6, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.94 }}
                transition={{ duration: 0.14, ease: "easeOut" }}
                style={{
                  left: `${Math.min(86, Math.max(14, hoverPercentX))}%`,
                }}
                className="pointer-events-none absolute top-2.5 -translate-x-1/2 z-20 px-3 py-1.5 rounded-xl backdrop-blur-md bg-zinc-950/90 border border-white/10 shadow-[0_8px_24px_rgba(0,0,0,0.6)] text-[11px] font-mono flex items-center gap-3 whitespace-nowrap"
              >
                <span className="text-[#8793a5]">{history[hoverIndex].timestamp}</span>
                <span className="text-sky-400 font-semibold">
                  CPU {history[hoverIndex].cpu.toFixed(1)}%
                </span>
                <span className="text-cyan-400 font-semibold">
                  RAM {history[hoverIndex].ram.toFixed(1)}%
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="w-full h-full overflow-visible rounded-xl bg-[#151c27]/90 border border-white/5 cursor-crosshair"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              const idx = Math.round(relX * (history.length - 1));
              setHoverIndex(idx);
            }}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <defs>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3.2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              <linearGradient id="cpuAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.34" />
                <stop offset="65%" stopColor="#38bdf8" stopOpacity="0.08" />
                <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.0" />
              </linearGradient>
              <linearGradient id="ramAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.26" />
                <stop offset="65%" stopColor="#22d3ee" stopOpacity="0.06" />
                <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.0" />
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

            <path d={ramPaths.area} fill="url(#ramAreaGrad)" />
            <path
              d={ramPaths.line}
              fill="none"
              stroke="#22d3ee"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              filter="url(#glow)"
            />

            <path d={cpuPaths.area} fill="url(#cpuAreaGrad)" />
            <path
              d={cpuPaths.line}
              fill="none"
              stroke="#38bdf8"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              filter="url(#glow)"
            />

            {hoverIndex !== null && hoverCoordCpu && hoverCoordRam && (
              <g>
                <line
                  x1={hoverCoordCpu.x}
                  y1={0}
                  x2={hoverCoordCpu.x}
                  y2={height}
                  stroke="#a1a1aa"
                  strokeOpacity="0.5"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
                <circle
                  cx={hoverCoordRam.x}
                  cy={hoverCoordRam.y}
                  r="4.5"
                  fill="#090b0e"
                  stroke="#22d3ee"
                  strokeWidth="2.5"
                  filter="url(#glow)"
                />
                <circle
                  cx={hoverCoordCpu.x}
                  cy={hoverCoordCpu.y}
                  r="4.5"
                  fill="#090b0e"
                  stroke="#38bdf8"
                  strokeWidth="2.5"
                  filter="url(#glow)"
                />
              </g>
            )}
          </svg>

          <div className="flex justify-between text-[10px] font-mono text-[#8793a5] mt-1.5 px-1">
            <span>-60 сек</span>
            <span>-30 сек</span>
            <span>Сейчас</span>
          </div>
        </div>
      </div>
    </SpotlightCard>
  );
});

