import "./App.css";
import { useState, useEffect } from "react";
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
} from "lucide-react";

interface Metrics {
  cpu_usage: number;
  ram_used_gb: number;
  ram_total_gb: number;
  ram_percentage: number;
  disk_free_gb: number;
  disk_total_gb: number;
}

interface StoredTimerState {
  endTime: number;
  totalSeconds: number;
  restart: boolean;
}

const TIMER_STORAGE_KEY = "nexus_power_timer";
const PRESET_MINUTES = [15, 30, 45, 60];

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

export default function App() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "power">("dashboard");
  const [metrics, setMetrics] = useState<Metrics>({
    cpu_usage: 0,
    ram_used_gb: 0,
    ram_total_gb: 0,
    ram_percentage: 0,
    disk_free_gb: 0,
    disk_total_gb: 0,
  });

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
    // Опрашиваем Rust раз в секунду
    const fetchMetrics = async () => {
      try {
        const data = await invoke<Metrics>("get_system_metrics");
        setMetrics(data);
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
          <div className="space-y-6 max-w-5xl w-full">
            <div>
              <h2 className="text-2xl font-bold text-zinc-100">Состояние системы</h2>
              <p className="text-sm text-zinc-400 mt-1">Реальные параметры компьютера</p>
            </div>

            {/* Адаптивная сетка карточек с корректными отступами */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* CPU */}
              <div className="min-w-0 p-5 rounded-xl bg-[#14171d] border border-zinc-800/80 hover:border-zinc-700/80 transition-colors">
                <div className="flex items-center justify-between text-zinc-400 mb-3 gap-2">
                  <span className="text-sm font-medium truncate">Процессор (CPU)</span>
                  <Cpu size={18} className="text-emerald-400 shrink-0" />
                </div>
                <div className="text-2xl xl:text-3xl font-bold text-zinc-100 mb-2 truncate">
                  {metrics.cpu_usage.toFixed(1)}%
                </div>
                <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-emerald-400 h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(metrics.cpu_usage, 100)}%` }}
                  ></div>
                </div>
                <p className="text-xs text-zinc-500 mt-2 font-mono">Общая загрузка</p>
              </div>

              {/* RAM */}
              <div className="min-w-0 p-5 rounded-xl bg-[#14171d] border border-zinc-800/80 hover:border-zinc-700/80 transition-colors">
                <div className="flex items-center justify-between text-zinc-400 mb-3 gap-2">
                  <span className="text-sm font-medium truncate">Оперативная память</span>
                  <Activity size={18} className="text-emerald-400 shrink-0" />
                </div>
                <div className="text-2xl xl:text-3xl font-bold text-zinc-100 mb-2 truncate">
                  {metrics.ram_used_gb.toFixed(1)} / {metrics.ram_total_gb.toFixed(0)} GB
                </div>
                <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-emerald-400 h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(metrics.ram_percentage, 100)}%` }}
                  ></div>
                </div>
                <p className="text-xs text-zinc-500 mt-2 font-mono">
                  {metrics.ram_percentage.toFixed(0)}% занято
                </p>
              </div>

              {/* Storage */}
              <div className="min-w-0 p-5 rounded-xl bg-[#14171d] border border-zinc-800/80 hover:border-zinc-700/80 transition-colors">
                <div className="flex items-center justify-between text-zinc-400 mb-3 gap-2">
                  <span className="text-sm font-medium truncate">Основной накопитель</span>
                  <HardDrive size={18} className="text-emerald-400 shrink-0" />
                </div>
                <div className="text-2xl xl:text-3xl font-bold text-zinc-100 mb-2 truncate">
                  {metrics.disk_free_gb} GB своб.
                </div>
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
