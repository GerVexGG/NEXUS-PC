import { useEffect, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  Activity, Cpu, HardDrive, LayoutDashboard, Loader2, LogOut, Minimize2, Network, Power, Rocket, Smartphone, Trash2,
} from "lucide-react";
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
import "./App.css";

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
      className={`relative flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors cursor-pointer ${
        active ? "font-medium text-slate-100" : "text-slate-400 hover:text-slate-200"
      }`}
    >
      {active && (
        <motion.div
          layoutId="activeTabPill"
          transition={{ type: "spring", stiffness: 460, damping: 32 }}
          className="absolute inset-0 rounded-lg border border-[#222b38] bg-white/[0.05]"
        />
      )}
      <span className="relative z-10 flex items-center gap-2.5">
        <Icon size={16} />
        <span>{label}</span>
      </span>
      {badge ? <span className="relative z-10">{badge}</span> : null}
    </motion.button>
  );
}

export default function App() {
  const c = useNexusController();

  useEffect(() => {
    const window = getCurrentWindow();
    void window.show();
    void window.setFocus();
  }, []);

  return (
    <div className="nexus-shell relative flex h-screen w-screen select-none flex-col overflow-hidden rounded-3xl border border-[#222b38] font-sans text-slate-100">

      <TitleBar
        isElevatedAdmin={c.isElevatedAdmin}
        adminError={c.adminError}
        onRestartAsAdmin={c.handleRestartAsAdmin}
        onToggleMaximize={c.handleWindowToggleMaximize}
      />

      {/* Рабочая область под кастомным тайтлбаром */}
      <div className="relative z-10 flex flex-1 min-h-0 overflow-hidden">
      {/* Компактная строгая боковая панель Obsidian Cyber-HUD */}
      <aside className="relative z-20 flex w-60 shrink-0 flex-col justify-between border-r border-[#222b38] bg-[#0e1118] p-3">
        <div>
          <div className="mb-4 flex items-center gap-2.5 border-b border-[#222b38] px-2.5 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-sm font-semibold text-slate-100">
              N
            </div>
            <h1 className="text-sm font-semibold tracking-wide text-slate-100">NEXUS PC</h1>
          </div>

          <nav className="space-y-4">
            <div>
              <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">Обзор</div>
              <SidebarItem active={c.activeTab === "dashboard"} icon={LayoutDashboard} label="Главная" onClick={() => c.setActiveTab("dashboard")} />
            </div>

            <div>
              <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">Мониторинг</div>
              <SidebarItem
                active={c.activeTab === "hardware"}
                icon={Activity}
                label="Датчики железа"
                onClick={() => c.setActiveTab("hardware")}
                badge={c.thermalWarnings.length > 0 ? <span className="h-2 w-2 rounded-full bg-rose-400" /> : undefined}
              />
              <SidebarItem active={c.activeTab === "network"} icon={Network} label="Сеть" onClick={() => c.setActiveTab("network")} />
              <SidebarItem
                active={c.activeTab === "processes"}
                icon={Cpu}
                label="Процессы"
                onClick={() => c.setActiveTab("processes")}
                badge={
                  c.suspendedPids.length > 0 ? (
                    <span className="rounded-md border border-[#222b38] px-1.5 py-0.5 font-mono text-xs text-slate-300">{c.suspendedPids.length}</span>
                  ) : undefined
                }
              />
            </div>

            <div>
              <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">Обслуживание</div>
              <SidebarItem
                active={c.activeTab === "startup"}
                icon={Rocket}
                label="Автозагрузка"
                onClick={() => c.setActiveTab("startup")}
                badge={
                  c.brokenStartupCount > 0 ? (
                    <span className="rounded-md border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 font-mono text-xs text-rose-300">{c.brokenStartupCount}</span>
                  ) : undefined
                }
              />
              <SidebarItem
                active={c.activeTab === "storage"}
                icon={HardDrive}
                label="Накопители"
                onClick={() => c.setActiveTab("storage")}
                badge={c.isScanning ? <Loader2 size={14} className="animate-spin text-slate-400" /> : undefined}
              />
              <SidebarItem
                active={c.activeTab === "cleanup"}
                icon={Trash2}
                label="Очистка"
                onClick={() => c.setActiveTab("cleanup")}
                badge={c.isScanningCleanup || c.isCleaning ? <Loader2 size={14} className="animate-spin text-slate-400" /> : undefined}
              />
            </div>

            <div>
              <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">Инструменты</div>
              <SidebarItem
                active={c.activeTab === "power"}
                icon={Power}
                label="Питание"
                onClick={() => c.setActiveTab("power")}
                badge={
                  c.timerState && c.remainingSeconds > 0 ? (
                    <span className="font-mono text-xs tabular-nums text-slate-300">{formatCountdown(c.remainingSeconds)}</span>
                  ) : undefined
                }
              />
              <SidebarItem active={c.activeTab === "drop"} icon={Smartphone} label="NEXUS Drop" onClick={() => c.setActiveTab("drop")} />
            </div>
          </nav>
        </div>
        <div className="space-y-2 px-1">
          <button
            type="button"
            onClick={() => {
              getCurrentWindow().hide().catch(() => {});
            }}
            className="flex w-full items-center gap-2 rounded-lg border border-[#222b38] bg-[#111722] px-3 py-2 text-xs text-slate-300 transition-colors hover:bg-[#151c27] hover:text-slate-100"
          >
            <Minimize2 size={14} />
            Свернуть в трей
          </button>
          <button
            type="button"
            onClick={() => {
              c.handleWindowClose();
            }}
            className="flex w-full items-center gap-2 rounded-lg border border-[#222b38] bg-[#111722] px-3 py-2 text-xs text-rose-300 transition-colors hover:bg-rose-500/10"
          >
            <LogOut size={14} />
            Выход
          </button>
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
            className="w-full transform-gpu"
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
          </motion.div>
        </AnimatePresence>
      </main>
      </div>
    </div>
  );
}
