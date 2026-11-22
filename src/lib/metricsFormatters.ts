export const HISTORY_LENGTH = 60;

export interface HistoryPoint {
  timestamp: string;
  cpu: number;
  ram: number;
}

export function createInitialHistory(): HistoryPoint[] {
  const now = Date.now();
  return Array.from({ length: HISTORY_LENGTH }, (_, idx) => {
    const t = new Date(now - (HISTORY_LENGTH - 1 - idx) * 1000);
    return {
      timestamp: t.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
      cpu: 0,
      ram: 0,
    };
  });
}

export function formatCountdown(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(safeSeconds / 3600);
  const mins = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;

  const pad = (n: number) => n.toString().padStart(2, "0");
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

export function formatSpeedParts(kbps: number): { value: string; unit: string } {
  if (!Number.isFinite(kbps) || kbps <= 0) {
    return { value: "0.0", unit: "KB/S" };
  }
  if (kbps >= 1024) {
    return { value: (kbps / 1024).toFixed(2), unit: "MB/S" };
  }
  return { value: kbps.toFixed(1), unit: "KB/S" };
}

export function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0";
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

export function formatUptime(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return "—";
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m.toString().padStart(2, "0")}м`;
  return `${m}м ${s.toString().padStart(2, "0")}с`;
}

export function getPingHudStyle(pingMs: number): {
  valueText: string;
  statusLabel: string;
  colorClass: string;
  badgeClass: string;
  dotClass: string;
  barPercent: number;
} {
  if (!Number.isFinite(pingMs) || pingMs <= 0 || pingMs >= 999) {
    return {
      valueText: "—",
      statusLabel: "НЕТ СВЯЗИ",
      colorClass: "text-[#8292A3]",
      badgeClass: "bg-[#151C26] text-[#8292A3] border-[#202B38]",
      dotClass: "bg-[#526170]",
      barPercent: 0,
    };
  }
  if (pingMs <= 80) {
    return {
      valueText: `${pingMs}`,
      statusLabel: pingMs <= 40 ? "ОТЛИЧНО" : "НОРМА",
      colorClass: "text-[#00D5E8]",
      badgeClass: "bg-[#00D5E8]/10 text-[#00D5E8] border-[#00D5E8]/30",
      dotClass: "bg-[#00D5E8]",
      barPercent: Math.max(12, Math.min(100, (1 - pingMs / 150) * 100)),
    };
  }
  if (pingMs <= 120) {
    return {
      valueText: `${pingMs}`,
      statusLabel: "СРЕДНЕ",
      colorClass: "text-amber-400",
      badgeClass: "bg-amber-500/12 text-amber-300 border-amber-500/35",
      dotClass: "bg-amber-400",
      barPercent: Math.max(20, Math.min(100, (1 - pingMs / 160) * 100)),
    };
  }
  return {
    valueText: `${pingMs}`,
    statusLabel: "ВЫСОКИЙ ПИНГ",
    colorClass: "text-rose-400",
    badgeClass: "bg-rose-500/12 text-rose-300 border-rose-500/35",
    dotClass: "bg-rose-500",
    barPercent: 100,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Б";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} ГБ`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} МБ`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${kb.toFixed(0)} КБ`;
  return `${bytes} Б`;
}

export function getTempBadgeStyle(tempC: number | null | undefined): {
  badgeClass: string;
  textClass: string;
  barClass: string;
  label: string;
} {
  if (tempC === null || tempC === undefined || !Number.isFinite(tempC)) {
    return {
      badgeClass: "bg-[#151C26] text-[#8292A3] border-[#202B38]",
      textClass: "text-[#8292A3]",
      barClass: "bg-[#202B38]",
      label: "Недоступно",
    };
  }
  if (tempC > 80) {
    return {
      badgeClass: "bg-rose-500/12 text-rose-300 border-rose-500/35",
      textClass: "text-rose-400",
      barClass: "bg-gradient-to-r from-rose-500 to-red-400",
      label: "КРИТИЧНО",
    };
  }
  if (tempC >= 65) {
    return {
      badgeClass: "bg-amber-500/12 text-amber-300 border-amber-500/35",
      textClass: "text-amber-400",
      barClass: "bg-gradient-to-r from-amber-500 to-yellow-400",
      label: "НАГРЕВ",
    };
  }
  return {
    badgeClass: "bg-[#00D5E8]/10 text-[#00D5E8] border-[#00D5E8]/30",
    textClass: "text-[#00D5E8]",
    barClass: "bg-gradient-to-r from-[#00D5E8] to-[#36AFC0]",
    label: "НОРМА",
  };
}

export function getLoadBarStyles(
  percentage: number,
  defaultTheme: "emerald" | "cyan" = "cyan"
): { barClass: string; badgeTextClass: string; activeSegmentClass: string } {
  if (percentage > 90) {
    return {
      barClass:
        "bg-gradient-to-r from-rose-500 to-red-400 shadow-[0_0_10px_rgba(244,63,94,0.45)]",
      badgeTextClass: "text-rose-400",
      activeSegmentClass: "bg-rose-400",
    };
  }
  if (percentage > 70) {
    return {
      barClass:
        "bg-gradient-to-r from-amber-500 to-yellow-400 shadow-[0_0_10px_rgba(245,158,11,0.4)]",
      badgeTextClass: "text-amber-400",
      activeSegmentClass: "bg-amber-400",
    };
  }
  if (defaultTheme === "cyan") {
    return {
      barClass:
        "bg-gradient-to-r from-[#00D5E8] to-[#36AFC0] shadow-[0_0_10px_rgba(0,213,232,0.35)]",
      badgeTextClass: "text-[#00D5E8]",
      activeSegmentClass: "bg-[#00D5E8]",
    };
  }
  return {
    barClass:
      "bg-gradient-to-r from-[#36AFC0] to-[#00D5E8] shadow-[0_0_10px_rgba(54,175,192,0.35)]",
    badgeTextClass: "text-[#36AFC0]",
    activeSegmentClass: "bg-[#36AFC0]",
  };
}

export const CLASSIC_ZIP_MAX_BYTES = 0xffffffff;
export const CLASSIC_ZIP_MAX_ENTRIES = 65535;

export function evaluateZipLimits(
  format: "zip" | "rar",
  totalBytes: number,
  totalEntries: number,
  oversizedSingle: boolean
): string | null {
  if (format !== "zip") return null;
  if (oversizedSingle || totalBytes > CLASSIC_ZIP_MAX_BYTES) {
    return "Суммарный объём или размер файла превышает лимит классического ZIP (4 ГБ). Выберите формат RAR или разделите файлы.";
  }
  if (totalEntries > CLASSIC_ZIP_MAX_ENTRIES) {
    return "Число объектов превышает лимит классического ZIP (65 535 записей). Выберите формат RAR.";
  }
  return null;
}

export function parseScriptConsoleStatus(
  consoleOutput: string,
  running: boolean
): {
  isTimeout: boolean;
  isError: boolean;
  exitCode: number | null;
  statusLabel: string;
  statusBadgeClass: string;
} {
  const isTimeout = consoleOutput.includes("[TIMEOUT]");
  const exitMatch =
    consoleOutput.match(/Код выхода:\s*(-?\d+)/) ??
    consoleOutput.match(/\[EXIT CODE\s+(-?\d+)\]/);
  const exitCode = exitMatch ? Number(exitMatch[1]) : null;
  const isError =
    isTimeout ||
    consoleOutput.startsWith("[ОШИБКА]") ||
    consoleOutput.includes("[ОШИБКА ·") ||
    (exitCode !== null && exitCode !== 0);

  const statusLabel = running
    ? "ВЫПОЛНЕНИЕ…"
    : isTimeout
    ? "ТАЙМАУТ (60с)"
    : isError
    ? exitCode !== null
      ? `ОШИБКА · КОД ${exitCode}`
      : "ОШИБКА"
    : exitCode === 0
    ? "ЗАВЕРШЕНО · КОД 0"
    : consoleOutput.includes("[INFO]")
    ? "ИНФО"
    : "ВЫПОЛНЕНО";

  const statusBadgeClass = running
    ? "border-[#00D5E8]/35 bg-[#00D5E8]/10 text-[#00D5E8]"
    : isTimeout || isError
    ? "border-rose-500/35 bg-rose-500/12 text-rose-300"
    : "border-emerald-500/35 bg-emerald-500/12 text-emerald-300";

  return { isTimeout, isError, exitCode, statusLabel, statusBadgeClass };
}
