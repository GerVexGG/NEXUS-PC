import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type MediaPlaybackStatus = "Playing" | "Paused" | "Stopped" | "Closed" | string;

export interface MediaTrackInfo {
  title: string;
  artist: string;
  album: string;
  playback_status: MediaPlaybackStatus;
  position_secs: number;
  duration_secs: number;
  cover_base64: string | null;
  source_app_id: string;
}

export function useMediaSession(enabled = true) {
  const [track, setTrack] = useState<MediaTrackInfo | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const lastTrackKeyRef = useRef<string>("");
  const lastRawPosRef = useRef<number>(-1);
  const seekLockUntilRef = useRef<number>(0);

  const fetchTrack = useCallback(async () => {
    if (!enabled || inFlightRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }

    inFlightRef.current = true;
    try {
      const next = await invoke<MediaTrackInfo | null>("get_media_track");
      setError(null);

      if (!next) {
        setTrack(null);
        setIsPlaying(false);
        setPosition(0);
        setDuration(0);
        lastTrackKeyRef.current = "";
        lastRawPosRef.current = -1;
        return;
      }

      const playing = next.playback_status === "Playing";
      const nextDuration = Number.isFinite(next.duration_secs) && next.duration_secs > 0 ? next.duration_secs : 0;
      const nextPos = Number.isFinite(next.position_secs) && next.position_secs >= 0 ? next.position_secs : 0;
      const trackKey = `${next.source_app_id}|${next.title}|${next.artist}|${next.album}`;

      setTrack(next);
      setIsPlaying(playing);
      setDuration(nextDuration);

      const now = Date.now();
      const trackChanged = trackKey !== lastTrackKeyRef.current;
      const rawPosChanged = Math.abs(nextPos - lastRawPosRef.current) > 0.25;

      lastTrackKeyRef.current = trackKey;
      lastRawPosRef.current = nextPos;

      if (now >= seekLockUntilRef.current) {
        setPosition((prev) => {
          if (trackChanged) {
            return nextDuration > 0 ? Math.min(nextDuration, nextPos) : nextPos;
          }
          // Если плеер обновляет позицию или произошёл скачок > 2 сек — синхронизируемся с бэкендом
          if (rawPosChanged || Math.abs(nextPos - prev) > 2.0 || !playing) {
            // Защита от сброса в 0 у плееров, которые не репортят прогресс в SMTC во время игры
            if (playing && nextPos === 0 && prev > 1.5) {
              return prev;
            }
            return nextDuration > 0 ? Math.min(nextDuration, nextPos) : nextPos;
          }
          return prev;
        });
      }
    } catch (err) {
      setError(String(err));
    } finally {
      inFlightRef.current = false;
    }
  }, [enabled]);

  // Опрос get_media_track каждые 1000 мс (только когда приложение активно)
  useEffect(() => {
    if (!enabled) return;

    void fetchTrack();
    const pollTimer = window.setInterval(() => {
      void fetchTrack();
    }, 1000);

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === "visible") {
        void fetchTrack();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    window.addEventListener("focus", handleVisibilityOrFocus);

    return () => {
      window.clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      window.removeEventListener("focus", handleVisibilityOrFocus);
    };
  }, [enabled, fetchTrack]);

  // Локальная интерполяция позиции каждую секунду при статусе "Playing"
  useEffect(() => {
    if (!enabled || !isPlaying) return;

    const tick = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      setPosition((prev) => {
        const next = prev + 1;
        return duration > 0 ? Math.min(duration, next) : next;
      });
    }, 1000);

    return () => window.clearInterval(tick);
  }, [enabled, isPlaying, duration]);

  const togglePlay = useCallback(async () => {
    try {
      setIsPlaying((prev) => !prev);
      await invoke("media_play_pause");
      void fetchTrack();
    } catch (err) {
      setError(String(err));
      void fetchTrack();
    }
  }, [fetchTrack]);

  const nextTrack = useCallback(async () => {
    try {
      await invoke("media_next");
      window.setTimeout(() => void fetchTrack(), 180);
    } catch (err) {
      setError(String(err));
    }
  }, [fetchTrack]);

  const prevTrack = useCallback(async () => {
    try {
      await invoke("media_previous");
      window.setTimeout(() => void fetchTrack(), 180);
    } catch (err) {
      setError(String(err));
    }
  }, [fetchTrack]);

  const seekTo = useCallback(
    async (targetSeconds: number) => {
      const clamped = Math.max(0, duration > 0 ? Math.min(duration, targetSeconds) : targetSeconds);
      seekLockUntilRef.current = Date.now() + 1200;
      setPosition(clamped);
      lastRawPosRef.current = clamped;
      try {
        await invoke("media_seek", { positionSecs: clamped });
      } catch (err) {
        setError(String(err));
      }
    },
    [duration]
  );

  return {
    track,
    isPlaying,
    position,
    duration,
    error,
    togglePlay,
    nextTrack,
    prevTrack,
    seekTo,
    refresh: fetchTrack,
  };
}
