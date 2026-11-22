import test from "node:test";
import assert from "node:assert/strict";
import { appendRtt, RTT_WINDOW, summarizeRtt, type RttSample } from "../src/lib/latencyHistory.ts";

const sample = (i: number, rtt_ms: number | null, overrides: Partial<RttSample> = {}): RttSample =>
  ({ timestamp_ms: i * 2500, host: "1.1.1.1", method: "ICMP", route: "interface-a", rtt_ms, ...overrides });
const series = (...samples: RttSample[]) => samples.reduce<RttSample[]>(appendRtt, []);

test("jitter averages absolute changes between consecutive RTTs", () => {
  assert.equal(summarizeRtt(series(sample(1, 12), sample(2, 12), sample(3, 12))).jitterMs, 0);
  assert.equal(summarizeRtt(series(sample(1, 12), sample(2, 20), sample(3, 16))).jitterMs, 6);
});

test("empty and one-sample windows have no jitter, including an actual zero RTT", () => {
  assert.equal(summarizeRtt([]).jitterMs, null);
  assert.equal(summarizeRtt(series(sample(1, 0))).jitterMs, null);
  assert.equal(summarizeRtt(series(sample(1, 0), sample(2, 1))).jitterMs, 1);
});

test("timeouts break consecutive RTTs and count separately from jitter", () => {
  const history = series(sample(1, 12), sample(2, null, { method: "" }), sample(3, 22));
  assert.equal(summarizeRtt(history).jitterMs, null);
  assert.equal(summarizeRtt(history).lossPct, 100 / 3);
  assert.equal(summarizeRtt(appendRtt(history, sample(4, 24))).jitterMs, 2);
});

test("a new endpoint, probe method, route or sampling gap starts a new window", () => {
  for (const next of [
    sample(3, 13, { host: "8.8.8.8" }),
    sample(3, 13, { method: "TCP:53" }),
    sample(3, 13, { route: "interface-b" }),
    sample(12, 13),
  ]) {
    assert.deepEqual(series(sample(1, 12), sample(2, 12), next), [next]);
  }
});

test("an unknown route does not produce jitter", () => {
  const unknown = { route: null };
  assert.equal(summarizeRtt(series(sample(1, 20, unknown), sample(2, 19, unknown))).jitterMs, null);
});

test("cached replies and out-of-order measurements do not grow the bounded history", () => {
  const history = series(...Array.from({ length: 40 }, (_, i) => sample(i, 20)));
  assert.equal(history.length, RTT_WINDOW);
  assert.equal(history[0].timestamp_ms, (40 - RTT_WINDOW) * 2500);
  assert.strictEqual(appendRtt(history, sample(39, 10)), history);
  assert.strictEqual(appendRtt(history, sample(38, 10)), history);
});
