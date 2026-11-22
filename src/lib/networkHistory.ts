export interface NetworkSpeedSample {
  adapter: string;
  at: number;
  ts: string;
  rxBps: number;
  txBps: number;
}

export function appendNetworkSample(previous: NetworkSpeedSample[], sample: NetworkSpeedSample, reset: boolean): NetworkSpeedSample[] {
  const last = previous[previous.length - 1];
  if (!last || reset || sample.adapter !== last.adapter) return [sample];
  const elapsed = sample.at - last.at;
  if (elapsed < 0 || elapsed >= 8000) return [sample];
  if (elapsed === 0) return [...previous.slice(0, -1), sample];
  return [...previous.filter((point) => sample.at - point.at <= 60000).slice(-59), sample];
}
