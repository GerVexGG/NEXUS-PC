import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard, Power, Rocket, PieChart, Loader2, Gauge, Trash2, Layers, Globe, Smartphone,
} from "lucide-react";
import { useNexusController } from "./hooks/useNexusController";
import {
  formatCountdown,
} from "./lib/studio";
import { TitleBar } from "./components/TitleBar";
import { DashboardModule } from "./components/modules/DashboardModule";
import { StartupModule } from "./components/modules/StartupModule";
import { StorageModule } from "./components/modules/StorageModule";
import { HardwareModule } from "./components/modules/HardwareModule";
import { CleanupModule } from "./components/modules/CleanupModule";
import { PowerModule } from "./components/modules/PowerModule";
import { ProcessModule } from "./components/modules/ProcessModule";
import { NetworkModule } from "./components/modules/NetworkModule";
import { DropModule } from "./components/modules/DropModule";
import "./App.css";

export default function App() {
  const c = useNexusController();

  return (
    <div className="relative flex flex-col h-screen w-screen rounded-3xl overflow-hidden border border-[#222b38] bg-[#07080b] obsidian-grid-bg text-[#e8edf4] select-none font-sans">
      <div className="pointer-events-none absolute -top-40 left-40 h-96 w-96 rounded-full bg-sky-500/[0.05] blur-[130px]" />
      <div className="pointer-events-none absolute bottom-0 right-10 h-96 w-96 rounded-full bg-cyan-500/[0.045] blur-[140px]" />

      <TitleBar
        isElevatedAdmin={c.isElevatedAdmin}
        adminMenuOpen={c.adminMenuOpen}
        setAdminMenuOpen={c.setAdminMenuOpen}
        adminError={c.adminError}
        onRestartAsAdmin={c.handleRestartAsAdmin}
        onToggleMaximize={c.handleWindowToggleMaximize}
        onClose={c.handleWindowClose}
      />

      {/* Рабочая область под кастомным тайтлбаром */}
      <div className="relative z-10 flex flex-1 min-h-0 overflow-hidden">
      {/* Компактная строгая боковая панель Obsidian Cyber-HUD */}
      <aside className="relative z-20 w-60 shrink-0 backdrop-blur-2xl bg-[#0e1118]/95 border-r border-white/[0.07] flex flex-col justify-between p-3.5">
        <div>
          <div className="flex items-center justify-between px-2.5 py-3 mb-5 border-b border-white/[0.07]">
            <div className="flex items-center gap-2.5">
              <div className="relative h-8 w-8 rounded-lg bg-sky-500/15 border border-sky-400/40 flex items-center justify-center text-sky-400 font-mono font-extrabold text-base shadow-[0_0_18px_rgba(56,189,248,0.25)]">
                N
                <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 bg-sky-400 rounded-full shadow-[0_0_6px_#38bdf8]" />
              </div>
              <div>
                <h1 className="font-mono font-bold text-sm tracking-[0.14em] text-[#e8edf4]">
                  NEXUS // HUD
                </h1>
                <p className="text-[10px] text-[#8793a5] font-mono uppercase tracking-wider">
                  SYS.VER 0.1 • OBSIDIAN
                </p>
              </div>
            </div>
          </div>

          <div className="px-2 mb-2 text-[10px] font-mono uppercase tracking-[0.18em] text-[#8793a5]">
            МОДУЛИ СИСТЕМЫ
          </div>

          <nav className="space-y-1.5">
            {/* 1. Кнопка вкладки Dashboard */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => c.setActiveTab("dashboard")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                c.activeTab === "dashboard"
                  ? "text-sky-300 font-semibold"
                  : "text-[#8793a5] hover:text-[#d5dde8]"
              }`}
            >
              {c.activeTab === "dashboard" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-sky-500/20 via-sky-500/[0.07] to-transparent border border-sky-500/30 shadow-[0_0_18px_rgba(56,189,248,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <LayoutDashboard size={15} />
                <span>ТЕЛЕМЕТРИЯ</span>
              </span>
              <span className="relative z-10 text-[10px] text-[#8793a5]">01</span>
            </motion.button>

            {/* 2. Кнопка вкладки Startup Manager */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => c.setActiveTab("startup")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                c.activeTab === "startup"
                  ? "text-sky-300 font-semibold"
                  : "text-[#8793a5] hover:text-[#d5dde8]"
              }`}
            >
              {c.activeTab === "startup" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-sky-500/20 via-sky-500/[0.07] to-transparent border border-sky-500/30 shadow-[0_0_18px_rgba(56,189,248,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Rocket size={15} />
                <span>АВТОЗАГРУЗКА</span>
              </span>
              {c.brokenStartupCount > 0 ? (
                <span className="relative z-10 text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/35">
                  !{c.brokenStartupCount}
                </span>
              ) : (
                <span className="relative z-10 text-[10px] text-[#8793a5]">02</span>
              )}
            </motion.button>

            {/* 3. Кнопка вкладки Storage Analyzer */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => c.setActiveTab("storage")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                c.activeTab === "storage"
                  ? "text-sky-300 font-semibold"
                  : "text-[#8793a5] hover:text-[#d5dde8]"
              }`}
            >
              {c.activeTab === "storage" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-sky-500/20 via-sky-500/[0.07] to-transparent border border-sky-500/30 shadow-[0_0_18px_rgba(56,189,248,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <PieChart size={15} />
                <span>ДИСКОВЫЙ РАДАР</span>
              </span>
              {c.isScanning ? (
                <Loader2
                  size={13}
                  className="relative z-10 animate-spin text-sky-400"
                />
              ) : (
                <span className="relative z-10 text-[10px] text-[#8793a5]">03</span>
              )}
            </motion.button>

            {/* 4. Кнопка вкладки Hardware Monitor («Железо») */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => c.setActiveTab("hardware")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                c.activeTab === "hardware"
                  ? "text-sky-300 font-semibold"
                  : "text-[#8793a5] hover:text-[#d5dde8]"
              }`}
            >
              {c.activeTab === "hardware" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-sky-500/20 via-sky-500/[0.07] to-transparent border border-sky-500/30 shadow-[0_0_18px_rgba(56,189,248,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Gauge size={15} />
                <span>ДАТЧИКИ ЖЕЛЕЗА</span>
              </span>
              {c.thermalWarnings.length > 0 ? (
                <span className="relative z-10 h-2 w-2 rounded-full bg-rose-500 shadow-[0_0_8px_#f43f5e] animate-ping" />
              ) : (
                <span className="relative z-10 text-[10px] text-[#8793a5]">04</span>
              )}
            </motion.button>

            {/* 5. Кнопка вкладки Cleanup Center («Очистка») */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => c.setActiveTab("cleanup")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                c.activeTab === "cleanup"
                  ? "text-sky-300 font-semibold"
                  : "text-[#8793a5] hover:text-[#d5dde8]"
              }`}
            >
              {c.activeTab === "cleanup" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-sky-500/20 via-sky-500/[0.07] to-transparent border border-sky-500/30 shadow-[0_0_18px_rgba(56,189,248,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Trash2 size={15} />
                <span>ОЧИСТКА</span>
              </span>
              {c.isScanningCleanup || c.isCleaning ? (
                <Loader2
                  size={13}
                  className="relative z-10 animate-spin text-sky-400"
                />
              ) : (
                <span className="relative z-10 text-[10px] text-[#8793a5]">05</span>
              )}
            </motion.button>

            {/* 6. Кнопка вкладки Power Manager */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => c.setActiveTab("power")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                c.activeTab === "power"
                  ? "text-sky-300 font-semibold"
                  : "text-[#8793a5] hover:text-[#d5dde8]"
              }`}
            >
              {c.activeTab === "power" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-sky-500/20 via-sky-500/[0.07] to-transparent border border-sky-500/30 shadow-[0_0_18px_rgba(56,189,248,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Power size={15} />
                <span>ПИТАНИЕ // ТАЙМЕР</span>
              </span>
              {c.timerState && c.remainingSeconds > 0 ? (
                <span className="relative z-10 text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/35">
                  {formatCountdown(c.remainingSeconds)}
                </span>
              ) : (
                <span className="relative z-10 text-[10px] text-[#8793a5]">06</span>
              )}
            </motion.button>

            {/* 7. Кнопка вкладки Process Explorer («Процессы») */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => c.setActiveTab("processes")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                c.activeTab === "processes"
                  ? "text-sky-300 font-semibold"
                  : "text-[#8793a5] hover:text-[#d5dde8]"
              }`}
            >
              {c.activeTab === "processes" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-sky-500/20 via-sky-500/[0.07] to-transparent border border-sky-500/30 shadow-[0_0_18px_rgba(56,189,248,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Layers size={15} />
                <span>ПРОЦЕССЫ</span>
              </span>
              {c.suspendedPids.length > 0 ? (
                <span className="relative z-10 text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/35">
                  ❄{c.suspendedPids.length}
                </span>
              ) : (
                <span className="relative z-10 text-[10px] text-[#8793a5]">07</span>
              )}
            </motion.button>

            {/* 8. Кнопка вкладки Network Analyzer */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => c.setActiveTab("network")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                c.activeTab === "network"
                  ? "text-sky-300 font-semibold"
                  : "text-[#8793a5] hover:text-[#d5dde8]"
              }`}
            >
              {c.activeTab === "network" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-sky-500/20 via-sky-500/[0.07] to-transparent border border-sky-500/30 shadow-[0_0_18px_rgba(56,189,248,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Globe size={15} />
                <span>СЕТЬ</span>
              </span>
              <span className="relative z-10 text-[10px] text-[#8793a5]">08</span>
            </motion.button>

            {/* 9. Кнопка вкладки NEXUS Drop */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => c.setActiveTab("drop")}
              className={`relative w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono tracking-wide transition-colors cursor-pointer ${
                c.activeTab === "drop"
                  ? "text-sky-300 font-semibold"
                  : "text-[#8793a5] hover:text-[#d5dde8]"
              }`}
            >
              {c.activeTab === "drop" && (
                <motion.div
                  layoutId="activeTabPill"
                  transition={{ type: "spring", stiffness: 460, damping: 32 }}
                  className="absolute inset-0 rounded-lg bg-gradient-to-r from-sky-500/20 via-sky-500/[0.07] to-transparent border border-sky-500/30 shadow-[0_0_18px_rgba(56,189,248,0.12)]"
                >
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
                </motion.div>
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Smartphone size={15} />
                <span>NEXUS DROP</span>
              </span>
              <span className="relative z-10 text-[10px] text-[#8793a5]">09</span>
            </motion.button>
          </nav>
        </div>

        {/* Нижний приборный блок статуса ядра и пинга */}
        <div className="space-y-2">
          <div className="px-3 py-2 rounded-lg bg-[#151c27] border border-white/[0.06] flex items-center justify-between text-[11px] font-mono">
            <span className="text-[#8793a5]">PING:</span>
            <span className={`font-bold tabular-nums ${c.pingStyle.colorClass}`}>
              {c.metrics.net_ping_ms > 0 ? `${c.metrics.net_ping_ms} MS` : "OFFLINE"}
            </span>
          </div>

          <div className="px-3 py-2.5 rounded-lg bg-[#151c27] border border-white/[0.06] text-[11px] text-[#8793a5] flex justify-between items-center font-mono">
            <span className="text-[#8793a5]">ЯДРО:</span>
            <span className="text-emerald-400 flex items-center gap-2 drop-shadow-[0_0_8px_rgba(16,185,129,0.45)]">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400 shadow-[0_0_8px_#10b981]"></span>
              </span>
              SYS + HWMON
            </span>
          </div>
        </div>
      </aside>

      <main className="relative z-10 flex-1 min-w-0 flex flex-col overflow-y-auto p-6 lg:p-7">
        <AnimatePresence mode="wait">
          {c.activeTab === "dashboard" && <DashboardModule c={c} />}
          {c.activeTab === "startup" && <StartupModule c={c} />}
          {c.activeTab === "storage" && <StorageModule c={c} />}
          {c.activeTab === "hardware" && <HardwareModule c={c} />}
          {c.activeTab === "cleanup" && <CleanupModule c={c} />}
          {c.activeTab === "power" && <PowerModule c={c} />}
          {c.activeTab === "processes" && <ProcessModule c={c} />}
          {c.activeTab === "network" && <NetworkModule c={c} />}
          {c.activeTab === "drop" && <DropModule />}
        </AnimatePresence>
      </main>
      </div>
    </div>
  );
}
