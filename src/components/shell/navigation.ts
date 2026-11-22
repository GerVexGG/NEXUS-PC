import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import { Activity, Cpu, HardDrive, LayoutDashboard, Network, Power, Rocket, Settings, Smartphone, Terminal, Trash2 } from "lucide-react";
import type { NexusController } from "../../hooks/useNexusController";
import { DashboardModule } from "../modules/DashboardModule";
import { StartupModule } from "../modules/StartupModule";
import { StorageModule } from "../modules/StorageModule";
import { HardwareModule } from "../modules/HardwareModule";
import { CleanupModule } from "../modules/CleanupModule";
import { PowerModule } from "../modules/PowerModule";
import { ProcessModule } from "../modules/ProcessModule";
import { NetworkModule } from "../modules/NetworkModule";
import { DropModule } from "../modules/DropModule";
import { ScriptsModule } from "../modules/ScriptsModule";
import { SettingsModule } from "../modules/SettingsModule";

export type Tab = NexusController["activeTab"];

export const pages: Record<Tab, { label: string; icon: LucideIcon; component: ComponentType<{ c: NexusController }> }> = {
  dashboard: { label: "Обзор системы", icon: LayoutDashboard, component: DashboardModule },
  hardware: { label: "Аппаратные датчики", icon: Activity, component: HardwareModule },
  processes: { label: "Процессы", icon: Cpu, component: ProcessModule },
  network: { label: "Сетевой монитор", icon: Network, component: NetworkModule },
  startup: { label: "Автозагрузка", icon: Rocket, component: StartupModule },
  storage: { label: "Накопители", icon: HardDrive, component: StorageModule },
  cleanup: { label: "Центр очистки", icon: Trash2, component: CleanupModule },
  power: { label: "Питание", icon: Power, component: PowerModule },
  drop: { label: "AURORA Drop", icon: Smartphone, component: DropModule },
  scripts: { label: "Скрипты", icon: Terminal, component: ScriptsModule },
  settings: { label: "Настройки", icon: Settings, component: SettingsModule },
};

export const groups = [
  { label: "Система", pages: ["hardware", "processes", "network", "storage"] },
  { label: "Обслуживание", pages: ["startup", "cleanup", "power"] },
  { label: "Рабочие инструменты", pages: ["scripts", "drop"] },
] as const;

export function groupFor(tab: Tab) {
  return groups.find((group) => group.pages.some((page) => page === tab))?.label ?? "Рабочая область";
}
