import type { ProcessSortKey } from "./studio";

export const PROCESS_COLUMNS = [
  ["name", "Процесс", 120, 100], ["pid", "PID", 48, 42], ["cpu", "ЦП", 55, 46],
  ["memory", "Память", 75, 58], ["disk", "I/O", 86, 70], ["owner", "Пользователь", 156, 90],
  ["description", "Описание", 180, 92], ["path", "Путь к EXE", 250, 110],
  ["status", "Статус", 114, 70], ["runtime", "Время", 70, 55],
  ["threads", "Потоки", 62, 52], ["handles", "Дескрипт.", 77, 65],
] as const satisfies readonly (readonly [ProcessSortKey, string, number, number])[];

export type ProcessColumn = typeof PROCESS_COLUMNS[number];
export type ColumnWidths = Partial<Record<ProcessSortKey, number>>;
export const DEFAULT_COLUMNS: ProcessSortKey[] = ["name", "pid", "cpu", "memory", "disk"];
export const MAX_COLUMN_WIDTH = 900;

export function columnWidth(column: ProcessColumn, width: number) {
  return Math.max(column[3], Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
}

export function readProcessColumns(raw: string | null, rawWidths: string | null) {
  let keys = DEFAULT_COLUMNS;
  const widths: ColumnWidths = {};
  try {
    const saved: unknown = JSON.parse(raw ?? "null");
    if (Array.isArray(saved)) keys = PROCESS_COLUMNS.filter(([key]) => key === "name" || saved.includes(key)).map(([key]) => key);
  } catch { /* Retain defaults for older or damaged preferences. */ }
  try {
    const saved = JSON.parse(rawWidths ?? "null") as ColumnWidths | null;
    for (const column of PROCESS_COLUMNS) {
      const width = saved?.[column[0]];
      if (typeof width === "number" && Number.isFinite(width)) widths[column[0]] = columnWidth(column, width);
    }
  } catch { /* A bad width cannot affect visible columns. */ }
  return { keys, widths };
}
