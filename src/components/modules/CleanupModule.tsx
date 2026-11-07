import { motion } from "framer-motion";
import { Check, Loader2, RefreshCw, Shield, Sparkles } from "lucide-react";
import { formatBytes } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";
import reaperIcon from "../../assets/reaper.png";

const lowRisk = {
  badge: "Низкий риск",
  badgeClass: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
};

function cleanupSafety(
  id: string,
  isElevatedAdmin: boolean,
): { badge: string; badgeClass: string; description: string; shield?: boolean } | null {
  if (id === "recycle_bin") {
    return {
      badge: "Внимание: Безвозвратное удаление",
      badgeClass: "border-amber-500/20 bg-amber-500/10 text-amber-400",
      description: "Файлы из корзины нельзя будет восстановить.",
    };
  }
  if (id === "windows_update" && !isElevatedAdmin) {
    return {
      badge: "Требуются права Администратора",
      badgeClass: "border-amber-500/20 bg-amber-500/10 text-amber-300",
      description: "Установочные пакеты уже применённых обновлений операционной системы.",
      shield: true,
    };
  }
  if (id === "user_temp" || id === "system_temp" || id === "thumbnails" || id === "windows_update") {
    return {
      ...lowRisk,
      description:
        id === "windows_update"
          ? "Установочные пакеты уже применённых обновлений операционной системы."
          : "Не затрагивает программы и личные файлы.",
    };
  }
  if (id === "browser_cache") {
    return {
      ...lowRisk,
      description: "Временный кэш картинок, стилей и скриптов. Сессии и пароли сохраняются.",
    };
  }
  if (id === "discord_cache") {
    return {
      ...lowRisk,
      description: "Кэшированные превью медиафайлов и голосовых сообщений.",
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
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
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
    isElevatedAdmin,
  } = c;

  const totalJunkBytes = cleanupCategories.reduce((sum, cat) => sum + cat.size_bytes, 0);
  const isZeroJunkFound = cleanupCategories.length > 0 && totalJunkBytes === 0;
  const showReaperBanner = cleanupReport !== null || isZeroJunkFound;
  const freedGbText = cleanupReport
    ? (cleanupReport.freed_bytes / (1024 * 1024 * 1024)).toFixed(2)
    : "0.00";

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
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400/90">
            SPECTRE // SYSTEM PURGE PROTOCOL
          </div>
          <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-slate-100">Центр очистки системы</h2>
          <p className="mt-0.5 text-sm text-slate-400">Временные файлы, кэш и отчёты, которые можно безопасно удалить</p>
        </div>
        <button
          type="button"
          disabled={isScanningCleanup || isCleaning}
          onClick={() => void handleScanCleanup()}
          className="cyber-btn inline-flex items-center gap-2.5 self-start px-5 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-cyan-100 disabled:opacity-60"
        >
          <RefreshCw size={14} className={isScanningCleanup ? "animate-spin text-cyan-300" : "text-cyan-300"} />
          {isScanningCleanup ? "СКАНИРОВАНИЕ..." : "АНАЛИЗ НАКОПИТЕЛЕЙ"}
        </button>
      </div>

      {cleanupError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {cleanupError}
        </div>
      )}

      {showReaperBanner && (
        <div className="tactical-card tactical-brackets flex flex-col items-start gap-4 rounded-xl p-5 sm:flex-row sm:items-center">
          <div className="octa-shell relative flex h-16 w-16 shrink-0 items-center justify-center bg-gradient-to-br from-cyan-400 via-cyan-500/50 to-indigo-500 p-[2px] shadow-[0_0_24px_rgba(0,240,255,0.28)]">
            <div className="octa-shell h-full w-full overflow-hidden bg-[#080b11]">
              <img src={reaperIcon} alt="Cyber Reaper Shield" className="h-full w-full object-cover" />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded border border-emerald-500/35 bg-emerald-500/12 px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest text-emerald-300">
                <Sparkles size={10} /> SPECTRE SHIELD // ACTIVE
              </span>
              <span className="font-mono text-xs text-slate-400">Система защищена и оптимизирована</span>
            </div>
            <div className="mt-1.5 font-mono text-xl font-bold tracking-tight text-white sm:text-2xl">
              ОСВОБОЖДЕНО {freedGbText} ГБ // СИСТЕМА ЧИСТА
            </div>
            {cleanupReport ? (
              <p className="mt-1 font-mono text-xs text-slate-400">
                Удалено объектов: <span className="text-cyan-300">{cleanupReport.deleted_files_count}</span>
                {" · "}пропущено активных: {cleanupReport.skipped_files_count}
                {" · "}объём: {formatBytes(cleanupReport.freed_bytes)}
              </p>
            ) : (
              <p className="mt-1 text-xs text-slate-400">
                Лишнего файлового мусора и устаревшего кэша в выбранных категориях не обнаружено.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="tactical-card tactical-brackets divide-y divide-slate-800/70 overflow-hidden rounded-xl">
        {cleanupCategories.length === 0 ? (
          <div className="px-4 py-12 text-center font-mono text-sm text-slate-400">
            Нажмите «АНАЛИЗ НАКОПИТЕЛЕЙ», чтобы запустить тактическое сканирование кэша.
          </div>
        ) : (
          cleanupCategories.map((cat) => {
            const checked = selectedCleanupIds.includes(cat.id);
            const safety = cleanupSafety(cat.id, isElevatedAdmin);
            return (
              <div key={cat.id} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-white/[0.02]">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => handleToggleCleanupCategory(cat.id)}
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    checked ? "border-cyan-400 bg-cyan-500/20 text-cyan-300 shadow-[0_0_8px_rgba(0,240,255,0.3)]" : "border-slate-700 text-transparent"
                  }`}
                >
                  <Check size={12} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-100">{cat.name}</span>
                    {safety && (
                      <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${safety.badgeClass}`}>
                        {safety.shield && <Shield size={11} />}
                        {safety.badge}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-slate-400">{safety?.description || cat.description}</p>
                </div>
                <span className="shrink-0 font-mono text-sm font-bold text-white">{formatBytes(cat.size_bytes)}</span>
              </div>
            );
          })
        )}
      </div>

      <div className="tactical-card sticky bottom-3 z-20 flex flex-col gap-3 rounded-xl bg-[#080b11] p-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="font-mono text-sm text-slate-300">
          ВЫБРАНО К ОЧИСТКЕ:{" "}
          <span className="font-mono text-base font-bold text-cyan-400">{formatSelectedGb(selectedCleanupBytes)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setConfirmCleanupOpen(false);
              setSelectedCleanupIds(
                cleanupCategories
                  .filter(
                    (cat) =>
                      cat.id !== "recycle_bin" &&
                      cat.id !== "windows_update" &&
                      cleanupSafety(cat.id, isElevatedAdmin)?.badge === "Низкий риск",
                  )
                  .map((cat) => cat.id),
              );
            }}
            className="rounded-lg border border-slate-800 bg-[#0e131d] px-3 py-2 font-mono text-xs font-medium text-slate-300 transition-colors hover:border-cyan-500/40 hover:text-slate-100"
          >
            Выбрать безопасные
          </button>
          {!confirmCleanupOpen ? (
            <button
              type="button"
              disabled={selectedCleanupIds.length === 0 || isCleaning}
              onClick={() => setConfirmCleanupOpen(true)}
              className="cyber-btn-danger px-5 py-2 font-mono text-xs font-bold uppercase tracking-wider text-rose-100 disabled:opacity-40 disabled:shadow-none"
            >
              ОЧИСТИТЬ ВЫБРАННОЕ
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={isCleaning}
                onClick={() => void handleExecuteCleanup()}
                className="cyber-btn-danger inline-flex items-center gap-2 px-5 py-2 font-mono text-xs font-bold uppercase tracking-wider text-rose-100"
              >
                {isCleaning && <Loader2 size={13} className="animate-spin" />}
                ПОДТВЕРДИТЬ УДАЛЕНИЕ
              </button>
              <button
                type="button"
                onClick={() => setConfirmCleanupOpen(false)}
                className="rounded-lg border border-slate-800 bg-[#0e131d] px-3 py-2 font-mono text-xs text-slate-300"
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
