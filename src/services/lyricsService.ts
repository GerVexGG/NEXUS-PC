import { parseLrc, type LyricLine } from "../utils/parseLrc";

const LRCLIB_BASE_URL = "https://lrclib.net/api";
const LRCLIB_USER_AGENT = "NEXUS-PC/0.2.1 (https://github.com/nexus-pc)";

export interface LyricsResult {
  isSynced: boolean;
  lines: LyricLine[];
  plainText?: string;
  isInstrumental: boolean;
}

interface LrclibTrackResponse {
  id?: number;
  name?: string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

const lyricsCache = new Map<string, LyricsResult>();
const inFlightRequests = new Map<string, Promise<LyricsResult>>();

function getCacheKey(artist: string, title: string): string {
  return `${artist.trim().toLowerCase()}_${title.trim().toLowerCase()}`;
}

async function lrclibFetch(url: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": LRCLIB_USER_AGENT,
        Accept: "application/json",
      },
    });
  } catch {
    // Фоллбэк на случай блокировки кастомного заголовка User-Agent политикой CORS в WebView
    return await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
  }
}

function toLyricsResult(payload: LrclibTrackResponse | null | undefined): LyricsResult {
  if (!payload) {
    return {
      isSynced: false,
      lines: [],
      isInstrumental: false,
    };
  }

  if (payload.instrumental === true) {
    return {
      isSynced: false,
      lines: [],
      plainText: payload.plainLyrics ?? undefined,
      isInstrumental: true,
    };
  }

  const syncedRaw = payload.syncedLyrics?.trim() ?? "";
  const plainRaw = payload.plainLyrics?.trim() ?? "";

  if (syncedRaw) {
    const parsed = parseLrc(syncedRaw);
    if (parsed.length > 0) {
      return {
        isSynced: true,
        lines: parsed,
        plainText: plainRaw || undefined,
        isInstrumental: false,
      };
    }
  }

  if (plainRaw) {
    return {
      isSynced: false,
      lines: [],
      plainText: plainRaw,
      isInstrumental: false,
    };
  }

  return {
    isSynced: false,
    lines: [],
    isInstrumental: false,
  };
}

function pickBestSearchCandidate(
  items: LrclibTrackResponse[],
  duration?: number
): LrclibTrackResponse | null {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const valid = items.filter(
    (item) =>
      item &&
      (item.instrumental === true ||
        Boolean(item.syncedLyrics?.trim()) ||
        Boolean(item.plainLyrics?.trim()))
  );

  if (valid.length === 0) {
    return items[0] ?? null;
  }

  // Приоритет: совпадение по длительности (±5 сек) и наличие синхронизированного LRC
  const syncedCandidates = valid.filter((item) => Boolean(item.syncedLyrics?.trim()));
  const pool = syncedCandidates.length > 0 ? syncedCandidates : valid;

  if (duration && Number.isFinite(duration) && duration > 0) {
    let best = pool[0];
    let bestDiff =
      typeof best.duration === "number" ? Math.abs(best.duration - duration) : Number.POSITIVE_INFINITY;

    for (const candidate of pool) {
      if (typeof candidate.duration === "number") {
        const diff = Math.abs(candidate.duration - duration);
        if (diff < bestDiff) {
          best = candidate;
          bestDiff = diff;
        }
      }
    }
    return best;
  }

  return pool[0];
}

export async function fetchLyrics(
  artist: string,
  title: string,
  duration?: number
): Promise<LyricsResult> {
  const cleanArtist = artist.trim();
  const cleanTitle = title.trim();

  if (!cleanTitle && !cleanArtist) {
    return { isSynced: false, lines: [], isInstrumental: false };
  }

  const cacheKey = getCacheKey(cleanArtist, cleanTitle);
  const cached = lyricsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const existingPromise = inFlightRequests.get(cacheKey);
  if (existingPromise) {
    return existingPromise;
  }

  const requestPromise = (async (): Promise<LyricsResult> => {
    try {
      // Шаг 1: Точный запрос GET /get?artist_name={artist}&track_name={title} (+ duration)
      const getParams = new URLSearchParams({
        artist_name: cleanArtist,
        track_name: cleanTitle,
      });
      if (duration && Number.isFinite(duration) && duration > 0) {
        getParams.set("duration", String(Math.round(duration)));
      }

      const exactResponse = await lrclibFetch(`${LRCLIB_BASE_URL}/get?${getParams.toString()}`);

      if (exactResponse.ok) {
        const data = (await exactResponse.json()) as LrclibTrackResponse;
        const result = toLyricsResult(data);
        lyricsCache.set(cacheKey, result);
        return result;
      }

      // Шаг 2: Резервный поиск GET /search?q={artist}+{title} при 404 или отсутствии точного совпадения
      if (exactResponse.status === 404 || !exactResponse.ok) {
        const query = [cleanArtist, cleanTitle].filter(Boolean).join(" ");
        const searchParams = new URLSearchParams({ q: query });
        const searchResponse = await lrclibFetch(
          `${LRCLIB_BASE_URL}/search?${searchParams.toString()}`
        );

        if (searchResponse.ok) {
          const list = (await searchResponse.json()) as LrclibTrackResponse[];
          const best = pickBestSearchCandidate(list, duration);
          const result = toLyricsResult(best);
          lyricsCache.set(cacheKey, result);
          return result;
        }
      }

      const emptyResult: LyricsResult = {
        isSynced: false,
        lines: [],
        isInstrumental: false,
      };
      lyricsCache.set(cacheKey, emptyResult);
      return emptyResult;
    } catch {
      return {
        isSynced: false,
        lines: [],
        isInstrumental: false,
      };
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, requestPromise);
  return requestPromise;
}
