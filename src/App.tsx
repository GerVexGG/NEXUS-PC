import { useEffect, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  Activity, Cpu, HardDrive, LayoutDashboard, Loader2, LogOut, Minimize2, Network, Power, Rocket, Settings, Smartphone, Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { SettingsModule } from "./components/modules/SettingsModule";
import reaperIcon from "./assets/reaper.png";
import "./App.css";

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 px-2.5 pt-1">
      <span className="h-1.5 w-1.5 shrink-0 border-l border-t border-cyan-500/60" />
      <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-500">
        {label}
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-slate-800 via-slate-800/60 to-transparent" />
    </div>
  );
}

function SidebarItem({
  active,
  icon: Icon,
  label,
  onClick,
  badge,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  badge?: ReactNode;
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`group relative flex w-full items-center justify-between overflow-hidden px-3 py-2 text-sm transition-all cursor-pointer ${
        active
          ? "sidebar-active-cut font-semibold text-white drop-shadow-[0_0_8px_rgba(0,240,255,0.35)]"
          : "rounded-lg text-slate-400 hover:bg-white/[0.03] hover:text-slate-200"
      }`}
    >
      {active && (
        <>
          <motion.div
            layoutId="activeTabPill"
            transition={{ type: "spring", stiffness: 460, damping: 32 }}
            className="sidebar-active-cut absolute inset-0 border border-cyan-500/30 bg-gradient-to-r from-cyan-500/18 via-cyan-500/8 to-[#0e131d]/90"
          />
          <span className="absolute inset-y-0 left-0 z-10 w-1 bg-cyan-400 shadow-[0_0_12px_rgba(0,240,255,0.6)]" />
        </>
      )}
      <span className="relative z-10 flex items-center gap-2.5">
        <Icon
          size={16}
          className={`transition-transform duration-200 group-hover:scale-110 ${
            active ? "text-cyan-400 drop-shadow-[0_0_8px_rgba(0,240,255,0.6)]" : ""
          }`}
        />
        <span>{label}</span>
      </span>
      {badge ? <span className="relative z-10">{badge}</span> : null}
    </motion.button>
  );
}

export default function App() {
  const c = useNexusController();
  const isOverheating = c.thermalWarnings.length > 0;

  useEffect(() => {
    const window = getCurrentWindow();
    void (async () => {
      try {
        const settings = await invoke<{ start_minimized: boolean }>("get_settings");
        if (settings.start_minimized) return;
      } catch {
        /* окно откроется обычным образом */
      }
      await window.show();
      await window.setFocus();
    })();
  }, []);

  return (
    <div className="nexus-shell hud-bg relative flex h-screen w-screen select-none flex-col overflow-hidden border border-slate-800/90 bg-[#080b11] font-sans text-slate-100">

      <TitleBar
        activeTab={c.activeTab}
        isElevatedAdmin={c.isElevatedAdmin}
        adminError={c.adminError}
        onRestartAsAdmin={c.handleRestartAsAdmin}
        onToggleMaximize={c.handleWindowToggleMaximize}
      />

      {/* Рабочая область под кастомным тайтлбаром */}
      <div className="relative z-10 flex flex-1 min-h-0 overflow-hidden">
      {/* Тактическая приборная боковая панель Tactical Cyberpunk 2.0 */}
      <aside className="relative z-20 flex w-64 shrink-0 flex-col justify-between border-r border-slate-800/90 bg-[#090d14] p-3">
        <div>
          {/* Приборный модуль ядра */}
          <div className="tactical-card tactical-brackets mb-4 flex items-center gap-3 rounded-xl p-2.5">
            <div
              title={isOverheating ? c.thermalWarnings.join(" · ") : "NEXUS // CORE · Система в норме"}
              className={`octa-shell relative flex h-12 w-12 shrink-0 items-center justify-center p-[1.5px] transition-all duration-300 ${
                isOverheating
                  ? "animate-pulse bg-gradient-to-br from-rose-500 via-red-500 to-amber-500 shadow-[0_0_20px_rgba(244,63,94,0.5)]"
                  : "bg-gradient-to-br from-cyan-400 via-cyan-500/40 to-indigo-500 shadow-[0_0_18px_rgba(0,240,255,0.22)]"
              }`}
            >
              <div className="octa-shell h-full w-full overflow-hidden bg-[#080b11]">
                <img
                  src={reaperIcon}
                  alt="Cyber Reaper"
                  className="h-full w-full object-cover transform-gpu transition-transform duration-300 hover:scale-105"
                />
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="text-xs font-black tracking-[0.2em] text-slate-100">
                NEXUS // CORE
              </div>
              <div className="mt-0.5 font-mono text-[9px] font-semibold tracking-widest text-slate-400">
                TACTICAL MONITOR
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    isOverheating
                      ? "animate-ping bg-rose-500 shadow-[0_0_8px_#f43f5e]"
                      : "bg-cyan-400 shadow-[0_0_8px_#00F0FF]"
                  }`}
                />
                <span
                  className={`truncate font-mono text-[10px] font-bold tracking-wider ${
                    isOverheating ? "animate-pulse text-rose-400" : "text-cyan-400"
                  }`}
                >
                  {isOverheating ? "CRITICAL TEMP" : "SYS: OPTIMAL"}
                </span>
              </div>
            </div>
          </div>

          <nav className="space-y-3.5">
            <div>
              <SectionDivider label="Обзор" />
              <SidebarItem active={c.activeTab === "dashboard"} icon={LayoutDashboard} label="Главная" onClick={() => c.setActiveTab("dashboard")} />
            </div>

            <div>
              <SectionDivider label="Мониторинг" />
              <SidebarItem
                active={c.activeTab === "hardware"}
                icon={Activity}
                label="Датчики железа"
                onClick={() => c.setActiveTab("hardware")}
                badge={c.thermalWarnings.length > 0 ? <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.8)]" /> : undefined}
              />
              <SidebarItem active={c.activeTab === "network"} icon={Network} label="Сеть" onClick={() => c.setActiveTab("network")} />
              <SidebarItem
                active={c.activeTab === "processes"}
                icon={Cpu}
                label="Процессы"
                onClick={() => c.setActiveTab("processes")}
                badge={
                  c.suspendedPids.length > 0 ? (
                    <span className="rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-cyan-300">{c.suspendedPids.length}</span>
                  ) : undefined
                }
              />
            </div>

            <div>
              <SectionDivider label="Обслуживание" />
              <SidebarItem
                active={c.activeTab === "startup"}
                icon={Rocket}
                label="Автозагрузка"
                onClick={() => c.setActiveTab("startup")}
                badge={
                  c.brokenStartupCount > 0 ? (
                    <span className="rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-rose-300">{c.brokenStartupCount}</span>
                  ) : undefined
                }
              />
              <SidebarItem
                active={c.activeTab === "storage"}
                icon={HardDrive}
                label="Накопители"
                onClick={() => c.setActiveTab("storage")}
                badge={c.isScanning ? <Loader2 size={14} className="animate-spin text-cyan-400" /> : undefined}
              />
              <SidebarItem
                active={c.activeTab === "cleanup"}
                icon={Trash2}
                label="Очистка"
                onClick={() => c.setActiveTab("cleanup")}
                badge={c.isScanningCleanup || c.isCleaning ? <Loader2 size={14} className="animate-spin text-cyan-400" /> : undefined}
              />
            </div>

            <div>
              <SectionDivider label="Инструменты" />
              <SidebarItem
                active={c.activeTab === "power"}
                icon={Power}
                label="Питание"
                onClick={() => c.setActiveTab("power")}
                badge={
                  c.timerState && c.remainingSeconds > 0 ? (
                    <span className="font-mono text-xs font-bold tabular-nums text-cyan-300">{formatCountdown(c.remainingSeconds)}</span>
                  ) : undefined
                }
              />
              <SidebarItem active={c.activeTab === "drop"} icon={Smartphone} label="NEXUS Drop" onClick={() => c.setActiveTab("drop")} />
            </div>
          </nav>
        </div>
        <div className="space-y-2 border-t border-slate-800/80 pt-2.5">
          <SidebarItem active={c.activeTab === "settings"} icon={Settings} label="Настройки" onClick={() => c.setActiveTab("settings")} />
          <div className="grid grid-cols-2 gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => {
                getCurrentWindow().hide().catch(() => {});
              }}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-800 bg-[#0e131d] px-2.5 py-2 font-mono text-[11px] text-slate-300 transition-colors hover:border-cyan-500/40 hover:text-cyan-200"
            >
              <Minimize2 size={13} />
              В трей
            </button>
            <button
              type="button"
              onClick={() => {
                c.handleWindowClose();
              }}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-800 bg-[#0e131d] px-2.5 py-2 font-mono text-[11px] text-rose-300 transition-colors hover:border-rose-500/40 hover:bg-rose-500/10"
            >
              <LogOut size={13} />
              Выход
            </button>
          </div>
        </div>
      </aside>

      <main className="relative z-10 flex-1 min-w-0 flex flex-col overflow-y-auto p-6 lg:p-7">
        <AnimatePresence mode="wait">
          <motion.div
            key={c.activeTab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="tab-fade-in w-full transform-gpu"
          >
            {c.activeTab === "dashboard" && <DashboardModule c={c} />}
            {c.activeTab === "startup" && <StartupModule c={c} />}
            {c.activeTab === "storage" && <StorageModule c={c} />}
            {c.activeTab === "hardware" && <HardwareModule c={c} />}
            {c.activeTab === "cleanup" && <CleanupModule c={c} />}
            {c.activeTab === "power" && <PowerModule c={c} />}
            {c.activeTab === "processes" && <ProcessModule c={c} />}
            {c.activeTab === "network" && <NetworkModule c={c} />}
            {c.activeTab === "drop" && <DropModule />}
            {c.activeTab === "settings" && <SettingsModule c={c} />}
          </motion.div>
        </AnimatePresence>
      </main>
      </div>
    </div>
  );
}
