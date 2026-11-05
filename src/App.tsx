import "./App.css";
import { useState, useEffect, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
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

  const buildPaths = (key: "cpu" | "ram") => {
    if (history.length === 0) return { line: "", area: "" };

    const coords = history.map((pt, idx) => {
      const x = (idx / Math.max(1, maxPoints - 1)) * width;
      const clampedVal = Math.min(100, Math.max(0, pt[key]));
      const y = height - (clampedVal / 100) * (height - 12) - 6;
      return { x, y };
    });

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

  return (
    <div className="p-5 rounded-xl bg-[#14171d] border border-zinc-800/80 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-zinc-100">
            История нагрузки (последние 60 сек)
          </h3>
          <p className="text-xs text-zinc-500 font-mono mt-0.5">
            Интервал обновления: 1 сек • {activePoint?.timestamp ?? "—"}
          </p>
        </div>

        {/* Легенда */}
        <div className="flex items-center gap-5 text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"></span>
            <span className="text-zinc-400">CPU:</span>
            <span className="text-emerald-400 font-semibold">
              {activePoint ? `${activePoint.cpu.toFixed(1)}%` : "0.0%"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]"></span>
            <span className="text-zinc-400">RAM:</span>
            <span className="text-cyan-400 font-semibold">
              {activePoint ? `${activePoint.ram.toFixed(1)}%` : "0.0%"}
            </span>
          </div>
        </div>
      </div>

      {/* Область SVG-графика */}
      <div className="relative h-48 w-full select-none">
        {/* Подписи оси Y */}
        <div className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between text-[10px] font-mono text-zinc-600 py-1 z-10">
          <span>100%</span>
          <span>75%</span>
          <span>50%</span>
          <span>25%</span>
          <span>0%</span>
        </div>

        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="w-full h-full overflow-visible rounded-lg bg-[#0d0f12]/70 border border-zinc-800/60"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const idx = Math.round(relX * (history.length - 1));
            setHoverIndex(idx);
          }}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id="cpuAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity="0.32" />
              <stop offset="100%" stopColor="#34d399" stopOpacity="0.0" />
            </linearGradient>
            <linearGradient id="ramAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.26" />
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
              strokeDasharray="4 4"
              strokeWidth="1"
            />
          ))}

          {/* Заливка и линия RAM (голубой / cyan) */}
          <path d={ramPaths.area} fill="url(#ramAreaGrad)" />
          <path
            d={ramPaths.line}
            fill="none"
            stroke="#22d3ee"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Заливка и линия CPU (зелёный / emerald) */}
          <path d={cpuPaths.area} fill="url(#cpuAreaGrad)" />
          <path
            d={cpuPaths.line}
            fill="none"
            stroke="#34d399"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Вертикальный курсор при наведении */}
          {hoverIndex !== null && history[hoverIndex] && (
            <line
              x1={(hoverIndex / Math.max(1, maxPoints - 1)) * width}
              y1={0}
              x2={(hoverIndex / Math.max(1, maxPoints - 1)) * width}
              y2={height}
              stroke="#52525b"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
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

  const isNetworkActive = metrics.net_rx_kbps > 0.1 || metrics.net_tx_kbps > 0.1;

  return (
    <div className="flex h-screen w-screen bg-[#0d0f12] text-zinc-200 select-none overflow-hidden font-sans">
      {/* Боковая панель */}
      <aside className="w-64 shrink-0 bg-[#13161b] border-r border-zinc-800/80 flex flex-col justify-between p-4">
        <div>
          <div className="flex items-center gap-3 px-3 py-4 mb-6 border-b border-zinc-800/60">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-lg">
              N
            </div>
            <div>
              <h1 className="font-bold text-base tracking-wider text-zinc-100">NEXUS PC</h1>
              <p className="text-xs text-zinc-500 font-mono">v0.1 Pre-Alpha</p>
            </div>
          </div>

          <nav className="space-y-1.5">
            <button
              onClick={() => setActiveTab("dashboard")}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === "dashboard"
                  ? "bg-zinc-800 text-emerald-400 border border-zinc-700/50 shadow-sm"
                  : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
              }`}
            >
              <LayoutDashboard size={18} />
              <span>Панель управления</span>
            </button>

            <button
              onClick={() => setActiveTab("power")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === "power"
                  ? "bg-zinc-800 text-emerald-400 border border-zinc-700/50 shadow-sm"
                  : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
              }`}
            >
              <div className="flex items-center gap-3">
                <Power size={18} />
                <span>Питание и таймер</span>
              </div>
              {timerState && remainingSeconds > 0 && (
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  {formatCountdown(remainingSeconds)}
                </span>
              )}
            </button>
          </nav>
        </div>

        <div className="px-3 py-3 rounded-lg bg-zinc-900/50 border border-zinc-800/60 text-xs text-zinc-500 flex justify-between items-center font-mono">
          <span>Служба:</span>
          <span className="text-emerald-400 flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
            sysinfo online
          </span>
        </div>
      </aside>

      {/* Основной экран */}
      <main className="flex-1 min-w-0 flex flex-col overflow-y-auto p-6 lg:p-8">
        {activeTab === "dashboard" ? (
          <div className="space-y-6 max-w-6xl w-full">
            <div>
              <h2 className="text-2xl font-bold text-zinc-100">Состояние системы</h2>
              <p className="text-sm text-zinc-400 mt-1">
                Реальные параметры компьютера и сетевая телеметрия
              </p>
            </div>

            {/* Сетка из 4 карточек */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {/* 1. CPU */}
              <div className="min-w-0 p-5 rounded-xl bg-[#14171d] border border-zinc-800/80 hover:border-zinc-700/80 transition-colors flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between text-zinc-400 mb-3 gap-2">
                    <span className="text-sm font-medium truncate">Процессор (CPU)</span>
                    <Cpu size={18} className="text-emerald-400 shrink-0" />
                  </div>
                  <div className="text-2xl 2xl:text-3xl font-bold text-zinc-100 mb-2 truncate">
                    {metrics.cpu_usage.toFixed(1)}%
                  </div>
                </div>
                <div>
                  <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-emerald-400 h-full rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(metrics.cpu_usage, 100)}%` }}
                    ></div>
                  </div>
                  <p className="text-xs text-zinc-500 mt-2 font-mono">Общая загрузка</p>
                </div>
              </div>

              {/* 2. RAM + Swap */}
              <div className="min-w-0 p-5 rounded-xl bg-[#14171d] border border-zinc-800/80 hover:border-zinc-700/80 transition-colors flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between text-zinc-400 mb-3 gap-2">
                    <span className="text-sm font-medium truncate">Оперативная память</span>
                    <Activity size={18} className="text-cyan-400 shrink-0" />
                  </div>
                  <div className="text-2xl 2xl:text-3xl font-bold text-zinc-100 mb-2 truncate">
                    {metrics.ram_used_gb.toFixed(1)} / {metrics.ram_total_gb.toFixed(0)} GB
                  </div>
                  <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-cyan-400 h-full rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(metrics.ram_percentage, 100)}%` }}
                    ></div>
                  </div>
                </div>

                {/* Компактная строка/шкала файла подкачки (Swap) */}
                <div className="mt-3 pt-2.5 border-t border-zinc-800/70 space-y-1.5">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-zinc-500">Swap (подкачка):</span>
                    <span className="text-zinc-300">
                      {metrics.swap_used_gb.toFixed(1)} / {metrics.swap_total_gb.toFixed(1)} GB
                    </span>
                  </div>
                  <div className="w-full bg-zinc-800/80 h-1 rounded-full overflow-hidden">
                    <div
                      className="bg-cyan-500/70 h-full rounded-full transition-all duration-500"
                      style={{ width: `${swapPercentage}%` }}
                    ></div>
                  </div>
                </div>
              </div>

              {/* 3. Основной накопитель */}
              <div className="min-w-0 p-5 rounded-xl bg-[#14171d] border border-zinc-800/80 hover:border-zinc-700/80 transition-colors flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between text-zinc-400 mb-3 gap-2">
                    <span className="text-sm font-medium truncate">Основной накопитель</span>
                    <HardDrive size={18} className="text-emerald-400 shrink-0" />
                  </div>
                  <div className="text-2xl 2xl:text-3xl font-bold text-zinc-100 mb-2 truncate">
                    {metrics.disk_free_gb} GB своб.
                  </div>
                </div>
                <div>
                  <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-emerald-400 h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${
                          metrics.disk_total_gb > 0
                            ? ((metrics.disk_total_gb - metrics.disk_free_gb) /
                                metrics.disk_total_gb) *
                              100
                            : 0
                        }%`,
                      }}
                    ></div>
                  </div>
                  <p className="text-xs text-zinc-500 mt-2 font-mono">
                    Всего: {metrics.disk_total_gb} GB
                  </p>
                </div>
              </div>

              {/* 4. Сеть (Network) */}
              <div className="min-w-0 p-5 rounded-xl bg-[#14171d] border border-zinc-800/80 hover:border-zinc-700/80 transition-colors flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between text-zinc-400 mb-3 gap-2">
                    <span className="text-sm font-medium truncate">Сеть (Network)</span>
                    <Wifi size={18} className="text-emerald-400 shrink-0" />
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

                <div className="pt-2.5 mt-2 border-t border-zinc-800/70 flex items-center justify-between text-xs font-mono">
                  <span className="text-zinc-500">Статус:</span>
                  <span
                    className={`flex items-center gap-1.5 ${
                      isNetworkActive ? "text-emerald-400" : "text-zinc-400"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        isNetworkActive ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"
                      }`}
                    ></span>
                    {isNetworkActive ? "Активен обмен" : "Ожидание"}
                  </span>
                </div>
              </div>
            </div>

            {/* Блок «История нагрузки (последние 60 сек)» */}
            <LoadHistoryChart history={history} />
          </div>
        ) : (
          <div className="space-y-6 max-w-2xl w-full">
            <div>
              <h2 className="text-2xl font-bold text-zinc-100">Управление питанием</h2>
              <p className="text-sm text-zinc-400 mt-1">
                Таймеры автоматического выключения и перезагрузки Windows
              </p>
            </div>

            <div className="p-6 rounded-xl bg-[#14171d] border border-zinc-800/80 space-y-6">
              {/* Заголовок и переключатель режима */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-zinc-800/60">
                <div className="flex items-center gap-3 text-zinc-200">
                  <Clock className="text-emerald-400 shrink-0" size={20} />
                  <span className="font-medium text-base">Режим действия</span>
                </div>

                <div className="inline-flex rounded-lg bg-zinc-900 p-1 border border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setRestartMode(false)}
                    className={`flex items-center gap-2 px-3.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                      !restartMode
                        ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <Power size={14} />
                    <span>Выключение</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRestartMode(true)}
                    className={`flex items-center gap-2 px-3.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                      restartMode
                        ? "bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-sm"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <RotateCcw size={14} />
                    <span>Перезагрузка</span>
                  </button>
                </div>
              </div>

              {/* Быстрые пресеты */}
              <div className="space-y-2.5">
                <label className="block text-xs font-mono uppercase tracking-wider text-zinc-400">
                  Быстрый запуск
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {PRESET_MINUTES.map((mins) => (
                    <button
                      key={mins}
                      type="button"
                      onClick={() => handleStartTimer(mins)}
                      className="py-2.5 px-3 rounded-lg bg-zinc-800/90 hover:bg-zinc-700/80 active:scale-[0.98] text-zinc-200 text-sm font-medium transition-all border border-zinc-700/50 hover:border-emerald-500/40"
                    >
                      {mins} мин
                    </button>
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
                    className="flex-1 px-3.5 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder-zinc-500 text-sm focus:outline-none focus:border-emerald-500/50 transition-colors"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 text-sm font-medium transition-all cursor-pointer"
                  >
                    <Play size={16} />
                    <span>Запустить таймер</span>
                  </button>
                </div>
              </form>

              {powerError && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-mono">
                  {powerError}
                </div>
              )}

              {/* Активный таймер и живой обратный отсчет */}
              {timerState && remainingSeconds > 0 && (
                <div className="p-5 rounded-xl bg-zinc-900/90 border border-zinc-800 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <span className="text-xs font-mono uppercase tracking-wider text-zinc-400">
                        Активный таймер:{" "}
                        <strong
                          className={
                            timerState.restart ? "text-amber-400" : "text-emerald-400"
                          }
                        >
                          {timerState.restart ? "Перезагрузка" : "Выключение"}
                        </strong>
                      </span>
                      <div className="text-3xl sm:text-4xl font-bold font-mono text-zinc-100 mt-1 tracking-tight">
                        {formatCountdown(remainingSeconds)}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={handleCancelTimer}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/30 text-sm font-medium transition-all cursor-pointer"
                    >
                      <XCircle size={16} />
                      <span>Отменить таймер</span>
                    </button>
                  </div>

                  <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        timerState.restart ? "bg-amber-400" : "bg-emerald-400"
                      }`}
                      style={{ width: `${timerProgress}%` }}
                    ></div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
