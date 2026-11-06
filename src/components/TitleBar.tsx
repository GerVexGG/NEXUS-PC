import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";

interface TitleBarProps {
  isElevatedAdmin: boolean;
  adminMenuOpen: boolean;
  setAdminMenuOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  adminError: string | null;
  onRestartAsAdmin: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export function TitleBar({
  isElevatedAdmin,
  adminMenuOpen,
  setAdminMenuOpen,
  adminError,
  onRestartAsAdmin,
  onToggleMaximize,
  onClose,
}: TitleBarProps) {
  const [dragging, setDragging] = useState(false);

  return (
    <header
      data-tauri-drag-region
      className="relative z-40 h-9 shrink-0 bg-[#0e1118] border-b border-[#222b38] flex items-center justify-between pl-3 pr-1.5"
    >
      <div
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button === 0 && e.detail === 1) {
            setDragging(true);
            getCurrentWindow().startDragging().catch(() => {});
          }
        }}
        onMouseUp={() => setDragging(false)}
        onDoubleClick={() => onToggleMaximize()}
        className="flex items-center gap-2.5 flex-1 h-full cursor-default"
      >
        <div className="pointer-events-none flex h-5 w-5 items-center justify-center rounded-md bg-white/[0.05] text-[11px] font-semibold text-slate-200">
          N
        </div>
        <span className="pointer-events-none text-xs font-semibold text-slate-100">
          NEXUS PC
        </span>
        {adminError && (
          <span className="pointer-events-none ml-2 max-w-xs truncate text-xs text-rose-400">
            {adminError}
          </span>
        )}
        {dragging ? <span className="sr-only">drag</span> : null}
      </div>

      <div className="flex items-center gap-1.5 h-full">
        {!isElevatedAdmin && (
          <button
            type="button"
            onClick={onRestartAsAdmin}
            title="Перезапустить NEXUS PC с правами Администратора (UAC)"
            className="hidden md:inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-[#222b38] bg-white/[0.04] px-2 text-xs text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
          >
            <ShieldAlert size={11} />
            <span>Перезапустить от имени администратора</span>
          </button>
        )}

        <div className="relative">
          <button
            type="button"
            onClick={() => setAdminMenuOpen((prev) => !prev)}
            className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
              isElevatedAdmin
                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/35"
                : "bg-white/[0.04] text-[#8793a5] hover:text-[#e8edf4] border-[#222b38]"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isElevatedAdmin ? "bg-emerald-400" : "bg-zinc-500"
              }`}
            />
            <span>{isElevatedAdmin ? "ADMIN" : "USER"}</span>
            <ChevronDown size={11} />
          </button>

          <AnimatePresence>
            {adminMenuOpen && (
              <motion.div
                initial={{ opacity: 0, y: 4, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.96 }}
                transition={{ duration: 0.14 }}
                className="absolute right-0 top-8 z-50 w-72 space-y-2 rounded-xl border border-[#222b38] bg-[#111722] p-2.5 text-xs shadow-lg"
              >
                <div className="px-2 py-1.5 rounded-lg bg-[#151c27] border border-[#222b38]">
                  <div className="text-[10px] uppercase tracking-wider text-[#8793a5]">
                    ПРИВИЛЕГИИ ПРОЦЕССА
                  </div>
                  <div className={`text-xs font-bold mt-0.5 ${isElevatedAdmin ? "text-emerald-400" : "text-[#c5d0de]"}`}>
                    {isElevatedAdmin
                      ? "Администратор (Полный доступ)"
                      : "Стандартный пользователь (USER)"}
                  </div>
                </div>

                {!isElevatedAdmin && (
                  <button
                    type="button"
                    onClick={onRestartAsAdmin}
                    className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg bg-white/[0.04] hover:bg-white/10 text-[#e8edf4] border border-[#222b38] text-left text-[11px] font-semibold transition-colors cursor-pointer"
                  >
                    <ShieldCheck size={14} className="shrink-0 text-sky-300" />
                    <span>Перезапустить от имени администратора</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={onClose}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg bg-white/[0.03] hover:bg-rose-500/15 text-[#c5d0de] hover:text-rose-300 border border-[#222b38] text-left text-[11px] transition-colors cursor-pointer"
                >
                  <XCircle size={14} className="shrink-0" />
                  <span>Выход из приложения</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
