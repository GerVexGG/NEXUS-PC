import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Lock, Moon, Play, Power, RotateCcw, XCircle } from "lucide-react";
import { formatCountdown } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

const CHIPS = [
  { label: "15 мин", minutes: 15 },
  { label: "30 мин", minutes: 30 },
  { label: "45 мин", minutes: 45 },
  { label: "1 час", minutes: 60 },
  { label: "1.5 часа", minutes: 90 },
  { label: "2 часа", minutes: 120 },
];

type ImmediateAction = "shutdown" | "restart";

export function PowerModule({ c }: { c: NexusController }) {
  const {
    timerSleep,
    setTimerSleep,
    restartMode,
    setRestartMode,
    customMinutes,
    setCustomMinutes,
    timerState,
    remainingSeconds,
    powerError,
    setPowerError,
    handleStartTimer,
    handleCancelTimer,
    handleImmediateAction,
    timerProgress,
  } = c;
  const [confirmAction, setConfirmAction] = useState<ImmediateAction | null>(null);
  const timerActive = Boolean(timerState && remainingSeconds > 0);

  const plannedAt = timerState
    ? new Date(timerState.endTime).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
    : "";
  const plannedLabel = timerState?.sleep
    ? `Переход в спящий режим запланирован на ${plannedAt}`
    : timerState?.restart
      ? `Перезагрузка запланирована на ${plannedAt}`
      : `Выключение запланировано на ${plannedAt}`;

  const actions = [
    {
      id: "shutdown" as const,
      label: "Завершение работы",
      icon: Power,
      hover: "hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300",
      iconClass: "text-rose-300",
    },
    {
      id: "restart" as const,
      label: "Перезагрузка",
      icon: RotateCcw,
      hover: "hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-300",
      iconClass: "text-amber-300",
    },
    {
      id: "sleep" as const,
      label: "Спящий режим",
      icon: Moon,
      hover: "hover:border-sky-500/40 hover:bg-sky-500/10 hover:text-sky-300",
      iconClass: "text-sky-300",
    },
    {
      id: "lock" as const,
      label: "Блокировка",
      icon: Lock,
      hover: "hover:border-indigo-500/40 hover:bg-indigo-500/10 hover:text-indigo-300",
      iconClass: "text-indigo-300",
    },
  ];

  return (
    <motion.div
      key="power"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="w-full max-w-5xl space-y-4"
    >
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-100">Управление питанием</h2>
        <p className="mt-0.5 text-sm text-slate-400">Таймеры автоматического выключения и системные действия</p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              type="button"
              onClick={() => {
                if (action.id === "shutdown" || action.id === "restart") {
                  setConfirmAction(action.id);
                  return;
                }
                void handleImmediateAction(action.id);
              }}
              className={`flex flex-col items-start gap-3 rounded-xl border border-[#222b38] bg-[#111722] px-4 py-4 text-left text-slate-200 transition-colors ${action.hover}`}
            >
              <Icon size={18} className={action.iconClass} />
              <span className="text-sm font-medium">{action.label}</span>
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border border-[#222b38] bg-[#111722] p-4">
        {timerActive && timerState ? (
          <div className="space-y-4">
            <div className="font-mono text-4xl font-bold text-slate-100">{formatCountdown(remainingSeconds)}</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[#151c27]">
              <div className="h-full rounded-full bg-sky-400 transition-all duration-500" style={{ width: `${timerProgress}%` }} />
            </div>
            <p className="text-sm text-slate-300">{plannedLabel}</p>
            <button
              type="button"
              onClick={() => void handleCancelTimer()}
              className="inline-flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/20 px-3 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/30"
            >
              <XCircle size={14} />
              Отменить таймер
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setTimerSleep(false);
                  setRestartMode(false);
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  !timerSleep && !restartMode
                    ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                    : "border-[#222b38] bg-[#151c27] text-slate-400 hover:text-slate-200"
                }`}
              >
                Выключение ПК
              </button>
              <button
                type="button"
                onClick={() => {
                  setTimerSleep(false);
                  setRestartMode(true);
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  !timerSleep && restartMode
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                    : "border-[#222b38] bg-[#151c27] text-slate-400 hover:text-slate-200"
                }`}
              >
                Перезагрузка ПК
              </button>
              <button
                type="button"
                onClick={() => {
                  setTimerSleep(true);
                  setRestartMode(false);
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  timerSleep
                    ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                    : "border-[#222b38] bg-[#151c27] text-slate-400 hover:text-slate-200"
                }`}
              >
                Спящий режим
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {CHIPS.map((chip) => {
                const selected = customMinutes === String(chip.minutes);
                return (
                  <button
                    key={chip.minutes}
                    type="button"
                    onClick={() => setCustomMinutes(String(chip.minutes))}
                    className={`rounded-lg border px-3 py-1.5 text-xs ${
                      selected
                        ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                        : "border-[#222b38] bg-[#151c27] text-slate-300 hover:text-slate-100"
                    }`}
                  >
                    {chip.label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                type="number"
                min="1"
                max="525600"
                step="1"
                value={customMinutes}
                onChange={(event) => setCustomMinutes(event.target.value)}
                placeholder="Минуты"
                className="flex-1 rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-slate-500"
              />
              <button
                type="button"
                onClick={() => {
                  const mins = parseFloat(customMinutes);
                  if (!Number.isNaN(mins) && mins > 0) void handleStartTimer(mins);
                  else setPowerError("Укажите положительное количество минут");
                }}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/20 px-4 py-2 text-sm font-medium text-sky-300 hover:bg-sky-500/30"
              >
                <Play size={15} />
                Запустить таймер
              </button>
            </div>
          </div>
        )}
        <AnimatePresence>
          {powerError && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
            >
              {powerError}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-md rounded-xl border border-[#222b38] bg-[#111722] p-4 shadow-2xl">
            <h3 className="text-base font-semibold text-slate-100">
              {confirmAction === "restart" ? "Перезагрузка компьютера" : "Завершение работы"}
            </h3>
            <p className="mt-2 text-sm text-slate-300">
              {confirmAction === "restart"
                ? "Компьютер будет перезагружен сразу. Несохранённые данные могут быть потеряны."
                : "Компьютер будет выключен сразу. Несохранённые данные могут быть потеряны."}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 text-xs font-medium text-slate-300 hover:bg-[#1a2332]"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  const action = confirmAction;
                  setConfirmAction(null);
                  void handleImmediateAction(action);
                }}
                className="rounded-lg border border-rose-500/30 bg-rose-500/20 px-3 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/30"
              >
                Продолжить
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
