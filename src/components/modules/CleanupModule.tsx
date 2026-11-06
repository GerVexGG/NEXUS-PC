import { motion } from "framer-motion";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { formatBytes } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

function cleanupSafety(id: string): { badge: string; badgeClass: string; description: string } | null {
  if (id === "user_temp" || id === "system_temp" || id === "recycle_bin" || id === "thumbnails") {
    return {
      badge: "100% БЕЗОПАСНО",
      badgeClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
      description: "Не затрагивает программы и личные файлы.",
    };
  }
  if (id === "shader_cache") {
    return {
      badge: "КЭШ ШЕЙДЕРОВ",
      badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-300",
      description: "Игра заново соберёт шейдеры при следующем запуске.",
    };
  }
  if (id === "crash_dumps") {
    return {
      badge: "ДИАГНОСТИКА",
      badgeClass: "border-sky-500/30 bg-sky-500/10 text-sky-300",
      description: "Отчёты о сбоях Windows. На работу системы не влияют.",
    };
  }
  return null;
}

function formatSelectedGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function CleanupModule({ c }: { c: NexusController }) {
  const {
    cleanupCategories,
    selectedCleanupIds,
    setSelectedCleanupIds,
    isScanningCleanup,
    isCleaning,
    confirmCleanupOpen,
    setConfirmCleanupOpen,
    cleanupReport,
    cleanupError,
    handleScanCleanup,
    handleToggleCleanupCategory,
    handleExecuteCleanup,
    selectedCleanupBytes,
  } = c;

  return (
    <motion.div
      key="cleanup"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="w-full max-w-6xl space-y-4 pb-24"
    >
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-2xl font-semibold text-slate-100">Центр очистки системы</h2>
          <p className="mt-1 text-sm text-slate-400">Временные файлы, кэш и отчёты, которые можно убрать</p>
        </div>
        <button
          type="button"
          disabled={isScanningCleanup || isCleaning}
          onClick={() => void handleScanCleanup()}
          className="inline-flex items-center gap-2 self-start rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-[#1a2332] disabled:opacity-60"
        >
          <RefreshCw size={14} className={isScanningCleanup ? "animate-spin" : ""} />
          {isScanningCleanup ? "Считаем размер" : "Анализ накопителей"}
        </button>
      </div>

      {cleanupError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {cleanupError}
        </div>
      )}

      {cleanupReport && (
        <div className="rounded-xl border border-[#222b38] bg-[#111722] px-4 py-3 text-sm text-slate-300">
          Освобождено <span className="font-mono font-semibold text-slate-100">{formatBytes(cleanupReport.freed_bytes)}</span>
          {" · "}удалено {cleanupReport.deleted_files_count}
          {" · "}пропущено {cleanupReport.skipped_files_count}
        </div>
      )}

      <div className="divide-y divide-[#222b38]/50 overflow-hidden rounded-xl border border-[#222b38] bg-[#111722]">
        {cleanupCategories.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            Нажмите «Анализ накопителей», чтобы посчитать кэш.
          </div>
        ) : (
          cleanupCategories.map((cat) => {
            const checked = selectedCleanupIds.includes(cat.id);
            const safety = cleanupSafety(cat.id);
            return (
              <div key={cat.id} className="flex items-center gap-3 px-4 py-3">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => handleToggleCleanupCategory(cat.id)}
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    checked ? "border-sky-400 bg-sky-500/20 text-sky-300" : "border-[#222b38] text-transparent"
                  }`}
                >
                  <Check size={12} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-100">{cat.name}</span>
                    {safety && (
                      <span className={`rounded-md border px-1.5 py-0.5 text-[11px] ${safety.badgeClass}`}>
                        {safety.badge}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-slate-400">{safety?.description || cat.description}</p>
                </div>
                <span className="shrink-0 font-mono text-sm font-semibold text-slate-100">{formatBytes(cat.size_bytes)}</span>
              </div>
            );
          })
        )}
      </div>

      <div className="sticky bottom-3 z-20 flex flex-col gap-3 rounded-xl border border-[#222b38] bg-[#0e1118]/90 p-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-slate-300">
          Выбрано к удалению:{" "}
          <span className="font-mono font-bold text-cyan-400">{formatSelectedGb(selectedCleanupBytes)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setConfirmCleanupOpen(false);
              setSelectedCleanupIds(
                cleanupCategories.filter((cat) => cleanupSafety(cat.id)?.badge === "100% БЕЗОПАСНО").map((cat) => cat.id),
              );
            }}
            className="rounded-lg bg-[#151c27] px-3 py-2 text-xs font-medium text-slate-300"
          >
            Выбрать только безопасные
          </button>
          {!confirmCleanupOpen ? (
            <button
              type="button"
              disabled={selectedCleanupIds.length === 0 || isCleaning}
              onClick={() => setConfirmCleanupOpen(true)}
              className="rounded-lg border border-rose-500/30 bg-rose-500/20 px-4 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/30 disabled:opacity-40"
            >
              Очистить выбранное
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={isCleaning}
                onClick={() => void handleExecuteCleanup()}
                className="inline-flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/20 px-4 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/30"
              >
                {isCleaning && <Loader2 size={13} className="animate-spin" />}
                Подтвердить
              </button>
              <button
                type="button"
                onClick={() => setConfirmCleanupOpen(false)}
                className="rounded-lg bg-[#151c27] px-3 py-2 text-xs text-slate-300"
              >
                Отмена
              </button>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}
