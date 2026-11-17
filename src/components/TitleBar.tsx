import { ShieldAlert, ShieldCheck, Square, X } from "lucide-react";

const MODULE_CODES: Record<string, string> = {
  dashboard: "NEXUS // TELEMETRY CORE",
  hardware: "NEXUS // HARDWARE SENSORS",
  network: "NEXUS // NETWORK ANALYZER",
  processes: "NEXUS // PROCESS EXPLORER",
  startup: "NEXUS // STARTUP CONTROL",
  storage: "NEXUS // STORAGE ANALYZER",
  cleanup: "NEXUS // CLEANUP ENGINE",
  power: "NEXUS // POWER MANAGEMENT",
  drop: "NEXUS // LOCAL TRANSFER",
  scripts: "NEXUS // SCRIPT AUTOMATION",
  settings: "NEXUS // SYSTEM CONFIGURATION",
};

interface TitleBarProps {
  activeTab: string;
  isElevatedAdmin: boolean;
  adminError: string | null;
  onRestartAsAdmin: () => void;
  onToggleMaximize: () => void;
  onHideToTray: () => void;
}

export function TitleBar({
  activeTab,
  isElevatedAdmin,
  adminError,
  onRestartAsAdmin,
  onToggleMaximize,
  onHideToTray,
}: TitleBarProps) {
  return (
    <header
      data-tauri-drag-region
      className="relative z-40 flex h-9 shrink-0 items-center justify-between border-b border-[#202B38] bg-[#0B0E14] pl-4 pr-3"
    >
      <div
        data-tauri-drag-region="deep"
        className="flex h-full flex-1 cursor-default items-center gap-2.5"
      >
        <span className="pointer-events-none h-2 w-0.5 rounded-full bg-[#00D5E8]" />
        <span className="pointer-events-none font-mono text-[11px] font-medium tracking-[0.14em] text-[#526170]">
          {MODULE_CODES[activeTab] ?? "NEXUS // SYSTEM UTILITY"}
        </span>
        {adminError && (
          <span className="pointer-events-none ml-2 max-w-xs truncate font-mono text-xs text-rose-400">
            {adminError}
          </span>
        )}
      </div>

      <div data-tauri-drag-region="false" className="flex h-full items-center gap-2">
        {isElevatedAdmin ? (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-[#00D5E8]/30 bg-[#00D5E8]/10 px-2.5 font-mono text-[10px] font-semibold tracking-wider text-[#00D5E8]">
            <ShieldCheck size={11} className="text-[#00D5E8]" />
            АДМИНИСТРАТОР
          </span>
        ) : (
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={onRestartAsAdmin}
            title="Перезапустить NEXUS с правами Администратора (UAC)"
            className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md border border-[#202B38] bg-[#10151D] px-2.5 font-mono text-[10px] font-medium tracking-wider text-[#8292A3] transition-colors hover:border-[#00D5E8]/40 hover:text-[#E5EDF5]"
          >
            <ShieldAlert size={11} className="text-amber-400" />
            <span>ПРАВА АДМИНИСТРАТОРА (UAC)</span>
          </button>
        )}

        <div className="ml-1 flex items-center gap-1 border-l border-[#202B38] pl-2">
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={onToggleMaximize}
            title="Развернуть / Восстановить"
            aria-label="Развернуть"
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-transparent text-[#8292A3] transition-colors hover:border-[#202B38] hover:bg-[#151C26] hover:text-[#00D5E8]"
          >
            <Square size={11} />
          </button>
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={onHideToTray}
            title="Скрыть в трей"
            aria-label="Скрыть в трей"
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-transparent text-[#8292A3] transition-colors hover:border-[#00D5E8]/35 hover:bg-[#00D5E8]/10 hover:text-[#00D5E8]"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </header>
  );
}
