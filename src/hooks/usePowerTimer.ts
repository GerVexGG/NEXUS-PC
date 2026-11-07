import { useState, useEffect, useMemo, useCallback, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type StoredTimerState,
  TIMER_STORAGE_KEY,
} from "../lib/studio";

export type PowerImmediateAction = "shutdown" | "restart" | "sleep" | "lock";

export function usePowerTimer() {
  const [restartMode, setRestartMode] = useState<boolean>(false);
  const [timerSleep, setTimerSleep] = useState<boolean>(false);
  const [customMinutes, setCustomMinutes] = useState<string>("");
  const [timerState, setTimerState] = useState<StoredTimerState | null>(() => {
    try {
      const raw = localStorage.getItem(TIMER_STORAGE_KEY);
      if (!raw) return null;
      const parsed: StoredTimerState = JSON.parse(raw);
      if (parsed.endTime > Date.now()) {
        return parsed;
      }
      localStorage.removeItem(TIMER_STORAGE_KEY);
      return null;
    } catch {
      return null;
    }
  });
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() => {
    if (!timerState) return 0;
    return Math.max(0, Math.ceil((timerState.endTime - Date.now()) / 1000));
  });
  const [powerError, setPowerError] = useState<string | null>(null);

  // Живой обратный отсчет таймера (работает независимо от выбранной вкладки Sidebar)
  useEffect(() => {
    if (!timerState) {
      setRemainingSeconds(0);
      return;
    }

    const updateRemaining = () => {
      const diff = Math.ceil((timerState.endTime - Date.now()) / 1000);
      if (diff <= 0) {
        const shouldSleep = timerState.sleep === true;
        setRemainingSeconds(0);
        setTimerState(null);
        localStorage.removeItem(TIMER_STORAGE_KEY);
        if (shouldSleep) {
          void invoke("system_power_action", { action: "sleep" }).catch((err) => {
            setPowerError(String(err));
          });
        }
      } else {
        setRemainingSeconds(diff);
      }
    };

    updateRemaining();
    const interval = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(interval);
  }, [timerState]);

  const handleStartTimer = useCallback(
    async (minutes: number) => {
      setPowerError(null);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        setPowerError("Введите корректное время в минутах (больше 0)");
        return;
      }

      const seconds = Math.round(minutes * 60);
      const sleep = timerSleep && !restartMode;
      try {
        if (sleep) {
          await invoke("cancel_shutdown");
        } else {
          await invoke("schedule_shutdown", {
            seconds,
            restart: restartMode,
          });
        }

        const newState: StoredTimerState = {
          endTime: Date.now() + seconds * 1000,
          totalSeconds: seconds,
          restart: sleep ? false : restartMode,
          sleep,
        };
        setTimerState(newState);
        setRemainingSeconds(seconds);
        localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(newState));
      } catch (err) {
        console.error("Ошибка при запуске таймера:", err);
        setPowerError(String(err));
      }
    },
    [timerSleep, restartMode]
  );

  const handleCancelTimer = useCallback(async (): Promise<boolean> => {
    setPowerError(null);
    try {
      await invoke("cancel_shutdown");
      setTimerState(null);
      setRemainingSeconds(0);
      localStorage.removeItem(TIMER_STORAGE_KEY);
      return true;
    } catch (err) {
      console.error("Ошибка при отмене таймера:", err);
      setPowerError("Не удалось отменить системный таймер");
      return false;
    }
  }, []);

  const handleImmediateAction = useCallback(
    async (action: PowerImmediateAction) => {
      setPowerError(null);
      const timerActive = Boolean(timerState && remainingSeconds > 0);
      try {
        if ((action === "shutdown" || action === "restart") && timerActive) {
          const cancelled = await handleCancelTimer();
          if (!cancelled) return;
        }
        await invoke("system_power_action", { action });
      } catch (err) {
        setPowerError(String(err));
      }
    },
    [timerState, remainingSeconds, handleCancelTimer]
  );

  const handleCustomSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const mins = parseFloat(customMinutes);
      if (!Number.isNaN(mins) && mins > 0) {
        void handleStartTimer(mins);
        setCustomMinutes("");
      } else {
        setPowerError("Укажите положительное количество минут");
      }
    },
    [customMinutes, handleStartTimer]
  );

  const timerProgress = useMemo(() => {
    if (!timerState || timerState.totalSeconds <= 0) return 0;
    return Math.min(
      100,
      Math.max(0, (remainingSeconds / timerState.totalSeconds) * 100)
    );
  }, [timerState, remainingSeconds]);

  return {
    // Основные состояния и методы по спецификации usePowerTimer
    timerState,
    setTimerState,
    remainingSeconds,
    setRemainingSeconds,
    restartMode,
    setRestartMode,
    timerSleep,
    setTimerSleep,
    handleStartTimer,
    handleCancelTimer,
    handleImmediateAction,

    // Совместимые поля для useNexusController / PowerModule
    customMinutes,
    setCustomMinutes,
    powerError,
    setPowerError,
    handleCustomSubmit,
    timerProgress,
  };
}
