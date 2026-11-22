import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_COLUMNS, MAX_COLUMN_WIDTH, readProcessColumns } from "../src/lib/processColumns.ts";
import { cpuPackageUnavailableReason, summarizeSensors } from "../src/lib/sensorSummary.ts";
import { processIoDisplay } from "../src/lib/processIo.ts";

test("column preferences preserve legacy visible columns and validate new widths independently", () => {
  assert.deepEqual(readProcessColumns('["pid","path","pid","unknown"]', '{"path":2000,"pid":1,"memory":"80"}'), {
    keys: ["name", "pid", "path"], widths: { pid: 42, path: MAX_COLUMN_WIDTH },
  });
  assert.deepEqual(readProcessColumns("broken", '{"name":216.6}'), { keys: DEFAULT_COLUMNS, widths: { name: 217 } });
  assert.deepEqual(readProcessColumns('["description"]', "broken"), { keys: ["name", "description"], widths: {} });
});

test("hardware criteria count unavailable and stale independently from fresh warnings", () => {
  const result = summarizeSensors([
    { name: "CPU", value: 85, limit: 85, direction: "maximum", stale: false, unit: "°C" },
    { name: "GPU 1", value: 92, limit: 83, direction: "maximum", stale: true, unit: "°C" },
    { name: "GPU 2", value: Number.NaN, limit: 83, direction: "maximum", stale: true, unit: "°C" },
    { name: "C:", value: 20, limit: 20, direction: "minimum", stale: false, unit: "ГБ" },
  ]);
  assert.deepEqual(result.counts, { normal: 1, warning: 1, unavailable: 1, stale: 1 });
  assert.equal(result.evaluated, 2);
  assert.deepEqual(result.readings.map(check => check.state), ["warning", "stale", "unavailable", "normal"]);
  const unknown = summarizeSensors([{ name: "CPU", value: null, limit: 85, direction: "maximum", stale: false, unit: "°C" }]);
  assert.equal(unknown.evaluated, 0);
});

test("CPU package availability distinguishes HVCI configuration from a confirmed driver block", () => {
  const live = { sample: true, online: true, hvciConfigured: true, elevated: false, driverBlocked: false };
  assert.match(cpuPackageUnavailableReason(live), /включена в настройках Windows/);
  assert.match(cpuPackageUnavailableReason({ ...live, driverBlocked: true }), /заблокировала драйвер/);
  assert.match(cpuPackageUnavailableReason({ ...live, online: false }), /Служба датчиков недоступна/);
  const check = { name: "CPU", limit: 85, direction: "maximum" as const, unit: "°C" };
  const stale = summarizeSensors([{ ...check, value: 90, stale: true }]);
  const recovered = summarizeSensors([{ ...check, value: 65, stale: false }]);
  assert.equal(stale.counts.stale, 1);
  assert.equal(recovered.counts.normal, 1);
});

test("I/O formats measured zero, first sample, unavailable counters and unexpected errors separately", () => {
  const zero = { disk_read_bytes_sec: 0, disk_write_bytes_sec: 0 };
  assert.equal(processIoDisplay({ ...zero, disk_status: "ready" }).total, "0");
  assert.equal(processIoDisplay({ ...zero, disk_status: "pending" }).total, "Н/Д");
  assert.equal(processIoDisplay({ ...zero, disk_status: "unavailable", disk_error_code: 5 }).total, "Недоступно");
  assert.match(processIoDisplay({ ...zero, disk_status: "unavailable", disk_error_code: 5 }).reason, /код 5/);
  assert.match(processIoDisplay({ ...zero, disk_status: "error", disk_error_code: 31 }).reason, /Windows 31/);
  assert.equal(processIoDisplay({ ...zero, disk_status: "ready", disk_read_bytes_sec: 0.5 }).total, "<1 B/s");
  assert.equal(processIoDisplay({ ...zero, disk_status: "ready", disk_read_bytes_sec: 74.254835 }).total, "74 B/s");
});

test("the shared NumericInput puts the keyboard outline on the wrapper", () => {
  const styles = readFileSync(new URL("../src/App.css", import.meta.url), "utf-8");
  assert.match(styles, /\.nexus-numeric > \.nexus-numeric-input:focus-visible\s*\{[^}]*outline:\s*none/);
  assert.match(styles, /\.nexus-numeric:has\(> \.nexus-numeric-input:focus-visible\)\s*\{[^}]*outline:\s*2px solid/);
  const source = readFileSync(new URL("../src/components/ui/NumericInput.tsx", import.meta.url), "utf-8");
  assert.match(source, /className=\{`nexus-numeric group/);
  assert.doesNotMatch(source, /caret-transparent/);
});
