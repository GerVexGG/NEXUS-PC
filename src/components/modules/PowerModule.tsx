import { motion, AnimatePresence } from "framer-motion";
import {
  Power,
  Clock,
  RotateCcw,
  XCircle,
  Play,
} from "lucide-react";
import {
  PRESET_MINUTES,
  SpotlightCard,
  formatCountdown,
} from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

export function PowerModule({ c }: { c: NexusController }) {
  const {
    restartMode,
    setRestartMode,
    customMinutes,
    setCustomMinutes,
    timerState,
    remainingSeconds,
    powerError,
    handleStartTimer,
    handleCancelTimer,
    handleCustomSubmit,
    timerProgress,
  } = c;
  return (
            <motion.div
              key="power"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="space-y-6 max-w-2xl w-full"
            >
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-100">
                  Управление питанием
                </h2>
                <p className="text-sm text-[#8793a5] mt-1">
                  Таймеры автоматического выключения и перезагрузки Windows
                </p>
              </div>

              <SpotlightCard
                spotlightColor={
                  restartMode
                    ? "rgba(251, 191, 36, 0.12)"
                    : "rgba(56, 189, 248, 0.12)"
                }
                className="p-6"
              >
                <div className="space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/[0.06]">
                    <div className="flex items-center gap-3 text-[#d5dde8]">
                      <div className="p-2 rounded-xl bg-sky-500/10 border border-sky-500/20">
                        <Clock className="text-sky-400 shrink-0" size={18} />
                      </div>
                      <span className="font-medium text-base">Режим действия</span>
                    </div>

                    <div className="inline-flex rounded-xl bg-zinc-950/80 p-1 border border-white/[0.06]">
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.96 }}
                        onClick={() => setRestartMode(false)}
                        className={`relative flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                          !restartMode
                            ? "text-sky-400"
                            : "text-[#8793a5] hover:text-[#d5dde8]"
                        }`}
                      >
                        {!restartMode && (
                          <motion.div
                            layoutId="powerModePill"
                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                            className="absolute inset-0 rounded-lg bg-sky-500/15 border border-sky-500/30 shadow-[0_0_14px_rgba(56,189,248,0.2)]"
                          />
                        )}
                        <span className="relative z-10 flex items-center gap-2">
                          <Power size={14} />
                          <span>Выключение</span>
                        </span>
                      </motion.button>

                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.96 }}
                        onClick={() => setRestartMode(true)}
                        className={`relative flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                          restartMode
                            ? "text-amber-400"
                            : "text-[#8793a5] hover:text-[#d5dde8]"
                        }`}
                      >
                        {restartMode && (
                          <motion.div
                            layoutId="powerModePill"
                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                            className="absolute inset-0 rounded-lg bg-amber-500/15 border border-amber-500/30 shadow-[0_0_14px_rgba(251,191,36,0.2)]"
                          />
                        )}
                        <span className="relative z-10 flex items-center gap-2">
                          <RotateCcw size={14} />
                          <span>Перезагрузка</span>
                        </span>
                      </motion.button>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <label className="block text-xs font-mono uppercase tracking-wider text-[#8793a5]">
                      Быстрый запуск
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {PRESET_MINUTES.map((mins) => (
                        <motion.button
                          key={mins}
                          type="button"
                          whileHover={{ y: -2 }}
                          whileTap={{ scale: 0.96 }}
                          transition={{ type: "spring", stiffness: 400, damping: 22 }}
                          onClick={() => handleStartTimer(mins)}
                          className="py-3 px-3 rounded-xl bg-zinc-800/60 hover:bg-sky-500/10 text-[#d5dde8] hover:text-sky-300 text-sm font-medium transition-colors border border-white/[0.06] hover:border-sky-500/35 hover:shadow-[0_0_20px_rgba(56,189,248,0.14)] cursor-pointer"
                        >
                          {mins} мин
                        </motion.button>
                      ))}
                    </div>
                  </div>

                  <form onSubmit={handleCustomSubmit} className="space-y-2.5">
                    <label className="block text-xs font-mono uppercase tracking-wider text-[#8793a5]">
                      Произвольное время (в минутах)
                    </label>
                    <div className="flex flex-col sm:flex-row gap-3">
                      <input
                        type="number"
                        min="1"
                        max="525600"
                        step="1"
                        value={customMinutes}
                        onChange={(e) => setCustomMinutes(e.target.value)}
                        placeholder="Например: 90"
                        className="flex-1 px-4 py-2.5 rounded-xl bg-zinc-950/80 border border-white/[0.07] text-[#e8edf4] placeholder-zinc-500 text-sm focus:outline-none focus:border-sky-500/50 focus:shadow-[0_0_16px_rgba(56,189,248,0.12)] transition-all"
                      />
                      <motion.button
                        type="submit"
                        whileHover={{ scale: 1.01 }}
                        whileTap={{ scale: 0.97 }}
                        className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-sky-500/20 to-teal-500/20 hover:from-sky-500/30 hover:to-teal-500/30 text-sky-300 border border-sky-500/30 shadow-[0_0_20px_rgba(56,189,248,0.15)] text-sm font-medium transition-all cursor-pointer"
                      >
                        <Play size={16} />
                        <span>Запустить таймер</span>
                      </motion.button>
                    </div>
                  </form>

                  <AnimatePresence>
                    {powerError && (
                      <motion.div
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-mono"
                      >
                        {powerError}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <AnimatePresence>
                    {timerState && remainingSeconds > 0 && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.97, y: 8 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97, y: 8 }}
                        transition={{ type: "spring", stiffness: 320, damping: 26 }}
                        className="p-5 rounded-2xl bg-zinc-950/85 border border-white/[0.08] space-y-4 shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                          <div>
                            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-zinc-900 border border-white/[0.06] text-xs font-mono">
                              <span className="relative flex h-2 w-2">
                                <span
                                  className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                                    timerState.restart ? "bg-amber-400" : "bg-sky-400"
                                  }`}
                                />
                                <span
                                  className={`relative inline-flex rounded-full h-2 w-2 ${
                                    timerState.restart ? "bg-amber-400" : "bg-sky-400"
                                  }`}
                                />
                              </span>
                              <span className="text-[#8793a5]">Активный таймер:</span>
                              <strong
                                className={
                                  timerState.restart ? "text-amber-400" : "text-sky-400"
                                }
                              >
                                {timerState.restart ? "Перезагрузка" : "Выключение"}
                              </strong>
                            </div>

                            <div className="text-3xl sm:text-4xl font-bold font-mono text-[#e8edf4] mt-2 tracking-tight drop-shadow-[0_0_14px_rgba(56,189,248,0.2)]">
                              {formatCountdown(remainingSeconds)}
                            </div>
                          </div>

                          <motion.button
                            type="button"
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.96 }}
                            onClick={handleCancelTimer}
                            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 border border-rose-500/30 shadow-[0_0_20px_rgba(244,63,94,0.15)] text-sm font-medium transition-all cursor-pointer"
                          >
                            <XCircle size={16} />
                            <span>Отменить таймер</span>
                          </motion.button>
                        </div>

                        <div className="w-full bg-zinc-800/80 h-2 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${
                              timerState.restart
                                ? "bg-gradient-to-r from-amber-500 via-orange-400 to-yellow-400 shadow-[0_0_12px_rgba(251,191,36,0.5)]"
                                : "bg-gradient-to-r from-sky-500 via-teal-400 to-cyan-400 shadow-[0_0_12px_rgba(56,189,248,0.5)]"
                            }`}
                            style={{ width: `${timerProgress}%` }}
                          ></div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </SpotlightCard>
            </motion.div>
  );
}
