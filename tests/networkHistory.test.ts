import test from "node:test";
import assert from "node:assert/strict";
import { appendNetworkSample, type NetworkSpeedSample } from "../src/lib/networkHistory.ts";

function sample(at: number, adapter = "ethernet"): NetworkSpeedSample {
  return { at, adapter, rxBps: at / 2, txBps: 0, ts: String(at) };
}

test("network history uses real samples from one adapter and one continuous sampling interval", () => {
  const previous = [sample(1000), sample(2000)];
  const next = sample(3500);
  assert.deepEqual(appendNetworkSample(previous, next, false), [...previous, next]);
  const updated = { ...sample(2000), rxBps: 350 };
  assert.deepEqual(appendNetworkSample(previous, updated, false), [previous[0], updated]);
  for (const restarted of [sample(3000, "wifi"), sample(11000), sample(500)]) {
    assert.deepEqual(appendNetworkSample(previous, restarted, false), [restarted]);
  }
  assert.deepEqual(appendNetworkSample(previous, next, true), [next]);
});

test("network history bounds both the plotted time range and the stored sample count", () => {
  for (const spacing of [500, 2000]) {
    let history: NetworkSpeedSample[] = [];
    for (let i = 0; i < 150; i++) history = appendNetworkSample(history, sample(i * spacing), false);
    assert.ok(history.length <= 60);
    assert.ok(history.at(-1)!.at - history[0].at <= 60000);
    assert.equal(history.at(-1)!.at, 149 * spacing);
  }
});
