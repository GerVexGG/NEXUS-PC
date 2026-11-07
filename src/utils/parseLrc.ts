export interface LyricLine {
  time: number; // время в секундах
  text: string;
}

const META_TAG_RE = /^\s*\[(ar|ti|al|au|by|offset|length|re|ve|id|tool|lang):.*\]\s*$/i;
const TIME_TAG_GLOBAL_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?\]/g;

/**
 * Разбирает LRC-разметку с временными метками вида [mm:ss.xx] или [mm:ss.xxx]
 * и возвращает отсортированный по времени массив строк.
 */
export function parseLrc(lrcContent: string): LyricLine[] {
  if (!lrcContent || typeof lrcContent !== "string") {
    return [];
  }

  const result: LyricLine[] = [];
  const rawLines = lrcContent.split(/\r?\n/);

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed || META_TAG_RE.test(trimmed)) {
      continue;
    }

    const matches = [...trimmed.matchAll(TIME_TAG_GLOBAL_RE)];
    if (matches.length === 0) {
      continue;
    }

    const text = trimmed.replace(TIME_TAG_GLOBAL_RE, "").trim();

    for (const match of matches) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const fracRaw = match[3];

      if (Number.isNaN(min) || Number.isNaN(sec)) {
        continue;
      }

      let fracSecs = 0;
      if (fracRaw) {
        const ms = parseInt(fracRaw, 10);
        if (!Number.isNaN(ms)) {
          fracSecs = fracRaw.length === 3 ? ms / 1000 : ms / 100;
        }
      }

      const time = min * 60 + sec + fracSecs;
      result.push({ time, text });
    }
  }

  result.sort((a, b) => a.time - b.time);
  return result;
}
