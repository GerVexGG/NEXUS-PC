import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  RefreshCw,
  Loader2,
  Trash2,
  CheckCircle2,
  Check,
} from "lucide-react";
import {
  SpotlightCard,
  cardItemVariants,
  cardsContainerVariants,
  formatBytes,
} from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

function cleanupSafety(id: string): {
  level: "safe" | "rebuildable" | "diagnostic";
  badge: string;
  badgeClass: string;
  description: string;
} | null {
  if (id === "user_temp" || id === "system_temp" || id === "recycle_bin" || id === "thumbnails") {
    return {
      level: "safe",
      badge: "100% БЕЗОПАСНО",
      badgeClass: "bg-emerald-500/15 text-emerald-300 border-emerald-500/35",
      description:
        "Не затрагивает игры, софт и личные файлы. Полностью безопасно для удаления",
    };
  }
  if (id === "shader_cache") {
    return {
      level: "rebuildable",
      badge: "КЭШ ШЕЙДЕРОВ",
      badgeClass: "bg-amber-500/15 text-amber-300 border-amber-500/35",
      description:
        "Скомпилированные шейдеры старых игр. При запуске игры просто создадут нужные заново",
    };
  }
  if (id === "crash_dumps") {
    return {
      level: "diagnostic",
      badge: "ДИАГНОСТИКА",
      badgeClass: "bg-sky-500/15 text-sky-300 border-sky-500/35",
      description:
        "Технические отчеты о сбоях Windows. Удаление освобождает место без последствий",
    };
  }
  return null;
}

export function CleanupModule({ c }: { c: NexusController }) {
  const {
    isElevatedAdmin,
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
    totalCleanupBytes,
    selectedCleanupBytes,
    selectedCleanupFilesCount,
  } = c;
  return (
            <motion.div
              key="cleanup"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="space-y-5 max-w-6xl w-full"
            >
              {/* Шапка Cleanup Center */}
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/[0.06] pb-3.5">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-sky-400/90 mb-0.5">
                    CLEANUP CENTER // SAFE STORAGE SANITIZER
                  </div>
                  <h2 className="text-2xl font-bold text-[#e8edf4] tracking-tight">
                    Безопасная очистка накопителя
                  </h2>
                  <p className="text-xs sm:text-sm text-[#8793a5] mt-0.5">
                    Анализ временных кэшей, шейдеров, миниатюр, дампов памяти и корзины Windows с пропуском занятых файлов
                  </p>
                </div>

                <motion.button
                  type="button"
                  whileHover={{ scale: isScanningCleanup || isCleaning ? 1 : 1.02 }}
                  whileTap={{ scale: isScanningCleanup || isCleaning ? 1 : 0.96 }}
                  disabled={isScanningCleanup || isCleaning}
                  onClick={handleScanCleanup}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-sky-500/20 to-teal-500/20 hover:from-sky-500/30 hover:to-teal-500/30 text-sky-300 border border-sky-500/35 shadow-[0_0_20px_rgba(56,189,248,0.16)] text-xs font-mono font-bold transition-all cursor-pointer self-start sm:self-auto"
                >
                  <RefreshCw
                    size={14}
                    className={isScanningCleanup ? "animate-spin text-sky-400" : "text-sky-400"}
                  />
                  <span>{isScanningCleanup ? "АНАЛИЗ СИСТЕМЫ..." : "АНАЛИЗ СИСТЕМЫ"}</span>
                </motion.button>
              </div>

              {/* Сводная панель объёма найденного кэша и управления выделением */}
              <SpotlightCard
                spotlightColor="rgba(56, 189, 248, 0.12)"
                accentColor="emerald"
                className="p-5"
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 flex-1">
                    <div className="p-3.5 rounded-xl bg-[#151c27]/90 border border-white/[0.06] hud-dot-matrix">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-[#8793a5] block">
                        ОБНАРУЖЕНО ВСЕГО
                      </span>
                      <div className="text-2xl font-extrabold font-mono tabular-nums text-[#e8edf4] mt-1">
                        {formatBytes(totalCleanupBytes)}
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-[#151c27]/90 border border-sky-500/25 hud-dot-matrix">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-sky-400/90 block">
                        ВЫБРАНО К ОЧИСТКЕ
                      </span>
                      <div className="text-2xl font-extrabold font-mono tabular-nums text-sky-400 mt-1">
                        {formatBytes(selectedCleanupBytes)}
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-[#151c27]/90 border border-white/[0.06] hud-dot-matrix">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-[#8793a5] block">
                        ФАЙЛОВ В ВЫБОРКЕ
                      </span>
                      <div className="text-2xl font-extrabold font-mono tabular-nums text-cyan-400 mt-1">
                        {selectedCleanupFilesCount.toLocaleString("ru-RU")}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-start lg:self-center font-mono text-xs shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmCleanupOpen(false);
                        setSelectedCleanupIds(cleanupCategories.map((c) => c.id));
                      }}
                      className="px-3 py-2 rounded-lg bg-[#151c27] hover:bg-white/[0.07] text-[#c5d0de] border border-white/[0.08] transition-colors cursor-pointer"
                    >
                      Выбрать все
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmCleanupOpen(false);
                        setSelectedCleanupIds(
                          cleanupCategories
                            .filter((cat) => cleanupSafety(cat.id)?.level === "safe")
                            .map((cat) => cat.id)
                        );
                      }}
                      className="px-3 py-2 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 transition-colors cursor-pointer"
                    >
                      Выбрать только безопасные
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmCleanupOpen(false);
                        setSelectedCleanupIds([]);
                      }}
                      className="px-3 py-2 rounded-lg bg-[#151c27] hover:bg-white/[0.07] text-[#8793a5] border border-white/[0.08] transition-colors cursor-pointer"
                    >
                      Сбросить
                    </button>
                  </div>
                </div>
              </SpotlightCard>

              {/* Ошибка при сканировании или очистке */}
              <AnimatePresence>
                {cleanupError && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-mono"
                  >
                    {cleanupError}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Итоговый отчёт после выполнения очистки (CleanupReport) */}
              <AnimatePresence>
                {cleanupReport && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98, y: -6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    className="p-5 rounded-xl backdrop-blur-2xl bg-gradient-to-r from-sky-500/15 via-cyan-500/10 to-[#0b0d13] border border-sky-500/40 shadow-[0_0_28px_rgba(56,189,248,0.18)] space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-xl bg-sky-500/20 border border-sky-500/40 text-sky-300">
                          <CheckCircle2 size={20} />
                        </div>
                        <div>
                          <div className="text-[10px] font-mono uppercase tracking-wider text-sky-300 font-bold">
                            ОТЧЁТ ОЧИСТКИ НАКОПИТЕЛЯ // ЗАВЕРШЕНО
                          </div>
                          <div className="text-base sm:text-lg font-bold text-[#e8edf4] font-mono">
                            Освобождено:{" "}
                            <span className="text-sky-400">
                              {formatBytes(cleanupReport.freed_bytes)}
                            </span>{" "}
                            ({cleanupReport.freed_bytes.toLocaleString("ru-RU")} байт)
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                        <span className="px-2.5 py-1 rounded-lg bg-sky-500/15 text-sky-300 border border-sky-500/30">
                          Удалено файлов: <strong>{cleanupReport.deleted_files_count}</strong>
                        </span>
                        <span className="px-2.5 py-1 rounded-lg bg-zinc-900/90 text-[#8793a5] border border-white/[0.08]">
                          Пропущено (заняты ОС): <strong>{cleanupReport.skipped_files_count}</strong>
                        </span>
                      </div>
                    </div>

                    {cleanupReport.categories.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 pt-2 border-t border-white/[0.08]">
                        {cleanupReport.categories.map((catRep) => (
                          <div
                            key={catRep.id}
                            className="px-3 py-2 rounded-lg bg-[#151c27]/85 border border-white/[0.06] flex items-center justify-between text-xs font-mono"
                          >
                            <span className="text-[#c5d0de] truncate mr-2">{catRep.name}</span>
                            <span className="text-sky-400 font-bold shrink-0 tabular-nums">
                              -{formatBytes(catRep.freed_bytes)} ({catRep.deleted_files})
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Список категорий очистки с чекбоксами */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 md:grid-cols-2 gap-4"
              >
                {cleanupCategories.map((cat) => {
                  const isChecked = selectedCleanupIds.includes(cat.id);
                  return (
                    <SpotlightCard
                      key={cat.id}
                      variants={cardItemVariants}
                      spotlightColor={
                        isChecked
                          ? "rgba(56, 189, 248, 0.13)"
                          : "rgba(161, 161, 170, 0.07)"
                      }
                      accentColor={isChecked ? "emerald" : "cyan"}
                      className="p-4 sm:p-5"
                    >
                      <div
                        onClick={() => handleToggleCleanupCategory(cat.id)}
                        className="flex items-start justify-between gap-3.5 cursor-pointer h-full"
                      >
                        <div className="flex items-start gap-3.5 min-w-0 flex-1">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={isChecked}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleCleanupCategory(cat.id);
                            }}
                            className={`mt-0.5 h-5 w-5 rounded-md border flex items-center justify-center shrink-0 transition-all cursor-pointer ${
                              isChecked
                                ? "bg-sky-500/25 border-sky-400 text-sky-300 shadow-[0_0_12px_rgba(56,189,248,0.3)]"
                                : "bg-[#151c27] border-white/[0.15] text-transparent hover:border-white/30"
                            }`}
                          >
                            <Check size={13} />
                          </button>

                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-bold text-sm text-[#e8edf4]">
                                {cat.name}
                              </span>
                              {cleanupSafety(cat.id) && (
                                <span
                                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${cleanupSafety(cat.id)?.badgeClass}`}
                                >
                                  {cleanupSafety(cat.id)?.badge}
                                </span>
                              )}
                              {cat.requires_admin && (
                                <span
                                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                                    isElevatedAdmin
                                      ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
                                      : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                                  }`}
                                >
                                  ADMIN
                                </span>
                              )}
                            </div>

                            {cleanupSafety(cat.id) && (
                              <p className="text-xs text-[#c5d0de] leading-relaxed">
                                {cleanupSafety(cat.id)?.description}
                              </p>
                            )}
                            <p className="text-xs text-[#8793a5] leading-relaxed">
                              {cat.description}
                            </p>

                            <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] font-mono text-[#8793a5]">
                              <span className="px-2 py-0.5 rounded bg-[#151c27] border border-white/[0.05] truncate max-w-xs">
                                {cat.paths_hint}
                              </span>
                              <span>
                                Файлов:{" "}
                                <strong className="text-[#c5d0de] tabular-nums">
                                  {cat.files_count.toLocaleString("ru-RU")}
                                </strong>
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <span
                            className={`inline-block font-mono font-extrabold text-sm sm:text-base tabular-nums px-2.5 py-1 rounded-lg border ${
                              cat.size_bytes > 100 * 1024 * 1024
                                ? "bg-amber-500/15 text-amber-300 border-amber-500/35"
                                : cat.size_bytes > 0
                                ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
                                : "bg-zinc-900/80 text-[#8793a5] border-white/[0.06]"
                            }`}
                          >
                            {formatBytes(cat.size_bytes)}
                          </span>
                        </div>
                      </div>
                    </SpotlightCard>
                  );
                })}
              </motion.div>

              {/* Блок подтверждения и безопасного запуска очистки */}
              <SpotlightCard
                spotlightColor="rgba(244, 63, 94, 0.12)"
                accentColor="amber"
                className="p-5"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 shrink-0 mt-0.5">
                      <AlertTriangle size={18} />
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-sm font-semibold text-[#e8edf4]">
                        Безопасный протокол очистки NEXUS
                      </div>
                      <p className="text-xs font-mono text-[#8793a5]">
                        Заблокированные системой или открытыми программами файлы (`EBUSY` / `PermissionDenied`) автоматически пропускаются без сбоев.
                      </p>
                    </div>
                  </div>

                  {!confirmCleanupOpen ? (
                    <motion.button
                      type="button"
                      whileHover={{
                        scale:
                          selectedCleanupIds.length === 0 || isCleaning ? 1 : 1.02,
                      }}
                      whileTap={{
                        scale:
                          selectedCleanupIds.length === 0 || isCleaning ? 1 : 0.96,
                      }}
                      disabled={selectedCleanupIds.length === 0 || isCleaning}
                      onClick={() => setConfirmCleanupOpen(true)}
                      className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-xs font-mono font-bold transition-all border shrink-0 cursor-pointer ${
                        selectedCleanupIds.length === 0 || isCleaning
                          ? "bg-zinc-900 text-[#8793a5] border-white/[0.06] cursor-not-allowed"
                          : "bg-gradient-to-r from-rose-500/25 via-amber-500/20 to-sky-500/20 hover:from-rose-500/35 hover:to-sky-500/30 text-sky-300 border-sky-500/40 shadow-[0_0_22px_rgba(56,189,248,0.2)]"
                      }`}
                    >
                      <Trash2 size={15} />
                      <span>
                        ОЧИСТИТЬ ВЫБРАННОЕ ({formatBytes(selectedCleanupBytes)})
                      </span>
                    </motion.button>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2 shrink-0 font-mono text-xs">
                      <span className="text-amber-300 mr-1">
                        Удалить {selectedCleanupFilesCount.toLocaleString("ru-RU")} файлов?
                      </span>
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.96 }}
                        disabled={isCleaning}
                        onClick={handleExecuteCleanup}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-500/25 hover:bg-rose-500/35 text-rose-200 border border-rose-500/45 font-bold shadow-[0_0_18px_rgba(244,63,94,0.25)] cursor-pointer"
                      >
                        {isCleaning ? (
                          <>
                            <Loader2 size={14} className="animate-spin" />
                            <span>Очистка...</span>
                          </>
                        ) : (
                          <>
                            <Trash2 size={14} />
                            <span>Подтвердить ({formatBytes(selectedCleanupBytes)})</span>
                          </>
                        )}
                      </motion.button>
                      <button
                        type="button"
                        onClick={() => setConfirmCleanupOpen(false)}
                        className="px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-[#c5d0de] border border-white/[0.08] cursor-pointer"
                      >
                        Отмена
                      </button>
                    </div>
                  )}
                </div>
              </SpotlightCard>
            </motion.div>
  );
}
