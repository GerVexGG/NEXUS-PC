import { emptyProcessSnapshot, reconcileProcesses } from "../../lib/processSnapshot";
import { processIoDisplay } from "../../lib/processIo";
import {
  columnWidth, DEFAULT_COLUMNS, MAX_COLUMN_WIDTH, PROCESS_COLUMNS, readProcessColumns,
  type ColumnWidths, type ProcessColumn,
} from "../../lib/processColumns";
import { useWorkspaceState } from "../../hooks/useWorkspaceState";
import { ModuleHeader } from "../ui/ModuleHeader";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  AppWindow, ArrowDown, ArrowUp, ChevronRight, ChevronsDownUp, ChevronsUpDown,
  Copy, FolderOpen, Info, Loader2, MoreHorizontal, Pause, Play, RefreshCw, Search,
  Shield, Trash2, X, XCircle,
} from "lucide-react";
import { UtilityConfirmDialog } from "../ui/UtilityConfirmDialog";
import {
  copyTextToClipboard, formatUptime,
  type ProcessDetails, type ProcessItem, type ProcessSortKey, type ProcessTargetIdentity,
} from "../../lib/studio";
import {
  buildProcessTree, compareProcessItems, getProcessIdentityKey, matchesProcessQuery, processAncestorKeys, toProcessTargetIdentity,
  type FlattenedProcessRow, type ProcessNodeStats, type ProcessTreeMode,
} from "../../lib/processTree";
import type { NexusController } from "../../hooks/useNexusController";
import "./ProcessModule.css";

const PROTECTED_NAMES = new Set([
  "system", "system idle process", "idle", "registry", "memory compression", "secure system",
  "smss", "csrss", "wininit", "services", "lsass", "lsaiso", "winlogon", "dwm", "explorer",
  "fontdrvhost", "sihost", "svchost", "nexus", "nexus-hwmon", "aurora", "aurora-hwmon",
]);
const ROW_HEIGHT = 32;
const OVERSCAN = 5;
const processDate = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "medium",
});
const processNumber = new Intl.NumberFormat("ru-RU");
type Labels = { owner: string | null; description: string | null };
const COLUMN_PREF = "aurora.process.columns";
const WIDTH_PREF = "aurora.process.columnWidths";

function readColumns() {
  try {
    return readProcessColumns(localStorage.getItem(COLUMN_PREF), localStorage.getItem(WIDTH_PREF));
  } catch {
    return readProcessColumns(null, null);
  }
}

function useLabels(processes: ProcessItem[], enabled: boolean, preferred: string | null) {
  const [labels, setLabels] = useState<Map<string, Labels>>(new Map());
  const inFlight = useRef(false);
  const retryAfter = useRef(0);
  useEffect(() => {
    if ((!enabled && !preferred) || inFlight.current || Date.now() < retryAfter.current) return;
    const current = new Map(processes.map(process => [getProcessIdentityKey(process), process]));
    const missing = new Map<string, ProcessItem>();
    const first = preferred ? current.get(preferred) : undefined;
    if (preferred && first && !labels.has(preferred)) missing.set(preferred, first);
    if (enabled) {
      for (const [key, process] of current) {
        if (missing.size >= 128) break;
        if (!labels.has(key)) missing.set(key, process);
      }
    }
    if (!missing.size) return;
    inFlight.current = true;
    const targets = [...missing.values()].map(toProcessTargetIdentity);
    void invoke<Labels[]>("get_process_labels", { targets }).then(result => {
      inFlight.current = false;
      setLabels(previous => {
        const next = new Map(previous);
        [...missing.keys()].forEach((key, index) => next.set(key, result[index] ?? { owner: null, description: null }));
        // Retain known-exited labels for brief UI history, but bound caches under process churn.
        if (next.size > current.size + 128) {
          for (const key of next.keys()) if (!current.has(key)) next.delete(key);
        }
        return next;
      });
    }).catch(() => {
      inFlight.current = false;
      retryAfter.current = Date.now() + 5000;
    });
  }, [processes, enabled, preferred, labels]);
  return labels;
}

function isProtectedProcess(process: Pick<ProcessItem, "pid" | "name"> & { exe_path?: string }): boolean {
  const stems = [process.name, process.exe_path?.split(/[\\/]/).pop() ?? ""];
  return process.pid <= 4 || stems.some((stem) => PROTECTED_NAMES.has(stem.toLowerCase().replace(/\.exe$/i, "")));
}

function processActionBlock(process: ProcessItem, busy: boolean): string | undefined {
  if (isProtectedProcess(process)) return "Процесс защищён";
  if (process.start_time <= 0) return "Недоступно время запуска для проверки PID";
  return busy ? "Выполняется другая операция" : undefined;
}

function isPausedProcess(process: ProcessItem, isNexusPaused: (process: ProcessItem) => boolean): boolean {
  return isNexusPaused(process) || process.status === "Приостановлен";
}

function formatRam(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} ГБ`;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} МБ`;
}

function countLabel(value: number): string {
  return value > 0 ? processNumber.format(value) : "Н/Д";
}

function formatProcessRuntime(process: ProcessItem): string {
  return process.start_time > 0 ? formatUptime(process.run_time_sec) : "Н/Д";
}

function processColumnText(process: ProcessItem, column: Exclude<ProcessSortKey, "cpu" | "disk">, labels: Labels | undefined, paused: boolean, finished: boolean) {
  switch (column) {
    case "name": return process.name;
    case "pid": return process.pid;
    case "memory": return process.memory_mb > 0 ? formatRam(process.memory_mb) : "Н/Д";
    case "runtime": return formatProcessRuntime(process);
    case "threads": return countLabel(process.thread_count);
    case "handles": return countLabel(process.handle_count);
    case "owner": return labels?.owner ?? "Н/Д";
    case "description": return labels?.description ?? "Н/Д";
    case "path": return process.exe_path || "Н/Д";
    case "status": return finished ? "Завершён" : paused ? "Приостановлен" :
      process.status.startsWith("Unknown") ? "Н/Д" : process.status;
  }
}

function ProcessIcon({ process }: { process: ProcessItem }) {
  return (
    <span className="process-icon" aria-hidden="true">
      {process.icon_base64
        ? <img src={`data:image/png;base64,${process.icon_base64}`} alt="" draggable={false} />
        : <AppWindow size={15} />}
    </span>
  );
}

type ProcessRow = Pick<
  FlattenedProcessRow, "process" | "depth" | "hasChildren" | "isExpanded" | "matchedSelf" | "ancestorHasNext" | "isLastChild"
>;
type ProcessFilter = "all" | "protected" | "paused" | "windows";

interface ProcessGridProps {
  rows: ProcessRow[];
  snapshot: ReturnType<typeof reconcileProcesses>;
  tree: boolean;
  filterActive: boolean;
  resetKey: string;
  revealKey: string | null;
  columns: readonly ProcessColumn[];
  widths: ColumnWidths;
  onColumnWidth: (key: ProcessSortKey, width: number) => void;
  labels: ReadonlyMap<string, Labels>;
  loading: boolean;
  loadError: string | null;
  sortKey: ProcessSortKey;
  sortDesc: boolean;
  selectedKey: string | null;
  onSort: (key: ProcessSortKey) => void;
  onSelect: (process: ProcessItem) => void;
  onExpand: (process: ProcessItem) => void;
  onInspect: (process: ProcessItem) => void;
  onMenu: (process: ProcessItem, x: number, y: number) => void;
  onScroll: () => void;
  isNexusPaused: (process: ProcessItem) => boolean;
}

const ProcessGrid = memo(function ProcessGrid({
  rows, snapshot, tree, filterActive, resetKey, revealKey, columns, loading, loadError, sortKey, sortDesc,
  selectedKey, onSort, onSelect, onExpand, onInspect, onMenu, onScroll, isNexusPaused, labels, widths, onColumnWidth,
}: ProcessGridProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const prior = useRef<{ rows: ProcessRow[]; resetKey: string; revealKey: string | null } | null>(null);
  const automaticScroll = useRef<number | null>(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const indices = useMemo(() => new Map(rows.map(({ process }, index) => [getProcessIdentityKey(process), index])), [rows]);
  const drag = useRef<{ key: ProcessSortKey; x: number; width: number } | null>(null);
  const [preview, setPreview] = useState<{ key: ProcessSortKey; width: number } | null>(null);
  const dimensions = columns.map(([key, , defaultWidth]) => preview?.key === key ? preview.width : widths[key] ?? defaultWidth);
  const columnStyle = {
    "--process-columns": columns.map(([key], index) => key === "name" && widths.name === undefined && preview?.key !== "name"
      ? `minmax(${dimensions[index]}px, 1fr)` : `${dimensions[index]}px`).join(" "),
    "--process-min-width": `${dimensions.reduce((total, width) => total + width, 0) + (columns.length - 1) * 6 + 18}px`,
  } as CSSProperties;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setHeight(element.clientHeight);
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = viewport.current;
    const previous = prior.current;
    prior.current = { rows, resetKey, revealKey };
    if (!element) return;
    const before = element.scrollTop;
    if (revealKey && revealKey !== previous?.revealKey) {
      const index = indices.get(revealKey);
      if (index !== undefined) element.scrollTop = index * ROW_HEIGHT;
    } else if (previous && previous.resetKey !== resetKey) {
      element.scrollTop = 0;
    } else if (previous && previous.rows !== rows && element.scrollTop > ROW_HEIGHT) {
      const offset = before % ROW_HEIGHT;
      const anchor = previous.rows[Math.floor(before / ROW_HEIGHT)];
      const nextIndex = anchor ? indices.get(getProcessIdentityKey(anchor.process)) : undefined;
      if (nextIndex !== undefined) element.scrollTop = nextIndex * ROW_HEIGHT + offset;
    }
    if (element.scrollTop !== before) automaticScroll.current = element.scrollTop;
    setScrollTop(element.scrollTop);
  }, [indices, resetKey, revealKey, rows]);

  const top = Math.min(scrollTop, Math.max(0, rows.length * ROW_HEIGHT - height));
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
  const activeIndex = selectedKey === null ? undefined : indices.get(selectedKey);

  function selectIndex(index: number) {
    const element = viewport.current;
    const row = rows[index];
    if (!row || !element || snapshot.departed.has(getProcessIdentityKey(row.process))) return;
    const start = index * ROW_HEIGHT;
    if (start < element.scrollTop) element.scrollTop = start;
    else if (start + ROW_HEIGHT > element.scrollTop + height) element.scrollTop = start + ROW_HEIGHT - height;
    setScrollTop(element.scrollTop);
    onSelect(snapshot.live.get(getProcessIdentityKey(row.process)) ?? row.process);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || rows.length === 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const active = activeIndex ?? -1;
    const row = rows[active];
    const page = Math.max(1, Math.floor(height / ROW_HEIGHT));
    let next = active;
    switch (event.key) {
      case "ArrowDown": next = Math.min(rows.length - 1, active + 1); break;
      case "ArrowUp": next = Math.max(0, active - 1); break;
      case "Home": next = 0; break;
      case "End": next = rows.length - 1; break;
      case "PageUp": next = Math.max(0, active - page); break;
      case "PageDown": next = Math.min(rows.length - 1, active + page); break;
      case "ArrowLeft":
        if (!row || !tree) return;
        if (row.hasChildren && row.isExpanded && !filterActive) onExpand(row.process);
        else {
          for (let index = active - 1; index >= 0; index--) {
            if (rows[index].depth < row.depth) {
              next = index;
              break;
            }
          }
        }
        break;
      case "ArrowRight":
        if (!row || !tree || !row.hasChildren) return;
        if (row.isExpanded) next = Math.min(rows.length - 1, active + 1);
        else if (!filterActive) onExpand(row.process);
        break;
      case "Enter":
        if (!row || snapshot.departed.has(getProcessIdentityKey(row.process))) return;
        onInspect(row.process);
        break;
      case "ContextMenu":
      case "F10": {
        if ((event.key === "F10" && !event.shiftKey) || !row || snapshot.departed.has(getProcessIdentityKey(row.process))) return;
        const rect = document.getElementById(`process-row-${row.process.pid}`)?.getBoundingClientRect()
          ?? viewport.current?.getBoundingClientRect();
        if (rect) onMenu(row.process, rect.left + 32, rect.top + 20);
        break;
      }
      default: return;
    }
    event.preventDefault();
    if (next !== active || event.key === "Home" || event.key === "End") {
      const step = next >= active && event.key !== "End" ? 1 : -1;
      while (rows[next] && snapshot.departed.has(getProcessIdentityKey(rows[next].process))) next += step;
      selectIndex(next);
    }
  }

  return (
    <div
      ref={grid}
      role={tree ? "treegrid" : "grid"}
      tabIndex={0}
      aria-label="Список процессов"
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length}
      aria-activedescendant={activeIndex !== undefined && activeIndex >= first && activeIndex < last
        ? `process-row-${rows[activeIndex].process.pid}`
        : undefined}
      className="nexus-panel process-grid"
      style={columnStyle}
      onKeyDown={handleKeyDown}
    >
      <div className="process-column-clip" ref={header} role="presentation">
      <div role="row" aria-rowindex={1} className="process-columns process-column-header">
        {columns.map((column, index) => {
          const [key, label] = column;
          return <div role="columnheader" key={key} data-column={key} aria-sort={sortKey === key ? (sortDesc ? "descending" : "ascending") : undefined}>
            <button type="button" onClick={() => onSort(key)} className={sortKey === key ? "process-sort-active" : undefined}
              title={key === "disk" ? "Чтение и запись по счётчикам процесса Windows" : undefined}>
              {label}
              {sortKey === key && (sortDesc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
            </button>
            <span
              className="process-column-resizer"
              role="separator"
              aria-label={`Ширина столбца ${label}`}
              aria-orientation="vertical"
              aria-valuemin={column[3]}
              aria-valuemax={MAX_COLUMN_WIDTH}
              aria-valuenow={dimensions[index]}
              title="Перетащите или используйте ← →"
              tabIndex={0}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                const handle = event.currentTarget;
                drag.current = { key, x: event.clientX, width: handle.parentElement!.getBoundingClientRect().width };
                handle.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const start = drag.current;
                if (start?.key === key) setPreview({ key, width: columnWidth(column, start.width + event.clientX - start.x) });
              }}
              onPointerUp={(event) => {
                const start = drag.current;
                if (start?.key === key && event.clientX !== start.x) onColumnWidth(key, columnWidth(column, start.width + event.clientX - start.x));
                drag.current = null;
                setPreview(null);
              }}
              onLostPointerCapture={() => { drag.current = null; setPreview(null); }}
              onKeyDown={(event) => {
                if (event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                const width = event.currentTarget.parentElement!.getBoundingClientRect().width;
                onColumnWidth(key, columnWidth(column, width + (event.key === "ArrowRight" ? 8 : -8)));
              }}
            />
          </div>;
        })}
      </div></div>
      <div
        ref={viewport}
        role="rowgroup"
        className="process-viewport"
        onScroll={(event) => {
          const position = event.currentTarget.scrollTop;
          if (header.current) header.current.scrollLeft = event.currentTarget.scrollLeft;
          setScrollTop(position);
          if (position !== automaticScroll.current) onScroll();
          automaticScroll.current = null;
        }}
      >
        {rows.length === 0 && (
          <div className="nexus-empty process-empty" role="status">
            {loading
              ? <><Loader2 className="motion-safe:animate-spin" size={18} /> Чтение списка процессов…</>
              : <><Search size={18} /> {loadError ? "Список процессов недоступен" : filterActive ? "Подходящие процессы не найдены" : "Список процессов пуст"}</>}
          </div>
        )}
        <div role="presentation" style={{ paddingTop: first * ROW_HEIGHT, paddingBottom: (rows.length - last) * ROW_HEIGHT }}>
          {rows.slice(first, last).map((row, offset) => {
            const identity = getProcessIdentityKey(row.process);
            const process = snapshot.live.get(identity) ?? row.process;
            const finished = snapshot.departed.has(identity);
            const life = finished ? "exited" : snapshot.added.has(identity) ? "new" : undefined;
            const key = getProcessIdentityKey(process);
            const selected = selectedKey === key;
            const protectedProcess = isProtectedProcess(process);
            const paused = isPausedProcess(process, isNexusPaused);
            const depth = Math.min(6, row.depth);
            const prefix = row.ancestorHasNext.slice(0, depth - 1);
            return (
              <div
                key={key}
                id={`process-row-${process.pid}`} data-identity={identity}
                role="row"
                aria-rowindex={first + offset + 2}
                aria-selected={selected}
                aria-level={tree ? row.depth + 1 : undefined}
                aria-expanded={tree && row.hasChildren ? row.isExpanded : undefined}
                data-life={life}
                aria-disabled={finished || undefined}
                className="process-columns process-row"
                style={{ height: ROW_HEIGHT }}
                onClick={() => {
                  grid.current?.focus({ preventScroll: true });
                  if (!finished) onSelect(process);
                }}
                onDoubleClick={() => { if (!finished) onInspect(process); }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  grid.current?.focus({ preventScroll: true });
                  if (!finished) onMenu(process, event.clientX, event.clientY);
                }}
              >
                <div role="gridcell" className="process-name">
                  {tree && (
                    <span className="process-tree-guides" aria-hidden="true">
                      {prefix.map((hasLine, index) => <i key={index} className={hasLine ? "process-guide" : ""} />)}
                      {depth > 0 && <i className={`process-guide process-guide--elbow${row.isLastChild ? " process-guide--last" : ""}`} />}
                    </span>
                  )}
                  {tree && (
                    row.hasChildren
                      ? <button
                        type="button"
                        tabIndex={-1}
                        aria-label={row.isExpanded ? "Свернуть ветку" : "Развернуть ветку"}
                        aria-expanded={row.isExpanded}
                        disabled={filterActive}
                        className="process-expander"
                        onClick={(event) => {
                          event.stopPropagation();
                          grid.current?.focus({ preventScroll: true });
                          onExpand(process);
                        }}
                      ><ChevronRight size={15} /></button>
                      : <span className="process-expander" />
                  )}
                  <ProcessIcon process={process} />
                  <span className={row.matchedSelf ? "process-name-label process-match" : "process-name-label"} title={process.exe_path || process.name}>
                    {process.name}
                  </span>
                  {paused && <span className="process-paused" title="Процесс приостановлен" aria-label="Приостановлен"><Pause size={12} /></span>}
                  {protectedProcess && <span className="process-protected" title="Процесс защищён" aria-label="Защищён"><Shield size={12} /></span>}
                </div>
                {columns.slice(1).map(([column]) => {
                  if (column === "cpu") return <span key={column} role="gridcell"
                    className={process.cpu_usage >= 10 ? "process-cpu process-high-cpu" : "process-cpu"}
                    style={{ "--cpu-load": Math.min(1, Math.max(0, process.cpu_usage / 100)) } as CSSProperties}>
                    {finished ? "—" : process.cpu_usage.toFixed(1) + "%"}
                  </span>;
                  if (column === "disk") {
                    const io = finished ? null : processIoDisplay(process);
                    return <span key={column} role="gridcell" title={io?.reason || io?.total}>{io?.total ?? "—"}</span>;
                  }
                  const value = processColumnText(process, column, labels.get(identity), paused, finished);
                  return <span key={column} role="gridcell" title={String(value)}>{value}</span>;
                })}

              </div>
            );
          })}
        </div>
      </div>
      <div className="process-grid-footer">{processNumber.format(rows.length)} строк · ↑ ↓ выбор · Enter свойства{sortKey !== "name" && sortKey !== "pid" ? " · Пересортировка по команде" : ""}</div>
    </div>
  );
});

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="process-field"><dt>{label}</dt><dd>{children}</dd></div>;
}

function ProcessInspector({
  selected, disappeared, details, detailError, stats, labels, paused, startTimeText, actionBusy, focusTarget,
  onHide, onOpenPath, onCopyPath, onCopyCommand, onPause, onKill, onMenu,
}: {
  selected: ProcessItem | null;
  disappeared: boolean;
  details: ProcessDetails | null;
  detailError: string | null;
  stats: ProcessNodeStats | undefined;
  labels: Labels | undefined;
  paused: boolean;
  startTimeText: string;
  actionBusy: boolean;
  focusTarget: React.RefObject<HTMLElement | null>;
  onHide: () => void;
  onOpenPath: (process: ProcessItem) => void;
  onCopyPath: (process: ProcessItem) => void;
  onCopyCommand: (command: string) => void;
  onPause: (process: ProcessItem) => void;
  onKill: (process: ProcessItem, tree: boolean) => void;
  onMenu: (process: ProcessItem, x: number, y: number) => void;
}) {
  if (!selected) {
    return (
      <aside className="nexus-panel process-inspector process-inspector--empty" aria-label="Свойства процесса">
        <div className="process-inspector-head"><h2>Свойства процесса</h2></div>
        <div className="nexus-empty process-empty">
          <Info size={20} />
          {disappeared ? "Выбранный процесс завершён или PID был переиспользован" : "Выберите процесс в таблице"}
        </div>
      </aside>
    );
  }

  const protectedProcess = isProtectedProcess(selected);
  const fileSource = !selected.exe_path && details?.exe_path ? { ...selected, exe_path: details.exe_path } : selected;
  const ppid = details?.parent_pid;
  const io = processIoDisplay(selected);
  const resource = (value: number) => `${value.toFixed(1)}%`;
  const actionBlock = processActionBlock(selected, actionBusy);

  return (
    <aside ref={focusTarget} tabIndex={-1} className="nexus-panel process-inspector" aria-label="Свойства процесса">
      <div className="process-inspector-head">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProcessIcon process={selected} />
          <div className="min-w-0">
            <h2 title={selected.name}>{selected.name}</h2>
            <p className="process-identity">PID {selected.pid} <span>·</span> {paused ? "Приостановлен" : selected.status.startsWith("Unknown") ? "Состояние недоступно" : selected.status}</p>
          </div>
        </div>
        <button type="button" className="process-icon-button" title="Снять выделение" aria-label="Снять выделение" onClick={onHide}><X size={16} /></button>
      </div>
      <div className="process-inspector-body">
        {protectedProcess && <p className="process-protection"><Shield size={13} /> Системные действия заблокированы</p>}
        {!protectedProcess && selected.start_time <= 0 && (
          <p className="process-protection"><Shield size={13} /> Действия недоступны без времени запуска</p>
        )}
        <section className="process-inspector-section">
          <h3>Ресурсы</h3>
          <dl className="avs-process-resources">
            <div><dt>Загрузка ЦП</dt><dd>{resource(selected.cpu_usage)}</dd></div>
            <div><dt>Память</dt><dd>{formatRam(selected.memory_mb)}</dd></div>
          </dl>
          <dl>
            <Field label="Чтение / запись">
              <span title={io.reason || undefined}>{io.separate}</span>
              {io.reason && <small className="block text-[var(--nexus-muted)]">{io.reason}</small>}
            </Field>
            <Field label="Виртуальная память">{details && details.virtual_memory_mb > 0 ? formatRam(details.virtual_memory_mb) : "Н/Д"}</Field>
          </dl>
        </section>
        <section className="process-inspector-section">
          <h3>Связи</h3>
          <dl>
            <Field label="Родитель">{ppid ? `${details?.parent_name ? `${details.parent_name} · ` : ""}PID ${ppid}` : "Н/Д"}</Field>
            <Field label="Прямые / всего потомков">{stats ? `${stats.directChildCount} / ${stats.totalDescendants}` : "Н/Д"}</Field>
            {stats && stats.totalDescendants > 0 && (
              <Field label="Ресурсы ветки">{resource(stats.subtreeCpu)} · {formatRam(stats.subtreeMemoryMb)}</Field>
            )}
          </dl>
        </section>
        <section className="process-inspector-section">
          <h3>Выполнение</h3>
          <dl>
            <Field label="Запуск">{startTimeText}</Field>
            <Field label="Время работы">{formatProcessRuntime(selected)}</Field>
            <Field label="Потоки / дескрипторы">{countLabel(selected.thread_count)} / {countLabel(selected.handle_count)}</Field>
          </dl>
        </section>
        <section className="process-inspector-section">
          <h3>Исполняемый файл</h3>
          <dl>
            <Field label="Описание">{labels?.description ?? "Н/Д"}</Field>
            <Field label="Пользователь">{labels?.owner ?? "Н/Д"}</Field>
          </dl>
          <code className="process-code">{fileSource.exe_path || "Путь недоступен"}</code>
          <div className="process-path-actions">
            <button className="nexus-button" type="button" disabled={!fileSource.exe_path} onClick={() => onOpenPath(fileSource)}>
              <FolderOpen size={14} /> Расположение
            </button>
            <button className="nexus-button" type="button" onClick={() => onCopyPath(fileSource)}>
              <Copy size={14} /> {fileSource.exe_path ? "Путь" : "Имя"}
            </button>
          </div>
          {detailError ? <p className="process-detail-error" role="status">{detailError}</p> : !details ? (
            <p className="process-detail-loading" role="status"><Loader2 size={13} className="motion-safe:animate-spin" /> Чтение параметров…</p>
          ) : (
            <>
              <p className="process-detail-label">Рабочая папка</p>
              <code className="process-code">{details.working_dir || "Н/Д"}</code>
              <p className="process-detail-label">Командная строка</p>
              <code className="process-code">{details.command_line || "Н/Д"}</code>
              {details.command_line && (
                <button className="nexus-button mt-2" type="button" onClick={() => onCopyCommand(details.command_line)}>
                  <Copy size={14} /> Копировать команду
                </button>
              )}
            </>
          )}
        </section>
      </div>
      <div className="process-inspector-actions">
        <button type="button" disabled={Boolean(actionBlock)} title={actionBlock} className="nexus-button" onClick={() => onPause(selected)}>
          {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "Возобновить" : "Приостановить"}
        </button>
        <button type="button" disabled={Boolean(actionBlock)} title={actionBlock} className="nexus-button nexus-button--danger" onClick={() => onKill(selected, false)}>
          <XCircle size={14} /> Завершить
        </button>
        <button
          type="button"
          className="process-icon-button"
          aria-label="Все действия процесса"
          title="Все действия процесса"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu(selected, rect.right, rect.bottom);
          }}
        ><MoreHorizontal size={17} /></button>
      </div>
    </aside>
  );
}

function ProcessMenu({
  position, title, children, onDismiss,
}: {
  position: { x: number; y: number };
  title: string;
  children: ReactNode;
  onDismiss: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const place = () => {
      element.style.left = `${Math.max(8, Math.min(position.x, innerWidth - element.offsetWidth - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(position.y, innerHeight - element.offsetHeight - 8))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [position.x, position.y]);
  useEffect(() => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={`Действия для процесса ${title}`}
      className="nexus-panel process-menu"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(event) => event.stopPropagation()}
      onClickCapture={(event) => {
        if ((event.target as Element).closest("button:enabled")) trigger.current?.focus({ preventScroll: true });
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
          const current = buttons.findIndex((button) => button === document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : event.key === "ArrowDown" ? (current + 1) % buttons.length
            : (current + buttons.length - 1) % buttons.length;
          buttons[next]?.focus();
          return;
        }
        if (event.key !== "Escape" && event.key !== "Tab") return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
        trigger.current?.focus({ preventScroll: true });
        onDismiss();
      }}
    >
      <div className="process-menu-title" title={title}>{title}</div>
      {children}
    </div>,
    document.body,
  );
}

export function ProcessModule({ c }: { c: NexusController }) {
  const {
    processes, processSearch, setProcessSearch, processAutoRefresh, setProcessAutoRefresh,
    processError, setProcessError, processLoadError, processNotice, processLoading, processActionBusy,
    selectedProcessKey, selectProcess, networkProcessPid, isProcessSuspended, processMenu, setProcessMenu,
    fetchProcesses, handleProcessContextMenu, handleProcessOpenLocation, handleProcessCopyPath,
    handleProcessSuspendToggle, handleProcessKill, handleProcessSort, processSortKey, processSortDesc,
    showProcessNotice,
  } = c;
  const [view, setView] = useWorkspaceState<ProcessTreeMode | "list">("process.view", "applications");
  const tree = view !== "list";
  const [preferences, setPreferences] = useState(readColumns);
  const { keys: columnKeys, widths } = preferences;
  const columns = useMemo(() => PROCESS_COLUMNS.filter(([key]) => columnKeys.includes(key)), [columnKeys]);
  const query = networkProcessPid === null ? processSearch.trim().toLowerCase() : "";
  const searchDescriptions = Boolean(query && !/^\d+$/.test(query));
  const labels = useLabels(processes, searchDescriptions || columnKeys.includes("owner") || columnKeys.includes("description"), selectedProcessKey);
  const [rankedLabels, setRankedLabels] = useState<ReadonlyMap<string, Labels>>(new Map());
  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_PREF, JSON.stringify(columnKeys));
      localStorage.setItem(WIDTH_PREF, JSON.stringify(widths));
    } catch { /* Session choices still work. */ }
  }, [columnKeys, widths]);
  const resizeColumn = useCallback((key: ProcessSortKey, width: number) => {
    setPreferences(previous => ({ ...previous, widths: { ...previous.widths, [key]: width } }));
  }, []);
  const [filter, setFilter] = useWorkspaceState<ProcessFilter>("process.filter", "all");
  const [expandedKeys, setExpandedKeys] = useWorkspaceState<Set<string>>("process.expandedKeys", new Set());
  const [detailsState, setDetailsState] = useState<{ key: string; data?: ProcessDetails; error?: string } | null>(null);
  const [pendingKill, setPendingKill] = useState<{ process: ProcessItem; tree: boolean; targets: ProcessTargetIdentity[] } | null>(null);
  const inspector = useRef<HTMLElement>(null);
  const shouldFocusInspector = useRef(false);

  const [orderRevision, setOrderRevision] = useState(0);
  const [previous, setPrevious] = useState({ processes, revision: -1, snapshot: emptyProcessSnapshot });
  const snapshot = previous.processes === processes && previous.revision === orderRevision
    ? previous.snapshot : reconcileProcesses(previous.snapshot, processes, orderRevision, Date.now());
  if (snapshot !== previous.snapshot) setPrevious({ processes, revision: orderRevision, snapshot });
  const activeIdentities = snapshot.live;
  const selected = selectedProcessKey ? activeIdentities.get(selectedProcessKey) ?? null : null;
  const filterLive = filter === "paused" || filter === "windows" ? activeIdentities : null;
  const matchesStatus = useCallback((process: ProcessItem) => {
    if (networkProcessPid !== null && process.pid !== networkProcessPid) return false;
    if (filter === "protected") return isProtectedProcess(process);
    if (filterLive) {
      const live = filterLive.get(getProcessIdentityKey(process));
      return !!live && (filter === "paused" ? isPausedProcess(live, isProcessSuspended) : Boolean(live.has_main_window));
    }
    return true;
  }, [filter, filterLive, isProcessSuspended, networkProcessPid]);
  const filterActive = Boolean(query || filter !== "all" || networkProcessPid !== null);
  const queryLabels = searchDescriptions ? labels : null;
  const describe = useCallback((process: ProcessItem) => queryLabels?.get(getProcessIdentityKey(process))?.description, [queryLabels]);

  const sortable = useMemo(() => processSortKey === "owner" || processSortKey === "description"
    ? snapshot.topology.map(process => ({ ...process, ...rankedLabels.get(getProcessIdentityKey(process)) }))
    : snapshot.topology, [rankedLabels, processSortKey, snapshot.topology]);
  const treeData = useMemo(() => {
    const expandedPids = new Set<number>();
    for (const process of snapshot.topology) {
      if (expandedKeys.has(getProcessIdentityKey(process))) expandedPids.add(process.pid);
    }
    const predicate = filter !== "all" || networkProcessPid !== null ? matchesStatus : undefined;
    return buildProcessTree(sortable, processSortKey, processSortDesc, query, expandedPids, predicate,
      view === "applications" ? "applications" : "ppid", describe);
  }, [sortable, expandedKeys, filter, matchesStatus, networkProcessPid, processSortDesc, processSortKey, query, view, describe]);
  const rows = useMemo<ProcessRow[]>(() => {
    if (tree) return treeData.rows;
    return sortable
      .filter((process) => matchesStatus(process) && (!query || matchesProcessQuery(process, query) ||
        (describe(process)?.toLowerCase().includes(query) ?? false)))
      .sort((a, b) => compareProcessItems(a, b, processSortKey, processSortDesc))
      .map((process) => ({
        process, depth: 0, hasChildren: false, isExpanded: false, matchedSelf: false, ancestorHasNext: [], isLastChild: false,
      }));
  }, [matchesStatus, sortable, processSortDesc, processSortKey, query, tree, treeData.rows, describe]);
  const realStats = useMemo(() => {
    if (!selectedProcessKey && !processMenu) return null;
    return buildProcessTree(snapshot.topology, "pid", false, "", new Set()).statsByPid;
  }, [snapshot.topology, Boolean(selectedProcessKey || processMenu)]);

  useEffect(() => {
    setExpandedKeys((previous) => {
      const next = new Set([...previous].filter((key) => activeIdentities.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [activeIdentities]);

  const detailPid = selected?.pid;
  const detailName = selected?.name;
  const detailStart = selected?.start_time;
  const detailPath = selected?.exe_path;
  useEffect(() => {
    if (!selectedProcessKey || detailPid === undefined || detailStart === undefined || detailName === undefined) return;
    let alive = true;
    const target = { pid: detailPid, name: detailName, start_time: detailStart, exe_path: detailPath || undefined };
    invoke<ProcessDetails>("get_process_details", { target }).then((data) => {
      if (alive) setDetailsState({ key: selectedProcessKey, data });
    }).catch((error) => {
      if (alive) setDetailsState({ key: selectedProcessKey, error: String(error) });
    });
    return () => { alive = false; };
  }, [detailName, detailPath, detailPid, detailStart, selectedProcessKey]);

  useEffect(() => {
    if (processMenu && !activeIdentities.has(getProcessIdentityKey(processMenu.process))) setProcessMenu(null);
  }, [activeIdentities, processMenu, setProcessMenu]);

  const showInspector = useCallback((process: ProcessItem) => {
    shouldFocusInspector.current = true;
    selectProcess(process);
    if (getProcessIdentityKey(process) === selectedProcessKey) {
      shouldFocusInspector.current = false;
      inspector.current?.focus();
    }
  }, [selectProcess, selectedProcessKey]);
  useLayoutEffect(() => {
    if (shouldFocusInspector.current && inspector.current) {
      shouldFocusInspector.current = false;
      inspector.current.focus();
    }
  }, [selectedProcessKey]);

  const toggleExpand = useCallback((process: ProcessItem) => {
    const key = getProcessIdentityKey(process);
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const expandAll = () => {
    const parents = new Set(treeData.parentPids);
    setExpandedKeys(new Set(processes.filter(({ pid }) => parents.has(pid)).map(getProcessIdentityKey)));
  };
  const switchView = (next: typeof view) => {
    if (next === "ppid" || next === "applications") {
      setExpandedKeys(previous => new Set([...previous, ...processAncestorKeys(processes, selected)]));
    }
    setView(next);
  };

  const closeMenu = useCallback(() => setProcessMenu(null), [setProcessMenu]);
  const requestKill = (process: ProcessItem, includeTree: boolean) => {
    closeMenu();
    if (!activeIdentities.has(getProcessIdentityKey(process)) || isProtectedProcess(process)) return;
    const targets = includeTree
      ? buildProcessTree(processes, "name", false, "", new Set()).statsByPid.get(process.pid)?.subtreeTargets ?? [toProcessTargetIdentity(process)]
      : [toProcessTargetIdentity(process)];
    const protectedChild = targets.find(isProtectedProcess);
    if (protectedChild) {
      setProcessError(`В ветке есть защищённый процесс ${protectedChild.name} (PID ${protectedChild.pid}).`);
      return;
    }
    const unverified = targets.find(({ start_time }) => start_time <= 0);
    if (unverified) {
      setProcessError(`Время запуска ${unverified.name} (PID ${unverified.pid}) недоступно для проверки.`);
      return;
    }
    setPendingKill({ process, tree: includeTree, targets });
  };

  const menuProcess = processMenu ? activeIdentities.get(getProcessIdentityKey(processMenu.process)) : undefined;
  const menuBlock = menuProcess && processActionBlock(menuProcess, processActionBusy);
  const branchMember = menuProcess && !menuBlock && realStats?.get(menuProcess.pid)?.subtreeTargets
    .find(target => target.pid !== menuProcess.pid && activeIdentities.has(getProcessIdentityKey(target)) &&
      (isProtectedProcess(target) || target.start_time <= 0));
  const treeBlock = menuBlock || (branchMember
    ? `В ветке есть защищённый или непроверяемый процесс ${branchMember.name} (PID ${branchMember.pid})` : undefined);
  const pathBlock = menuProcess?.exe_path ? undefined : "Путь к исполняемому файлу недоступен";
  const menuPaused = menuProcess ? isPausedProcess(menuProcess, isProcessSuspended) : false;
  const liveStats = selected && realStats?.get(selected.pid);
  const displayedStats = liveStats && liveStats.subtreeTargets.reduce((stats, target) => {
    const member = activeIdentities.get(getProcessIdentityKey(target));
    if (member) {
      stats.subtreeCpu += member.cpu_usage;
      stats.subtreeMemoryMb += member.memory_mb;
    }
    return stats;
  }, { ...liveStats, subtreeCpu: 0, subtreeMemoryMb: 0 });
  const reSort = (key: ProcessSortKey) => {
    setRankedLabels(labels);
    setOrderRevision(value => value + 1);
    handleProcessSort(key);
  };
  const detailsCurrent = detailsState?.key === selectedProcessKey ? detailsState : null;

  return (
    <div className="avs-module process-surface">
      <ModuleHeader module="processes"
        title="Диспетчер процессов"
        description="Дерево процессов, ресурсы и свойства выбранного приложения"
        actions={
          <div className="process-summary">
            <span className="process-total">{processNumber.format(processes.length)} процессов</span>
            {c.metricsReady && <span className="process-total">ЦП системы {c.metrics.cpu_usage.toFixed(1)}%</span>}
          </div>
        }
      />

      <div className="process-toolbar">
        <div className="process-segment" role="group" aria-label="Режим отображения">
          <button type="button" aria-pressed={view === "applications"} onClick={() => switchView("applications")} title="Приложения, запущенные из оболочки, показаны отдельно">Приложения</button>
          <button type="button" aria-pressed={view === "ppid"} onClick={() => switchView("ppid")} title="Системные связи Windows без группировки">PPID</button>
          <button type="button" aria-pressed={view === "list"} onClick={() => switchView("list")}>Список</button>
        </div>
        <label className="process-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={processSearch}
            onChange={(event) => setProcessSearch(event.target.value)}
            placeholder="Имя, PID, путь, описание"
            aria-label="Поиск процесса"
          />
          {processSearch && <button className="process-icon-button" type="button" aria-label="Очистить поиск" onClick={() => setProcessSearch("")}><X size={14} /></button>}
        </label>
        <select className="process-select" aria-label="Фильтр процессов" value={filter} onChange={(event) => setFilter(event.target.value as ProcessFilter)}>
          <option value="all">Все процессы</option>
          <option value="paused">Приостановленные</option>
          <option value="protected">Защищённые</option>
          <option value="windows">С окнами</option>
        </select>
        <details className="process-column-picker">
          <summary className="process-select">Столбцы</summary>
          <fieldset className="nexus-panel">
            <legend className="sr-only">Столбцы таблицы</legend>
            {PROCESS_COLUMNS.slice(1).map(([key, label]) => (
              <label key={key}><input type="checkbox" checked={columnKeys.includes(key)} onChange={() => {
                const enabled = columnKeys.includes(key);
                setPreferences(previous => ({ ...previous, keys: enabled ? columnKeys.filter(column => column !== key) : [...columnKeys, key] }));
                if (enabled && processSortKey === key) handleProcessSort("name");
              }} />{label}</label>
            ))}
            <button type="button" className="nexus-button" onClick={() => {
              setPreferences({ keys: DEFAULT_COLUMNS, widths: {} });
              if (!DEFAULT_COLUMNS.includes(processSortKey)) handleProcessSort("name");
            }}>По умолчанию</button>
          </fieldset>
        </details>
        {tree && (
          <div className="process-toolbar-group">
            <button type="button" className="process-icon-button" disabled={filterActive || !treeData.parentPids.length} onClick={expandAll} title="Развернуть все ветки процессов" aria-label="Развернуть все ветки процессов"><ChevronsUpDown size={16} /></button>
            <button type="button" className="process-icon-button" disabled={filterActive || !expandedKeys.size} onClick={() => setExpandedKeys(new Set())} title="Свернуть все ветки процессов" aria-label="Свернуть все ветки процессов"><ChevronsDownUp size={16} /></button>
          </div>
        )}
        <div className="process-toolbar-group">
          <button type="button" className="process-icon-button" disabled={processLoading} onClick={() => void fetchProcesses().then(() => { setRankedLabels(labels); setOrderRevision(value => value + 1); })} title="Обновить и пересортировать" aria-label="Обновить список">
            <RefreshCw size={16} className={processLoading ? "motion-safe:animate-spin" : ""} />
          </button>
          <button type="button" className="nexus-button process-auto" aria-pressed={processAutoRefresh} onClick={() => setProcessAutoRefresh((previous) => !previous)}>
            {processAutoRefresh ? <Pause size={13} /> : <Play size={13} />} {processAutoRefresh ? "Автообновление" : "Опрос на паузе"}
          </button>
        </div>
      </div>
      {processLoadError && <p className="process-feedback process-feedback--error" role="status">Ошибка обновления списка · {processLoadError}</p>}
      {processError && (
        <div className="process-feedback process-feedback--error" role="alert">
          <span>{processError}</span>
          <button type="button" className="process-icon-button" aria-label="Закрыть сообщение" onClick={() => setProcessError(null)}><X size={14} /></button>
        </div>
      )}
      {processNotice && <p role="status" className="process-feedback">{processNotice}</p>}

      <div className="process-workspace" data-inspecting={selectedProcessKey !== null}>
        <ProcessGrid
          rows={rows}
          snapshot={snapshot}
          tree={tree}
          filterActive={filterActive}
          resetKey={`${tree}:${filter}:${processSortKey}:${processSortDesc}:${query}:${networkProcessPid}`}
          revealKey={networkProcessPid === null ? null : selectedProcessKey}
          columns={columns}
          widths={widths}
          onColumnWidth={resizeColumn}
          labels={labels}
          loading={processLoading && processes.length === 0}
          loadError={processLoadError}
          sortKey={processSortKey}
          sortDesc={processSortDesc}
          selectedKey={selectedProcessKey}
          onSort={reSort}
          onSelect={selectProcess}
          onExpand={toggleExpand}
          onInspect={showInspector}
          onMenu={handleProcessContextMenu}
          onScroll={closeMenu}
          isNexusPaused={isProcessSuspended}
        />
        {selectedProcessKey !== null && <ProcessInspector
          selected={selected}
          disappeared={selectedProcessKey !== null && !selected}
          details={detailsCurrent?.data ?? null}
          detailError={detailsCurrent?.error ?? null}
          stats={displayedStats ?? undefined}
          labels={selectedProcessKey ? labels.get(selectedProcessKey) : undefined}
          paused={selected ? isPausedProcess(selected, isProcessSuspended) : false}
          startTimeText={selected?.start_time ? processDate.format(selected.start_time * 1000) : "Н/Д"}
          actionBusy={processActionBusy}
          focusTarget={inspector}
          onHide={() => selectProcess(null)}
          onOpenPath={handleProcessOpenLocation}
          onCopyPath={handleProcessCopyPath}
          onCopyCommand={(command) => void copyTextToClipboard(command)
            .then(() => showProcessNotice("Командная строка скопирована"))
            .catch((error) => setProcessError(String(error)))}
          onPause={handleProcessSuspendToggle}
          onKill={requestKill}
          onMenu={handleProcessContextMenu}
        />}
      </div>

      {processMenu && menuProcess && (
        <ProcessMenu position={processMenu} title={`${menuProcess.name} · PID ${menuProcess.pid}`} onDismiss={closeMenu}>
          <button type="button" role="menuitem" onClick={() => { closeMenu(); showInspector(menuProcess); }}><Info size={15} /> Свойства процесса</button>
          <button type="button" role="menuitem" disabled={Boolean(pathBlock)} title={pathBlock} onClick={() => void handleProcessOpenLocation(menuProcess)}><FolderOpen size={15} /> Открыть расположение</button>
          <button type="button" role="menuitem" onClick={() => void handleProcessCopyPath(menuProcess)}><Copy size={15} /> {menuProcess.exe_path ? "Копировать путь" : "Копировать имя"}</button>
          <button type="button" role="menuitem" disabled={Boolean(menuBlock)} title={menuBlock} onClick={() => void handleProcessSuspendToggle(menuProcess)}>
            {menuPaused ? <Play size={15} /> : <Pause size={15} />} {menuPaused ? "Возобновить" : "Приостановить"}
          </button>
          <button type="button" role="menuitem" disabled={Boolean(menuBlock)} title={menuBlock} className="process-menu-danger" onClick={() => requestKill(menuProcess, false)}><XCircle size={15} /> Завершить процесс</button>
          <button type="button" role="menuitem" disabled={Boolean(treeBlock)} title={treeBlock} className="process-menu-danger" onClick={() => requestKill(menuProcess, true)}><Trash2 size={15} /> Завершить ветку</button>
          {(treeBlock || pathBlock) && <p className="process-menu-reason">{[treeBlock, pathBlock].filter(Boolean).join(" · ")}</p>}
        </ProcessMenu>
      )}

      {pendingKill && (
        <UtilityConfirmDialog
          title={pendingKill.tree ? "Завершить ветку процессов?" : "Завершить процесс?"}
          confirmLabel={pendingKill.tree ? `Завершить ветку (${pendingKill.targets.length})` : "Завершить процесс"}
          onCancel={() => setPendingKill(null)}
          onConfirm={() => {
            setPendingKill(null);
            if (activeIdentities.has(getProcessIdentityKey(pendingKill.process))) {
              void handleProcessKill(pendingKill.process, pendingKill.tree, pendingKill.targets);
            } else {
              setProcessError("Выбранный процесс уже завершён или PID был переиспользован.");
            }
          }}
        >
          <p>{pendingKill.process.name} · PID {pendingKill.process.pid}. Несохранённые данные могут быть потеряны.</p>
          {pendingKill.tree && (
            <>
              <p>Будут завершены перечисленные процессы ветки.</p>
              <ul className="process-confirm-list" aria-label="Процессы в ветке">
                {pendingKill.targets.map((item) => (
                  <li key={getProcessIdentityKey(item)}><span title={item.name}>{item.name}</span><span>PID {item.pid}</span></li>
                ))}
              </ul>
            </>
          )}
        </UtilityConfirmDialog>
      )}
    </div>
  );
}
