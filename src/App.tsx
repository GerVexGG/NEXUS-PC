import type { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Cpu,
  HardDrive,
  LayoutDashboard,
  Loader2,
  LogOut,
  Network,
  Power,
  Rocket,
  Settings,
  Smartphone,
  Terminal,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useNexusController } from "./hooks/useNexusController";
import { formatCountdown } from "./lib/studio";
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
import { ScriptsModule } from "./components/modules/ScriptsModule";
import { SettingsModule } from "./components/modules/SettingsModule";
import reaperIcon from "./assets/reaper.png";
import "./App.css";

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 px-2.5 pt-1">
      <span className="h-1 w-1 shrink-0 rounded-full bg-[#36AFC0]" />
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#526170]">
        {label}
      </span>
      <span className="h-px flex-1 bg-[#202B38]/70" />
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
      whileTap={{ scale: 0.99 }}
      onClick={onClick}
      className={`group relative flex w-full cursor-pointer items-center justify-between overflow-hidden rounded-lg px-3 py-2 text-[13px] transition-colors ${
        active
          ? "font-semibold text-[#E5EDF5]"
          : "font-medium text-[#8292A3] hover:bg-[#10151D] hover:text-[#E5EDF5]"
      }`}
    >
      {active && (
        <>
          <motion.div
            layoutId="activeTabPill"
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
            className="absolute inset-0 rounded-lg border border-[#00D5E8]/30 bg-gradient-to-r from-[#00D5E8]/14 via-[#10151D] to-[#10151D]"
          />
          <span className="absolute inset-y-1.5 left-0 z-10 w-[3px] rounded-r bg-[#00D5E8] shadow-[0_0_8px_rgba(0,213,232,0.5)]" />
        </>
      )}
      <span className="relative z-10 flex items-center gap-2.5">
        <Icon
          size={16}
          className={`transition-colors duration-150 ${
            active ? "text-[#00D5E8]" : "text-[#8292A3] group-hover:text-[#E5EDF5]"
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

  return (
    <div className="nexus-shell hud-bg relative flex h-screen w-screen select-none flex-col overflow-hidden border border-[#202B38] bg-[#07080B] font-sans text-[#E5EDF5]">
      <TitleBar
        activeTab={c.activeTab}
        isElevatedAdmin={c.isElevatedAdmin}
        adminError={c.adminError}
        onRestartAsAdmin={c.handleRestartAsAdmin}
        onToggleMaximize={c.handleWindowToggleMaximize}
        onHideToTray={() => {
          void invoke("hide_to_tray").catch(() => getCurrentWindow().hide());
        }}
      />

      <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden">
        <aside className="relative z-20 flex w-64 shrink-0 flex-col justify-between border-r border-[#202B38] bg-[#0B0E14] p-3">
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Бренд-хедер NEXUS */}
            <div className="tactical-card mb-3 flex shrink-0 items-center gap-3 rounded-xl p-2.5">
              <div
                title={
                  isOverheating
                    ? c.thermalWarnings.join(" · ")
                    : "NEXUS · Системный сервис активен"
                }
                className={`relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border transition-colors duration-300 ${
                  isOverheating
                    ? "border-rose-500/60 bg-rose-500/10"
                    : "border-[#202B38] bg-[#07080B]"
                }`}
              >
                <img
                  src={reaperIcon}
                  alt="NEXUS"
                  className="h-full w-full object-cover"
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold tracking-[0.14em] text-[#E5EDF5]">
                    NEXUS
                  </span>
                  <span className="font-mono text-[10px] text-[#526170]">v0.2.2</span>
                </div>
                <div className="text-[11px] text-[#8292A3]">
                  Системный центр
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      isOverheating
                        ? "animate-ping bg-rose-500"
                        : "bg-[#00D5E8] shadow-[0_0_6px_rgba(0,213,232,0.7)]"
                    }`}
                  />
                  <span
                    className={`truncate font-mono text-[10px] font-medium ${
                      isOverheating ? "text-rose-400" : "text-[#00D5E8]"
                    }`}
                  >
                    {isOverheating ? "Перегрев узла" : "Сервис активен"}
                  </span>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
              <nav className="space-y-2.5 pb-2">
              <div>
                <SectionDivider label="Обзор" />
                <SidebarItem
                  active={c.activeTab === "dashboard"}
                  icon={LayoutDashboard}
                  label="Обзор системы"
                  onClick={() => c.setActiveTab("dashboard")}
                />
              </div>

              <div>
                <SectionDivider label="Мониторинг" />
                <SidebarItem
                  active={c.activeTab === "hardware"}
                  icon={Activity}
                  label="Аппаратные датчики"
                  onClick={() => c.setActiveTab("hardware")}
                  badge={
                    c.thermalWarnings.length > 0 ? (
                      <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" />
                    ) : undefined
                  }
                />
                <SidebarItem
                  active={c.activeTab === "network"}
                  icon={Network}
                  label="Сетевой монитор"
                  onClick={() => c.setActiveTab("network")}
                />
                <SidebarItem
                  active={c.activeTab === "processes"}
                  icon={Cpu}
                  label="Процессы"
                  onClick={() => c.setActiveTab("processes")}
                  badge={
                    c.suspendedPids.length > 0 ? (
                      <span className="rounded border border-[#00D5E8]/30 bg-[#00D5E8]/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[#00D5E8]">
                        {c.suspendedPids.length}
                      </span>
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
                      <span className="rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-rose-300">
                        {c.brokenStartupCount}
                      </span>
                    ) : undefined
                  }
                />
                <SidebarItem
                  active={c.activeTab === "storage"}
                  icon={HardDrive}
                  label="Накопители"
                  onClick={() => c.setActiveTab("storage")}
                  badge={
                    c.isScanning ? (
                      <Loader2 size={14} className="animate-spin text-[#00D5E8]" />
                    ) : undefined
                  }
                />
                <SidebarItem
                  active={c.activeTab === "cleanup"}
                  icon={Trash2}
                  label="Центр очистки"
                  onClick={() => c.setActiveTab("cleanup")}
                  badge={
                    c.isScanningCleanup || c.isCleaning ? (
                      <Loader2 size={14} className="animate-spin text-[#00D5E8]" />
                    ) : undefined
                  }
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
                      <span className="rounded border border-[#00D5E8]/30 bg-[#00D5E8]/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-[#00D5E8]">
                        {formatCountdown(c.remainingSeconds)}
                      </span>
                    ) : undefined
                  }
                />
                <SidebarItem
                  active={c.activeTab === "drop"}
                  icon={Smartphone}
                  label="NEXUS Drop"
                  onClick={() => c.setActiveTab("drop")}
                />
                <SidebarItem
                  active={c.activeTab === "scripts"}
                  icon={Terminal}
                  label="Скрипты"
                  onClick={() => c.setActiveTab("scripts")}
                />
              </div>
              </nav>
            </div>
          </div>

          <div className="shrink-0 space-y-2 border-t border-[#202B38] pt-2.5">
            <SidebarItem
              active={c.activeTab === "settings"}
              icon={Settings}
              label="Настройки"
              onClick={() => c.setActiveTab("settings")}
            />
            <button
              type="button"
              onClick={() => {
                void c.handleWindowClose();
              }}
              className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-[#202B38] bg-[#10151D] px-2.5 py-1.5 text-xs font-medium text-rose-300 transition-colors hover:border-rose-500/40 hover:bg-rose-500/10"
            >
              <LogOut size={13} />
              Выход
            </button>
          </div>
        </aside>

        <main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-y-auto px-6 py-4 lg:px-7 lg:py-5">
          <AnimatePresence mode="wait">
            <motion.div
              key={c.activeTab}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
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
              {c.activeTab === "scripts" && <ScriptsModule />}
              {c.activeTab === "settings" && <SettingsModule c={c} />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
