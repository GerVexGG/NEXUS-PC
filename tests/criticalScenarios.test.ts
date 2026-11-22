import test from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIC_ZIP_MAX_BYTES,
  CLASSIC_ZIP_MAX_ENTRIES,
  HISTORY_LENGTH,
  createInitialHistory,
  evaluateZipLimits,
  formatBytes,
  formatCountdown,
  formatSpeedParts,
  getLoadBarStyles,
  getPingHudStyle,
  getTempBadgeStyle,
  parseScriptConsoleStatus,
} from "../src/lib/metricsFormatters.ts";

test("formats byte sizes, network speed parts, and power countdowns deterministically", () => {
  assert.equal(formatBytes(0), "0 Б");
  assert.equal(formatBytes(NaN), "0 Б");
  assert.equal(formatBytes(512), "512 Б");
  assert.equal(formatBytes(2048), "2 КБ");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 МБ");
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), "2.50 ГБ");

  assert.deepEqual(formatSpeedParts(0), { value: "0.0", unit: "KB/S" });
  assert.deepEqual(formatSpeedParts(512.34), { value: "512.3", unit: "KB/S" });
  assert.deepEqual(formatSpeedParts(2048), { value: "2.00", unit: "MB/S" });

  assert.equal(formatCountdown(-5), "00:00");
  assert.equal(formatCountdown(95), "01:35");
  assert.equal(formatCountdown(3661), "01:01:01");

  const initialHistory = createInitialHistory();
  assert.equal(initialHistory.length, HISTORY_LENGTH);
  assert.ok(initialHistory.every((pt) => pt.cpu === 0 && pt.ram === 0 && pt.timestamp.length > 0));
});

test("classifies ping latency, thermal thresholds, and load bar severity accurately", () => {
  assert.equal(getPingHudStyle(0).statusLabel, "НЕТ СВЯЗИ");
  assert.equal(getPingHudStyle(999).statusLabel, "НЕТ СВЯЗИ");
  assert.equal(getPingHudStyle(24).statusLabel, "ОТЛИЧНО");
  assert.equal(getPingHudStyle(60).statusLabel, "НОРМА");
  assert.equal(getPingHudStyle(105).statusLabel, "СРЕДНЕ");
  assert.equal(getPingHudStyle(180).statusLabel, "ВЫСОКИЙ ПИНГ");

  assert.equal(getTempBadgeStyle(null).label, "Недоступно");
  assert.equal(getTempBadgeStyle(55).label, "НОРМА");
  assert.equal(getTempBadgeStyle(65).label, "НАГРЕВ");
  assert.equal(getTempBadgeStyle(81).label, "КРИТИЧНО");

  assert.match(getLoadBarStyles(95).badgeTextClass, /rose/);
  assert.match(getLoadBarStyles(75).badgeTextClass, /amber/);
  assert.match(getLoadBarStyles(30, "cyan").badgeTextClass, /00D5E8/);
});

test("validates classic 32-bit ZIP pre-check boundaries without blocking RAR", () => {
  assert.equal(evaluateZipLimits("zip", CLASSIC_ZIP_MAX_BYTES, CLASSIC_ZIP_MAX_ENTRIES, false), null);
  assert.match(
    evaluateZipLimits("zip", CLASSIC_ZIP_MAX_BYTES + 1, 1, false) ?? "",
    /4 ГБ/
  );
  assert.match(
    evaluateZipLimits("zip", 1024, 1, true) ?? "",
    /4 ГБ/
  );
  assert.match(
    evaluateZipLimits("zip", 1024, CLASSIC_ZIP_MAX_ENTRIES + 1, false) ?? "",
    /65 535/
  );
  assert.equal(
    evaluateZipLimits("rar", CLASSIC_ZIP_MAX_BYTES * 4, CLASSIC_ZIP_MAX_ENTRIES + 500, true),
    null
  );
});

test("parses script execution exit codes, admin OK, timeouts, and error statuses honestly", () => {
  const runningState = parseScriptConsoleStatus("Исполнение…", true);
  assert.equal(runningState.statusLabel, "ВЫПОЛНЕНИЕ…");

  const adminOk = parseScriptConsoleStatus(
    "[ADMIN OK · Код выхода: 0] Скрипт выполнен с правами Администратора (без консольного вывода).",
    false
  );
  assert.equal(adminOk.isError, false);
  assert.equal(adminOk.exitCode, 0);
  assert.equal(adminOk.statusLabel, "ЗАВЕРШЕНО · КОД 0");

  const nonzeroAdmin = parseScriptConsoleStatus(
    "some output\n\n[ОШИБКА · Администратор · Код выхода: 5]",
    false
  );
  assert.equal(nonzeroAdmin.isError, true);
  assert.equal(nonzeroAdmin.exitCode, 5);
  assert.equal(nonzeroAdmin.statusLabel, "ОШИБКА · КОД 5");

  const timeoutState = parseScriptConsoleStatus(
    "started\n\n[TIMEOUT] Скрипт превысил лимит времени (60 с) и был принудительно завершён.",
    false
  );
  assert.equal(timeoutState.isTimeout, true);
  assert.equal(timeoutState.isError, true);
  assert.equal(timeoutState.statusLabel, "ТАЙМАУТ (60с)");
});
