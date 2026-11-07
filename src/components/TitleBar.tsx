import { ShieldAlert } from "lucide-react";

const TAB_TITLES: Record<string, string> = {
  dashboard: "SYS // ОБЗОР СИСТЕМЫ",
  hardware: "HWMON // КОНСОЛЬ ДИАГНОСТИКИ ЖЕЛЕЗА",
  network: "NET // СЕТЕВОЙ МОНИТОР",
  processes: "PROC // ДИСПЕТЧЕР ПРОЦЕССОВ",
  startup: "BOOT // АВТОЗАГРУЗКА ПРОГРАММ",
  storage: "STORAGE // АНАЛИЗАТОР НАКОПИТЕЛЕЙ",
  cleanup: "PURGE // ЦЕНТР ОЧИСТКИ СИСТЕМЫ",
  power: "PWR // УПРАВЛЕНИЕ ПИТАНИЕМ",
  drop: "DROP // ЛОКАЛЬНАЯ ПЕРЕДАЧА ФАЙЛОВ",
  settings: "CFG // НАСТРОЙКИ И ЖУРНАЛ",
};

interface TitleBarProps {
  activeTab: string;
  isElevatedAdmin: boolean;
  adminError: string | null;
  onRestartAsAdmin: () => void;
  onToggleMaximize: () => void;
}

export function TitleBar({
  activeTab,
  isElevatedAdmin,
  adminError,
  onRestartAsAdmin,
  onToggleMaximize,
}: TitleBarProps) {
  return (
    <header
      data-tauri-drag-region
      className="relative z-40 flex h-9 shrink-0 items-center justify-between border-b border-slate-800/90 bg-[#080b11] pl-3.5 pr-2.5"
    >
      <div
        data-tauri-drag-region
        onDoubleClick={() => onToggleMaximize()}
        className="flex h-full flex-1 cursor-default items-center gap-2.5"
      >
        <span className="pointer-events-none h-2 w-0.5 bg-cyan-400 shadow-[0_0_6px_#00F0FF]" />
        <span className="pointer-events-none font-mono text-[11px] font-semibold tracking-widest text-slate-400">
          {TAB_TITLES[activeTab] ?? "SYS // ОБЗОР СИСТЕМЫ"}
        </span>
        {adminError && (
          <span className="pointer-events-none ml-2 max-w-xs truncate font-mono text-xs text-rose-400">
            {adminError}
          </span>
        )}
      </div>

      <div data-tauri-drag-region="false" className="flex h-full items-center gap-2">
        {isElevatedAdmin ? (
          <span className="inline-flex h-6 items-center gap-1.5 rounded border border-emerald-500/35 bg-emerald-500/10 px-2.5 font-mono text-[10px] font-bold tracking-wider text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.15)]">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
            PRIVILEGE: ADMIN
          </span>
        ) : (
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={onRestartAsAdmin}
            title="Перезапустить NEXUS PC с правами Администратора (UAC)"
            className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded border border-slate-800 bg-[#0e131d] px-2.5 font-mono text-[10px] tracking-wider text-slate-300 transition-colors hover:border-cyan-500/40 hover:text-cyan-200"
          >
            <ShieldAlert size={11} className="text-amber-400" />
            <span>ELEVATE: UAC ADMIN</span>
          </button>
        )}
      </div>
    </header>
  );
}
