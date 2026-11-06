import { ShieldAlert } from "lucide-react";

interface TitleBarProps {
  isElevatedAdmin: boolean;
  adminError: string | null;
  onRestartAsAdmin: () => void;
  onToggleMaximize: () => void;
}

export function TitleBar({
  isElevatedAdmin,
  adminError,
  onRestartAsAdmin,
  onToggleMaximize,
}: TitleBarProps) {
  return (
    <header
      data-tauri-drag-region
      className="relative z-40 flex h-9 shrink-0 items-center justify-between border-b border-[#222b38] bg-[#0e1118] pl-3 pr-2"
    >
      <div
        data-tauri-drag-region
        onDoubleClick={() => onToggleMaximize()}
        className="flex h-full flex-1 cursor-default items-center gap-2.5"
      >
        <div className="pointer-events-none flex h-5 w-5 items-center justify-center rounded-md bg-white/[0.05] text-[11px] font-semibold text-slate-200">
          N
        </div>
        <span className="pointer-events-none text-xs font-semibold text-slate-100">NEXUS PC</span>
        {adminError && (
          <span className="pointer-events-none ml-2 max-w-xs truncate text-xs text-rose-400">{adminError}</span>
        )}
      </div>

      <div data-tauri-drag-region="false" className="flex h-full items-center">
        {isElevatedAdmin ? (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/35 bg-emerald-500/15 px-2.5 text-xs font-medium text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            ADMIN
          </span>
        ) : (
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={onRestartAsAdmin}
            title="Перезапустить NEXUS PC с правами Администратора (UAC)"
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-[#222b38] bg-white/[0.04] px-2 text-xs text-slate-300 transition-colors hover:bg-white/10 hover:text-slate-100"
          >
            <ShieldAlert size={12} />
            <span>Перезапустить от имени администратора</span>
          </button>
        )}
      </div>
    </header>
  );
}
