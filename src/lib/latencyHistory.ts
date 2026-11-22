export interface RttSample {
  timestamp_ms: number;
  host: string;
  method: string;
  route: string | null;
  rtt_ms: number | null;
}

export const RTT_WINDOW = 12;
const MAX_GAP_MS = 12_000;
export const JITTER_HELP = "Среднее абсолютное изменение RTT между соседними успешными пробами. До 12 проб к одному адресу по одному маршруту и методу. Таймаут прерывает серию.";

export function appendRtt(history: RttSample[], sample: RttSample): RttSample[] {
  const previous = history[history.length - 1];
  if (previous && sample.timestamp_ms <= previous.timestamp_ms) return history;
  const sameRoute = previous && previous.host === sample.host && previous.route === sample.route &&
    sample.timestamp_ms - previous.timestamp_ms <= MAX_GAP_MS;
  const method = sample.method || (sameRoute ? previous.method : "");
  const continued = sameRoute && (!previous.method || method === previous.method);
  return [...(continued ? history.slice(-(RTT_WINDOW - 1)) : []), { ...sample, method }];
}

export function summarizeRtt(history: RttSample[]) {
  const successes = history.flatMap(sample => sample.rtt_ms === null ? [] : [sample.rtt_ms]);
  let change = 0;
  let pairs = 0;
  for (let index = history.length - 1; index > 0; index--) {
    const next = history[index];
    const previous = history[index - 1];
    if (!next.route || !next.method || previous.rtt_ms === null || next.rtt_ms === null) break;
    change += Math.abs(next.rtt_ms - previous.rtt_ms);
    pairs++;
  }
  return {
    avgMs: successes.length ? successes.reduce((sum, rtt) => sum + rtt, 0) / successes.length : null,
    jitterMs: pairs ? change / pairs : null,
    successes: successes.length,
    lossPct: history.length ? 100 * (history.length - successes.length) / history.length : null,
  };
}

export function formatJitter(ms: number | null) {
  return ms === null ? "Н/Д" : ms.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " мс";
}
