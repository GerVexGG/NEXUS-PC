import { formatRate } from "./metricsFormatters.ts";
import type { ProcessItem } from "./studio";

type IoFields = Pick<ProcessItem, "disk_status" | "disk_error_code" | "disk_read_bytes_sec" | "disk_write_bytes_sec">;

export function processIoAvailable(process: IoFields) {
  return process.disk_status === "ready";
}

function bytesPerSecond(value: number) {
  return value === 0 ? "0" : value < 1 ? "<1 B/s" : formatRate(value);
}

export function processIoDisplay(process: IoFields) {
  if (processIoAvailable(process)) {
    const read = process.disk_read_bytes_sec;
    const write = process.disk_write_bytes_sec;
    return { total: bytesPerSecond(read + write), separate: `${bytesPerSecond(read)} / ${bytesPerSecond(write)}`, reason: "" };
  }
  const code = process.disk_error_code;
  const suffix = code === undefined ? "" : ` (Windows ${code})`;
  if (process.disk_status === "error") {
    return { total: "Ошибка", separate: "Ошибка", reason: `Не удалось прочитать счётчики I/O${suffix}` };
  }
  if (process.disk_status === "unavailable") {
    return { total: "Недоступно", separate: "Недоступно", reason: code === 5 ?
      "Windows отказала в доступе к счётчикам (код 5)" : `Счётчики процесса недоступны${suffix}` };
  }
  return { total: "Н/Д", separate: "Н/Д", reason: "Нужны две выборки счётчиков одного процесса" };
}
