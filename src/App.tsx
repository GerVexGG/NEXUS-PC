import "./App.css";
import { useState, useEffect, memo, type ReactNode, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  Flame,
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

// Варианты каскадной анимации карточек
const cardsContainerVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.02,
    },
  },
};

const cardItemVariants: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.985 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: "spring",
      stiffness: 320,
      damping: 26,
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

function formatNetworkSpeed(kbps: number): string {
  if (!Number.isFinite(kbps) || kbps <= 0) {
    return "0.0 КБ/с";
  }
  if (kbps >= 1024) {
    return `${(kbps / 1024).toFixed(2)} МБ/с`;
  }
  return `${kbps.toFixed(1)} КБ/с`;
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
      badgeClass: "bg-zinc-800/80 text-zinc-400 border-white/[0.08]",
      textClass: "text-zinc-400",
      barClass: "bg-zinc-600",
      label: "Н/Д",
    };
  }
  if (tempC > 80) {
    return {
      badgeClass:
        "bg-rose-500/15 text-rose-400 border-rose-500/35 shadow-[0_0_14px_rgba(244,63,94,0.25)]",
      textClass: "text-rose-400",
      barClass:
        "bg-gradient-to-r from-rose-500 to-red-400 shadow-[0_0_12px_rgba(244,63,94,0.6)]",
      label: "Горячо",
    };
  }
  if (tempC >= 65) {
    return {
      badgeClass:
        "bg-amber-500/15 text-amber-400 border-amber-500/35 shadow-[0_0_14px_rgba(245,158,11,0.2)]",
      textClass: "text-amber-400",
      barClass:
        "bg-gradient-to-r from-amber-500 to-yellow-400 shadow-[0_0_12px_rgba(245,158,11,0.5)]",
      label: "Нагрузка",
    };
  }
  return {
    badgeClass:
      "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 shadow-[0_0_14px_rgba(52,211,153,0.18)]",
    textClass: "text-emerald-400",
    barClass:
      "bg-gradient-to-r from-emerald-500 to-teal-400 shadow-[0_0_12px_rgba(52,211,153,0.45)]",
    label: "Норма",
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
): { barClass: string; badgeTextClass: string } {
  if (percentage > 90) {
    return {
      barClass:
        "bg-gradient-to-r from-rose-500 to-red-400 shadow-[0_0_12px_rgba(244,63,94,0.65)]",
      badgeTextClass: "text-rose-400",
    };
  }
  if (percentage > 70) {
    return {
      barClass:
        "bg-gradient-to-r from-amber-500 to-yellow-400 shadow-[0_0_12px_rgba(245,158,11,0.55)]",
      badgeTextClass: "text-amber-400",
    };
  }
  if (defaultTheme === "cyan") {
    return {
      barClass:
        "bg-gradient-to-r from-cyan-500 to-sky-400 shadow-[0_0_12px_rgba(34,211,238,0.45)]",
      badgeTextClass: "text-cyan-400",
    };
  }
  return {
    barClass:
      "bg-gradient-to-r from-emerald-500 to-teal-400 shadow-[0_0_12px_rgba(52,211,153,0.45)]",
    badgeTextClass: "text-emerald-400",
  };
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

// Карточка с эффектом направленного света (Spotlight Glow Card) без лишних ререндеров
interface SpotlightCardProps {
  children: ReactNode;
  className?: string;
  spotlightColor?: string;
  variants?: Variants;
}

function SpotlightCard({
  children,
  className = "",
  spotlightColor = "rgba(52, 211, 153, 0.13)",
  variants,
}: SpotlightCardProps) {
  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    e.currentTarget.style.setProperty("--mouse-x", `${x}px`);
    e.currentTarget.style.setProperty("--mouse-y", `${y}px`);
  };

  return (
    <motion.div
      variants={variants}
      onMouseMove={handleMouseMove}
      style={
        {
          "--spotlight-color": spotlightColor,
        } as React.CSSProperties
      }
      className={`group relative overflow-hidden rounded-2xl backdrop-blur-xl bg-zinc-900/60 border border-white/5 hover:border-white/10 transition-colors duration-300 shadow-[0_8px_30px_rgb(0,0,0,0.35)] ${className}`}
    >
      {/* Направленный радиальный свет за курсором */}
      <div
        className="pointer-events-none absolute -inset-px opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          background:
            "radial-gradient(340px circle at var(--mouse-x, 0px) var(--mouse-y, 0px), var(--spotlight-color), transparent 80%)",
        }}
      />
      {/* Тонкий верхний блик стекла */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
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
    "dashboard" | "startup" | "storage" | "hardware" | "power"
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
  });
  const [history, setHistory] = useState<HistoryPoint[]>(createInitialHistory);

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

  return (
    <div className="relative flex h-screen w-screen bg-[#0a0c10] text-zinc-200 select-none overflow-hidden font-sans">
      {/* Фоновое кибер-графитовое ambient-свечение для глубины стекла */}
      <div className="pointer-events-none absolute -top-36 left-48 h-96 w-96 rounded-full bg-emerald-500/[0.06] blur-[120px]" />
      <div className="pointer-events-none absolute bottom-0 right-12 h-96 w-96 rounded-full bg-cyan-500/[0.05] blur-[130px]" />

      {/* Боковая панель */}
      <aside className="relative z-20 w-64 shrink-0 backdrop-blur-2xl bg-[#101318]/85 border-r border-white/[0.06] flex flex-col justify-between p-4">
        <div>
          <div className="flex items-center gap-3 px-3 py-4 mb-6 border-b border-white/[0.06]">
            <div className="relative h-9 w-9 rounded-xl bg-emerald-500/15 border border-emerald-400/30 flex items-center justify-center text-emerald-400 font-bold text-lg shadow-[0_0_20px_rgba(52,211,153,0.2)]">
              N
            </div>
            <div>
              <h1 className="font-bold text-base tracking-wider text-zinc-100">NEXUS PC</h1>
              <p className="text-[11px] text-zinc-500 font-mono">v0.1 Cyber-Graphite</p>
            </div>
          </div>

          <nav className="space-y-2">
            {/* 1. Кнопка вкладки Dashboard */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("dashboard")}
              className={`relative w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                activeTab === "dashboard"
                  ? "text-emerald-400"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "dashboard" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  className="absolute inset-0 rounded-xl bg-gradient-to-r from-emerald-500/15 via-zinc-800/80 to-zinc-800/50 border border-emerald-500/25 shadow-[0_0_20px_rgba(52,211,153,0.12)]"
                />
              )}
              <span className="relative z-10 flex items-center gap-3">
                <LayoutDashboard size={18} />
                <span>Панель управления</span>
              </span>
            </motion.button>

            {/* 2. Кнопка вкладки Startup Manager */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("startup")}
              className={`relative w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                activeTab === "startup"
                  ? "text-emerald-400"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "startup" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  className="absolute inset-0 rounded-xl bg-gradient-to-r from-emerald-500/15 via-zinc-800/80 to-zinc-800/50 border border-emerald-500/25 shadow-[0_0_20px_rgba(52,211,153,0.12)]"
                />
              )}
              <span className="relative z-10 flex items-center gap-3">
                <Rocket size={18} />
                <span>Автозагрузка</span>
              </span>
              {brokenStartupCount > 0 && (
                <span className="relative z-10 text-[11px] font-mono px-1.5 py-0.5 rounded-md bg-rose-500/15 text-rose-400 border border-rose-500/30">
                  {brokenStartupCount}
                </span>
              )}
            </motion.button>

            {/* 3. Кнопка вкладки Storage Analyzer */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("storage")}
              className={`relative w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                activeTab === "storage"
                  ? "text-emerald-400"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "storage" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  className="absolute inset-0 rounded-xl bg-gradient-to-r from-emerald-500/15 via-zinc-800/80 to-zinc-800/50 border border-emerald-500/25 shadow-[0_0_20px_rgba(52,211,153,0.12)]"
                />
              )}
              <span className="relative z-10 flex items-center gap-3">
                <PieChart size={18} />
                <span>Анализатор дисков</span>
              </span>
              {isScanning && (
                <Loader2
                  size={14}
                  className="relative z-10 animate-spin text-emerald-400"
                />
              )}
            </motion.button>

            {/* 4. Кнопка вкладки Hardware Monitor («Железо») */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("hardware")}
              className={`relative w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                activeTab === "hardware"
                  ? "text-emerald-400"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "hardware" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  className="absolute inset-0 rounded-xl bg-gradient-to-r from-emerald-500/15 via-zinc-800/80 to-zinc-800/50 border border-emerald-500/25 shadow-[0_0_20px_rgba(52,211,153,0.12)]"
                />
              )}
              <span className="relative z-10 flex items-center gap-3">
                <Gauge size={18} />
                <span>Железо</span>
              </span>
              {thermalWarnings.length > 0 && (
                <span className="relative z-10 h-2 w-2 rounded-full bg-rose-500 shadow-[0_0_8px_#f43f5e] animate-ping" />
              )}
            </motion.button>

            {/* 5. Кнопка вкладки Power Manager */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveTab("power")}
              className={`relative w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                activeTab === "power"
                  ? "text-emerald-400"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {activeTab === "power" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  className="absolute inset-0 rounded-xl bg-gradient-to-r from-emerald-500/15 via-zinc-800/80 to-zinc-800/50 border border-emerald-500/25 shadow-[0_0_20px_rgba(52,211,153,0.12)]"
                />
              )}
              <span className="relative z-10 flex items-center gap-3">
                <Power size={18} />
                <span>Питание и таймер</span>
              </span>
              {timerState && remainingSeconds > 0 && (
                <span className="relative z-10 text-xs font-mono px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-[0_0_10px_rgba(52,211,153,0.25)]">
                  {formatCountdown(remainingSeconds)}
                </span>
              )}
            </motion.button>
          </nav>
        </div>

        {/* Пульсирующий неоновый индикатор службы внизу сайдбара */}
        <div className="px-3.5 py-3 rounded-xl backdrop-blur-md bg-zinc-900/70 border border-white/[0.06] text-xs text-zinc-400 flex justify-between items-center font-mono shadow-inner">
          <span>Служба:</span>
          <span className="text-emerald-400 flex items-center gap-2 drop-shadow-[0_0_8px_rgba(52,211,153,0.45)]">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400 shadow-[0_0_10px_#34d399]"></span>
            </span>
            sysinfo + hwmon
          </span>
        </div>
      </aside>

      {/* Основной экран с кинематографичным переходом */}
      <main className="relative z-10 flex-1 min-w-0 flex flex-col overflow-y-auto p-6 lg:p-8">
        <AnimatePresence mode="wait">
          {activeTab === "dashboard" && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="space-y-6 max-w-6xl w-full"
            >
              <div>
                <h2 className="text-2xl font-bold text-zinc-100 tracking-tight">
                  Состояние системы
                </h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Реальные параметры компьютера и сетевая телеметрия
                </p>
              </div>

              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4"
              >
                {/* 1. CPU */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(52, 211, 153, 0.14)"
                  className="min-w-0 p-5"
                >
                  <div>
                    <div className="flex items-center justify-between text-zinc-400 mb-3 gap-2">
                      <span className="text-sm font-medium truncate">Процессор (CPU)</span>
                      <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                        <Cpu size={16} className={cpuLoadStyles.badgeTextClass} />
                      </div>
                    </div>
                    <div className="text-2xl 2xl:text-3xl font-bold text-zinc-100 mb-3 truncate tracking-tight">
                      {metrics.cpu_usage.toFixed(1)}%
                    </div>
                  </div>
                  <div>
                    <div className="w-full bg-zinc-800/80 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${cpuLoadStyles.barClass}`}
                        style={{ width: `${Math.min(metrics.cpu_usage, 100)}%` }}
                      ></div>
                    </div>
                    <div className="flex items-center justify-between text-xs text-zinc-500 mt-2.5 font-mono">
                      <span>Общая загрузка</span>
                      <span className={cpuLoadStyles.badgeTextClass}>
                        {metrics.cpu_usage > 90
                          ? "Критическая"
                          : metrics.cpu_usage > 70
                          ? "Высокая"
                          : "Норма"}
                      </span>
                    </div>
                  </div>
                </SpotlightCard>

                {/* 2. RAM + Swap */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(34, 211, 238, 0.14)"
                  className="min-w-0 p-5"
                >
                  <div>
                    <div className="flex items-center justify-between text-zinc-400 mb-3 gap-2">
                      <span className="text-sm font-medium truncate">
                        Оперативная память
                      </span>
                      <div className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
                        <Activity size={16} className={ramLoadStyles.badgeTextClass} />
                      </div>
                    </div>
                    <div className="text-2xl 2xl:text-3xl font-bold text-zinc-100 mb-3 truncate tracking-tight">
                      {metrics.ram_used_gb.toFixed(1)} / {metrics.ram_total_gb.toFixed(0)} GB
                    </div>
                    <div className="w-full bg-zinc-800/80 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${ramLoadStyles.barClass}`}
                        style={{ width: `${Math.min(metrics.ram_percentage, 100)}%` }}
                      ></div>
                    </div>
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-white/[0.06] space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-zinc-500">Swap (подкачка):</span>
                      <span className="text-zinc-300">
                        {metrics.swap_used_gb.toFixed(1)} / {metrics.swap_total_gb.toFixed(1)} GB
                      </span>
                    </div>
                    <div className="w-full bg-zinc-800/80 h-1 rounded-full overflow-hidden">
                      <div
                        className="bg-cyan-400/75 h-full rounded-full transition-all duration-500"
                        style={{ width: `${swapPercentage}%` }}
                      ></div>
                    </div>
                  </div>
                </SpotlightCard>

                {/* 3. Основной накопитель */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(52, 211, 153, 0.14)"
                  className="min-w-0 p-5"
                >
                  <div>
                    <div className="flex items-center justify-between text-zinc-400 mb-3 gap-2">
                      <span className="text-sm font-medium truncate">
                        Основной накопитель
                      </span>
                      <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                        <HardDrive size={16} className={diskLoadStyles.badgeTextClass} />
                      </div>
                    </div>
                    <div className="text-2xl 2xl:text-3xl font-bold text-zinc-100 mb-3 truncate tracking-tight">
                      {metrics.disk_free_gb} GB своб.
                    </div>
                  </div>
                  <div>
                    <div className="w-full bg-zinc-800/80 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${diskLoadStyles.barClass}`}
                        style={{ width: `${diskUsedPercentage}%` }}
                      ></div>
                    </div>
                    <p className="text-xs text-zinc-500 mt-2.5 font-mono">
                      Всего: {metrics.disk_total_gb} GB ({diskUsedPercentage.toFixed(0)}% исп.)
                    </p>
                  </div>
                </SpotlightCard>

                {/* 4. Сеть (Network) */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(34, 211, 238, 0.14)"
                  className="min-w-0 p-5"
                >
                  <div>
                    <div className="flex items-center justify-between text-zinc-400 mb-3 gap-2">
                      <span className="text-sm font-medium truncate">Сеть (Network)</span>
                      <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                        <Wifi size={16} className="text-emerald-400" />
                      </div>
                    </div>

                    <div className="space-y-2 my-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1.5 text-zinc-400 font-mono text-xs">
                          <ArrowDown size={14} className="text-emerald-400" />
                          Download
                        </span>
                        <span className="font-bold font-mono text-zinc-100">
                          {formatNetworkSpeed(metrics.net_rx_kbps)}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1.5 text-zinc-400 font-mono text-xs">
                          <ArrowUp size={14} className="text-cyan-400" />
                          Upload
                        </span>
                        <span className="font-bold font-mono text-zinc-100">
                          {formatNetworkSpeed(metrics.net_tx_kbps)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2.5 mt-2 border-t border-white/[0.06] flex items-center justify-between text-xs font-mono">
                    <span className="text-zinc-500">Статус:</span>
                    <span
                      className={`flex items-center gap-1.5 ${
                        isNetworkActive ? "text-emerald-400" : "text-zinc-400"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          isNetworkActive
                            ? "bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse"
                            : "bg-zinc-600"
                        }`}
                      ></span>
                      {isNetworkActive ? "Активен обмен" : "Ожидание"}
                    </span>
                  </div>
                </SpotlightCard>
              </motion.div>

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

                          {/* Индикатор вертушек GPU (RPM и шкала %) */}
                          <div className="p-3.5 rounded-xl bg-zinc-950/80 border border-white/[0.06] space-y-2">
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
                              <div className="flex items-center gap-3">
                                <span className="text-zinc-100 font-bold">
                                  {gpu.fan_rpm != null
                                    ? `${gpu.fan_rpm.toFixed(0)} RPM`
                                    : "0 RPM (Zero Fan)"}
                                </span>
                                <span className="text-cyan-400 font-semibold">
                                  {gpu.fan_percent != null
                                    ? `${gpu.fan_percent.toFixed(0)}%`
                                    : "0%"}
                                </span>
                              </div>
                            </div>
                            <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                              <div
                                style={{ width: `${fanPct}%` }}
                                className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 rounded-full transition-all duration-500"
                              />
                            </div>
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
  );
}
