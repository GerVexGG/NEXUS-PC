import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, Minus, ShieldAlert, ShieldCheck, Square, X, XCircle } from "lucide-react";

interface TitleBarProps {
  isElevatedAdmin: boolean;
  adminMenuOpen: boolean;
  setAdminMenuOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  adminError: string | null;
  onRestartAsAdmin: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export function TitleBar({
  isElevatedAdmin,
  adminMenuOpen,
  setAdminMenuOpen,
  adminError,
  onRestartAsAdmin,
  onMinimize,
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
        <div className="pointer-events-none h-5 w-5 rounded-md bg-sky-500/15 border border-sky-400/40 flex items-center justify-center text-sky-300 font-mono font-extrabold text-[11px]">
          N
        </div>
        <span className="pointer-events-none font-mono font-bold text-[11px] tracking-[0.16em] text-[#e8edf4]">
          NEXUS PC
        </span>
        <span className="pointer-events-none hidden sm:inline-block text-[10px] font-mono text-[#8793a5]">
          // STUDIO GRAPHITE
        </span>
        {adminError && (
          <span className="pointer-events-none text-[10px] font-mono text-rose-400 truncate max-w-xs ml-2">
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
            className="hidden md:inline-flex items-center gap-1.5 h-7 px-2 rounded-md bg-white/[0.04] hover:bg-white/10 text-[#8793a5] hover:text-[#e8edf4] border border-[#222b38] text-[10px] font-mono transition-colors cursor-pointer"
          >
            <ShieldAlert size={11} />
            <span>Перезапустить от имени администратора</span>
          </button>
        )}

        <div className="relative">
          <button
            type="button"
            onClick={() => setAdminMenuOpen((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[10px] font-mono font-bold tracking-wider border transition-colors cursor-pointer ${
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
                className="absolute right-0 top-8 w-72 rounded-xl backdrop-blur-2xl bg-[#111722]/95 border border-[#222b38] shadow-[0_14px_38px_rgba(0,0,0,0.8)] p-2.5 z-50 space-y-2 font-mono text-xs"
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
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-rose-500/15 text-[#8793a5] hover:text-rose-300 text-left text-[11px] transition-colors cursor-pointer"
                >
                  <XCircle size={13} className="shrink-0" />
                  <span>Завершить работу NEXUS PC</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="h-3.5 w-px bg-[#222b38] mx-0.5" />

        <button
          type="button"
          onClick={onMinimize}
          title="Свернуть"
          className="h-7 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/10 text-[#8793a5] hover:text-[#e8edf4] transition-colors cursor-pointer"
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          onClick={onToggleMaximize}
          title="Развернуть / Оконный режим"
          className="h-7 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/10 text-[#8793a5] hover:text-[#e8edf4] transition-colors cursor-pointer"
        >
          <Square size={11} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Закрыть NEXUS PC"
          className="h-7 w-8 inline-flex items-center justify-center rounded-md hover:bg-rose-500/20 hover:text-rose-400 text-[#8793a5] transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
