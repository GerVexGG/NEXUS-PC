import { ModuleHeader } from "../ui/ModuleHeader";
import { useState } from "react";
import { Clock, Loader2, Lock, Moon, Play, Power, RotateCcw, XCircle } from "lucide-react";
import { formatCountdown } from "../../lib/studio";
import { NumericInput } from "../ui/NumericInput";
import { UtilityConfirmDialog } from "../ui/UtilityConfirmDialog";
import type { NexusController } from "../../hooks/useNexusController";

const PRESETS = [
  { label: "15 мин", minutes: 15 },
  { label: "30 мин", minutes: 30 },
  { label: "45 мин", minutes: 45 },
  { label: "1 ч", minutes: 60 },
  { label: "1 ч 30 мин", minutes: 90 },
  { label: "2 ч", minutes: 120 },
];

const POWER_ACTIONS = [
  { id: "shutdown", label: "Выключить ПК", icon: Power },
  { id: "restart", label: "Перезагрузить", icon: RotateCcw },
  { id: "sleep", label: "Спящий режим", icon: Moon },
  { id: "lock", label: "Заблокировать", icon: Lock },
] as const;

type ConfirmAction = "shutdown" | "restart";

export function PowerModule({ c }: { c: NexusController }) {
  const {
    timerSleep, setTimerSleep, restartMode, setRestartMode, customMinutes, setCustomMinutes,
    timerState, remainingSeconds, powerError, isPowerPending, handleCustomSubmit, handleCancelTimer,
    handleImmediateAction, timerProgress,
  } = c;
  const [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);
  const plannedAt = timerState ? new Date(timerState.endTime) : null;
  const timerAction = timerSleep ? "sleep" : restartMode ? "restart" : "shutdown";
  const plannedAction = timerState && POWER_ACTIONS.find(
    (action) => action.id === (timerState.sleep ? "sleep" : timerState.restart ? "restart" : "shutdown")
  );

  return (
    <div className="avs-module avs-power w-full space-y-4">
      <ModuleHeader module="power" title="Управление питанием" description="Запланируйте действие или отправьте команду Windows прямо сейчас" />

      {powerError && (
        <p role="alert" className="rounded-lg border border-rose-400/35 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{powerError}</p>
      )}

      <div className="avs-power-workspace">
      <section aria-labelledby="power-timer-title" aria-busy={isPowerPending} data-active={Boolean(plannedAction)} className="nexus-panel aurora-power-timer avs-power-clock overflow-hidden">
        <div className="flex items-center gap-2.5 border-b border-[#202B38] px-5 py-4">
          <Clock size={18} className="text-[#00D5E8]" />
          <h3 id="power-timer-title" className="text-base font-semibold text-[#E5EDF5]">Таймер питания</h3>
          {plannedAction && <span className="ml-auto text-sm text-[#9ce2e8]">Активен</span>}
        </div>

        {plannedAction && plannedAt ? (
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-[#d6e2eb]">
                  {plannedAction.label} · <time dateTime={Number.isFinite(plannedAt.getTime()) ? plannedAt.toISOString() : undefined}>
                    {plannedAt.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </time>
                </p>
                <p className="mt-1 font-mono text-4xl font-semibold tabular-nums text-[#b7eef4]" role="timer" aria-label="Осталось времени">
                  {formatCountdown(remainingSeconds)}
                </p>
              </div>
              <button type="button" className="nexus-button nexus-button--danger" disabled={isPowerPending} onClick={() => void handleCancelTimer()}>
                {isPowerPending ? <Loader2 size={15} className="animate-spin" /> : <XCircle size={15} />}
                {isPowerPending ? "Обработка…" : "Отменить таймер"}
              </button>
            </div>
            <progress className="block h-1.5 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-[#222e3a] [&::-webkit-progress-value]:bg-[#00aabd]" max={100} value={timerProgress} aria-label="Остаток времени" />
            <p className="text-sm text-[#a0adbb]">Windows выполнит запланированное действие и после закрытия AURORA.</p>
          </div>
        ) : (
          <form className="avs-power-layout" onSubmit={(event) => void handleCustomSubmit(event)}>
            <div className="avs-clock-face">
              <small>Выбранный интервал</small>
              <strong>{/^\d+$/.test(customMinutes) && Number(customMinutes) >= 1 && Number(customMinutes) <= 525600
                ? Number(customMinutes).toLocaleString("ru-RU") : "—"} <span className="text-lg">мин</span></strong>
              <small>{POWER_ACTIONS.find(({ id }) => id === timerAction)?.label}</small>
            </div>
            <fieldset disabled={isPowerPending} className="min-w-0 space-y-4 p-4">
              <div role="group" aria-label="Действие по таймеру" className="flex flex-wrap gap-2">
                {POWER_ACTIONS.filter((action) => action.id !== "lock").map((action) => (
                  <button
                    type="button"
                    key={action.id}
                    aria-pressed={timerAction === action.id}
                    className={`nexus-button ${timerAction === action.id ? "border-[#3f7985] bg-[#103039] text-[#b7eef4]" : ""}`}
                    onClick={() => {
                      setTimerSleep(action.id === "sleep");
                      setRestartMode(action.id === "restart");
                    }}
                  >
                    <action.icon size={15} />{action.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-full max-w-48 space-y-1.5">
                  <p className="text-xs font-medium text-[#a0adbb]">Через</p>
                  <NumericInput
                    ariaLabel="Время до выполнения"
                    min={1}
                    max={525600}
                    step={5}
                    unit="мин"
                    value={customMinutes}
                    onChange={(raw) => setCustomMinutes(raw)}
                    placeholder="Например, 45"
                  />
                </div>
                <div role="group" aria-label="Быстрый выбор времени" className="flex flex-wrap gap-1.5">
                  {PRESETS.map((preset) => (
                    <button key={preset.minutes} type="button" aria-pressed={customMinutes === String(preset.minutes)} className="nexus-button tabular-nums" onClick={() => setCustomMinutes(String(preset.minutes))}>
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
              <button type="submit" className="nexus-button nexus-button--primary">
                {isPowerPending ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                {isPowerPending ? "Планирование…" : "Запустить таймер"}
              </button>
            </fieldset>
          </form>
        )}
      </section>

      <section className="nexus-panel p-5" aria-labelledby="power-immediate-title">
        <h3 id="power-immediate-title" className="text-base font-semibold text-[#E5EDF5]">Действия сейчас</h3>
        <div className="avs-immediate-actions mt-3 grid gap-2">
          {POWER_ACTIONS.map((action) => (
            <button
              type="button"
              key={action.id}
              disabled={isPowerPending}
              className={`nexus-button justify-start ${action.id === "shutdown" || action.id === "restart" ? "text-rose-200" : ""}`}
              onClick={() => {
                if (action.id === "shutdown" || action.id === "restart") setConfirmation(action.id);
                else void handleImmediateAction(action.id);
              }}
            >
              <action.icon size={16} />
              {action.label}
            </button>
          ))}
        </div>
      </section>
      </div>

      {confirmation && (
        <UtilityConfirmDialog
          title={confirmation === "restart" ? "Перезагрузить компьютер сейчас?" : "Выключить компьютер сейчас?"}
          confirmLabel={confirmation === "restart" ? "Перезагрузить" : "Выключить"}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            void handleImmediateAction(confirmation);
            setConfirmation(null);
          }}
        >
          <p>Сохраните работу в открытых приложениях перед продолжением.</p>
          {plannedAction && <p className="text-amber-200">Активный таймер будет отменён.</p>}
        </UtilityConfirmDialog>
      )}
    </div>
  );
}
