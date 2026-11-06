import { motion, AnimatePresence } from "framer-motion";
import {
  FolderOpen,
  Search,
  AlertTriangle,
  RefreshCw,
  AppWindow,
} from "lucide-react";
import {
  SpotlightCard,
  cardItemVariants,
  cardsContainerVariants,
  getLocationBadgeStyles,
} from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

export function StartupModule({ c }: { c: NexusController }) {
  const {
    startupSearch,
    setStartupSearch,
    startupLoading,
    startupError,
    fetchStartupItems,
    handleToggleStartup,
    handleOpenItemLocation,
    totalStartupCount,
    activeStartupCount,
    brokenStartupCount,
    filteredStartupItems,
  } = c;
  return (
            <motion.div
              key="startup"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="space-y-6 max-w-6xl w-full"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold text-[#e8edf4] tracking-tight">
                    Менеджер автозагрузки
                  </h2>
                  <p className="text-xs sm:text-sm text-[#8793a5] font-mono mt-1">
                    Всего записей:{" "}
                    <span className="text-[#d5dde8] font-semibold">{totalStartupCount}</span> •
                    Активных:{" "}
                    <span className="text-sky-400 font-semibold">
                      {activeStartupCount}
                    </span>{" "}
                    • Обнаружено битых путей:{" "}
                    <span
                      className={
                        brokenStartupCount > 0
                          ? "text-rose-400 font-semibold"
                          : "text-[#8793a5] font-semibold"
                      }
                    >
                      {brokenStartupCount}
                    </span>
                  </p>
                </div>

                <motion.button
                  type="button"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.96 }}
                  onClick={fetchStartupItems}
                  disabled={startupLoading}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl backdrop-blur-xl bg-zinc-900/70 hover:bg-zinc-800/80 border border-white/[0.08] text-xs font-mono text-[#c5d0de] transition-colors cursor-pointer self-start sm:self-auto"
                >
                  <RefreshCw
                    size={14}
                    className={
                      startupLoading ? "animate-spin text-sky-400" : "text-sky-400"
                    }
                  />
                  <span>Обновить</span>
                </motion.button>
              </div>

              <div className="relative">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#8793a5]"
                />
                <input
                  type="text"
                  value={startupSearch}
                  onChange={(e) => setStartupSearch(e.target.value)}
                  placeholder="Поиск по названию программы, пути или расположению (HKCU, HKLM, Папка)..."
                  className="w-full pl-11 pr-4 py-3 rounded-2xl backdrop-blur-xl bg-zinc-900/60 border border-white/[0.07] text-sm text-[#e8edf4] placeholder-zinc-500 focus:outline-none focus:border-sky-500/40 focus:shadow-[0_0_20px_rgba(56,189,248,0.1)] transition-all"
                />
              </div>

              <AnimatePresence>
                {startupError && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-mono"
                  >
                    {startupError}
                  </motion.div>
                )}
              </AnimatePresence>

              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
                className="space-y-3"
              >
                {filteredStartupItems.length === 0 ? (
                  <SpotlightCard className="p-8 text-center">
                    <p className="text-sm text-[#8793a5] font-mono">
                      {startupLoading
                        ? "Сканирование реестра и папок автозагрузки..."
                        : "Записи автозагрузки не найдены"}
                    </p>
                  </SpotlightCard>
                ) : (
                  filteredStartupItems.map((item) => (
                    <SpotlightCard
                      key={item.id}
                      variants={cardItemVariants}
                      spotlightColor={
                        !item.file_exists
                          ? "rgba(244, 63, 94, 0.14)"
                          : item.enabled
                          ? "rgba(56, 189, 248, 0.12)"
                          : "rgba(161, 161, 170, 0.08)"
                      }
                      className="p-4 sm:p-5"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="flex items-start gap-3.5 min-w-0 flex-1">
                          <div
                            className={`mt-0.5 p-2.5 rounded-xl border shrink-0 ${
                              !item.file_exists
                                ? "bg-rose-500/10 border-rose-500/30 text-rose-400"
                                : item.enabled
                                ? "bg-sky-500/10 border-sky-500/25 text-sky-400"
                                : "bg-zinc-800/70 border-white/[0.06] text-[#8793a5]"
                            }`}
                          >
                            {!item.file_exists ? (
                              <AlertTriangle size={18} />
                            ) : (
                              <AppWindow size={18} />
                            )}
                          </div>

                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`font-semibold text-sm sm:text-base truncate ${
                                  item.enabled ? "text-[#e8edf4]" : "text-[#8793a5]"
                                }`}
                              >
                                {item.name}
                              </span>

                              <span
                                className={`text-[11px] font-mono px-2 py-0.5 rounded-md border ${getLocationBadgeStyles(
                                  item.location
                                )}`}
                              >
                                {item.location}
                              </span>

                              {!item.file_exists && (
                                <span className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-md bg-rose-500/15 text-rose-400 border border-rose-500/35 shadow-[0_0_12px_rgba(244,63,94,0.2)]">
                                  ⚠️ Битая запись (файл не найден)
                                </span>
                              )}
                            </div>

                            <p
                              title={item.command}
                              className="text-xs font-mono text-[#8793a5] truncate"
                            >
                              {item.clean_path || item.command}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center justify-end gap-3 shrink-0">
                          <motion.button
                            type="button"
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.94 }}
                            onClick={() => handleOpenItemLocation(item)}
                            title="Показать в проводнике"
                            className="p-2.5 rounded-xl bg-zinc-800/70 hover:bg-zinc-700/80 text-[#c5d0de] hover:text-sky-400 border border-white/[0.06] hover:border-sky-500/30 transition-colors cursor-pointer"
                          >
                            <FolderOpen size={16} />
                          </motion.button>

                          <button
                            type="button"
                            role="switch"
                            aria-checked={item.enabled}
                            onClick={() => handleToggleStartup(item)}
                            className={`relative inline-flex h-7 w-13 shrink-0 items-center rounded-full p-1 transition-colors duration-200 cursor-pointer border ${
                              item.enabled
                                ? "bg-sky-500/25 border-sky-500/40 shadow-[0_0_14px_rgba(56,189,248,0.25)] justify-end"
                                : "bg-zinc-900/90 border-white/[0.08] justify-start"
                            }`}
                          >
                            <motion.span
                              layout
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 32,
                              }}
                              className={`h-5 w-5 rounded-full ${
                                item.enabled
                                  ? "bg-sky-400 shadow-[0_0_10px_#38bdf8]"
                                  : "bg-zinc-500"
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    </SpotlightCard>
                  ))
                )}
              </motion.div>
            </motion.div>
  );
}
