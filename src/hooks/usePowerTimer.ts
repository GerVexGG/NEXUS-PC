import { useState, useEffect, useRef, useMemo, useCallback, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type BackendPowerTimerState,
  type PowerTimerAction,
  type StoredTimerState,
  TIMER_STORAGE_KEY,
} from "../lib/studio";

export type PowerImmediateAction = "shutdown" | "restart" | "sleep" | "lock";

function toStoredTimerState(backend: BackendPowerTimerState): StoredTimerState {
  return {
    timerId: backend.timer_id,
    action: backend.action,
    endTime: backend.end_time_ms,
    totalSeconds: backend.total_seconds,
    restart: backend.restart,
    sleep: backend.sleep,
  };
}

function readCachedTimerState(): StoredTimerState | null {
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
}

export function usePowerTimer() {
  const [restartMode, setRestartMode] = useState<boolean>(false);
  const [timerSleep, setTimerSleep] = useState<boolean>(false);
  const [customMinutes, setCustomMinutes] = useState<string>("");
  const [timerState, setTimerState] = useState<StoredTimerState | null>(readCachedTimerState);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() => {
    if (!timerState) return 0;
    return Math.max(0, Math.ceil((timerState.endTime - Date.now()) / 1000));
  });
  const [powerError, setPowerError] = useState<string | null>(null);
  const syncSeqRef = useRef<number>(0);

  const applyBackendState = useCallback((backend: BackendPowerTimerState | null) => {
    if (backend && backend.remaining_seconds > 0) {
      const next = toStoredTimerState(backend);
      setTimerState(next);
      setRemainingSeconds(backend.remaining_seconds);
      setRestartMode(backend.restart);
      setTimerSleep(backend.sleep);
      try {
        localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Игнорируем ошибку квоты localStorage — источник истины находится на Backend
      }
      return;
    }
    setTimerState(null);
    setRemainingSeconds(0);
    try {
      localStorage.removeItem(TIMER_STORAGE_KEY);
    } catch {
      // Игнорируем ошибку доступа к localStorage
    }
  }, []);

  const syncTimerFromBackend = useCallback(async (): Promise<BackendPowerTimerState | null> => {
    const seq = ++syncSeqRef.current;
    try {
      const backend = await invoke<BackendPowerTimerState | null>("get_power_timer_state");
      if (syncSeqRef.current !== seq) return backend;
      applyBackendState(backend);
      return backend;
    } catch (err) {
      if (syncSeqRef.current === seq) {
        console.error("Ошибка синхронизации таймера питания с Backend:", err);
      }
      return null;
    }
  }, [applyBackendState]);

  // Синхронизация состояния с Backend при старте и возврате фокуса окна
  useEffect(() => {
    void syncTimerFromBackend();

    const onFocus = () => {
      void syncTimerFromBackend();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) {
        void syncTimerFromBackend();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [syncTimerFromBackend]);

  // Живой UI-счетчик обратного отсчёта (само выполнение таймера полностью на стороне ОС/Backend)
  useEffect(() => {
    if (!timerState) {
      setRemainingSeconds(0);
      return;
    }

    const updateRemaining = () => {
      const diff = Math.ceil((timerState.endTime - Date.now()) / 1000);
      if (diff <= 0) {
        setRemainingSeconds(0);
        void syncTimerFromBackend();
      } else {
        setRemainingSeconds(diff);
      }
    };

    updateRemaining();
    const interval = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(interval);
  }, [timerState, syncTimerFromBackend]);

  const handleStartTimer = useCallback(
    async (minutes: number) => {
      setPowerError(null);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        setPowerError("Введите корректное время в минутах (больше 0)");
        return;
      }

      const seconds = Math.round(minutes * 60);
      const action: PowerTimerAction =
        timerSleep && !restartMode ? "sleep" : restartMode ? "restart" : "shutdown";
      const seq = ++syncSeqRef.current;

      try {
        const created = await invoke<BackendPowerTimerState>("schedule_power_timer", {
          seconds,
          action,
        });
        if (syncSeqRef.current !== seq) return;
        applyBackendState(created);
      } catch (err) {
        console.error("Ошибка при запуске таймера:", err);
        setPowerError(String(err));
      }
    },
    [timerSleep, restartMode, applyBackendState]
  );

  const handleCancelTimer = useCallback(async (): Promise<boolean> => {
    setPowerError(null);
    const seq = ++syncSeqRef.current;
    try {
      await invoke("cancel_power_timer");
      if (syncSeqRef.current !== seq) return true;
      applyBackendState(null);
      return true;
    } catch (err) {
      console.error("Ошибка при отмене таймера:", err);
      setPowerError(`Не удалось отменить системный таймер: ${String(err)}`);
      return false;
    }
  }, [applyBackendState]);

  const handleImmediateAction = useCallback(
    async (action: PowerImmediateAction) => {
      setPowerError(null);
      try {
        // Правила согласования реализованы на Backend:
        // shutdown/restart/sleep отменяют конфликтующее расписание, lock его сохраняет.
        await invoke("system_power_action", { action });
        await syncTimerFromBackend();
      } catch (err) {
        setPowerError(String(err));
        await syncTimerFromBackend();
      }
    },
    [syncTimerFromBackend]
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
    syncTimerFromBackend,

    // Совместимые поля для useNexusController / PowerModule
    customMinutes,
    setCustomMinutes,
    powerError,
    setPowerError,
    handleCustomSubmit,
    timerProgress,
  };
}
