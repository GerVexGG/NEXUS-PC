import "./App.css";
import { useState, useEffect, useRef, memo, type ReactNode, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import {
  LayoutDashboard,
  Power,
  HardDrive,
  Cpu,
  Activity,
  Clock,
  RotateCcw,
  XCircle,
  Play,
  Wifi,
  ArrowDown,
  ArrowUp,
  Sparkles,
  Rocket,
  FolderOpen,
  Search,
  AlertTriangle,
  RefreshCw,
  AppWindow,
  PieChart,
  Folder,
  FileText,
  ChevronRight,
  CornerUpLeft,
  Loader2,
  Gauge,
  Thermometer,
  Fan,
  ShieldCheck,
  ShieldAlert,
  Flame,
  Radio,
  Trash2,
  Minus,
  Square,
  X,
  ChevronDown,
  CheckCircle2,
  Check,
  Layers,
  Pause,
  Copy,
  ChevronUp,
} from "lucide-react";

interface Metrics {
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

interface StartupItem {
  id: string;
  name: string;
  command: string;
  clean_path: string;
  location: string;
  enabled: boolean;
  file_exists: boolean;
}

interface FileEntry {
  path: string;
  name: string;
  size_bytes: number;
  extension: string;
}

interface FolderNode {
  name: string;
  path: string;
  size_bytes: number;
  children: FolderNode[];
}

interface ScanResult {
  target_path: string;
  total_scanned_bytes: number;
  total_files_count: number;
  root_node: FolderNode;
  top_files: FileEntry[];
  category_sizes: [string, number][];
}

interface TreemapRect {
  node: FolderNode;
  x: number;
  y: number;
  w: number;
  h: number;
  colorIndex: number;
}

interface CoreTemp {
  name: string;
  temp_c: number;
}

interface CpuTelemetry {
  name: string;
  package_temp_c: number | null;
  max_core_temp_c: number | null;
  avg_clock_mhz: number | null;
  power_watts: number | null;
  voltage_v: number | null;
  core_temps: CoreTemp[];
}

interface GpuTelemetry {
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

interface FanSensorItem {
  name: string;
  rpm: number;
  percent: number | null;
}

interface TempSensorItem {
  name: string;
  temp_c: number;
}

interface StorageTempItem {
  name: string;
  temp_c: number | null;
  used_percent: number | null;
}

interface HardwareTelemetry {
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

interface CleanupCategory {
  id: string;
  name: string;
  description: string;
  paths_hint: string;
  size_bytes: number;
  files_count: number;
  requires_admin: boolean;
}

interface CleanupCategoryReport {
  id: string;
  name: string;
  deleted_files: number;
  skipped_files: number;
  freed_bytes: number;
}

interface CleanupReport {
  deleted_files_count: number;
  skipped_files_count: number;
  freed_bytes: number;
  categories: CleanupCategoryReport[];
}

interface ProcessItem {
  pid: number;
  parent_pid: number | null;
  name: string;
  exe_path: string;
  cpu_usage: number;
  memory_mb: number;
  disk_read_bytes_sec: number;
  disk_write_bytes_sec: number;
  run_time_sec: number;
}

type ProcessSortKey = "name" | "cpu" | "memory" | "disk" | "runtime";

interface ProcessContextMenuState {
  x: number;
  y: number;
  process: ProcessItem;
}

const PROCESS_REFRESH_MS = 1500;

function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0";
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec} B/s`;
}

function formatUptime(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return "—";
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m.toString().padStart(2, "0")}м`;
  return `${m}м ${s.toString().padStart(2, "0")}с`;
}

async function copyTextToClipboard(text: string): Promise<void> {
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

interface HistoryPoint {
  timestamp: string;
  cpu: number;
  ram: number;
}

interface StoredTimerState {
  endTime: number;
  totalSeconds: number;
  restart: boolean;
}

const TIMER_STORAGE_KEY = "nexus_power_timer";
const PRESET_MINUTES = [15, 30, 45, 60];
const HISTORY_LENGTH = 60;

const TREEMAP_PALETTE = [
  "from-emerald-500/30 to-teal-600/20 border-emerald-400/35 hover:border-emerald-300/70 text-emerald-200",
  "from-cyan-500/30 to-sky-600/20 border-cyan-400/35 hover:border-cyan-300/70 text-cyan-200",
  "from-indigo-500/30 to-blue-600/20 border-indigo-400/35 hover:border-indigo-300/70 text-indigo-200",
  "from-amber-500/30 to-orange-600/20 border-amber-400/35 hover:border-amber-300/70 text-amber-200",
  "from-violet-500/30 to-purple-600/20 border-violet-400/35 hover:border-violet-300/70 text-violet-200",
  "from-teal-500/25 to-emerald-700/20 border-teal-400/30 hover:border-teal-300/70 text-teal-200",
  "from-sky-500/25 to-cyan-700/20 border-sky-400/30 hover:border-sky-300/70 text-sky-200",
  "from-rose-500/25 to-pink-700/20 border-rose-400/30 hover:border-rose-300/70 text-rose-200",
  "from-lime-500/25 to-emerald-700/20 border-lime-400/30 hover:border-lime-300/70 text-lime-200",
  "from-zinc-700/40 to-zinc-800/40 border-zinc-600/40 hover:border-zinc-400/60 text-zinc-200",
];

// Варианты упругой каскадной анимации приборных модулей Obsidian Cyber-HUD
const cardsContainerVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.045,
      delayChildren: 0.01,
    },
  },
};

const cardItemVariants: Variants = {
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

function createInitialHistory(): HistoryPoint[] {
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

function formatCountdown(seconds: number): string {
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

function formatSpeedParts(kbps: number): { value: string; unit: string } {
  if (!Number.isFinite(kbps) || kbps <= 0) {
    return { value: "0.0", unit: "KB/S" };
  }
  if (kbps >= 1024) {
    return { value: (kbps / 1024).toFixed(2), unit: "MB/S" };
  }
  return { value: kbps.toFixed(1), unit: "KB/S" };
}

function getPingHudStyle(pingMs: number): {
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
      colorClass: "text-zinc-500",
      badgeClass: "bg-zinc-800/90 text-zinc-400 border-white/[0.08]",
      dotClass: "bg-zinc-600",
      barPercent: 0,
    };
  }
  if (pingMs < 40) {
    return {
      valueText: `${pingMs}`,
      statusLabel: "ИДЕАЛЬНО",
      colorClass: "text-emerald-400 drop-shadow-[0_0_12px_rgba(52,211,153,0.35)]",
      badgeClass:
        "bg-emerald-500/15 text-emerald-300 border-emerald-500/35 shadow-[0_0_12px_rgba(52,211,153,0.2)]",
      dotClass: "bg-emerald-400 shadow-[0_0_8px_#34d399]",
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

function formatBytes(bytes: number): string {
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
function getTempBadgeStyle(tempC: number | null | undefined): {
  badgeClass: string;
  textClass: string;
  barClass: string;
  label: string;
} {
  if (tempC === null || tempC === undefined || !Number.isFinite(tempC)) {
    return {
      badgeClass: "bg-zinc-900/90 text-zinc-400 border-white/[0.08]",
      textClass: "text-zinc-400",
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
      "bg-emerald-500/15 text-emerald-300 border-emerald-500/35 shadow-[0_0_14px_rgba(52,211,153,0.18)]",
    textClass: "text-emerald-400",
    barClass:
      "bg-gradient-to-r from-emerald-500 to-teal-400 shadow-[0_0_12px_rgba(52,211,153,0.45)]",
    label: "OPTIMAL",
  };
}

function getCategoryStyle(category: string): {
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
        barClass: "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]",
        dotClass: "bg-emerald-400",
        textClass: "text-emerald-400",
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
        textClass: "text-zinc-400",
      };
  }
}

// Алгоритм пропорционального разбиения прямоугольника (Binary Split Treemap)
function computeTreemapRects(nodes: FolderNode[]): TreemapRect[] {
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
function getLoadBarStyles(
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
      "bg-gradient-to-r from-emerald-500 to-teal-400 shadow-[0_0_12px_rgba(52,211,153,0.45)]",
    badgeTextClass: "text-emerald-400",
    activeSegmentClass: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55)]",
  };
}

// Сегментированный индикатор приборной шкалы Obsidian Cyber-HUD
function SegmentedHudBar({
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

function getLocationBadgeStyles(location: string): string {
  if (location.includes("HKCU")) {
    return "bg-cyan-500/10 text-cyan-400 border-cyan-500/25";
  }
  if (location.includes("HKLM")) {
    return "bg-indigo-500/10 text-indigo-400 border-indigo-500/25";
  }
  return "bg-emerald-500/10 text-emerald-400 border-emerald-500/25";
}

// Приборный модуль Obsidian Cyber-HUD с угловыми метками (HUD corner brackets) и Spotlight-свечением
interface SpotlightCardProps {
  children: ReactNode;
  className?: string;
  spotlightColor?: string;
  variants?: Variants;
  accentColor?: "emerald" | "cyan" | "amber" | "rose";
}

function SpotlightCard({
  children,
  className = "",
  spotlightColor = "rgba(52, 211, 153, 0.12)",
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
      : "border-emerald-400/40 group-hover:border-emerald-300/80";

  return (
    <motion.div
      variants={variants}
      onMouseMove={handleMouseMove}
      style={
        {
          "--spotlight-color": spotlightColor,
        } as React.CSSProperties
      }
      className={`group relative overflow-hidden rounded-xl backdrop-blur-2xl bg-[#0b0d13]/90 border border-white/[0.07] hover:border-white/[0.15] transition-all duration-300 shadow-[0_12px_36px_rgba(0,0,0,0.65)] ${className}`}
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
const LoadHistoryChart = memo(function LoadHistoryChart({
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
              <h3 className="text-base font-semibold text-zinc-100 tracking-tight">
                История нагрузки (последние 60 сек)
              </h3>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Sparkles size={10} /> LIVE
              </span>
            </div>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">
              Интервал обновления: 1 сек • Отметка: {activePoint?.timestamp ?? "—"}
            </p>
          </div>

          {/* Легенда */}
          <div className="flex items-center gap-5 text-xs font-mono bg-zinc-950/60 px-3.5 py-2 rounded-xl border border-white/5">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.85)]"></span>
              <span className="text-zinc-400">CPU:</span>
              <span className="text-emerald-400 font-semibold w-12 text-right">
                {activePoint ? `${activePoint.cpu.toFixed(1)}%` : "0.0%"}
              </span>
            </div>
            <div className="h-3.5 w-px bg-zinc-800" />
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.85)]"></span>
              <span className="text-zinc-400">RAM:</span>
              <span className="text-cyan-400 font-semibold w-12 text-right">
                {activePoint ? `${activePoint.ram.toFixed(1)}%` : "0.0%"}
              </span>
            </div>
          </div>
        </div>

        {/* Область SVG-графика */}
        <div className="relative h-52 w-full select-none">
          <div className="pointer-events-none absolute inset-y-0 left-2 flex flex-col justify-between text-[10px] font-mono text-zinc-500/80 py-2 z-10">
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
                <span className="text-zinc-400">{history[hoverIndex].timestamp}</span>
                <span className="text-emerald-400 font-semibold">
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
            className="w-full h-full overflow-visible rounded-xl bg-[#090b0e]/90 border border-white/5 cursor-crosshair"
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
                <stop offset="0%" stopColor="#34d399" stopOpacity="0.34" />
                <stop offset="65%" stopColor="#34d399" stopOpacity="0.08" />
                <stop offset="100%" stopColor="#34d399" stopOpacity="0.0" />
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
              stroke="#34d399"
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
                  stroke="#34d399"
                  strokeWidth="2.5"
                  filter="url(#glow)"
                />
              </g>
            )}
          </svg>

          <div className="flex justify-between text-[10px] font-mono text-zinc-500 mt-1.5 px-1">
            <span>-60 сек</span>
            <span>-30 сек</span>
            <span>Сейчас</span>
          </div>
        </div>
      </div>
    </SpotlightCard>
  );
});

export default function App() {
  const [activeTab, setActiveTab] = useState<
    "dashboard" | "startup" | "storage" | "hardware" | "cleanup" | "power" | "processes"
  >("dashboard");
  const [metrics, setMetrics] = useState<Metrics>({
    cpu_usage: 0,
    ram_used_gb: 0,
    ram_total_gb: 0,
    ram_percentage: 0,
    swap_used_gb: 0,
    swap_total_gb: 0,
    disk_free_gb: 0,
    disk_total_gb: 0,
    net_rx_kbps: 0,
    net_tx_kbps: 0,
    net_ping_ms: 0,
  });
  const [history, setHistory] = useState<HistoryPoint[]>(createInitialHistory);

  // Состояние кастомного тайтлбара и привилегий процесса
  const [isElevatedAdmin, setIsElevatedAdmin] = useState<boolean>(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState<boolean>(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  // Состояние модуля Startup Manager (Автозагрузка)
  const [startupItems, setStartupItems] = useState<StartupItem[]>([]);
  const [startupSearch, setStartupSearch] = useState<string>("");
  const [startupLoading, setStartupLoading] = useState<boolean>(false);
  const [startupError, setStartupError] = useState<string | null>(null);

  // Состояние модуля Storage Analyzer (Анализатор накопителей)
  const [availableDrives, setAvailableDrives] = useState<string[]>(["C:\\"]);
  const [selectedDriveOrPath, setSelectedDriveOrPath] = useState<string>("C:\\");
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanElapsedSec, setScanElapsedSec] = useState<number>(0);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [treemapStack, setTreemapStack] = useState<FolderNode[]>([]);
  const [selectedTreemapNode, setSelectedTreemapNode] = useState<FolderNode | null>(
    null
  );
  const [fileSearch, setFileSearch] = useState<string>("");

  // Состояние модуля Hardware Monitor (Мониторинг железа)
  const [hwData, setHwData] = useState<HardwareTelemetry | null>(null);

  // Состояние модуля Cleanup Center (Безопасная очистка накопителя)
  const [cleanupCategories, setCleanupCategories] = useState<CleanupCategory[]>([]);
  const [selectedCleanupIds, setSelectedCleanupIds] = useState<string[]>([]);
  const [isScanningCleanup, setIsScanningCleanup] = useState<boolean>(false);
  const [isCleaning, setIsCleaning] = useState<boolean>(false);
  const [confirmCleanupOpen, setConfirmCleanupOpen] = useState<boolean>(false);
  const [cleanupReport, setCleanupReport] = useState<CleanupReport | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  // Состояние модуля Process Explorer (Диспетчер процессов)
  const [processes, setProcesses] = useState<ProcessItem[]>([]);
  const [processSearch, setProcessSearch] = useState<string>("");
  const [processAutoRefresh, setProcessAutoRefresh] = useState<boolean>(true);
  const [processSortKey, setProcessSortKey] = useState<ProcessSortKey>("cpu");
  const [processSortDesc, setProcessSortDesc] = useState<boolean>(true);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processNotice, setProcessNotice] = useState<string | null>(null);
  const [processLoading, setProcessLoading] = useState<boolean>(false);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [suspendedPids, setSuspendedPids] = useState<number[]>([]);
  const [processMenu, setProcessMenu] = useState<ProcessContextMenuState | null>(null);
  const processMenuRef = useRef<ProcessContextMenuState | null>(null);
  processMenuRef.current = processMenu;

  // Состояние модуля управления питанием
  const [restartMode, setRestartMode] = useState<boolean>(false);
  const [customMinutes, setCustomMinutes] = useState<string>("");
  const [timerState, setTimerState] = useState<StoredTimerState | null>(() => {
    try {
      const raw = localStorage.getItem(TIMER_STORAGE_KEY);
      if (!raw) return null;
      const parsed: StoredTimerState = JSON.parse(raw);
      if (parsed.endTime > Date.now()) {
        return parsed;
      }
      localStorage.removeItem(TIMER_STORAGE_KEY);
      return null;
    } catch {
      return null;
    }
  });
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() => {
    if (!timerState) return 0;
    return Math.max(0, Math.ceil((timerState.endTime - Date.now()) / 1000));
  });
  const [powerError, setPowerError] = useState<string | null>(null);

  // Проверка прав Администратора при старте приложения
  useEffect(() => {
    invoke<boolean>("is_elevated_admin")
      .then((elevated) => setIsElevatedAdmin(Boolean(elevated)))
      .catch((err) => console.error("Ошибка проверки прав администратора:", err));
  }, []);

  // Глобальные горячие клавиши: F11 — полноэкранный режим, Escape — выход из Fullscreen
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key !== "F11" && e.key !== "Escape") return;
      try {
        const win = getCurrentWindow();
        const isFullscreen = await win.isFullscreen();
        if (e.key === "F11") {
          e.preventDefault();
          await win.setFullscreen(!isFullscreen);
        } else if (isFullscreen && !processMenuRef.current) {
          e.preventDefault();
          await win.setFullscreen(false);
        }
      } catch (err) {
        console.error("Ошибка переключения полноэкранного режима:", err);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Опрос списка процессов (Process Explorer) с интервалом автообновления
  const fetchProcesses = async () => {
    try {
      const list = await invoke<ProcessItem[]>("get_process_list");
      setProcesses(list);
      setProcessError(null);
      // Убираем из списка замороженных PID, которых больше не существует
      setSuspendedPids((prev) => prev.filter((pid) => list.some((p) => p.pid === pid)));
    } catch (err) {
      console.error("Ошибка получения списка процессов:", err);
      setProcessError(String(err));
    } finally {
      setProcessLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "processes") return;
    if (processes.length === 0) setProcessLoading(true);
    fetchProcesses();
    if (!processAutoRefresh) return;
    const interval = setInterval(fetchProcesses, PROCESS_REFRESH_MS);
    return () => clearInterval(interval);
  }, [activeTab, processAutoRefresh]);

  // Закрытие контекстного меню по клику вне области, Escape, прокрутке или смене вкладки
  useEffect(() => {
    if (!processMenu) return;
    const close = () => setProcessMenu(null);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [processMenu]);

  useEffect(() => {
    setProcessMenu(null);
  }, [activeTab]);

  const showProcessNotice = (msg: string) => {
    setProcessNotice(msg);
    setTimeout(() => setProcessNotice((cur) => (cur === msg ? null : cur)), 2600);
  };

  const handleProcessContextMenu = (e: MouseEvent<HTMLDivElement>, proc: ProcessItem) => {
    e.preventDefault();
    e.stopPropagation();
    const MENU_W = 248;
    const MENU_H = 250;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    setSelectedPid(proc.pid);
    setProcessMenu({ x: Math.max(8, x), y: Math.max(8, y), process: proc });
  };

  const handleProcessSort = (key: ProcessSortKey) => {
    if (processSortKey === key) {
      setProcessSortDesc((prev) => !prev);
    } else {
      setProcessSortKey(key);
      setProcessSortDesc(key !== "name");
    }
  };

  const handleProcessOpenLocation = async (proc: ProcessItem) => {
    setProcessMenu(null);
    if (!proc.exe_path) {
      setProcessError(`Путь к файлу процесса ${proc.name} недоступен (требуются права Администратора)`);
      return;
    }
    try {
      await invoke("open_item_location", { path: proc.exe_path });
    } catch (err) {
      setProcessError(String(err));
    }
  };

  const handleProcessCopyPath = async (proc: ProcessItem) => {
    setProcessMenu(null);
    const text = proc.exe_path || proc.name;
    await copyTextToClipboard(text);
    showProcessNotice(`Скопировано: ${text}`);
  };

  const handleProcessSuspendToggle = async (proc: ProcessItem) => {
    setProcessMenu(null);
    const isSuspended = suspendedPids.includes(proc.pid);
    try {
      await invoke("suspend_process", { pid: proc.pid, suspend: !isSuspended });
      setSuspendedPids((prev) =>
        isSuspended ? prev.filter((p) => p !== proc.pid) : [...prev, proc.pid]
      );
      showProcessNotice(
        isSuspended
          ? `Процесс ${proc.name} (PID ${proc.pid}) возобновлён`
          : `Процесс ${proc.name} (PID ${proc.pid}) заморожен`
      );
    } catch (err) {
      setProcessError(String(err));
    }
  };

  const handleProcessKill = async (proc: ProcessItem, tree: boolean) => {
    setProcessMenu(null);
    try {
      await invoke("kill_process", { pid: proc.pid, tree });
      setProcesses((prev) => prev.filter((p) => p.pid !== proc.pid));
      showProcessNotice(
        tree
          ? `Дерево процессов ${proc.name} (PID ${proc.pid}) завершено`
          : `Процесс ${proc.name} (PID ${proc.pid}) завершён`
      );
      setTimeout(fetchProcesses, 400);
    } catch (err) {
      setProcessError(String(err));
    }
  };

  // Обработчики безрамочного окна (Frameless Window Controls)
  const handleWindowMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (err) {
      console.error("Ошибка сворачивания окна:", err);
    }
  };

  const handleWindowToggleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch (err) {
      console.error("Ошибка разворачивания окна:", err);
    }
  };

  const handleWindowClose = async () => {
    try {
      await invoke("app_exit");
    } catch {
      try {
        await getCurrentWindow().close();
      } catch (err) {
        console.error("Ошибка закрытия окна:", err);
      }
    }
  };

  const handleRestartAsAdmin = async () => {
    setAdminError(null);
    setAdminMenuOpen(false);
    try {
      await invoke("restart_as_admin");
    } catch (err) {
      console.error("Ошибка перезапуска от имени Администратора:", err);
      setAdminError(String(err));
    }
  };

  // Обработчик анализа целей очистки (Cleanup Center)
  const handleScanCleanup = async () => {
    if (isScanningCleanup || isCleaning) return;
    setIsScanningCleanup(true);
    setCleanupError(null);
    setConfirmCleanupOpen(false);
    try {
      const categories = await invoke<CleanupCategory[]>("scan_cleanup_targets");
      setCleanupCategories(categories);
      // По умолчанию отмечаем все непустые категории (кроме требующих прав админа, если нет админки)
      const autoSelect = categories
        .filter((c) => c.size_bytes > 0 && (!c.requires_admin || isElevatedAdmin))
        .map((c) => c.id);
      setSelectedCleanupIds(
        autoSelect.length > 0 ? autoSelect : categories.map((c) => c.id)
      );
    } catch (err) {
      console.error("Ошибка сканирования категорий очистки:", err);
      setCleanupError(String(err));
    } finally {
      setIsScanningCleanup(false);
    }
  };

  const handleToggleCleanupCategory = (id: string) => {
    setConfirmCleanupOpen(false);
    setSelectedCleanupIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleExecuteCleanup = async () => {
    if (selectedCleanupIds.length === 0 || isCleaning) return;
    setIsCleaning(true);
    setCleanupError(null);
    setConfirmCleanupOpen(false);
    try {
      const report = await invoke<CleanupReport>("execute_cleanup", {
        categoryIds: selectedCleanupIds,
      });
      setCleanupReport(report);
      // Обновляем размеры категорий после завершения очистки
      const refreshed = await invoke<CleanupCategory[]>("scan_cleanup_targets");
      setCleanupCategories(refreshed);
    } catch (err) {
      console.error("Ошибка выполнения очистки:", err);
      setCleanupError(String(err));
    } finally {
      setIsCleaning(false);
    }
  };

  useEffect(() => {
    // Опрашиваем Rust раз в секунду и пополняем кольцевой буфер на 60 точек
    const fetchMetrics = async () => {
      try {
        const data = await invoke<Metrics>("get_system_metrics");
        setMetrics(data);

        const nowLabel = new Date().toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        setHistory((prev) => {
          const next = prev.slice(-(HISTORY_LENGTH - 1));
          next.push({
            timestamp: nowLabel,
            cpu: data.cpu_usage,
            ram: data.ram_percentage,
          });
          return next;
        });
      } catch (err) {
        console.error("Ошибка чтения метрик:", err);
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 1000);
    return () => clearInterval(interval);
  }, []);

  // Опрос датчиков LibreHardwareMonitor раз в 1 секунду при активной вкладке «Железо»
  useEffect(() => {
    if (activeTab !== "hardware") return;

    const fetchHwTelemetry = async () => {
      try {
        const data = await invoke<HardwareTelemetry>("get_hardware_telemetry");
        setHwData(data);
        if (data.is_admin) {
          setIsElevatedAdmin(true);
        }
      } catch (err) {
        console.error("Ошибка получения аппаратной телеметрии:", err);
      }
    };

    fetchHwTelemetry();
    const interval = setInterval(fetchHwTelemetry, 1000);
    return () => clearInterval(interval);
  }, [activeTab]);

  // Загрузка списка автозагрузки при переходе на вкладку «Автозагрузка»
  const fetchStartupItems = async () => {
    setStartupLoading(true);
    setStartupError(null);
    try {
      const items = await invoke<StartupItem[]>("get_startup_items");
      setStartupItems(items);
    } catch (err) {
      console.error("Ошибка чтения автозагрузки:", err);
      setStartupError(String(err));
    } finally {
      setStartupLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "startup") {
      fetchStartupItems();
    } else if (activeTab === "storage") {
      invoke<string[]>("get_available_drives")
        .then((drives) => {
          if (drives && drives.length > 0) {
            setAvailableDrives(drives);
            setSelectedDriveOrPath((prev) => (prev ? prev : drives[0]));
          }
        })
        .catch((err) => console.error("Ошибка получения списка дисков:", err));
    } else if (activeTab === "cleanup" && cleanupCategories.length === 0) {
      handleScanCleanup();
    }
  }, [activeTab]);

  // Секундомер ожидания во время многопоточного сканирования диска
  useEffect(() => {
    if (!isScanning) {
      setScanElapsedSec(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setScanElapsedSec((Date.now() - start) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, [isScanning]);

  const handleStartStorageScan = async (targetPathOverride?: string) => {
    const pathToScan = (targetPathOverride ?? selectedDriveOrPath).trim();
    if (!pathToScan || isScanning) return;

    setIsScanning(true);
    setScanError(null);
    try {
      const res = await invoke<ScanResult>("scan_storage", { path: pathToScan });
      setScanResult(res);
      setTreemapStack([res.root_node]);
      setSelectedTreemapNode(res.root_node.children[0] ?? res.root_node);
    } catch (err) {
      console.error("Ошибка сканирования диска:", err);
      setScanError(String(err));
    } finally {
      setIsScanning(false);
    }
  };

  const handleOpenPathInExplorer = async (path: string) => {
    try {
      await invoke("open_item_location", { path });
    } catch (err) {
      console.error("Ошибка открытия пути в проводнике:", err);
      setScanError(String(err));
    }
  };

  const handleToggleStartup = async (item: StartupItem) => {
    const nextEnabled = !item.enabled;
    setStartupError(null);

    setStartupItems((prev) =>
      prev.map((entry) =>
        entry.id === item.id ? { ...entry, enabled: nextEnabled } : entry
      )
    );

    try {
      await invoke("toggle_startup_item", {
        id: item.id,
        enable: nextEnabled,
      });
    } catch (err) {
      console.error("Ошибка переключения автозагрузки:", err);
      setStartupError(String(err));
      setStartupItems((prev) =>
        prev.map((entry) =>
          entry.id === item.id ? { ...entry, enabled: item.enabled } : entry
        )
      );
    }
  };

  const handleOpenItemLocation = async (item: StartupItem) => {
    setStartupError(null);
    try {
      await invoke("open_item_location", {
        path: item.clean_path || item.command,
      });
    } catch (err) {
      console.error("Ошибка открытия папки:", err);
      setStartupError(String(err));
    }
  };

  // Живой обратный отсчет таймера (работает независимо от выбранной вкладки Sidebar)
  useEffect(() => {
    if (!timerState) {
      setRemainingSeconds(0);
      return;
    }

    const updateRemaining = () => {
      const diff = Math.ceil((timerState.endTime - Date.now()) / 1000);
      if (diff <= 0) {
        setRemainingSeconds(0);
        setTimerState(null);
        localStorage.removeItem(TIMER_STORAGE_KEY);
      } else {
        setRemainingSeconds(diff);
      }
    };

    updateRemaining();
    const interval = setInterval(updateRemaining, 1000);
    return () => clearInterval(interval);
  }, [timerState]);

  const handleStartTimer = async (minutes: number) => {
    setPowerError(null);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setPowerError("Введите корректное время в минутах (больше 0)");
      return;
    }

    const seconds = Math.round(minutes * 60);
    try {
      await invoke("schedule_shutdown", {
        seconds,
        restart: restartMode,
      });

      const newState: StoredTimerState = {
        endTime: Date.now() + seconds * 1000,
        totalSeconds: seconds,
        restart: restartMode,
      };
      setTimerState(newState);
      setRemainingSeconds(seconds);
      localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(newState));
    } catch (err) {
      console.error("Ошибка при запуске таймера:", err);
      setPowerError(String(err));
    }
  };

  const handleCancelTimer = async () => {
    setPowerError(null);
    try {
      await invoke("cancel_shutdown");
    } catch (err) {
      console.error("Ошибка при отмене таймера:", err);
      setPowerError(String(err));
    } finally {
      setTimerState(null);
      setRemainingSeconds(0);
      localStorage.removeItem(TIMER_STORAGE_KEY);
    }
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const mins = parseFloat(customMinutes);
    if (!isNaN(mins) && mins > 0) {
      handleStartTimer(mins);
      setCustomMinutes("");
    } else {
      setPowerError("Укажите положительное количество минут");
    }
  };

  const timerProgress =
    timerState && timerState.totalSeconds > 0
      ? Math.min(100, Math.max(0, (remainingSeconds / timerState.totalSeconds) * 100))
      : 0;

  const swapPercentage =
    metrics.swap_total_gb > 0
      ? Math.min(100, (metrics.swap_used_gb / metrics.swap_total_gb) * 100)
      : 0;

  const diskUsedPercentage =
    metrics.disk_total_gb > 0
      ? Math.min(
          100,
          ((metrics.disk_total_gb - metrics.disk_free_gb) / metrics.disk_total_gb) * 100
        )
      : 0;

  const isNetworkActive = metrics.net_rx_kbps > 0.1 || metrics.net_tx_kbps > 0.1;
  const isGatewayOnline = metrics.net_ping_ms > 0 && metrics.net_ping_ms < 999;
  const pingStyle = getPingHudStyle(metrics.net_ping_ms);
  const rxParts = formatSpeedParts(metrics.net_rx_kbps);
  const txParts = formatSpeedParts(metrics.net_tx_kbps);
  const rxPulsePct =
    metrics.net_rx_kbps <= 0
      ? 0
      : Math.min(100, Math.max(8, Math.log10(metrics.net_rx_kbps + 1) * 25));
  const txPulsePct =
    metrics.net_tx_kbps <= 0
      ? 0
      : Math.min(100, Math.max(8, Math.log10(metrics.net_tx_kbps + 1) * 25));

  const cpuLoadStyles = getLoadBarStyles(metrics.cpu_usage, "emerald");
  const ramLoadStyles = getLoadBarStyles(metrics.ram_percentage, "cyan");
  const diskLoadStyles = getLoadBarStyles(diskUsedPercentage, "emerald");

  // Статистика и фильтрация автозагрузки
  const totalStartupCount = startupItems.length;
  const activeStartupCount = startupItems.filter((i) => i.enabled).length;
  const brokenStartupCount = startupItems.filter((i) => !i.file_exists).length;

  const filteredStartupItems = startupItems.filter((item) => {
    const q = startupSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      item.name.toLowerCase().includes(q) ||
      item.clean_path.toLowerCase().includes(q) ||
      item.location.toLowerCase().includes(q)
    );
  });

  // Данные текущего уровня Treemap и фильтрация ТОП-100 файлов
  const currentTreemapRoot =
    treemapStack.length > 0
      ? treemapStack[treemapStack.length - 1]
      : scanResult?.root_node ?? null;

  const treemapRects = currentTreemapRoot
    ? computeTreemapRects(currentTreemapRoot.children)
    : [];

  const filteredTopFiles = (scanResult?.top_files ?? []).filter((f) => {
    const q = fileSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      f.name.toLowerCase().includes(q) ||
      f.extension.toLowerCase().includes(q) ||
      f.path.toLowerCase().includes(q)
    );
  });

  // Проверка перегрева для блока предупреждений Hardware Monitor (> 85°C)
  const thermalWarnings: string[] = [];
  if (hwData) {
    if (hwData.cpu.package_temp_c !== null && hwData.cpu.package_temp_c > 85) {
      thermalWarnings.push(
        `Повышенный нагрев CPU Package: ${hwData.cpu.package_temp_c.toFixed(1)}°C`
      );
    }
    for (const g of hwData.gpus) {
      if (g.hotspot_temp_c !== null && g.hotspot_temp_c > 85) {
        thermalWarnings.push(
          `Повышенный нагрев GPU Hotspot (${g.name}): ${g.hotspot_temp_c.toFixed(1)}°C`
        );
      } else if (g.core_temp_c !== null && g.core_temp_c > 85) {
        thermalWarnings.push(
          `Повышенный нагрев GPU Core (${g.name}): ${g.core_temp_c.toFixed(1)}°C`
        );
      }
    }
  }

  const cpuTempStyle = getTempBadgeStyle(hwData?.cpu.package_temp_c);

  // Агрегированная статистика для Cleanup Center
  const totalCleanupBytes = cleanupCategories.reduce(
    (acc, cat) => acc + cat.size_bytes,
    0
  );
  const selectedCleanupCategories = cleanupCategories.filter((cat) =>
    selectedCleanupIds.includes(cat.id)
  );
  const selectedCleanupBytes = selectedCleanupCategories.reduce(
    (acc, cat) => acc + cat.size_bytes,
    0
  );
  const selectedCleanupFilesCount = selectedCleanupCategories.reduce(
    (acc, cat) => acc + cat.files_count,
    0
  );

  // Фильтрация и сортировка процессов (Process Explorer)
  const processQuery = processSearch.trim().toLowerCase();
  const visibleProcesses = processes
    .filter((p) => {
      if (!processQuery) return true;
      return (
        p.name.toLowerCase().includes(processQuery) ||
        p.pid.toString().includes(processQuery) ||
        p.exe_path.toLowerCase().includes(processQuery)
      );
    })
    .sort((a, b) => {
      let diff = 0;
      switch (processSortKey) {
        case "name":
          diff = a.name.localeCompare(b.name, "ru");
          break;
        case "cpu":
          diff = a.cpu_usage - b.cpu_usage;
          break;
        case "memory":
          diff = a.memory_mb - b.memory_mb;
          break;
        case "disk":
          diff =
            a.disk_read_bytes_sec + a.disk_write_bytes_sec -
            (b.disk_read_bytes_sec + b.disk_write_bytes_sec);
          break;
        case "runtime":
          diff = a.run_time_sec - b.run_time_sec;
          break;
      }
      if (diff === 0) diff = a.pid - b.pid;
      return processSortDesc ? -diff : diff;
    });

  const totalProcessCpu = Math.min(
    100,
    processes.reduce((acc, p) => acc + p.cpu_usage, 0)
  );
  const totalProcessMemoryGb = processes.reduce((acc, p) => acc + p.memory_mb, 0) / 1024;
  const menuProcessSuspended = processMenu
    ? suspendedPids.includes(processMenu.process.pid)
    : false;

  const renderSortHeader = (key: ProcessSortKey, label: string, alignRight = true) => {
    const isActive = processSortKey === key;
    return (
      <button
        type="button"
        onClick={() => handleProcessSort(key)}
        className={`flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.14em] transition-colors cursor-pointer ${
          alignRight ? "justify-end" : "justify-start"
        } ${isActive ? "text-emerald-300" : "text-zinc-500 hover:text-zinc-300"}`}
      >
        <span>{label}</span>
        {isActive ? (
          processSortDesc ? (
            <ChevronDown size={11} />
          ) : (
            <ChevronUp size={11} />
          )
        ) : (
          <span className="w-[11px]" />
        )}
      </button>
    );
  };

  return (
    <div className="relative flex flex-col h-screen w-screen bg-[#07080b] obsidian-grid-bg text-zinc-200 select-none overflow-hidden font-sans border border-white/[0.08]">
      {/* Точечное акцентное свечение Obsidian Cyber-HUD */}
      <div className="pointer-events-none absolute -top-40 left-40 h-96 w-96 rounded-full bg-emerald-500/[0.055] blur-[130px]" />
      <div className="pointer-events-none absolute bottom-0 right-10 h-96 w-96 rounded-full bg-cyan-500/[0.05] blur-[140px]" />

      {/* Кастомный безрамочный кибер-тайтлбар (36px) с поддержкой перетаскивания */}
      <header
        data-tauri-drag-region
        className="relative z-40 h-9 shrink-0 bg-[#050609]/95 border-b border-white/[0.07] flex items-center justify-between pl-3 pr-1"
      >
        {/* Левая зона перетаскивания: бренд и статус сессии */}
        <div
          data-tauri-drag-region
          onMouseDown={(e) => {
            if (e.button === 0 && e.detail === 1) {
              getCurrentWindow().startDragging().catch(() => {});
            }
          }}
          onDoubleClick={() => {
            handleWindowToggleMaximize();
          }}
          className="flex items-center gap-2.5 flex-1 h-full cursor-default"
        >
          <div className="pointer-events-none h-5 w-5 rounded bg-emerald-500/20 border border-emerald-400/50 flex items-center justify-center text-emerald-400 font-mono font-extrabold text-[11px] shadow-[0_0_10px_rgba(52,211,153,0.3)]">
            N
          </div>
          <span className="pointer-events-none font-mono font-bold text-[11px] tracking-[0.16em] text-zinc-200">
            NEXUS PC
          </span>
          <span className="pointer-events-none hidden sm:inline-block text-[10px] font-mono text-zinc-500">
            // OBSIDIAN CYBER-HUD v0.1
          </span>
          {adminError && (
            <span className="pointer-events-none text-[10px] font-mono text-rose-400 truncate max-w-xs ml-2">
              {adminError}
            </span>
          )}
        </div>

        {/* Правая зона: индикатор привилегий (ADMIN / USER), меню рестарта и кнопки окна */}
        <div className="flex items-center gap-1.5 h-full">
          {!isElevatedAdmin && (
            <button
              type="button"
              onClick={handleRestartAsAdmin}
              title="Перезапустить NEXUS PC с правами Администратора (UAC)"
              className="hidden md:inline-flex items-center gap-1.5 px-2 py-1 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-mono transition-colors cursor-pointer"
            >
              <ShieldAlert size={11} />
              <span>Перезапустить от имени администратора</span>
            </button>
          )}

          {/* Выпадающее меню статуса прав (ADMIN зелёный / USER серый) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setAdminMenuOpen((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-mono font-bold tracking-wider border transition-colors cursor-pointer ${
                isElevatedAdmin
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40 shadow-[0_0_12px_rgba(52,211,153,0.2)]"
                  : "bg-zinc-800/80 text-zinc-400 hover:text-zinc-200 border-white/[0.1]"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  isElevatedAdmin
                    ? "bg-emerald-400 shadow-[0_0_6px_#34d399]"
                    : "bg-zinc-500"
                }`}
              />
              <span>{isElevatedAdmin ? "ADMIN" : "USER"}</span>
              <ChevronDown size={11} />
            </button>

            <AnimatePresence>
              {adminMenuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 4, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.96 }}
                  transition={{ duration: 0.14 }}
                  className="absolute right-0 top-7 w-72 rounded-xl backdrop-blur-2xl bg-[#0b0d14]/95 border border-white/[0.12] shadow-[0_14px_38px_rgba(0,0,0,0.8)] p-2.5 z-50 space-y-2 font-mono text-xs"
                >
                  <div className="px-2 py-1.5 rounded-lg bg-[#07080c] border border-white/[0.06]">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                      ПРИВИЛЕГИИ ПРОЦЕССА
                    </div>
                    <div
                      className={`text-xs font-bold mt-0.5 ${
                        isElevatedAdmin ? "text-emerald-400" : "text-zinc-300"
                      }`}
                    >
                      {isElevatedAdmin
                        ? "Администратор (Полный доступ Ring0)"
                        : "Стандартный пользователь (USER)"}
                    </div>
                  </div>

                  {!isElevatedAdmin && (
                    <button
                      type="button"
                      onClick={handleRestartAsAdmin}
                      className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/35 text-left text-[11px] font-semibold transition-colors cursor-pointer"
                    >
                      <ShieldCheck size={14} className="shrink-0" />
                      <span>Перезапустить от имени администратора</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleWindowClose}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-rose-500/15 text-zinc-400 hover:text-rose-300 text-left text-[11px] transition-colors cursor-pointer"
                  >
                    <XCircle size={13} className="shrink-0" />
                    <span>Завершить работу NEXUS PC</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="h-3.5 w-px bg-white/[0.08] mx-0.5" />

          {/* Кнопки управления окном (Свернуть, Развернуть, Закрыть) */}
          <button
            type="button"
            onClick={handleWindowMinimize}
            title="Свернуть"
            className="h-7 w-8 inline-flex items-center justify-center rounded hover:bg-white/[0.08] text-zinc-400 hover:text-zinc-100 transition-colors cursor-pointer"
          >
            <Minus size={13} />
          </button>

          <button
            type="button"
            onClick={handleWindowToggleMaximize}
            title="Развернуть / Оконный режим"
            className="h-7 w-8 inline-flex items-center justify-center rounded hover:bg-white/[0.08] text-zinc-400 hover:text-zinc-100 transition-colors cursor-pointer"
          >
            <Square size={11} />
          </button>

          <button
            type="button"
            onClick={handleWindowClose}
            title="Закрыть NEXUS PC"
            className="h-7 w-8 inline-flex items-center justify-center rounded hover:bg-rose-500/80 text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {/* Рабочая область под кастомным тайтлбаром */}
      <div className="relative z-10 flex flex-1 min-h-0 overflow-hidden">
      {/* Компактная строгая боковая панель Obsidian Cyber-HUD */}
      <aside className="relative z-20 w-60 shrink-0 backdrop-blur-2xl bg-[#090b10]/95 border-r border-white/[0.07] flex flex-col justify-between p-3.5">
        <div>
          <div className="flex items-center justify-between px-2.5 py-3 mb-5 border-b border-white/[0.07]">
            <div className="flex items-center gap-2.5">
              <div className="relative h-8 w-8 rounded-lg bg-emerald-500/15 border border-emerald-400/40 flex items-center justify-center text-emerald-400 font-mono font-extrabold text-base shadow-[0_0_18px_rgba(52,211,153,0.25)]">
                N
                <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 bg-emerald-400 rounded-full shadow-[0_0_6px_#34d399]" />
              </div>
              <div>
                <h1 className="font-mono font-bold text-sm tracking-[0.14em] text-zinc-100">
                  NEXUS // HUD
                </h1>
                <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider">
                  SYS.VER 0.1 • OBSIDIAN
                </p>
              </div>
            </div>
          </div>

          <div className="px-2 mb-2 text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">
            МОДУЛИ СИСТЕМЫ
          </div>

          <nav className="space-y-1.5">
            {/* 1. Кнопка вкладки Dashboard */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("dashboard")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                activeTab === "dashboard"
                  ? "text-emerald-300 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "dashboard" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-emerald-500/20 via-emerald-500/[0.07] to-transparent border border-emerald-500/30 shadow-[0_0_18px_rgba(52,211,153,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <LayoutDashboard size={15} />
                <span>ТЕЛЕМЕТРИЯ</span>
              </span>
              <span className="relative z-10 text-[10px] text-zinc-500">01</span>
            </motion.button>

            {/* 2. Кнопка вкладки Startup Manager */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("startup")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                activeTab === "startup"
                  ? "text-emerald-300 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "startup" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-emerald-500/20 via-emerald-500/[0.07] to-transparent border border-emerald-500/30 shadow-[0_0_18px_rgba(52,211,153,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Rocket size={15} />
                <span>АВТОЗАГРУЗКА</span>
              </span>
              {brokenStartupCount > 0 ? (
                <span className="relative z-10 text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/35">
                  !{brokenStartupCount}
                </span>
              ) : (
                <span className="relative z-10 text-[10px] text-zinc-500">02</span>
              )}
            </motion.button>

            {/* 3. Кнопка вкладки Storage Analyzer */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("storage")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                activeTab === "storage"
                  ? "text-emerald-300 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "storage" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-emerald-500/20 via-emerald-500/[0.07] to-transparent border border-emerald-500/30 shadow-[0_0_18px_rgba(52,211,153,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <PieChart size={15} />
                <span>ДИСКОВЫЙ РАДАР</span>
              </span>
              {isScanning ? (
                <Loader2
                  size={13}
                  className="relative z-10 animate-spin text-emerald-400"
                />
              ) : (
                <span className="relative z-10 text-[10px] text-zinc-500">03</span>
              )}
            </motion.button>

            {/* 4. Кнопка вкладки Hardware Monitor («Железо») */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("hardware")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                activeTab === "hardware"
                  ? "text-emerald-300 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "hardware" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-emerald-500/20 via-emerald-500/[0.07] to-transparent border border-emerald-500/30 shadow-[0_0_18px_rgba(52,211,153,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Gauge size={15} />
                <span>ДАТЧИКИ ЖЕЛЕЗА</span>
              </span>
              {thermalWarnings.length > 0 ? (
                <span className="relative z-10 h-2 w-2 rounded-full bg-rose-500 shadow-[0_0_8px_#f43f5e] animate-ping" />
              ) : (
                <span className="relative z-10 text-[10px] text-zinc-500">04</span>
              )}
            </motion.button>

            {/* 5. Кнопка вкладки Cleanup Center («Очистка») */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("cleanup")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                activeTab === "cleanup"
                  ? "text-emerald-300 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "cleanup" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-emerald-500/20 via-emerald-500/[0.07] to-transparent border border-emerald-500/30 shadow-[0_0_18px_rgba(52,211,153,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Trash2 size={15} />
                <span>ОЧИСТКА</span>
              </span>
              {isScanningCleanup || isCleaning ? (
                <Loader2
                  size={13}
                  className="relative z-10 animate-spin text-emerald-400"
                />
              ) : (
                <span className="relative z-10 text-[10px] text-zinc-500">05</span>
              )}
            </motion.button>

            {/* 6. Кнопка вкладки Power Manager */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("power")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                activeTab === "power"
                  ? "text-emerald-300 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "power" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-emerald-500/20 via-emerald-500/[0.07] to-transparent border border-emerald-500/30 shadow-[0_0_18px_rgba(52,211,153,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Power size={15} />
                <span>ПИТАНИЕ // ТАЙМЕР</span>
              </span>
              {timerState && remainingSeconds > 0 ? (
                <span className="relative z-10 text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/35">
                  {formatCountdown(remainingSeconds)}
                </span>
              ) : (
                <span className="relative z-10 text-[10px] text-zinc-500">06</span>
              )}
            </motion.button>

            {/* 7. Кнопка вкладки Process Explorer («Процессы») */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("processes")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                activeTab === "processes"
                  ? "text-emerald-300 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "processes" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-emerald-500/20 via-emerald-500/[0.07] to-transparent border border-emerald-500/30 shadow-[0_0_18px_rgba(52,211,153,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Layers size={15} />
                <span>ПРОЦЕССЫ</span>
              </span>
              {suspendedPids.length > 0 ? (
                <span className="relative z-10 text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/35">
                  ❄{suspendedPids.length}
                </span>
              ) : (
                <span className="relative z-10 text-[10px] text-zinc-500">07</span>
              )}
            </motion.button>
          </nav>
        </div>

        {/* Нижний приборный блок статуса ядра и пинга */}
        <div className="space-y-2">
          <div className="px-3 py-2 rounded-lg bg-[#0d1017] border border-white/[0.06] flex items-center justify-between text-[11px] font-mono">
            <span className="text-zinc-500">PING:</span>
            <span className={`font-bold tabular-nums ${pingStyle.colorClass}`}>
              {metrics.net_ping_ms > 0 ? `${metrics.net_ping_ms} MS` : "OFFLINE"}
            </span>
          </div>

          <div className="px-3 py-2.5 rounded-lg bg-[#0d1017] border border-white/[0.06] text-[11px] text-zinc-400 flex justify-between items-center font-mono">
            <span className="text-zinc-500">ЯДРО:</span>
            <span className="text-emerald-400 flex items-center gap-2 drop-shadow-[0_0_8px_rgba(52,211,153,0.45)]">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400 shadow-[0_0_8px_#34d399]"></span>
              </span>
              SYS + HWMON
            </span>
          </div>
        </div>
      </aside>

      {/* Основной экран с упругим быстрым переходом */}
      <main className="relative z-10 flex-1 min-w-0 flex flex-col overflow-y-auto p-6 lg:p-7">
        <AnimatePresence mode="wait">
          {activeTab === "dashboard" && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="space-y-5 max-w-6xl w-full"
            >
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 border-b border-white/[0.06] pb-3.5">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-400/90 mb-0.5">
                    OBSIDIAN CYBER-HUD // REALTIME TELEMETRY
                  </div>
                  <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">
                    Приборная панель системы
                  </h2>
                </div>
                <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-400">
                  <span className="px-2.5 py-1 rounded bg-[#0d1017] border border-white/[0.07] tabular-nums">
                    ОПРОС: <strong className="text-emerald-400">1000 MS</strong>
                  </span>
                  <span className="px-2.5 py-1 rounded bg-[#0d1017] border border-white/[0.07] tabular-nums">
                    ШЛЮЗ:{" "}
                    <strong className={isGatewayOnline ? "text-emerald-400" : "text-rose-400"}>
                      {isGatewayOnline ? "ONLINE" : "TIMEOUT"}
                    </strong>
                  </span>
                </div>
              </div>

              {/* Верхний ряд: 3 главных системных прибора (CPU, RAM+Swap, Накопитель) */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 md:grid-cols-3 gap-4"
              >
                {/* 1. CPU HUD Module */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(52, 211, 153, 0.14)"
                  accentColor="emerald"
                  className="min-w-0 p-5"
                >
                  <div>
                    <div className="flex items-center justify-between mb-3 gap-2">
                      <div>
                        <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-zinc-500 block">
                          SYS.MOD // 01
                        </span>
                        <span className="text-sm font-semibold text-zinc-200">
                          Центральный процессор
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25">
                        <Cpu size={16} className={cpuLoadStyles.badgeTextClass} />
                      </div>
                    </div>

                    <div className="flex items-baseline gap-2 my-3">
                      <span className="text-3xl sm:text-4xl font-extrabold font-mono tabular-nums text-zinc-100 tracking-tight">
                        {metrics.cpu_usage.toFixed(1)}
                      </span>
                      <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        % LOAD
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <SegmentedHudBar
                      percentage={metrics.cpu_usage}
                      segments={20}
                      theme="emerald"
                    />
                    <div className="flex items-center justify-between text-[11px] text-zinc-500 font-mono pt-1 border-t border-white/[0.05]">
                      <span>СТАТУС ЯДРА</span>
                      <span className={`font-bold ${cpuLoadStyles.badgeTextClass}`}>
                        {metrics.cpu_usage > 90
                          ? "CRITICAL LOAD"
                          : metrics.cpu_usage > 70
                          ? "HIGH LOAD"
                          : "NOMINAL"}
                      </span>
                    </div>
                  </div>
                </SpotlightCard>

                {/* 2. RAM + Swap HUD Module */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(34, 211, 238, 0.14)"
                  accentColor="cyan"
                  className="min-w-0 p-5"
                >
                  <div>
                    <div className="flex items-center justify-between mb-3 gap-2">
                      <div>
                        <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-zinc-500 block">
                          SYS.MOD // 02
                        </span>
                        <span className="text-sm font-semibold text-zinc-200">
                          Оперативная память
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/25">
                        <Activity size={16} className={ramLoadStyles.badgeTextClass} />
                      </div>
                    </div>

                    <div className="flex items-baseline justify-between gap-2 my-3">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-3xl sm:text-4xl font-extrabold font-mono tabular-nums text-zinc-100 tracking-tight">
                          {metrics.ram_used_gb.toFixed(1)}
                        </span>
                        <span className="text-sm font-mono text-zinc-500 tabular-nums">
                          / {metrics.ram_total_gb.toFixed(0)}
                        </span>
                        <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                          GB
                        </span>
                      </div>
                      <span className={`text-xs font-mono font-bold tabular-nums ${ramLoadStyles.badgeTextClass}`}>
                        {metrics.ram_percentage.toFixed(0)}%
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <SegmentedHudBar
                      percentage={metrics.ram_percentage}
                      segments={20}
                      theme="cyan"
                    />
                    <div className="flex items-center justify-between text-[11px] font-mono pt-1 border-t border-white/[0.05]">
                      <span className="text-zinc-500">SWAP БУФЕР:</span>
                      <span className="text-zinc-300 tabular-nums">
                        {metrics.swap_used_gb.toFixed(1)} / {metrics.swap_total_gb.toFixed(1)}{" "}
                        <span className="text-cyan-400">GB</span> ({swapPercentage.toFixed(0)}%)
                      </span>
                    </div>
                  </div>
                </SpotlightCard>

                {/* 3. Primary Storage HUD Module */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(52, 211, 153, 0.14)"
                  accentColor="emerald"
                  className="min-w-0 p-5"
                >
                  <div>
                    <div className="flex items-center justify-between mb-3 gap-2">
                      <div>
                        <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-zinc-500 block">
                          SYS.MOD // 03
                        </span>
                        <span className="text-sm font-semibold text-zinc-200">
                          Системный накопитель
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25">
                        <HardDrive size={16} className={diskLoadStyles.badgeTextClass} />
                      </div>
                    </div>

                    <div className="flex items-baseline justify-between gap-2 my-3">
                      <div className="flex items-baseline gap-2">
                        <span className="text-3xl sm:text-4xl font-extrabold font-mono tabular-nums text-zinc-100 tracking-tight">
                          {metrics.disk_free_gb}
                        </span>
                        <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                          GB FREE
                        </span>
                      </div>
                      <span className="text-xs font-mono text-zinc-400 tabular-nums">
                        {diskUsedPercentage.toFixed(0)}% ИСП.
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <SegmentedHudBar
                      percentage={diskUsedPercentage}
                      segments={20}
                      theme="emerald"
                    />
                    <div className="flex items-center justify-between text-[11px] text-zinc-500 font-mono pt-1 border-t border-white/[0.05]">
                      <span>ОБЩИЙ ОБЪЕМ</span>
                      <span className="text-zinc-300 tabular-nums">
                        {metrics.disk_total_gb} <span className="text-emerald-400">GB</span>
                      </span>
                    </div>
                  </div>
                </SpotlightCard>
              </motion.div>

              {/* Второй ряд: Полноценная тройная панель сетевой телеметрии (Network HUD) */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
              >
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(34, 211, 238, 0.12)"
                  accentColor="cyan"
                  className="p-5 sm:p-6"
                >
                  <div className="space-y-4">
                    {/* Шапка Network HUD со шлюзом и общим статусом подключения */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 border-b border-white/[0.06]">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.18)]">
                          <Wifi size={18} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-cyan-400">
                              NET.HUD // TRIPLE TELEMETRY
                            </span>
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.05] text-zinc-400">
                              TCP 1.1.1.1:53
                            </span>
                          </div>
                          <h3 className="text-base font-bold text-zinc-100 tracking-tight">
                            Сетевой контур и задержка канала (Network HUD)
                          </h3>
                        </div>
                      </div>

                      <div className="flex items-center gap-2.5 self-start sm:self-auto font-mono text-xs">
                        <div className="px-3 py-1.5 rounded-lg bg-[#07090d] border border-white/[0.07] flex items-center gap-2">
                          <span
                            className={`h-2 w-2 rounded-full ${
                              isNetworkActive
                                ? "bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse"
                                : isGatewayOnline
                                ? "bg-cyan-400"
                                : "bg-zinc-600"
                            }`}
                          />
                          <span className="text-zinc-400">КАНАЛ:</span>
                          <span
                            className={
                              isNetworkActive
                                ? "text-emerald-400 font-bold"
                                : isGatewayOnline
                                ? "text-cyan-300 font-semibold"
                                : "text-zinc-500"
                            }
                          >
                            {isNetworkActive
                              ? "АКТИВНЫЙ ТРАФИК"
                              : isGatewayOnline
                              ? " В СЕТИ (STANDBY)"
                              : "НЕТ ОТВЕТА"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Тройная приборная сетка: 1. PING, 2. DOWNLOAD, 3. UPLOAD */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {/* 1. PING (Задержка шлюза в мс) */}
                      <div className="relative p-4 rounded-xl bg-[#07090e]/90 border border-white/[0.07] flex flex-col justify-between space-y-3 hud-dot-matrix">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider text-zinc-400">
                            <Radio size={14} className={pingStyle.colorClass} />
                            1. PING / ЗАДЕРЖКА
                          </span>
                          <span
                            className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${pingStyle.badgeClass}`}
                          >
                            {pingStyle.statusLabel}
                          </span>
                        </div>

                        <div className="flex items-baseline gap-2">
                          <span
                            className={`text-3xl sm:text-4xl font-extrabold font-mono tabular-nums tracking-tight ${pingStyle.colorClass}`}
                          >
                            {pingStyle.valueText}
                          </span>
                          <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-white/[0.06] text-zinc-300 border border-white/[0.08]">
                            MS
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          <div className="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden border border-white/[0.05]">
                            <div
                              style={{ width: `${pingStyle.barPercent}%` }}
                              className={`h-full rounded-full transition-all duration-500 ${
                                metrics.net_ping_ms === 0 || metrics.net_ping_ms >= 999
                                  ? "bg-zinc-700"
                                  : metrics.net_ping_ms < 40
                                  ? "bg-gradient-to-r from-emerald-500 to-teal-400 shadow-[0_0_10px_#34d399]"
                                  : metrics.net_ping_ms <= 90
                                  ? "bg-gradient-to-r from-amber-500 to-yellow-400 shadow-[0_0_10px_#fbbf24]"
                                  : "bg-gradient-to-r from-rose-500 to-red-400 shadow-[0_0_10px_#f43f5e]"
                              }`}
                            />
                          </div>
                          <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                            <span>&lt;40ms Идеально</span>
                            <span>40-90ms Средне</span>
                            <span>&gt;90ms Пик</span>
                          </div>
                        </div>
                      </div>

                      {/* 2. DOWNLOAD (Входящий поток) */}
                      <div className="relative p-4 rounded-xl bg-[#07090e]/90 border border-white/[0.07] flex flex-col justify-between space-y-3 hud-dot-matrix">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider text-zinc-400">
                            <span className="p-1 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.3)]">
                              <ArrowDown size={13} />
                            </span>
                            2. DOWNLOAD / ПРИЕМ
                          </span>
                          <span className="text-[10px] font-mono text-emerald-400/90 uppercase">
                            RX STREAM
                          </span>
                        </div>

                        <div className="flex items-baseline gap-2">
                          <span className="text-3xl sm:text-4xl font-extrabold font-mono tabular-nums text-zinc-100 tracking-tight">
                            {rxParts.value}
                          </span>
                          <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                            {rxParts.unit}
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          <div className="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden border border-white/[0.05]">
                            <div
                              style={{ width: `${rxPulsePct}%` }}
                              className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.65)] transition-all duration-300"
                            />
                          </div>
                          <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                            <span>Входящий импульс</span>
                            <span className="text-emerald-400 tabular-nums">
                              {metrics.net_rx_kbps.toFixed(1)} KB/S
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* 3. UPLOAD (Исходящий поток) */}
                      <div className="relative p-4 rounded-xl bg-[#07090e]/90 border border-white/[0.07] flex flex-col justify-between space-y-3 hud-dot-matrix">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider text-zinc-400">
                            <span className="p-1 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.3)]">
                              <ArrowUp size={13} />
                            </span>
                            3. UPLOAD / ОТДАЧА
                          </span>
                          <span className="text-[10px] font-mono text-cyan-400/90 uppercase">
                            TX STREAM
                          </span>
                        </div>

                        <div className="flex items-baseline gap-2">
                          <span className="text-3xl sm:text-4xl font-extrabold font-mono tabular-nums text-zinc-100 tracking-tight">
                            {txParts.value}
                          </span>
                          <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                            {txParts.unit}
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          <div className="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden border border-white/[0.05]">
                            <div
                              style={{ width: `${txPulsePct}%` }}
                              className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-sky-400 to-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.65)] transition-all duration-300"
                            />
                          </div>
                          <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                            <span>Исходящий импульс</span>
                            <span className="text-cyan-400 tabular-nums">
                              {metrics.net_tx_kbps.toFixed(1)} KB/S
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </SpotlightCard>
              </motion.div>

              {/* Третий ряд: 60-секундный живой неоновый график */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
              >
                <LoadHistoryChart history={history} />
              </motion.div>
            </motion.div>
          )}

          {activeTab === "startup" && (
            <motion.div
              key="startup"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="space-y-6 max-w-6xl w-full"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">
                    Менеджер автозагрузки
                  </h2>
                  <p className="text-xs sm:text-sm text-zinc-400 font-mono mt-1">
                    Всего записей:{" "}
                    <span className="text-zinc-200 font-semibold">{totalStartupCount}</span> •
                    Активных:{" "}
                    <span className="text-emerald-400 font-semibold">
                      {activeStartupCount}
                    </span>{" "}
                    • Обнаружено битых путей:{" "}
                    <span
                      className={
                        brokenStartupCount > 0
                          ? "text-rose-400 font-semibold"
                          : "text-zinc-400 font-semibold"
                      }
                    >
                      {brokenStartupCount}
                    </span>
                  </p>
                </div>

                <motion.button
                  type="button"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.96 }}
                  onClick={fetchStartupItems}
                  disabled={startupLoading}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl backdrop-blur-xl bg-zinc-900/70 hover:bg-zinc-800/80 border border-white/[0.08] text-xs font-mono text-zinc-300 transition-colors cursor-pointer self-start sm:self-auto"
                >
                  <RefreshCw
                    size={14}
                    className={
                      startupLoading ? "animate-spin text-emerald-400" : "text-emerald-400"
                    }
                  />
                  <span>Обновить</span>
                </motion.button>
              </div>

              <div className="relative">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500"
                />
                <input
                  type="text"
                  value={startupSearch}
                  onChange={(e) => setStartupSearch(e.target.value)}
                  placeholder="Поиск по названию программы, пути или расположению (HKCU, HKLM, Папка)..."
                  className="w-full pl-11 pr-4 py-3 rounded-2xl backdrop-blur-xl bg-zinc-900/60 border border-white/[0.07] text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/40 focus:shadow-[0_0_20px_rgba(52,211,153,0.1)] transition-all"
                />
              </div>

              <AnimatePresence>
                {startupError && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-mono"
                  >
                    {startupError}
                  </motion.div>
                )}
              </AnimatePresence>

              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
                className="space-y-3"
              >
                {filteredStartupItems.length === 0 ? (
                  <SpotlightCard className="p-8 text-center">
                    <p className="text-sm text-zinc-400 font-mono">
                      {startupLoading
                        ? "Сканирование реестра и папок автозагрузки..."
                        : "Записи автозагрузки не найдены"}
                    </p>
                  </SpotlightCard>
                ) : (
                  filteredStartupItems.map((item) => (
                    <SpotlightCard
                      key={item.id}
                      variants={cardItemVariants}
                      spotlightColor={
                        !item.file_exists
                          ? "rgba(244, 63, 94, 0.14)"
                          : item.enabled
                          ? "rgba(52, 211, 153, 0.12)"
                          : "rgba(161, 161, 170, 0.08)"
                      }
                      className="p-4 sm:p-5"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="flex items-start gap-3.5 min-w-0 flex-1">
                          <div
                            className={`mt-0.5 p-2.5 rounded-xl border shrink-0 ${
                              !item.file_exists
                                ? "bg-rose-500/10 border-rose-500/30 text-rose-400"
                                : item.enabled
                                ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-400"
                                : "bg-zinc-800/70 border-white/[0.06] text-zinc-500"
                            }`}
                          >
                            {!item.file_exists ? (
                              <AlertTriangle size={18} />
                            ) : (
                              <AppWindow size={18} />
                            )}
                          </div>

                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`font-semibold text-sm sm:text-base truncate ${
                                  item.enabled ? "text-zinc-100" : "text-zinc-400"
                                }`}
                              >
                                {item.name}
                              </span>

                              <span
                                className={`text-[11px] font-mono px-2 py-0.5 rounded-md border ${getLocationBadgeStyles(
                                  item.location
                                )}`}
                              >
                                {item.location}
                              </span>

                              {!item.file_exists && (
                                <span className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-md bg-rose-500/15 text-rose-400 border border-rose-500/35 shadow-[0_0_12px_rgba(244,63,94,0.2)]">
                                  ⚠️ Битая запись (файл не найден)
                                </span>
                              )}
                            </div>

                            <p
                              title={item.command}
                              className="text-xs font-mono text-zinc-500 truncate"
                            >
                              {item.clean_path || item.command}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center justify-end gap-3 shrink-0">
                          <motion.button
                            type="button"
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.94 }}
                            onClick={() => handleOpenItemLocation(item)}
                            title="Показать в проводнике"
                            className="p-2.5 rounded-xl bg-zinc-800/70 hover:bg-zinc-700/80 text-zinc-300 hover:text-emerald-400 border border-white/[0.06] hover:border-emerald-500/30 transition-colors cursor-pointer"
                          >
                            <FolderOpen size={16} />
                          </motion.button>

                          <button
                            type="button"
                            role="switch"
                            aria-checked={item.enabled}
                            onClick={() => handleToggleStartup(item)}
                            className={`relative inline-flex h-7 w-13 shrink-0 items-center rounded-full p-1 transition-colors duration-200 cursor-pointer border ${
                              item.enabled
                                ? "bg-emerald-500/25 border-emerald-500/40 shadow-[0_0_14px_rgba(52,211,153,0.25)] justify-end"
                                : "bg-zinc-900/90 border-white/[0.08] justify-start"
                            }`}
                          >
                            <motion.span
                              layout
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 32,
                              }}
                              className={`h-5 w-5 rounded-full ${
                                item.enabled
                                  ? "bg-emerald-400 shadow-[0_0_10px_#34d399]"
                                  : "bg-zinc-500"
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    </SpotlightCard>
                  ))
                )}
              </motion.div>
            </motion.div>
          )}

          {activeTab === "storage" && (
            <motion.div
              key="storage"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="space-y-6 max-w-6xl w-full"
            >
              <div>
                <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">
                  Анализатор накопителей (Storage Analyzer)
                </h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Многопоточное сканирование дисков, карта занятого пространства (Treemap) и ТОП-100 тяжелых файлов
                </p>
              </div>

              <SpotlightCard
                spotlightColor="rgba(52, 211, 153, 0.12)"
                className="p-5 sm:p-6"
              >
                <div className="space-y-4">
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-mono uppercase tracking-wider text-zinc-400 mr-1">
                        Диски:
                      </span>
                      {availableDrives.map((drive) => {
                        const isSelected =
                          selectedDriveOrPath.toUpperCase() === drive.toUpperCase();
                        return (
                          <motion.button
                            key={drive}
                            type="button"
                            whileHover={{ y: -1 }}
                            whileTap={{ scale: 0.96 }}
                            onClick={() => setSelectedDriveOrPath(drive)}
                            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-mono font-semibold transition-all cursor-pointer border ${
                              isSelected
                                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shadow-[0_0_16px_rgba(52,211,153,0.2)]"
                                : "bg-zinc-900/80 text-zinc-300 border-white/[0.07] hover:border-white/15"
                            }`}
                          >
                            <HardDrive size={14} className="text-emerald-400" />
                            <span>{drive}</span>
                          </motion.button>
                        );
                      })}
                    </div>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 flex-1 lg:max-w-xl">
                      <input
                        type="text"
                        value={selectedDriveOrPath}
                        onChange={(e) => setSelectedDriveOrPath(e.target.value)}
                        placeholder="Укажите диск или путь (например C:\ или C:\Users)"
                        className="flex-1 px-4 py-2.5 rounded-xl bg-zinc-950/85 border border-white/[0.08] text-xs sm:text-sm font-mono text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50 transition-all"
                      />
                      <motion.button
                        type="button"
                        whileHover={{ scale: isScanning ? 1 : 1.02 }}
                        whileTap={{ scale: isScanning ? 1 : 0.97 }}
                        disabled={isScanning}
                        onClick={() => handleStartStorageScan()}
                        className={`inline-flex items-center justify-center gap-2.5 px-5 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer border shrink-0 ${
                          isScanning
                            ? "bg-emerald-500/10 text-emerald-300/80 border-emerald-500/25 cursor-wait"
                            : "bg-gradient-to-r from-emerald-500/25 to-teal-500/25 hover:from-emerald-500/35 hover:to-teal-500/35 text-emerald-300 border-emerald-500/40 shadow-[0_0_24px_rgba(52,211,153,0.18)]"
                        }`}
                      >
                        {isScanning ? (
                          <>
                            <Loader2 size={16} className="animate-spin text-emerald-400" />
                            <span>Сканирование...</span>
                          </>
                        ) : (
                          <>
                            <Play size={16} />
                            <span>Начать сканирование</span>
                          </>
                        )}
                      </motion.button>
                    </div>
                  </div>

                  <AnimatePresence>
                    {isScanning && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="pt-3 border-t border-white/[0.06] flex items-center justify-between text-xs font-mono text-emerald-400"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="relative flex h-2.5 w-2.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
                          </span>
                          <span>
                            Многопоточный обход{" "}
                            <strong className="text-zinc-100">{selectedDriveOrPath}</strong>{" "}
                            через jwalk...
                          </span>
                        </div>
                        <span className="px-2.5 py-1 rounded-lg bg-zinc-950/80 border border-white/[0.06] text-zinc-300">
                          Время: {scanElapsedSec.toFixed(1)} сек
                        </span>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <AnimatePresence>
                    {scanError && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-mono"
                      >
                        {scanError}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </SpotlightCard>

              {scanResult && (
                <motion.div
                  variants={cardsContainerVariants}
                  initial="hidden"
                  animate="show"
                  className="space-y-6"
                >
                  <SpotlightCard
                    variants={cardItemVariants}
                    spotlightColor="rgba(34, 211, 238, 0.12)"
                    className="p-5 sm:p-6"
                  >
                    <div className="space-y-5">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                          <span className="text-xs font-mono uppercase tracking-wider text-zinc-400">
                            Сводка сканирования • {scanResult.target_path}
                          </span>
                          <div className="flex flex-wrap items-baseline gap-4 mt-1">
                            <span className="text-2xl sm:text-3xl font-bold text-zinc-100 tracking-tight">
                              {formatBytes(scanResult.total_scanned_bytes)}
                            </span>
                            <span className="text-xs sm:text-sm font-mono text-zinc-400">
                              Проверено файлов:{" "}
                              <strong className="text-emerald-400">
                                {scanResult.total_files_count.toLocaleString("ru-RU")}
                              </strong>
                            </span>
                          </div>
                        </div>

                        <motion.button
                          type="button"
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.96 }}
                          onClick={() => handleOpenPathInExplorer(scanResult.target_path)}
                          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-800/80 hover:bg-zinc-700/80 text-xs font-mono text-zinc-200 border border-white/[0.07] cursor-pointer self-start sm:self-auto"
                        >
                          <FolderOpen size={14} className="text-emerald-400" />
                          <span>Открыть корень в Проводнике</span>
                        </motion.button>
                      </div>

                      <div className="space-y-3">
                        <div className="w-full h-3 rounded-full bg-zinc-950/90 border border-white/[0.06] overflow-hidden flex p-0.5 gap-0.5">
                          {scanResult.category_sizes.map(([catName, catBytes]) => {
                            const pct =
                              scanResult.total_scanned_bytes > 0
                                ? (catBytes / scanResult.total_scanned_bytes) * 100
                                : 0;
                            if (pct < 0.4) return null;
                            const st = getCategoryStyle(catName);
                            return (
                              <div
                                key={catName}
                                title={`${catName}: ${formatBytes(catBytes)} (${pct.toFixed(1)}%)`}
                                style={{ width: `${pct}%` }}
                                className={`h-full first:rounded-l-full last:rounded-r-full transition-all duration-500 ${st.barClass}`}
                              />
                            );
                          })}
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 pt-1">
                          {scanResult.category_sizes.map(([catName, catBytes]) => {
                            const pct =
                              scanResult.total_scanned_bytes > 0
                                ? (catBytes / scanResult.total_scanned_bytes) * 100
                                : 0;
                            const st = getCategoryStyle(catName);
                            return (
                              <div
                                key={catName}
                                className="p-2.5 rounded-xl bg-zinc-950/60 border border-white/[0.05] flex flex-col justify-between"
                              >
                                <div className="flex items-center gap-2 text-xs text-zinc-400 truncate">
                                  <span
                                    className={`h-2 w-2 rounded-full shrink-0 ${st.dotClass}`}
                                  />
                                  <span className="truncate">{catName}</span>
                                </div>
                                <div className="mt-1.5 flex items-baseline justify-between gap-1 font-mono">
                                  <span className="text-xs font-bold text-zinc-100">
                                    {formatBytes(catBytes)}
                                  </span>
                                  <span className={`text-[10px] ${st.textClass}`}>
                                    {pct.toFixed(1)}%
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </SpotlightCard>

                  <SpotlightCard
                    variants={cardItemVariants}
                    spotlightColor="rgba(52, 211, 153, 0.1)"
                    className="p-5 sm:p-6"
                  >
                    <div className="space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div>
                          <h3 className="text-base font-semibold text-zinc-100">
                            Карта распределения папок (Treemap)
                          </h3>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono text-zinc-400 mt-1">
                            {treemapStack.map((node, idx) => (
                              <span key={node.path + idx} className="flex items-center gap-1">
                                {idx > 0 && <ChevronRight size={12} className="text-zinc-600" />}
                                <button
                                  type="button"
                                  onClick={() => {
                                    const nextStack = treemapStack.slice(0, idx + 1);
                                    setTreemapStack(nextStack);
                                    setSelectedTreemapNode(node);
                                  }}
                                  className={`hover:text-emerald-400 transition-colors cursor-pointer ${
                                    idx === treemapStack.length - 1
                                      ? "text-emerald-400 font-semibold"
                                      : "text-zinc-400"
                                  }`}
                                >
                                  {node.name || node.path}
                                </button>
                              </span>
                            ))}
                          </div>
                        </div>

                        {treemapStack.length > 1 && (
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.96 }}
                            onClick={() => {
                              const nextStack = treemapStack.slice(0, -1);
                              setTreemapStack(nextStack);
                              setSelectedTreemapNode(nextStack[nextStack.length - 1]);
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-800/80 hover:bg-zinc-700/80 text-xs font-mono text-zinc-200 border border-white/[0.08] cursor-pointer self-start sm:self-auto"
                          >
                            <CornerUpLeft size={13} className="text-emerald-400" />
                            <span>На уровень выше</span>
                          </motion.button>
                        )}
                      </div>

                      <div className="relative w-full h-80 rounded-2xl bg-[#080a0e] border border-white/[0.07] overflow-hidden p-1.5">
                        {treemapRects.length === 0 ? (
                          <div className="w-full h-full flex items-center justify-center text-xs font-mono text-zinc-500">
                            Нет вложенных подпапок для построения карты
                          </div>
                        ) : (
                          <div className="relative w-full h-full">
                            {treemapRects.map((rect) => {
                              const isSelected =
                                selectedTreemapNode?.path === rect.node.path;
                              const pctOfDisk =
                                scanResult.total_scanned_bytes > 0
                                  ? (rect.node.size_bytes /
                                      scanResult.total_scanned_bytes) *
                                    100
                                  : 0;
                              const paletteClass =
                                TREEMAP_PALETTE[rect.colorIndex] ?? TREEMAP_PALETTE[0];

                              return (
                                <div
                                  key={rect.node.path}
                                  style={{
                                    left: `${rect.x}%`,
                                    top: `${rect.y}%`,
                                    width: `${rect.w}%`,
                                    height: `${rect.h}%`,
                                  }}
                                  className="absolute p-1 transition-all duration-300"
                                >
                                  <button
                                    type="button"
                                    onClick={() => setSelectedTreemapNode(rect.node)}
                                    onDoubleClick={() => {
                                      if (rect.node.children.length > 0) {
                                        setTreemapStack((prev) => [...prev, rect.node]);
                                        setSelectedTreemapNode(
                                          rect.node.children[0] ?? rect.node
                                        );
                                      }
                                    }}
                                    title={`${rect.node.name} — ${formatBytes(
                                      rect.node.size_bytes
                                    )} (${pctOfDisk.toFixed(1)}%)`}
                                    className={`w-full h-full rounded-xl bg-gradient-to-br border p-2.5 flex flex-col justify-between text-left overflow-hidden transition-all cursor-pointer ${paletteClass} ${
                                      isSelected
                                        ? "ring-2 ring-emerald-400 shadow-[0_0_20px_rgba(52,211,153,0.3)]"
                                        : ""
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-1 min-w-0">
                                      <span className="font-semibold text-xs truncate">
                                        {rect.node.name}
                                      </span>
                                      {rect.node.children.length > 0 &&
                                        rect.w > 14 &&
                                        rect.h > 18 && (
                                          <Folder
                                            size={12}
                                            className="shrink-0 opacity-75"
                                          />
                                        )}
                                    </div>

                                    {rect.w > 10 && rect.h > 16 && (
                                      <div className="font-mono text-[11px] leading-tight truncate opacity-90">
                                        <div className="font-bold">
                                          {formatBytes(rect.node.size_bytes)}
                                        </div>
                                        {rect.h > 26 && (
                                          <div className="text-[10px] opacity-75">
                                            {pctOfDisk.toFixed(1)}% от диска
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {selectedTreemapNode && (
                        <div className="p-4 rounded-xl bg-zinc-950/85 border border-white/[0.08] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2.5">
                              <Folder size={16} className="text-emerald-400 shrink-0" />
                              <span className="font-bold text-sm text-zinc-100 truncate">
                                {selectedTreemapNode.name}
                              </span>
                              <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                {formatBytes(selectedTreemapNode.size_bytes)}
                              </span>
                              <span className="text-xs font-mono text-zinc-400">
                                (
                                {scanResult.total_scanned_bytes > 0
                                  ? (
                                      (selectedTreemapNode.size_bytes /
                                        scanResult.total_scanned_bytes) *
                                      100
                                    ).toFixed(1)
                                  : "0.0"}
                                % от просканированного объёма)
                              </span>
                            </div>
                            <p className="text-xs font-mono text-zinc-500 truncate">
                              {selectedTreemapNode.path}
                            </p>
                          </div>

                          <div className="flex items-center gap-2.5 shrink-0">
                            {selectedTreemapNode.children.length > 0 && (
                              <motion.button
                                type="button"
                                whileTap={{ scale: 0.96 }}
                                onClick={() => {
                                  setTreemapStack((prev) => [
                                    ...prev,
                                    selectedTreemapNode,
                                  ]);
                                  setSelectedTreemapNode(
                                    selectedTreemapNode.children[0] ??
                                      selectedTreemapNode
                                  );
                                }}
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-mono cursor-pointer"
                              >
                                <span>Войти в папку</span>
                                <ChevronRight size={14} />
                              </motion.button>
                            )}

                            <motion.button
                              type="button"
                              whileTap={{ scale: 0.96 }}
                              onClick={() =>
                                handleOpenPathInExplorer(selectedTreemapNode.path)
                              }
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/[0.08] text-xs font-mono cursor-pointer"
                            >
                              <FolderOpen size={14} className="text-emerald-400" />
                              <span>Открыть в проводнике</span>
                            </motion.button>
                          </div>
                        </div>
                      )}
                    </div>
                  </SpotlightCard>

                  <SpotlightCard
                    variants={cardItemVariants}
                    spotlightColor="rgba(34, 211, 238, 0.1)"
                    className="p-5 sm:p-6"
                  >
                    <div className="space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div>
                          <h3 className="text-base font-semibold text-zinc-100">
                            ТОП-100 самых тяжелых файлов
                          </h3>
                          <p className="text-xs font-mono text-zinc-500 mt-0.5">
                            Отсортировано по убыванию размера • Найдено:{" "}
                            {filteredTopFiles.length}
                          </p>
                        </div>

                        <div className="relative w-full sm:w-80">
                          <Search
                            size={15}
                            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500"
                          />
                          <input
                            type="text"
                            value={fileSearch}
                            onChange={(e) => setFileSearch(e.target.value)}
                            placeholder="Фильтр по имени или расширению..."
                            className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-zinc-950/80 border border-white/[0.07] text-xs font-mono text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/40"
                          />
                        </div>
                      </div>

                      <div className="max-h-96 overflow-y-auto rounded-xl border border-white/[0.06] bg-zinc-950/50 divide-y divide-white/[0.04]">
                        {filteredTopFiles.length === 0 ? (
                          <div className="p-8 text-center text-xs font-mono text-zinc-500">
                            Файлы по заданному фильтру не найдены
                          </div>
                        ) : (
                          filteredTopFiles.map((file, idx) => {
                            const maxFileBytes =
                              scanResult.top_files[0]?.size_bytes || 1;
                            const relWidth = Math.min(
                              100,
                              Math.max(2, (file.size_bytes / maxFileBytes) * 100)
                            );

                            return (
                              <div
                                key={file.path + idx}
                                className="px-4 py-3 hover:bg-white/[0.03] transition-colors flex items-center justify-between gap-4"
                              >
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <span className="w-7 text-xs font-mono text-zinc-500 shrink-0">
                                    #{idx + 1}
                                  </span>
                                  <FileText
                                    size={16}
                                    className="text-cyan-400 shrink-0"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-medium text-zinc-100 truncate">
                                        {file.name}
                                      </span>
                                      {file.extension && (
                                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-white/[0.06] shrink-0">
                                          .{file.extension}
                                        </span>
                                      )}
                                    </div>
                                    <p
                                      title={file.path}
                                      className="text-[11px] font-mono text-zinc-500 truncate mt-0.5"
                                    >
                                      {file.path}
                                    </p>
                                  </div>
                                </div>

                                <div className="flex items-center gap-4 shrink-0">
                                  <div className="w-28 hidden md:block">
                                    <div className="text-right text-xs font-mono font-bold text-emerald-400 mb-1">
                                      {formatBytes(file.size_bytes)}
                                    </div>
                                    <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
                                      <div
                                        style={{ width: `${relWidth}%` }}
                                        className="h-full bg-gradient-to-r from-emerald-400 to-cyan-400 rounded-full"
                                      />
                                    </div>
                                  </div>

                                  <span className="md:hidden text-xs font-mono font-bold text-emerald-400">
                                    {formatBytes(file.size_bytes)}
                                  </span>

                                  <motion.button
                                    type="button"
                                    whileHover={{ scale: 1.06 }}
                                    whileTap={{ scale: 0.94 }}
                                    onClick={() => handleOpenPathInExplorer(file.path)}
                                    title="Показать файл в проводнике"
                                    className="p-2 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-emerald-400 border border-white/[0.06] transition-colors cursor-pointer"
                                  >
                                    <FolderOpen size={15} />
                                  </motion.button>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </SpotlightCard>
                </motion.div>
              )}
            </motion.div>
          )}

          {activeTab === "hardware" && (
            <motion.div
              key="hardware"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="space-y-6 max-w-6xl w-full"
            >
              {/* Заголовок и статус LibreHardwareMonitor */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">
                    Аппаратный мониторинг (Hardware Monitor)
                  </h2>
                  <p className="text-sm text-zinc-400 mt-1">
                    Глубокая телеметрия датчиков CPU, GPU Hotspot, кулеров и накопителей (LibreHardwareMonitor)
                  </p>
                </div>

                <div className="flex items-center gap-2.5 self-start sm:self-auto">
                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono border ${
                      hwData?.sidecar_online
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                        : "bg-amber-500/10 text-amber-400 border-amber-500/25"
                    }`}
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${
                        hwData?.sidecar_online
                          ? "bg-emerald-400 animate-pulse"
                          : "bg-amber-400"
                      }`}
                    />
                    {hwData?.sidecar_online ? "LHM Sidecar Online" : "Инициализация..."}
                  </span>

                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono border ${
                      hwData?.is_admin
                        ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/25"
                        : "bg-zinc-900/80 text-zinc-400 border-white/[0.07]"
                    }`}
                    title="Для чтения низкоуровневых датчиков кулеров SuperIO и температур ядер рекомендуется запуск от имени Администратора"
                  >
                    <ShieldCheck size={14} />
                    {hwData?.is_admin ? "Admin Mode" : "Standard Mode"}
                  </span>
                </div>
              </div>

              {/* 1. Блок предупреждений / Health Status */}
              {thermalWarnings.length > 0 ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="p-4 sm:p-5 rounded-2xl backdrop-blur-xl bg-gradient-to-r from-rose-500/20 via-amber-500/15 to-zinc-900/80 border border-rose-500/40 shadow-[0_0_30px_rgba(244,63,94,0.25)] flex items-start gap-3.5"
                >
                  <div className="p-2.5 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-400 shrink-0">
                    <Flame size={20} className="animate-pulse" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold text-rose-300 uppercase tracking-wider font-mono">
                      Внимание: критический температурный режим (&gt; 85°C)
                    </h3>
                    <ul className="text-xs sm:text-sm font-mono text-zinc-100 space-y-0.5">
                      {thermalWarnings.map((warn, i) => (
                        <li key={i}>• {warn}</li>
                      ))}
                    </ul>
                  </div>
                </motion.div>
              ) : (
                <div className="p-4 rounded-2xl backdrop-blur-xl bg-emerald-500/[0.06] border border-emerald-500/20 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
                      <Thermometer size={18} />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-zinc-100">
                        Температурный режим всех узлов в пределах нормы
                      </div>
                      <div className="text-xs font-mono text-zinc-400">
                        Порог тревоги CPU Package / GPU Hotspot: 85.0°C • Плата:{" "}
                        <span className="text-zinc-300">
                          {hwData?.motherboard_name || "Определяется..."}
                        </span>
                      </div>
                    </div>
                  </div>
                  <span className="hidden sm:inline-flex text-xs font-mono px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                    HEALTH OK
                  </span>
                </div>
              )}

              {/* Сетка карточек: CPU и GPU */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 lg:grid-cols-2 gap-5"
              >
                {/* 2. Карточка CPU */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(52, 211, 153, 0.14)"
                  className="p-5 sm:p-6"
                >
                  <div className="space-y-5">
                    <div className="flex items-start justify-between gap-3 pb-4 border-b border-white/[0.06]">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 shrink-0">
                          <Cpu size={20} />
                        </div>
                        <div className="min-w-0">
                          <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
                            Центральный процессор (CPU)
                          </span>
                          <h3 className="text-base font-bold text-zinc-100 truncate">
                            {hwData?.cpu.name || "Определение модели CPU..."}
                          </h3>
                        </div>
                      </div>

                      <span
                        className={`text-xs font-mono px-2.5 py-1 rounded-lg border shrink-0 ${cpuTempStyle.badgeClass}`}
                      >
                        {hwData?.cpu.package_temp_c !== null &&
                        hwData?.cpu.package_temp_c !== undefined
                          ? `${hwData.cpu.package_temp_c.toFixed(1)}°C • ${cpuTempStyle.label}`
                          : "Датчик Т°: Н/Д"}
                      </span>
                    </div>

                    {/* Основные показатели CPU */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="p-3 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                        <span className="text-[11px] font-mono text-zinc-500">
                          CPU Package
                        </span>
                        <div
                          className={`text-xl font-bold font-mono mt-1 ${cpuTempStyle.textClass}`}
                        >
                          {hwData?.cpu.package_temp_c != null
                            ? `${hwData.cpu.package_temp_c.toFixed(1)}°C`
                            : `${metrics.cpu_usage.toFixed(0)}% исп.`}
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                        <span className="text-[11px] font-mono text-zinc-500">
                          Частота ядер
                        </span>
                        <div className="text-xl font-bold font-mono text-zinc-100 mt-1">
                          {hwData?.cpu.avg_clock_mhz != null
                            ? `${(hwData.cpu.avg_clock_mhz / 1000).toFixed(2)} ГГц`
                            : "—"}
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                        <span className="text-[11px] font-mono text-zinc-500">
                          Потребление
                        </span>
                        <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
                          {hwData?.cpu.power_watts != null
                            ? `${hwData.cpu.power_watts.toFixed(1)} W`
                            : "—"}
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                        <span className="text-[11px] font-mono text-zinc-500">
                          Вольтаж (VID)
                        </span>
                        <div className="text-xl font-bold font-mono text-cyan-400 mt-1">
                          {hwData?.cpu.voltage_v != null
                            ? `${hwData.cpu.voltage_v.toFixed(3)} V`
                            : "—"}
                        </div>
                      </div>
                    </div>

                    {/* Список температур по ядрам */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs font-mono text-zinc-400">
                        <span>Датчики ядер процессора</span>
                        {hwData?.cpu.max_core_temp_c != null && (
                          <span>
                            Пик:{" "}
                            <strong className="text-zinc-200">
                              {hwData.cpu.max_core_temp_c.toFixed(1)}°C
                            </strong>
                          </span>
                        )}
                      </div>

                      {hwData?.cpu.core_temps && hwData.cpu.core_temps.length > 0 ? (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-40 overflow-y-auto pr-1">
                          {hwData.cpu.core_temps.map((core, idx) => {
                            const cStyle = getTempBadgeStyle(core.temp_c);
                            return (
                              <div
                                key={core.name + idx}
                                className="px-3 py-2 rounded-lg bg-zinc-950/60 border border-white/[0.05] flex items-center justify-between text-xs font-mono"
                              >
                                <span className="text-zinc-400 truncate mr-2">
                                  {core.name}
                                </span>
                                <span className={`font-bold ${cStyle.textClass}`}>
                                  {core.temp_c.toFixed(0)}°C
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="p-3 rounded-xl bg-zinc-950/50 border border-white/[0.04] text-xs font-mono text-zinc-500">
                          {hwData?.is_admin
                            ? "Индивидуальные датчики ядер не предоставлены драйвером CPU"
                            : "Запустите приложение от имени Администратора для чтения температур отдельных ядер CPU Ring0"}
                        </div>
                      )}
                    </div>
                  </div>
                </SpotlightCard>

                {/* 3. Карточка GPU (с выделенным Hotspot и индикатором вертушек) */}
                {hwData?.gpus && hwData.gpus.length > 0 ? (
                  hwData.gpus.map((gpu, gIdx) => {
                    const hotspotStyle = getTempBadgeStyle(
                      gpu.hotspot_temp_c ?? gpu.core_temp_c
                    );
                    const coreStyle = getTempBadgeStyle(gpu.core_temp_c);
                    const fanPct = Math.min(100, Math.max(0, gpu.fan_percent ?? 0));

                    return (
                      <SpotlightCard
                        key={gpu.name + gIdx}
                        variants={cardItemVariants}
                        spotlightColor="rgba(34, 211, 238, 0.14)"
                        className="p-5 sm:p-6"
                      >
                        <div className="space-y-5">
                          <div className="flex items-start justify-between gap-3 pb-4 border-b border-white/[0.06]">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/25 text-cyan-400 shrink-0">
                                <Activity size={20} />
                              </div>
                              <div className="min-w-0">
                                <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
                                  Графический адаптер (GPU #{gIdx + 1})
                                </span>
                                <h3 className="text-base font-bold text-zinc-100 truncate">
                                  {gpu.name}
                                </h3>
                              </div>
                            </div>

                            <span
                              className={`text-xs font-mono px-2.5 py-1 rounded-lg border shrink-0 ${hotspotStyle.badgeClass}`}
                            >
                              {hotspotStyle.label}
                            </span>
                          </div>

                          {/* Крупный блок температур: Core, HOTSPOT, VRAM */}
                          <div className="grid grid-cols-3 gap-3">
                            <div className="p-3.5 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                              <span className="text-[11px] font-mono text-zinc-400">
                                Чип (GPU Core)
                              </span>
                              <div
                                className={`text-2xl font-bold font-mono mt-1 ${coreStyle.textClass}`}
                              >
                                {gpu.core_temp_c != null
                                  ? `${gpu.core_temp_c.toFixed(1)}°C`
                                  : "—"}
                              </div>
                            </div>

                            {/* Выделенный крупно GPU Hotspot */}
                            <div className="p-3.5 rounded-xl bg-gradient-to-br from-amber-500/15 via-rose-500/10 to-zinc-950 border border-amber-500/35 shadow-[0_0_20px_rgba(245,158,11,0.12)]">
                              <span className="text-[11px] font-mono uppercase tracking-wider text-amber-300 font-semibold flex items-center gap-1">
                                <Flame size={12} /> HOTSPOT
                              </span>
                              <div
                                className={`text-2xl sm:text-3xl font-extrabold font-mono mt-0.5 ${hotspotStyle.textClass}`}
                              >
                                {gpu.hotspot_temp_c != null
                                  ? `${gpu.hotspot_temp_c.toFixed(1)}°C`
                                  : gpu.core_temp_c != null
                                  ? `${gpu.core_temp_c.toFixed(1)}°C`
                                  : "—"}
                              </div>
                            </div>

                            <div className="p-3.5 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                              <span className="text-[11px] font-mono text-zinc-400">
                                Память (VRAM)
                              </span>
                              <div className="text-2xl font-bold font-mono text-cyan-400 mt-1">
                                {gpu.memory_temp_c != null
                                  ? `${gpu.memory_temp_c.toFixed(1)}°C`
                                  : "—"}
                              </div>
                            </div>
                          </div>

                          {/* Частоты, питание и вольтаж */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs font-mono">
                            <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-white/[0.04]">
                              <span className="text-zinc-500 block">Ядро МГц</span>
                              <span className="text-zinc-100 font-bold text-sm">
                                {gpu.core_clock_mhz != null
                                  ? `${gpu.core_clock_mhz.toFixed(0)} MHz`
                                  : "—"}
                              </span>
                            </div>
                            <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-white/[0.04]">
                              <span className="text-zinc-500 block">Память МГц</span>
                              <span className="text-zinc-100 font-bold text-sm">
                                {gpu.memory_clock_mhz != null
                                  ? `${gpu.memory_clock_mhz.toFixed(0)} MHz`
                                  : "—"}
                              </span>
                            </div>
                            <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-white/[0.04]">
                              <span className="text-zinc-500 block">Потребление</span>
                              <span className="text-emerald-400 font-bold text-sm">
                                {gpu.power_watts != null
                                  ? `${gpu.power_watts.toFixed(1)} W`
                                  : "—"}
                              </span>
                            </div>
                            <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-white/[0.04]">
                              <span className="text-zinc-500 block">Вольтаж</span>
                              <span className="text-cyan-400 font-bold text-sm">
                                {gpu.voltage_v != null
                                  ? `${gpu.voltage_v.toFixed(3)} V`
                                  : "—"}
                              </span>
                            </div>
                          </div>

                          {/* Индикатор вертушек GPU (RPM и сегментированная шкала %) */}
                          <div className="p-3.5 rounded-xl bg-[#07090e]/90 border border-white/[0.06] space-y-2.5">
                            <div className="flex items-center justify-between text-xs font-mono">
                              <span className="flex items-center gap-2 text-zinc-300">
                                <Fan
                                  size={15}
                                  className={
                                    (gpu.fan_rpm ?? 0) > 0
                                      ? "text-cyan-400 animate-spin"
                                      : "text-zinc-500"
                                  }
                                />
                                Охлаждение GPU (Кулеры)
                              </span>
                              <div className="flex items-center gap-2">
                                <span className="text-zinc-100 font-bold tabular-nums">
                                  {gpu.fan_rpm != null
                                    ? gpu.fan_rpm.toFixed(0)
                                    : "0"}
                                </span>
                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                                  RPM
                                </span>
                                <span className="text-cyan-400 font-semibold tabular-nums ml-1">
                                  {gpu.fan_percent != null
                                    ? `${gpu.fan_percent.toFixed(0)}%`
                                    : "0%"}
                                </span>
                              </div>
                            </div>
                            <SegmentedHudBar
                              percentage={fanPct}
                              segments={24}
                              theme="cyan"
                            />
                          </div>
                        </div>
                      </SpotlightCard>
                    );
                  })
                ) : (
                  <SpotlightCard
                    variants={cardItemVariants}
                    spotlightColor="rgba(34, 211, 238, 0.12)"
                    className="p-6 flex flex-col justify-center items-center text-center"
                  >
                    <Activity size={28} className="text-cyan-400 mb-2 opacity-80" />
                    <div className="text-sm font-semibold text-zinc-200">
                      Датчики дискретной видеокарты (GPU)
                    </div>
                    <p className="text-xs font-mono text-zinc-500 mt-1 max-w-sm">
                      Ожидание ответа от LibreHardwareMonitor или в системе используется встроенное видеоядро без открытых термодатчиков.
                    </p>
                  </SpotlightCard>
                )}
              </motion.div>

              {/* 4. Карточка системных вентиляторов и температур накопителей SSD/HDD */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 lg:grid-cols-2 gap-5"
              >
                {/* Системные вентиляторы и датчики материнской платы */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(52, 211, 153, 0.12)"
                  className="p-5 sm:p-6"
                >
                  <div className="space-y-4">
                    <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
                      <div className="flex items-center gap-2.5">
                        <Fan size={18} className="text-emerald-400" />
                        <h3 className="text-base font-semibold text-zinc-100">
                          Вентиляторы корпуса и датчики платы
                        </h3>
                      </div>
                      <span className="text-xs font-mono text-zinc-500">
                        Кулеров: {hwData?.system_fans.length ?? 0}
                      </span>
                    </div>

                    {hwData?.system_fans && hwData.system_fans.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {hwData.system_fans.map((fan, fIdx) => (
                          <div
                            key={fan.name + fIdx}
                            className="p-3 rounded-xl bg-zinc-950/70 border border-white/[0.05] flex items-center justify-between"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <Fan
                                size={15}
                                className={
                                  fan.rpm > 0
                                    ? "text-emerald-400 animate-spin shrink-0"
                                    : "text-zinc-600 shrink-0"
                                }
                              />
                              <span className="text-xs font-mono text-zinc-300 truncate">
                                {fan.name}
                              </span>
                            </div>
                            <span className="text-sm font-mono font-bold text-emerald-400 shrink-0">
                              {fan.rpm.toFixed(0)} RPM
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="p-4 rounded-xl bg-zinc-950/50 border border-white/[0.04] text-xs font-mono text-zinc-500">
                        Обороты корпусных вентиляторов (SuperIO) недоступны без прав Администратора или управляются напрямую через BIOS.
                      </div>
                    )}

                    {hwData?.motherboard_temps &&
                      hwData.motherboard_temps.length > 0 && (
                        <div className="pt-2 space-y-2">
                          <span className="text-xs font-mono text-zinc-400 block">
                            Термодатчики системной платы:
                          </span>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {hwData.motherboard_temps.slice(0, 6).map((t, idx) => {
                              const st = getTempBadgeStyle(t.temp_c);
                              return (
                                <div
                                  key={t.name + idx}
                                  className="px-3 py-2 rounded-lg bg-zinc-950/60 border border-white/[0.05] flex items-center justify-between text-xs font-mono"
                                >
                                  <span className="text-zinc-400 truncate mr-2">
                                    {t.name}
                                  </span>
                                  <span className={`font-bold ${st.textClass}`}>
                                    {t.temp_c.toFixed(0)}°C
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                  </div>
                </SpotlightCard>

                {/* Температуры накопителей SSD / HDD */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(34, 211, 238, 0.12)"
                  className="p-5 sm:p-6"
                >
                  <div className="space-y-4">
                    <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
                      <div className="flex items-center gap-2.5">
                        <HardDrive size={18} className="text-cyan-400" />
                        <h3 className="text-base font-semibold text-zinc-100">
                          Температуры накопителей (SSD / NVMe / HDD)
                        </h3>
                      </div>
                      <span className="text-xs font-mono text-zinc-500">
                        Устройств: {hwData?.storage_temps.length ?? 0}
                      </span>
                    </div>

                    {hwData?.storage_temps && hwData.storage_temps.length > 0 ? (
                      <div className="space-y-2.5">
                        {hwData.storage_temps.map((st, idx) => {
                          const tempBadge = getTempBadgeStyle(st.temp_c);
                          return (
                            <div
                              key={st.name + idx}
                              className="p-3.5 rounded-xl bg-zinc-950/70 border border-white/[0.05] flex items-center justify-between gap-4"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-zinc-100 truncate">
                                  {st.name}
                                </div>
                                {st.used_percent != null && (
                                  <div className="flex items-center gap-2 mt-1.5">
                                    <div className="w-28 h-1 bg-zinc-800 rounded-full overflow-hidden">
                                      <div
                                        style={{
                                          width: `${Math.min(100, st.used_percent)}%`,
                                        }}
                                        className="h-full bg-cyan-400 rounded-full"
                                      />
                                    </div>
                                    <span className="text-[11px] font-mono text-zinc-500">
                                      Занято: {st.used_percent.toFixed(0)}%
                                    </span>
                                  </div>
                                )}
                              </div>

                              <span
                                className={`text-xs font-mono font-bold px-2.5 py-1 rounded-lg border shrink-0 ${tempBadge.badgeClass}`}
                              >
                                {st.temp_c != null
                                  ? `${st.temp_c.toFixed(1)}°C`
                                  : "SMART Н/Д"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="p-4 rounded-xl bg-zinc-950/50 border border-white/[0.04] text-xs font-mono text-zinc-500">
                        Опрос SMART-датчиков накопителей...
                      </div>
                    )}
                  </div>
                </SpotlightCard>
              </motion.div>
            </motion.div>
          )}

          {activeTab === "cleanup" && (
            <motion.div
              key="cleanup"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="space-y-5 max-w-6xl w-full"
            >
              {/* Шапка Cleanup Center */}
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.06] pb-3.5">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-400/90 mb-0.5">
                    CLEANUP CENTER // SAFE STORAGE SANITIZER
                  </div>
                  <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">
                    Безопасная очистка накопителя
                  </h2>
                  <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">
                    Анализ временных кэшей, шейдеров, миниатюр, дампов памяти и корзины Windows с пропуском занятых файлов
                  </p>
                </div>

                <motion.button
                  type="button"
                  whileHover={{ scale: isScanningCleanup || isCleaning ? 1 : 1.02 }}
                  whileTap={{ scale: isScanningCleanup || isCleaning ? 1 : 0.96 }}
                  disabled={isScanningCleanup || isCleaning}
                  onClick={handleScanCleanup}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500/20 to-teal-500/20 hover:from-emerald-500/30 hover:to-teal-500/30 text-emerald-300 border border-emerald-500/35 shadow-[0_0_20px_rgba(52,211,153,0.16)] text-xs font-mono font-bold transition-all cursor-pointer self-start sm:self-auto"
                >
                  <RefreshCw
                    size={14}
                    className={isScanningCleanup ? "animate-spin text-emerald-400" : "text-emerald-400"}
                  />
                  <span>{isScanningCleanup ? "АНАЛИЗ СИСТЕМЫ..." : "АНАЛИЗ СИСТЕМЫ"}</span>
                </motion.button>
              </div>

              {/* Сводная панель объёма найденного кэша и управления выделением */}
              <SpotlightCard
                spotlightColor="rgba(52, 211, 153, 0.12)"
                accentColor="emerald"
                className="p-5"
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 flex-1">
                    <div className="p-3.5 rounded-xl bg-[#07090e]/90 border border-white/[0.06] hud-dot-matrix">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 block">
                        ОБНАРУЖЕНО ВСЕГО
                      </span>
                      <div className="text-2xl font-extrabold font-mono tabular-nums text-zinc-100 mt-1">
                        {formatBytes(totalCleanupBytes)}
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-[#07090e]/90 border border-emerald-500/25 hud-dot-matrix">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-400/90 block">
                        ВЫБРАНО К ОЧИСТКЕ
                      </span>
                      <div className="text-2xl font-extrabold font-mono tabular-nums text-emerald-400 mt-1">
                        {formatBytes(selectedCleanupBytes)}
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-[#07090e]/90 border border-white/[0.06] hud-dot-matrix">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 block">
                        ФАЙЛОВ В ВЫБОРКЕ
                      </span>
                      <div className="text-2xl font-extrabold font-mono tabular-nums text-cyan-400 mt-1">
                        {selectedCleanupFilesCount.toLocaleString("ru-RU")}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-start lg:self-center font-mono text-xs shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmCleanupOpen(false);
                        setSelectedCleanupIds(cleanupCategories.map((c) => c.id));
                      }}
                      className="px-3 py-2 rounded-lg bg-[#0d1017] hover:bg-white/[0.07] text-zinc-300 border border-white/[0.08] transition-colors cursor-pointer"
                    >
                      Выбрать все
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmCleanupOpen(false);
                        setSelectedCleanupIds([]);
                      }}
                      className="px-3 py-2 rounded-lg bg-[#0d1017] hover:bg-white/[0.07] text-zinc-400 border border-white/[0.08] transition-colors cursor-pointer"
                    >
                      Сбросить
                    </button>
                  </div>
                </div>
              </SpotlightCard>

              {/* Ошибка при сканировании или очистке */}
              <AnimatePresence>
                {cleanupError && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-mono"
                  >
                    {cleanupError}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Итоговый отчёт после выполнения очистки (CleanupReport) */}
              <AnimatePresence>
                {cleanupReport && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98, y: -6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    className="p-5 rounded-xl backdrop-blur-2xl bg-gradient-to-r from-emerald-500/15 via-cyan-500/10 to-[#0b0d13] border border-emerald-500/40 shadow-[0_0_28px_rgba(52,211,153,0.18)] space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300">
                          <CheckCircle2 size={20} />
                        </div>
                        <div>
                          <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300 font-bold">
                            ОТЧЁТ ОЧИСТКИ НАКОПИТЕЛЯ // ЗАВЕРШЕНО
                          </div>
                          <div className="text-base sm:text-lg font-bold text-zinc-100 font-mono">
                            Освобождено:{" "}
                            <span className="text-emerald-400">
                              {formatBytes(cleanupReport.freed_bytes)}
                            </span>{" "}
                            ({cleanupReport.freed_bytes.toLocaleString("ru-RU")} байт)
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                        <span className="px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                          Удалено файлов: <strong>{cleanupReport.deleted_files_count}</strong>
                        </span>
                        <span className="px-2.5 py-1 rounded-lg bg-zinc-900/90 text-zinc-400 border border-white/[0.08]">
                          Пропущено (заняты ОС): <strong>{cleanupReport.skipped_files_count}</strong>
                        </span>
                      </div>
                    </div>

                    {cleanupReport.categories.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 pt-2 border-t border-white/[0.08]">
                        {cleanupReport.categories.map((catRep) => (
                          <div
                            key={catRep.id}
                            className="px-3 py-2 rounded-lg bg-[#07090e]/85 border border-white/[0.06] flex items-center justify-between text-xs font-mono"
                          >
                            <span className="text-zinc-300 truncate mr-2">{catRep.name}</span>
                            <span className="text-emerald-400 font-bold shrink-0 tabular-nums">
                              -{formatBytes(catRep.freed_bytes)} ({catRep.deleted_files})
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Список категорий очистки с чекбоксами */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 md:grid-cols-2 gap-4"
              >
                {cleanupCategories.map((cat) => {
                  const isChecked = selectedCleanupIds.includes(cat.id);
                  return (
                    <SpotlightCard
                      key={cat.id}
                      variants={cardItemVariants}
                      spotlightColor={
                        isChecked
                          ? "rgba(52, 211, 153, 0.13)"
                          : "rgba(161, 161, 170, 0.07)"
                      }
                      accentColor={isChecked ? "emerald" : "cyan"}
                      className="p-4 sm:p-5"
                    >
                      <div
                        onClick={() => handleToggleCleanupCategory(cat.id)}
                        className="flex items-start justify-between gap-3.5 cursor-pointer h-full"
                      >
                        <div className="flex items-start gap-3.5 min-w-0 flex-1">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={isChecked}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleCleanupCategory(cat.id);
                            }}
                            className={`mt-0.5 h-5 w-5 rounded-md border flex items-center justify-center shrink-0 transition-all cursor-pointer ${
                              isChecked
                                ? "bg-emerald-500/25 border-emerald-400 text-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.3)]"
                                : "bg-[#07090e] border-white/[0.15] text-transparent hover:border-white/30"
                            }`}
                          >
                            <Check size={13} />
                          </button>

                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-bold text-sm text-zinc-100">
                                {cat.name}
                              </span>
                              {cat.requires_admin && (
                                <span
                                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                                    isElevatedAdmin
                                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                      : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                                  }`}
                                >
                                  ADMIN
                                </span>
                              )}
                            </div>

                            <p className="text-xs text-zinc-400 leading-relaxed">
                              {cat.description}
                            </p>

                            <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] font-mono text-zinc-500">
                              <span className="px-2 py-0.5 rounded bg-[#07090e] border border-white/[0.05] truncate max-w-xs">
                                {cat.paths_hint}
                              </span>
                              <span>
                                Файлов:{" "}
                                <strong className="text-zinc-300 tabular-nums">
                                  {cat.files_count.toLocaleString("ru-RU")}
                                </strong>
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <span
                            className={`inline-block font-mono font-extrabold text-sm sm:text-base tabular-nums px-2.5 py-1 rounded-lg border ${
                              cat.size_bytes > 100 * 1024 * 1024
                                ? "bg-amber-500/15 text-amber-300 border-amber-500/35"
                                : cat.size_bytes > 0
                                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                : "bg-zinc-900/80 text-zinc-500 border-white/[0.06]"
                            }`}
                          >
                            {formatBytes(cat.size_bytes)}
                          </span>
                        </div>
                      </div>
                    </SpotlightCard>
                  );
                })}
              </motion.div>

              {/* Блок подтверждения и безопасного запуска очистки */}
              <SpotlightCard
                spotlightColor="rgba(244, 63, 94, 0.12)"
                accentColor="amber"
                className="p-5"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 shrink-0 mt-0.5">
                      <AlertTriangle size={18} />
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-sm font-semibold text-zinc-100">
                        Безопасный протокол очистки NEXUS
                      </div>
                      <p className="text-xs font-mono text-zinc-400">
                        Заблокированные системой или открытыми программами файлы (`EBUSY` / `PermissionDenied`) автоматически пропускаются без сбоев.
                      </p>
                    </div>
                  </div>

                  {!confirmCleanupOpen ? (
                    <motion.button
                      type="button"
                      whileHover={{
                        scale:
                          selectedCleanupIds.length === 0 || isCleaning ? 1 : 1.02,
                      }}
                      whileTap={{
                        scale:
                          selectedCleanupIds.length === 0 || isCleaning ? 1 : 0.96,
                      }}
                      disabled={selectedCleanupIds.length === 0 || isCleaning}
                      onClick={() => setConfirmCleanupOpen(true)}
                      className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-xs font-mono font-bold transition-all border shrink-0 cursor-pointer ${
                        selectedCleanupIds.length === 0 || isCleaning
                          ? "bg-zinc-900 text-zinc-500 border-white/[0.06] cursor-not-allowed"
                          : "bg-gradient-to-r from-rose-500/25 via-amber-500/20 to-emerald-500/20 hover:from-rose-500/35 hover:to-emerald-500/30 text-emerald-300 border-emerald-500/40 shadow-[0_0_22px_rgba(52,211,153,0.2)]"
                      }`}
                    >
                      <Trash2 size={15} />
                      <span>
                        ОЧИСТИТЬ ВЫБРАННОЕ ({formatBytes(selectedCleanupBytes)})
                      </span>
                    </motion.button>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2 shrink-0 font-mono text-xs">
                      <span className="text-amber-300 mr-1">
                        Удалить {selectedCleanupFilesCount.toLocaleString("ru-RU")} файлов?
                      </span>
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.96 }}
                        disabled={isCleaning}
                        onClick={handleExecuteCleanup}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-500/25 hover:bg-rose-500/35 text-rose-200 border border-rose-500/45 font-bold shadow-[0_0_18px_rgba(244,63,94,0.25)] cursor-pointer"
                      >
                        {isCleaning ? (
                          <>
                            <Loader2 size={14} className="animate-spin" />
                            <span>Очистка...</span>
                          </>
                        ) : (
                          <>
                            <Trash2 size={14} />
                            <span>Подтвердить ({formatBytes(selectedCleanupBytes)})</span>
                          </>
                        )}
                      </motion.button>
                      <button
                        type="button"
                        onClick={() => setConfirmCleanupOpen(false)}
                        className="px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-white/[0.08] cursor-pointer"
                      >
                        Отмена
                      </button>
                    </div>
                  )}
                </div>
              </SpotlightCard>
            </motion.div>
          )}

          {activeTab === "processes" && (
            <motion.div
              key="processes"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="space-y-4 max-w-6xl w-full"
            >
              {/* Шапка Process Explorer */}
              <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-white/[0.06] pb-3.5">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-400/90 mb-0.5">
                    PROCESS EXPLORER // LIVE TASK MATRIX
                  </div>
                  <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">
                    Диспетчер процессов
                  </h2>
                  <p className="text-xs text-zinc-500 font-mono mt-0.5">
                    ПКМ по строке — действия с процессом • Клик по заголовку — сортировка
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                  <span className="px-2.5 py-1.5 rounded-lg bg-[#0e1118] border border-white/[0.07] text-zinc-400 tabular-nums">
                    ПРОЦЕССОВ: <strong className="text-zinc-100">{processes.length}</strong>
                  </span>
                  <span className="px-2.5 py-1.5 rounded-lg bg-[#0e1118] border border-white/[0.07] text-zinc-400 tabular-nums">
                    CPU Σ:{" "}
                    <strong className={getLoadBarStyles(totalProcessCpu).badgeTextClass}>
                      {totalProcessCpu.toFixed(1)}%
                    </strong>
                  </span>
                  <span className="px-2.5 py-1.5 rounded-lg bg-[#0e1118] border border-white/[0.07] text-zinc-400 tabular-nums">
                    RAM Σ: <strong className="text-cyan-300">{totalProcessMemoryGb.toFixed(2)} GB</strong>
                  </span>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setProcessAutoRefresh((prev) => !prev)}
                    title={processAutoRefresh ? "Приостановить автообновление" : "Включить автообновление"}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-colors cursor-pointer ${
                      processAutoRefresh
                        ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/35"
                        : "bg-amber-500/15 text-amber-300 border-amber-500/35"
                    }`}
                  >
                    {processAutoRefresh ? <Pause size={12} /> : <Play size={12} />}
                    <span>{processAutoRefresh ? "LIVE 1.5s" : "ПАУЗА"}</span>
                  </motion.button>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.95 }}
                    onClick={fetchProcesses}
                    title="Обновить сейчас"
                    className="inline-flex items-center justify-center h-[30px] w-[30px] rounded-lg bg-[#0e1118] hover:bg-white/[0.06] text-zinc-300 border border-white/[0.07] cursor-pointer"
                  >
                    <RefreshCw size={13} className={processLoading ? "animate-spin" : ""} />
                  </motion.button>
                </div>
              </div>

              {/* Поиск по имени, PID или пути */}
              <div className="relative">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500"
                />
                <input
                  type="text"
                  value={processSearch}
                  onChange={(e) => setProcessSearch(e.target.value)}
                  placeholder="Мгновенный поиск по имени процесса, PID или пути к файлу..."
                  className="w-full pl-10 pr-24 py-2.5 rounded-xl bg-[#0e1118] border border-white/[0.07] text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-emerald-500/40 focus:shadow-[0_0_18px_rgba(52,211,153,0.1)] transition-all"
                />
                <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[10px] font-mono text-zinc-500 tabular-nums">
                  {visibleProcesses.length} / {processes.length}
                </span>
              </div>

              {/* Уведомления и ошибки действий */}
              <AnimatePresence>
                {processError && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-mono flex items-center justify-between gap-3"
                  >
                    <span>{processError}</span>
                    <button
                      type="button"
                      onClick={() => setProcessError(null)}
                      className="text-rose-300 hover:text-rose-100 cursor-pointer shrink-0"
                    >
                      <X size={13} />
                    </button>
                  </motion.div>
                )}
                {processNotice && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-mono truncate"
                  >
                    {processNotice}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Сортируемая таблица процессов */}
              <div className="relative rounded-xl bg-[#0b0d13]/95 border border-white/[0.07] shadow-[0_12px_36px_rgba(0,0,0,0.6)] overflow-hidden">
                <div className="grid grid-cols-[minmax(0,1fr)_90px_110px_170px_110px] gap-3 px-4 py-2.5 bg-[#0e1118] border-b border-white/[0.07]">
                  {renderSortHeader("name", "Процесс / PID", false)}
                  {renderSortHeader("cpu", "CPU %")}
                  {renderSortHeader("memory", "RAM (МБ)")}
                  {renderSortHeader("disk", "Диск R / W")}
                  {renderSortHeader("runtime", "Время")}
                </div>

                <div
                  onScroll={() => setProcessMenu(null)}
                  className="max-h-[calc(100vh-340px)] min-h-[240px] overflow-y-auto divide-y divide-white/[0.035]"
                >
                  {processLoading && processes.length === 0 ? (
                    <div className="p-10 flex items-center justify-center gap-2 text-xs font-mono text-zinc-500">
                      <Loader2 size={14} className="animate-spin text-emerald-400" />
                      Построение матрицы процессов...
                    </div>
                  ) : visibleProcesses.length === 0 ? (
                    <div className="p-10 text-center text-xs font-mono text-zinc-500">
                      Процессы по запросу не найдены
                    </div>
                  ) : (
                    visibleProcesses.map((proc) => {
                      const isSelected = selectedPid === proc.pid;
                      const isSuspended = suspendedPids.includes(proc.pid);
                      const cpuStyle = getLoadBarStyles(proc.cpu_usage * 2.5);
                      const hasDisk =
                        proc.disk_read_bytes_sec > 0 || proc.disk_write_bytes_sec > 0;
                      return (
                        <div
                          key={proc.pid}
                          onClick={() => setSelectedPid(proc.pid)}
                          onContextMenu={(e) => handleProcessContextMenu(e, proc)}
                          className={`grid grid-cols-[minmax(0,1fr)_90px_110px_170px_110px] gap-3 px-4 py-2 items-center text-xs font-mono cursor-default transition-colors ${
                            isSelected
                              ? "bg-emerald-500/[0.09] shadow-[inset_2px_0_0_#34d399]"
                              : isSuspended
                              ? "bg-cyan-500/[0.06] shadow-[inset_2px_0_0_#22d3ee]"
                              : "hover:bg-white/[0.025]"
                          }`}
                        >
                          <div className="min-w-0 flex items-center gap-2.5">
                            <div
                              className={`h-6 w-6 rounded-md flex items-center justify-center shrink-0 border ${
                                isSuspended
                                  ? "bg-cyan-500/15 border-cyan-500/35 text-cyan-300"
                                  : "bg-[#0e1118] border-white/[0.07] text-zinc-500"
                              }`}
                            >
                              {isSuspended ? <Pause size={11} /> : <AppWindow size={11} />}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`truncate font-semibold ${
                                    isSuspended ? "text-cyan-200" : "text-zinc-100"
                                  }`}
                                  title={proc.exe_path || proc.name}
                                >
                                  {proc.name}
                                </span>
                                {isSuspended && (
                                  <span className="text-[9px] px-1 py-px rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shrink-0">
                                    FROZEN
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-zinc-500 tabular-nums">
                                PID {proc.pid}
                                {proc.parent_pid != null && ` • PPID ${proc.parent_pid}`}
                              </div>
                            </div>
                          </div>

                          <div className="text-right">
                            <div className={`font-bold tabular-nums ${proc.cpu_usage >= 0.1 ? cpuStyle.badgeTextClass : "text-zinc-600"}`}>
                              {proc.cpu_usage.toFixed(1)}
                            </div>
                            <div className="mt-1 h-0.5 w-full bg-white/[0.05] rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${cpuStyle.barClass}`}
                                style={{ width: `${Math.min(100, proc.cpu_usage)}%` }}
                              />
                            </div>
                          </div>

                          <div
                            className={`text-right tabular-nums ${
                              proc.memory_mb >= 1024
                                ? "text-amber-300 font-bold"
                                : proc.memory_mb >= 300
                                ? "text-cyan-300"
                                : "text-zinc-300"
                            }`}
                          >
                            {proc.memory_mb.toFixed(1)}
                          </div>

                          <div className={`text-right tabular-nums text-[11px] ${hasDisk ? "text-zinc-300" : "text-zinc-600"}`}>
                            <span className={proc.disk_read_bytes_sec > 0 ? "text-emerald-400" : ""}>
                              {formatRate(proc.disk_read_bytes_sec)}
                            </span>
                            <span className="text-zinc-600"> / </span>
                            <span className={proc.disk_write_bytes_sec > 0 ? "text-cyan-400" : ""}>
                              {formatRate(proc.disk_write_bytes_sec)}
                            </span>
                          </div>

                          <div className="text-right tabular-nums text-zinc-400">
                            {formatUptime(proc.run_time_sec)}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === "power" && (
            <motion.div
              key="power"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="space-y-6 max-w-2xl w-full"
            >
              <div>
                <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">
                  Управление питанием
                </h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Таймеры автоматического выключения и перезагрузки Windows
                </p>
              </div>

              <SpotlightCard
                spotlightColor={
                  restartMode
                    ? "rgba(251, 191, 36, 0.12)"
                    : "rgba(52, 211, 153, 0.12)"
                }
                className="p-6"
              >
                <div className="space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/[0.06]">
                    <div className="flex items-center gap-3 text-zinc-200">
                      <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                        <Clock className="text-emerald-400 shrink-0" size={18} />
                      </div>
                      <span className="font-medium text-base">Режим действия</span>
                    </div>

                    <div className="inline-flex rounded-xl bg-zinc-950/80 p-1 border border-white/[0.06]">
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.96 }}
                        onClick={() => setRestartMode(false)}
                        className={`relative flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                          !restartMode
                            ? "text-emerald-400"
                            : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {!restartMode && (
                          <motion.div
                            layoutId="powerModePill"
                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                            className="absolute inset-0 rounded-lg bg-emerald-500/15 border border-emerald-500/30 shadow-[0_0_14px_rgba(52,211,153,0.2)]"
                          />
                        )}
                        <span className="relative z-10 flex items-center gap-2">
                          <Power size={14} />
                          <span>Выключение</span>
                        </span>
                      </motion.button>

                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.96 }}
                        onClick={() => setRestartMode(true)}
                        className={`relative flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                          restartMode
                            ? "text-amber-400"
                            : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {restartMode && (
                          <motion.div
                            layoutId="powerModePill"
                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                            className="absolute inset-0 rounded-lg bg-amber-500/15 border border-amber-500/30 shadow-[0_0_14px_rgba(251,191,36,0.2)]"
                          />
                        )}
                        <span className="relative z-10 flex items-center gap-2">
                          <RotateCcw size={14} />
                          <span>Перезагрузка</span>
                        </span>
                      </motion.button>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <label className="block text-xs font-mono uppercase tracking-wider text-zinc-400">
                      Быстрый запуск
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {PRESET_MINUTES.map((mins) => (
                        <motion.button
                          key={mins}
                          type="button"
                          whileHover={{ y: -2 }}
                          whileTap={{ scale: 0.96 }}
                          transition={{ type: "spring", stiffness: 400, damping: 22 }}
                          onClick={() => handleStartTimer(mins)}
                          className="py-3 px-3 rounded-xl bg-zinc-800/60 hover:bg-emerald-500/10 text-zinc-200 hover:text-emerald-300 text-sm font-medium transition-colors border border-white/[0.06] hover:border-emerald-500/35 hover:shadow-[0_0_20px_rgba(52,211,153,0.14)] cursor-pointer"
                        >
                          {mins} мин
                        </motion.button>
                      ))}
                    </div>
                  </div>

                  <form onSubmit={handleCustomSubmit} className="space-y-2.5">
                    <label className="block text-xs font-mono uppercase tracking-wider text-zinc-400">
                      Произвольное время (в минутах)
                    </label>
                    <div className="flex flex-col sm:flex-row gap-3">
                      <input
                        type="number"
                        min="1"
                        max="525600"
                        step="1"
                        value={customMinutes}
                        onChange={(e) => setCustomMinutes(e.target.value)}
                        placeholder="Например: 90"
                        className="flex-1 px-4 py-2.5 rounded-xl bg-zinc-950/80 border border-white/[0.07] text-zinc-100 placeholder-zinc-500 text-sm focus:outline-none focus:border-emerald-500/50 focus:shadow-[0_0_16px_rgba(52,211,153,0.12)] transition-all"
                      />
                      <motion.button
                        type="submit"
                        whileHover={{ scale: 1.01 }}
                        whileTap={{ scale: 0.97 }}
                        className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500/20 to-teal-500/20 hover:from-emerald-500/30 hover:to-teal-500/30 text-emerald-300 border border-emerald-500/30 shadow-[0_0_20px_rgba(52,211,153,0.15)] text-sm font-medium transition-all cursor-pointer"
                      >
                        <Play size={16} />
                        <span>Запустить таймер</span>
                      </motion.button>
                    </div>
                  </form>

                  <AnimatePresence>
                    {powerError && (
                      <motion.div
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-mono"
                      >
                        {powerError}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <AnimatePresence>
                    {timerState && remainingSeconds > 0 && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.97, y: 8 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97, y: 8 }}
                        transition={{ type: "spring", stiffness: 320, damping: 26 }}
                        className="p-5 rounded-2xl bg-zinc-950/85 border border-white/[0.08] space-y-4 shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                          <div>
                            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-zinc-900 border border-white/[0.06] text-xs font-mono">
                              <span className="relative flex h-2 w-2">
                                <span
                                  className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                                    timerState.restart ? "bg-amber-400" : "bg-emerald-400"
                                  }`}
                                />
                                <span
                                  className={`relative inline-flex rounded-full h-2 w-2 ${
                                    timerState.restart ? "bg-amber-400" : "bg-emerald-400"
                                  }`}
                                />
                              </span>
                              <span className="text-zinc-400">Активный таймер:</span>
                              <strong
                                className={
                                  timerState.restart ? "text-amber-400" : "text-emerald-400"
                                }
                              >
                                {timerState.restart ? "Перезагрузка" : "Выключение"}
                              </strong>
                            </div>

                            <div className="text-3xl sm:text-4xl font-bold font-mono text-zinc-100 mt-2 tracking-tight drop-shadow-[0_0_14px_rgba(52,211,153,0.2)]">
                              {formatCountdown(remainingSeconds)}
                            </div>
                          </div>

                          <motion.button
                            type="button"
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.96 }}
                            onClick={handleCancelTimer}
                            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 border border-rose-500/30 shadow-[0_0_20px_rgba(244,63,94,0.15)] text-sm font-medium transition-all cursor-pointer"
                          >
                            <XCircle size={16} />
                            <span>Отменить таймер</span>
                          </motion.button>
                        </div>

                        <div className="w-full bg-zinc-800/80 h-2 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${
                              timerState.restart
                                ? "bg-gradient-to-r from-amber-500 via-orange-400 to-yellow-400 shadow-[0_0_12px_rgba(251,191,36,0.5)]"
                                : "bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-400 shadow-[0_0_12px_rgba(52,211,153,0.5)]"
                            }`}
                            style={{ width: `${timerProgress}%` }}
                          ></div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </SpotlightCard>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      </div>

      {/* Кастомное контекстное меню процесса (ПКМ) */}
      <AnimatePresence>
        {processMenu && (
          <motion.div
            key={`menu-${processMenu.process.pid}-${processMenu.x}-${processMenu.y}`}
            initial={{ opacity: 0, scale: 0.94, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -2 }}
            transition={{ type: "spring", stiffness: 520, damping: 34 }}
            style={{ left: processMenu.x, top: processMenu.y, transformOrigin: "top left" }}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            className="fixed z-[100] w-62 rounded-xl backdrop-blur-2xl bg-[#0b0d14]/97 border border-white/[0.12] shadow-[0_18px_44px_rgba(0,0,0,0.85)] p-1.5 font-mono text-xs"
          >
            <div className="px-2.5 py-2 mb-1 rounded-lg bg-[#07080c] border border-white/[0.06]">
              <div className="text-zinc-100 font-bold truncate">{processMenu.process.name}</div>
              <div className="text-[10px] text-zinc-500 tabular-nums">
                PID {processMenu.process.pid} • {processMenu.process.memory_mb.toFixed(1)} MB
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleProcessOpenLocation(processMenu.process)}
              disabled={!processMenu.process.exe_path}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-zinc-200 hover:bg-white/[0.06] disabled:text-zinc-600 disabled:hover:bg-transparent transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <FolderOpen size={14} className="text-emerald-400 shrink-0" />
              <span>Открыть расположение файла</span>
            </button>

            <button
              type="button"
              onClick={() => handleProcessCopyPath(processMenu.process)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-zinc-200 hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <Copy size={14} className="text-zinc-400 shrink-0" />
              <span>Копировать путь</span>
            </button>

            <div className="my-1 h-px bg-white/[0.08]" />

            <button
              type="button"
              onClick={() => handleProcessSuspendToggle(processMenu.process)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-cyan-200 hover:bg-cyan-500/10 transition-colors cursor-pointer"
            >
              {menuProcessSuspended ? (
                <Play size={14} className="text-cyan-400 shrink-0" />
              ) : (
                <Pause size={14} className="text-cyan-400 shrink-0" />
              )}
              <span>{menuProcessSuspended ? "Возобновить процесс" : "Приостановить (Заморозить)"}</span>
            </button>

            <button
              type="button"
              onClick={() => handleProcessKill(processMenu.process, false)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer"
            >
              <XCircle size={14} className="text-rose-400 shrink-0" />
              <span className="font-semibold">Завершить процесс</span>
            </button>

            <button
              type="button"
              onClick={() => handleProcessKill(processMenu.process, true)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-rose-300/90 hover:bg-rose-500/15 transition-colors cursor-pointer"
            >
              <Trash2 size={14} className="text-rose-400 shrink-0" />
              <span>Завершить дерево процессов</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
