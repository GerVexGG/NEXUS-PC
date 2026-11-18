import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Clock, Lock, Moon, Play, Power, RotateCcw, XCircle } from "lucide-react";
import { PageHeader, SegmentedHudBar, formatCountdown } from "../../lib/studio";
import { NumericInput } from "../ui/NumericInput";
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
    ? new Date(timerState.endTime).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  const plannedLabel = timerState?.sleep
    ? `Переход в спящий режим в ${plannedAt}`
    : timerState?.restart
    ? `Автоматическая перезагрузка в ${plannedAt}`
    : `Автоматическое выключение в ${plannedAt}`;

  const actions = [
    {
      id: "shutdown" as const,
      label: "Завершение работы",
      desc: "Безопасное закрытие сеанса и отключение питания",
      code: "ACPI // S5",
      icon: Power,
      hover: "hover:border-rose-500/45",
      iconBox: "border-rose-500/30 bg-rose-500/12 text-rose-300",
    },
    {
      id: "restart" as const,
      label: "Перезагрузка",
      desc: "Полный перезапуск операционной системы Windows",
      code: "SYS // REBOOT",
      icon: RotateCcw,
      hover: "hover:border-amber-500/45",
      iconBox: "border-amber-500/30 bg-amber-500/12 text-amber-300",
    },
    {
      id: "sleep" as const,
      label: "Спящий режим",
      desc: "Низкое энергопотребление с сохранением состояния в RAM",
      code: "ACPI // S3",
      icon: Moon,
      hover: "hover:border-[#00D5E8]/45",
      iconBox: "border-[#00D5E8]/30 bg-[#00D5E8]/12 text-[#00D5E8]",
    },
    {
      id: "lock" as const,
      label: "Блокировка экрана",
      desc: "Мгновенный переход к экрану входа Windows",
      code: "SEC // LOCK",
      icon: Lock,
      hover: "hover:border-indigo-500/45",
      iconBox: "border-indigo-500/30 bg-indigo-500/12 text-indigo-300",
    },
  ];

  return (
    <motion.div
      key="power"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="w-full space-y-4"
    >
      <PageHeader
        title="Управление питанием"
        description="Прямые системные команды управления питанием и программируемый таймер отключения"
        badge={
          timerActive ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-[#00D5E8]/35 bg-[#00D5E8]/12 px-2.5 py-0.5 font-mono text-xs font-semibold text-[#00D5E8]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#00D5E8]" />
              Таймер: {formatCountdown(remainingSeconds)}
            </span>
          ) : undefined
        }
      />

      {/* Карточки мгновенных команд питания */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
              className={`tactical-card tactical-brackets group flex cursor-pointer flex-col justify-between gap-4 rounded-xl p-4 text-left transition-all ${action.hover}`}
            >
              <div className="flex w-full items-center justify-between">
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg border ${action.iconBox}`}>
                  <Icon size={18} />
                </div>
                <span className="font-mono text-[10px] font-medium tracking-wider text-[#526170]">
                  {action.code}
                </span>
              </div>
              <div>
                <div className="text-sm font-semibold text-[#E5EDF5] group-hover:text-white">
                  {action.label}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-[#8292A3]">{action.desc}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Панель таймера питания */}
      <div className="tactical-card tactical-brackets rounded-xl p-5">
        <div className="mb-4 flex items-center justify-between border-b border-[#202B38] pb-3">
          <div className="flex items-center gap-2.5">
            <Clock size={16} className="text-[#00D5E8]" />
            <div>
              <h3 className="text-sm font-semibold text-[#E5EDF5]">
                Таймер автоматического действия
              </h3>
              <p className="text-xs text-[#8292A3]">
                Планирование отключения, перезагрузки или перехода в спящий режим по расписанию
              </p>
            </div>
          </div>
          <span
            className={`rounded border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
              timerActive
                ? "border-[#00D5E8]/35 bg-[#00D5E8]/12 text-[#00D5E8]"
                : "border-[#202B38] bg-[#151C26] text-[#8292A3]"
            }`}
          >
            {timerActive ? "ТАЙМЕР АКТИВЕН" : "ОЖИДАНИЕ ЗАПУСКА"}
          </span>
        </div>

        {timerActive && timerState ? (
          <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-12">
            <div className="rounded-xl border border-[#202B38] bg-[#0B0E14] p-5 lg:col-span-7">
              <div className="text-xs font-medium uppercase tracking-wider text-[#8292A3]">
                Осталось времени до выполнения
              </div>
              <div className="mt-2 font-mono text-4xl font-bold tracking-tight text-[#00D5E8] sm:text-5xl">
                {formatCountdown(remainingSeconds)}
              </div>
              <div className="mt-4">
                <SegmentedHudBar percentage={timerProgress} theme="cyan" />
              </div>
              <div className="mt-2.5 flex items-center justify-between text-xs text-[#8292A3]">
                <span>{plannedLabel}</span>
                <span className="font-mono text-[#E5EDF5]">{timerProgress.toFixed(0)}%</span>
              </div>
            </div>

            <div className="flex flex-col justify-between gap-4 rounded-xl border border-[#202B38] bg-[#0B0E14] p-5 lg:col-span-5">
              <div>
                <div className="text-xs font-medium text-[#8292A3]">Запланированный сценарий</div>
                <div className="mt-1 text-base font-semibold text-[#E5EDF5]">
                  {timerState.sleep
                    ? "Переход в спящий режим"
                    : timerState.restart
                    ? "Перезагрузка системы"
                    : "Завершение работы ПК"}
                </div>
                <p className="mt-1 text-xs text-[#8292A3]">
                  Вы можете отменить запланированное действие в любой момент до истечения обратного отсчёта. Таймер выполняется системным механизмом и продолжает работу даже при закрытии NEXUS.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleCancelTimer()}
                className="cyber-btn-danger inline-flex w-full cursor-pointer items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-rose-300"
              >
                <XCircle size={15} />
                Отменить активный таймер
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
            <div className="space-y-4 lg:col-span-7">
              <div>
                <div className="mb-2 text-xs font-medium text-[#8292A3]">1. Выберите тип действия</div>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setTimerSleep(false);
                      setRestartMode(false);
                    }}
                    className={`cursor-pointer rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                      !timerSleep && !restartMode
                        ? "border-[#00D5E8]/45 bg-[#00D5E8]/12 text-[#00D5E8]"
                        : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
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
                    className={`cursor-pointer rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                      !timerSleep && restartMode
                        ? "border-amber-500/45 bg-amber-500/12 text-amber-300"
                        : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
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
                    className={`cursor-pointer rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                      timerSleep
                        ? "border-[#00D5E8]/45 bg-[#00D5E8]/12 text-[#00D5E8]"
                        : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
                    }`}
                  >
                    Спящий режим
                  </button>
                </div>
              </div>

              <div>
                <div className="mb-2 text-xs font-medium text-[#8292A3]">2. Быстрый выбор интервала</div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  {CHIPS.map((chip) => {
                    const selected = customMinutes === String(chip.minutes);
                    return (
                      <button
                        key={chip.minutes}
                        type="button"
                        onClick={() => setCustomMinutes(String(chip.minutes))}
                        className={`cursor-pointer rounded-lg border px-2.5 py-2 font-mono text-xs transition-colors ${
                          selected
                            ? "border-[#00D5E8]/45 bg-[#00D5E8]/12 font-semibold text-[#00D5E8]"
                            : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
                        }`}
                      >
                        {chip.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex flex-col justify-between rounded-xl border border-[#202B38] bg-[#0B0E14] p-4 lg:col-span-5">
              <div>
                <div className="mb-2 text-xs font-medium text-[#8292A3]">
                  3. Произвольный интервал (в минутах)
                </div>
                <NumericInput
                  ariaLabel="Произвольный интервал в минутах"
                  min={1}
                  max={525600}
                  step={5}
                  unit="мин"
                  value={customMinutes}
                  onChange={(raw) => setCustomMinutes(raw)}
                  placeholder="Например: 45"
                  className="bg-[#10151D]"
                />
              </div>

              <button
                type="button"
                onClick={() => {
                  const mins = parseFloat(customMinutes);
                  if (!Number.isNaN(mins) && mins > 0) void handleStartTimer(mins);
                  else setPowerError("Укажите положительное количество минут");
                }}
                className="cyber-btn mt-4 inline-flex w-full cursor-pointer items-center justify-center gap-2 px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-[#00D5E8]"
              >
                <Play size={14} />
                Запустить таймер
              </button>
            </div>
          </div>
        )}

        <AnimatePresence>
          {powerError && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="mt-4 rounded-xl border border-rose-500/35 bg-rose-500/12 px-3.5 py-2.5 text-xs text-rose-300"
            >
              {powerError}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-xl border border-[#202B38] bg-[#10151D] p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-[#E5EDF5]">
              {confirmAction === "restart" ? "Подтверждение перезагрузки" : "Подтверждение выключения"}
            </h3>
            <p className="mt-2 text-sm text-[#8292A3]">
              {confirmAction === "restart"
                ? "Компьютер будет немедленно перезагружен. Убедитесь, что все рабочие файлы сохранены."
                : "Компьютер будет немедленно выключен. Убедитесь, что все рабочие файлы сохранены."}
            </p>
            {timerActive && (
              <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                Активный таймер питания будет отменён перед выполнением действия.
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="cursor-pointer rounded-lg border border-[#202B38] bg-[#151C26] px-3.5 py-2 text-xs font-medium text-[#8292A3] hover:text-[#E5EDF5]"
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
                className="cyber-btn-danger cursor-pointer px-3.5 py-2 text-xs font-semibold text-rose-300"
              >
                Выполнить сейчас
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
