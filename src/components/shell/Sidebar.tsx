import { memo, type ReactNode } from "react";
import { Loader2, LogOut } from "lucide-react";
import type { NexusController } from "../../hooks/useNexusController";
import { formatCountdown } from "../../lib/studio";
import { groups, pages, type Tab } from "./navigation";

function SidebarItem({ tab, current, activate, badge }: { tab: Tab; current: Tab; activate: (tab: Tab) => void; badge?: ReactNode }) {
  const { label, icon: Icon } = pages[tab];
  return (
    <button type="button" title={label} onClick={() => activate(tab)} aria-current={current === tab ? "page" : undefined} className="av-nav-item">
      <Icon size={17} strokeWidth={1.65} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">{tab === "hardware" ? "Датчики" : label}</span>
      {badge}
    </button>
  );
}

type SidebarProps = Pick<NexusController, "activeTab" | "setActiveTab" | "handleWindowClose" |
  "thermalWarnings" | "suspendedPids" | "brokenStartupCount" | "isScanning" |
  "isScanningCleanup" | "isCleaning" | "timerState" | "remainingSeconds">;

export const Sidebar = memo(function Sidebar(c: SidebarProps) {
  const warnings = c.thermalWarnings.length;
  const badges: Partial<Record<Tab, ReactNode>> = {
    hardware: warnings > 0 && <span className="nexus-nav-count nexus-nav-count--warning" title={c.thermalWarnings.join(" · ")} aria-label={"Температурных предупреждений: " + warnings}>{warnings}</span>,
    processes: c.suspendedPids.length > 0 && <span className="nexus-nav-count" title="Приостановленные процессы">{c.suspendedPids.length}</span>,
    startup: c.brokenStartupCount > 0 && <span className="nexus-nav-count nexus-nav-count--warning" title="Проблемные записи автозагрузки">{c.brokenStartupCount}</span>,
    storage: c.isScanning && <Loader2 size={13} className="shrink-0 animate-spin" aria-label="Сканирование" />,
    cleanup: (c.isScanningCleanup || c.isCleaning) && <Loader2 size={13} className="shrink-0 animate-spin" aria-label="Обработка" />,
    power: c.timerState && c.remainingSeconds > 0 && <span className="nexus-nav-count" title="Активный таймер">{formatCountdown(c.remainingSeconds)}</span>,
  };
  return (
    <aside className="av-rail">
      <div className="av-rail-head">
        <div data-tauri-drag-region className="av-brand">
          <img src="/aurora.svg" alt="" />
          <div><strong>AURORA</strong><small>System Suite <i/> 2.0</small></div>
        </div>
      </div>
      <nav aria-label="Разделы AURORA" className="av-nav">
        <SidebarItem tab="dashboard" current={c.activeTab} activate={c.setActiveTab} />
        {groups.map((group) => (
          <div key={group.label} className="av-nav-group">
            <div className="av-group-name">{group.label}</div>
            {group.pages.map((tab) => <SidebarItem key={tab} tab={tab} current={c.activeTab} activate={c.setActiveTab} badge={badges[tab]} />)}
          </div>
        ))}
      </nav>
      <div className="av-rail-footer">
        <SidebarItem tab="settings" current={c.activeTab} activate={c.setActiveTab} />
        <button type="button" onClick={() => void c.handleWindowClose()} className="av-nav-item av-nav-exit">
          <LogOut size={15} aria-hidden="true" /> Выход
        </button>
      </div>
    </aside>
  );
});
