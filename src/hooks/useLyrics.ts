import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchLyrics, type LyricsResult } from "../services/lyricsService";
import type { LyricLine } from "../utils/parseLrc";

export interface UseLyricsOptions {
  artist: string;
  title: string;
  duration?: number;
  positionSecs: number;
}

export interface UseLyricsReturn {
  lyrics: LyricsResult | null;
  currentLineIndex: number;
  loading: boolean;
  offsetSecs: number;
  setOffsetSecs: (value: number | ((prev: number) => number)) => void;
}

const MIN_OFFSET_SECS = -3.0;
const MAX_OFFSET_SECS = 3.0;

function clampOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(MAX_OFFSET_SECS, Math.max(MIN_OFFSET_SECS, value));
  return Math.round(clamped * 100) / 100;
}

/**
 * Бинарный поиск индекса активной строки:
 * находит последнюю строку, где line.time <= effectiveTime.
 */
function findActiveLineIndex(lines: LyricLine[], effectiveTime: number): number {
  if (!lines || lines.length === 0) return -1;
  if (effectiveTime < lines[0].time) return -1;

  let low = 0;
  let high = lines.length - 1;
  let answer = -1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (lines[mid].time <= effectiveTime) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return answer;
}

export function useLyrics(
  artistOrOptions: string | UseLyricsOptions,
  titleArg = "",
  durationArg?: number,
  positionSecsArg = 0
): UseLyricsReturn {
  const artist =
    typeof artistOrOptions === "string" ? artistOrOptions : artistOrOptions.artist;
  const title =
    typeof artistOrOptions === "string" ? titleArg : artistOrOptions.title;
  const duration =
    typeof artistOrOptions === "string" ? durationArg : artistOrOptions.duration;
  const positionSecs =
    typeof artistOrOptions === "string" ? positionSecsArg : artistOrOptions.positionSecs;

  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [offsetSecs, setOffsetSecsRaw] = useState<number>(0);

  const durationRef = useRef<number | undefined>(duration);
  durationRef.current = duration;

  const setOffsetSecs = useCallback(
    (updater: number | ((prev: number) => number)) => {
      setOffsetSecsRaw((prev) => {
        const nextVal = typeof updater === "function" ? updater(prev) : updater;
        return clampOffset(nextVal);
      });
    },
    []
  );

  const cleanArtist = (artist ?? "").trim();
  const cleanTitle = (title ?? "").trim();
  const trackKey = `${cleanArtist.toLowerCase()}_${cleanTitle.toLowerCase()}`;

  useEffect(() => {
    if (!cleanTitle && !cleanArtist) {
      setLyrics(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLyrics(null);
    setLoading(true);
    setOffsetSecsRaw(0);

    void fetchLyrics(cleanArtist, cleanTitle, durationRef.current)
      .then((res) => {
        if (cancelled) return;
        setLyrics(res);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [trackKey, cleanArtist, cleanTitle]);

  const currentLineIndex = useMemo(() => {
    if (!lyrics || !lyrics.isSynced || lyrics.lines.length === 0) {
      return -1;
    }
    const effectiveTime = Math.max(0, positionSecs + offsetSecs);
    return findActiveLineIndex(lyrics.lines, effectiveTime);
  }, [lyrics, positionSecs, offsetSecs]);

  return {
    lyrics,
    currentLineIndex,
    loading,
    offsetSecs,
    setOffsetSecs,
  };
}
