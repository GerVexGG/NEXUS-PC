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

// Варианты каскадной анимации карточек
const cardsContainerVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.07,
      delayChildren: 0.03,
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
          {/* Подписи оси Y */}
          <div className="pointer-events-none absolute inset-y-0 left-2 flex flex-col justify-between text-[10px] font-mono text-zinc-500/80 py-2 z-10">
            <span>100%</span>
            <span>75%</span>
            <span>50%</span>
            <span>25%</span>
            <span>0%</span>
          </div>

          {/* Анимированный плавающий бейдж при наведении */}
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
              {/* Неоновый фильтр свечения для линий CPU и RAM */}
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

            {/* Горизонтальная сетка */}
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

            {/* Заливка и неоновая линия RAM (голубой / cyan) */}
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

            {/* Заливка и неоновая линия CPU (зелёный / emerald) */}
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

            {/* Анимированное перекрестие и узловые точки при наведении */}
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

          {/* Подписи оси X */}
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
  const [activeTab, setActiveTab] = useState<"dashboard" | "power">("dashboard");
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
            {/* Кнопка вкладки Dashboard */}
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

            {/* Кнопка вкладки Power Manager */}
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
            sysinfo online
          </span>
        </div>
      </aside>

      {/* Основной экран с кинематографичным переходом */}
      <main className="relative z-10 flex-1 min-w-0 flex flex-col overflow-y-auto p-6 lg:p-8">
        <AnimatePresence mode="wait">
          {activeTab === "dashboard" ? (
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

              {/* Каскадная сетка из 4 Spotlight-карточек */}
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

                  {/* Компактная строка/шкала файла подкачки (Swap) */}
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

              {/* Блок «История нагрузки (последние 60 сек)» */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
              >
                <LoadHistoryChart history={history} />
              </motion.div>
            </motion.div>
          ) : (
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
                  {/* Заголовок и переключатель режима */}
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

                  {/* Быстрые пресеты с интерактивным spring-откликом */}
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

                  {/* Произвольное время */}
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

                  {/* Активный таймер и живой обратный отсчет */}
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
