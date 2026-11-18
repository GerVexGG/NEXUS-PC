import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import {
  XCircle,
  Play,
  FolderOpen,
  Search,
  RefreshCw,
  AppWindow,
  Loader2,
  Trash2,
  X,
  Pause,
  Copy,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Info,
  GitBranch,
  Shield,
} from "lucide-react";
import {
  PageHeader,
  copyTextToClipboard,
  formatRate,
  formatUptime,
  type ProcessDetails,
  type ProcessItem,
  type ProcessSortKey,
  type ProcessTargetIdentity,
} from "../../lib/studio";
import {
  buildProcessTree,
  getProcessIdentityKey,
  toProcessTargetIdentity,
} from "../../lib/processTree";
import type { NexusController } from "../../hooks/useNexusController";

const CRITICAL_PROCESSES = new Set([
  "system",
  "system idle process",
  "idle",
  "registry",
  "memory compression",
  "secure system",
  "smss",
  "csrss",
  "wininit",
  "services",
  "lsass",
  "lsaiso",
  "winlogon",
  "dwm",
  "explorer",
  "fontdrvhost",
  "sihost",
  "svchost",
  "nexus",
  "nexus-hwmon",
]);

function isCriticalProcess(name: string): boolean {
  return CRITICAL_PROCESSES.has(name.toLowerCase().replace(/\.exe$/i, ""));
}

function formatRam(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} ГБ`;
  if (mb >= 10) return `${mb.toFixed(0)} МБ`;
  return `${mb.toFixed(1)} МБ`;
}

function formatStartTime(epochSec: number): string {
  if (!epochSec || epochSec <= 0) return "Н/Д";
  return new Date(epochSec * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function cpuTone(value: number): { text: string; bar: string } {
  if (value > 30) return { text: "text-rose-400 font-semibold", bar: "bg-rose-400" };
  if (value > 10) return { text: "text-amber-300 font-semibold", bar: "bg-amber-400" };
  if (value > 1) return { text: "text-[#00D5E8]", bar: "bg-[#00D5E8]" };
  return { text: "text-[#8292A3]", bar: "bg-[#36AFC0]/60" };
}

export function ProcessModule({ c }: { c: NexusController }) {
  const {
    metrics,
    processes,
    processSearch,
    setProcessSearch,
    processAutoRefresh,
    setProcessAutoRefresh,
    processError,
    setProcessError,
    processNotice,
    processLoading,
    selectedPid,
    setSelectedPid,
    isProcessSuspended,
    processMenu,
    setProcessMenu,
    fetchProcesses,
    handleProcessContextMenu,
    handleProcessOpenLocation,
    handleProcessCopyPath,
    handleProcessSuspendToggle,
    handleProcessKill,
    handleProcessSort,
    processSortKey,
    processSortDesc,
    visibleProcesses,
    totalProcessCpu,
    menuProcessSuspended,
    showProcessNotice,
  } = c;
  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [pendingKill, setPendingKill] = useState<{
    proc: ProcessItem;
    tree: boolean;
    directCount: number;
    totalDescendants: number;
    targets: ProcessTargetIdentity[];
  } | null>(null);
  const [detailsModal, setDetailsModal] = useState<{
    loading: boolean;
    error: string | null;
    data: ProcessDetails | null;
    fallbackProc: ProcessItem;
  } | null>(null);

  // Удаляем из expandedKeys завершившиеся/переиспользованные процессы (PID + start_time + name).
  useEffect(() => {
    if (processes.length === 0) return;
    const activeKeys = new Set(processes.map(getProcessIdentityKey));
    setExpandedKeys((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const key of prev) {
        if (activeKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [processes]);

  const expandedPids = useMemo(() => {
    const pids = new Set<number>();
    for (const p of processes) {
      if (expandedKeys.has(getProcessIdentityKey(p))) {
        pids.add(p.pid);
      }
    }
    return pids;
  }, [processes, expandedKeys]);

  const treeData = useMemo(
    () => buildProcessTree(processes, processSortKey, processSortDesc, processSearch, expandedPids),
    [processes, processSortKey, processSortDesc, processSearch, expandedPids]
  );

  const displayRows = useMemo(() => {
    if (viewMode === "tree") return treeData.rows;
    return visibleProcesses.map((proc) => {
      const stats = treeData.statsByPid.get(proc.pid);
      return {
        process: proc,
        depth: 0,
        hasChildren: (stats?.directChildCount ?? 0) > 0,
        directChildCount: stats?.directChildCount ?? 0,
        childCount: stats?.directChildCount ?? 0,
        totalDescendants: stats?.totalDescendants ?? 0,
        subtreeCpu: stats?.subtreeCpu ?? proc.cpu_usage,
        subtreeMemoryMb: stats?.subtreeMemoryMb ?? proc.memory_mb,
        isExpanded: false,
        matchedSelf: false,
        ancestorHasNext: [],
        isLastChild: false,
      };
    });
  }, [viewMode, treeData.rows, treeData.statsByPid, visibleProcesses]);

  const toggleExpand = useCallback(
    (proc: ProcessItem) => {
      const key = getProcessIdentityKey(proc);
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    []
  );

  const expandAll = useCallback(() => {
    const parentSet = new Set(treeData.parentPids);
    const next = new Set<string>();
    for (const p of processes) {
      if (parentSet.has(p.pid)) {
        next.add(getProcessIdentityKey(p));
      }
    }
    setExpandedKeys(next);
  }, [processes, treeData.parentPids]);

  const collapseAll = useCallback(() => {
    setExpandedKeys(new Set());
  }, []);

  const requestKill = (proc: ProcessItem, tree = false) => {
    if (isCriticalProcess(proc.name)) {
      setProcessError(
        `Процесс ${proc.name} (PID ${proc.pid}) относится к защищённым системным узлам Windows и не может быть завершён`
      );
      return;
    }
    const stats = treeData.statsByPid.get(proc.pid);
    const directCount = stats?.directChildCount ?? 0;
    const totalDescendants = stats?.totalDescendants ?? 0;
    const targets = tree
      ? stats?.subtreeTargets ?? [toProcessTargetIdentity(proc)]
      : [toProcessTargetIdentity(proc)];

    if (tree) {
      const protectedChild = targets.find((t) => isCriticalProcess(t.name));
      if (protectedChild) {
        setProcessError(
          `Ветка содержит защищённый системный процесс ${protectedChild.name} (PID ${protectedChild.pid}) — завершение ветки заблокировано`
        );
        return;
      }
      if (totalDescendants > 0) {
        setPendingKill({ proc, tree: true, directCount, totalDescendants, targets });
        return;
      }
    }
    void handleProcessKill(proc, tree, targets);
  };

  const openProcessDetails = useCallback(async (proc: ProcessItem) => {
    setDetailsModal({ loading: true, error: null, data: null, fallbackProc: proc });
    try {
      const details = await invoke<ProcessDetails>("get_process_details", { pid: proc.pid });
      setDetailsModal({ loading: false, error: null, data: details, fallbackProc: proc });
    } catch (err) {
      setDetailsModal({
        loading: false,
        error: String(err),
        data: null,
        fallbackProc: proc,
      });
    }
  }, []);

  const header = (key: ProcessSortKey, label: string, alignRight = false) => {
    const active = processSortKey === key;
    return (
      <button
        type="button"
        onClick={() => handleProcessSort(key)}
        className={`inline-flex cursor-pointer items-center gap-1 text-xs font-medium transition-colors ${
          alignRight ? "justify-end" : "justify-start"
        } ${active ? "text-[#00D5E8]" : "text-[#8292A3] hover:text-[#E5EDF5]"}`}
      >
        <span>{label}</span>
        {active ? (
          processSortDesc ? (
            <ChevronDown size={13} className="text-[#00D5E8]" />
          ) : (
            <ChevronUp size={13} className="text-[#00D5E8]" />
          )
        ) : (
          <span className="w-3" />
        )}
      </button>
    );
  };

  const searching = processSearch.trim().length > 0;
  const totalRamMb = Math.max(4096, metrics.ram_total_gb * 1024);

  return (
    <>
      <motion.div
        key="processes"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="w-full space-y-4"
      >
        <PageHeader
          title="Диспетчер процессов"
          description="Дерево процессов (PID / PPID), распределение CPU/RAM и управление выполнением задач"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-lg border border-[#202B38] bg-[#10151D] px-3 py-1.5 font-mono text-xs text-[#8292A3]">
                <GitBranch size={12} className="text-[#00D5E8]" />
                Корней: <span className="font-semibold text-[#E5EDF5]">{treeData.rootCount}</span>
                <span className="text-[#202B38]">|</span>
                Всего: <span className="font-semibold text-[#E5EDF5]">{processes.length}</span>
                <span className="text-[#202B38]">|</span>
                ЦП: <span className="font-semibold text-[#00D5E8]">{totalProcessCpu.toFixed(1)}%</span>
              </span>
            </div>
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-[#202B38] bg-[#10151D] p-0.5">
            {(
              [
                ["tree", "Дерево"],
                ["flat", "Список"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  viewMode === mode
                    ? "bg-[#151C26] text-[#00D5E8]"
                    : "text-[#8292A3] hover:text-[#E5EDF5]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative min-w-[200px] flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#526170]"
            />
            <input
              type="text"
              value={processSearch}
              onChange={(event) => setProcessSearch(event.target.value)}
              placeholder="Фильтр по имени (.exe), пути или PID…"
              className="w-full rounded-lg border border-[#202B38] bg-[#10151D] py-2 pr-20 pl-9 text-sm text-[#E5EDF5] outline-none placeholder:text-[#526170] focus:border-[#00D5E8]/50"
            />
            <span className="absolute top-1/2 right-3 -translate-y-1/2 font-mono text-[11px] text-[#526170]">
              {viewMode === "flat"
                ? `${visibleProcesses.length}/${processes.length}`
                : searching
                ? `${treeData.matchedCount}/${processes.length}`
                : `${treeData.rows.length}/${processes.length}`}
            </span>
          </div>

          {viewMode === "tree" && (
            <>
              <button
                type="button"
                disabled={searching || treeData.parentPids.length === 0}
                onClick={expandAll}
                title="Развернуть все ветки процессов"
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#10151D] px-3 py-2 text-xs font-medium text-[#8292A3] transition-colors hover:border-[#00D5E8]/35 hover:text-[#E5EDF5] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <ChevronsUpDown size={13} />
                Развернуть
              </button>

              <button
                type="button"
                disabled={searching || expandedPids.size === 0}
                onClick={collapseAll}
                title="Свернуть все ветки процессов"
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#10151D] px-3 py-2 text-xs font-medium text-[#8292A3] transition-colors hover:border-[#00D5E8]/35 hover:text-[#E5EDF5] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <ChevronsDownUp size={13} />
                Свернуть
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => void fetchProcesses()}
            className="cyber-btn inline-flex cursor-pointer items-center justify-center gap-2 px-3.5 py-2 text-xs font-medium text-[#00D5E8]"
          >
            <RefreshCw size={13} className={processLoading ? "animate-spin" : ""} />
            Обновить
          </button>

          <button
            type="button"
            onClick={() => setProcessAutoRefresh((prev) => !prev)}
            title={processAutoRefresh ? "Приостановить автообновление" : "Возобновить автообновление"}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-2 font-mono text-[11px] font-medium transition-colors ${
              processAutoRefresh
                ? "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8] hover:border-[#00D5E8]/50"
                : "border-[#202B38] bg-[#10151D] text-[#8292A3] hover:text-[#E5EDF5]"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                processAutoRefresh ? "bg-[#00D5E8] shadow-[0_0_6px_rgba(0,213,232,0.8)]" : "bg-[#526170]"
              }`}
            />
            {processAutoRefresh ? "АВТООПРОС" : "ПАУЗА"}
          </button>
        </div>

        <AnimatePresence>
          {processError && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="flex items-center justify-between gap-3 rounded-xl border border-rose-500/35 bg-rose-500/12 px-4 py-2.5 text-xs text-rose-300"
            >
              <span>{processError}</span>
              <button type="button" onClick={() => setProcessError(null)} className="shrink-0 cursor-pointer">
                <X size={13} />
              </button>
            </motion.div>
          )}
          {processNotice && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="truncate rounded-xl border border-[#00D5E8]/35 bg-[#00D5E8]/12 px-4 py-2.5 text-xs text-[#00D5E8]"
            >
              {processNotice}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="tactical-card tactical-brackets overflow-x-auto rounded-xl">
          <div className="min-w-[554px]">
          <div className="grid grid-cols-[minmax(140px,1.7fr)_56px_78px_90px_118px] gap-2.5 border-b border-[#202B38] bg-[#0B0E14] px-4 py-2.5 lg:grid-cols-[minmax(0,1.7fr)_90px_150px_150px_122px] lg:gap-3 xl:grid-cols-[minmax(200px,2.2fr)_88px_72px_92px_136px_136px_122px]">
            {header("name", "Процесс")}
            {header("pid", "PID")}
            <div className="hidden text-right xl:flex xl:justify-end">
              {header("threads", "Потоки", true)}
            </div>
            <div className="hidden text-right xl:flex xl:justify-end">
              {header("handles", "Дескрипторы", true)}
            </div>
            {header("cpu", "Нагрузка CPU", true)}
            {header("memory", "Память RAM", true)}
            <span className="text-right text-xs font-medium text-[#8292A3]">Управление</span>
          </div>

          <div
            onScroll={() => setProcessMenu(null)}
            className="max-h-[calc(100vh-310px)] min-h-[260px] divide-y divide-[#202B38]/60 overflow-y-auto"
          >
            {processLoading && processes.length === 0 ? (
              <div className="flex items-center justify-center gap-2 p-12 text-xs text-[#8292A3]">
                <Loader2 size={15} className="animate-spin text-[#00D5E8]" />
                Построение дерева процессов…
              </div>
            ) : displayRows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-12 text-sm text-[#8292A3]">
                <Search size={18} className="text-[#526170]" />
                {searching ? "По заданному фильтру процессы не найдены" : "Список процессов пуст"}
              </div>
            ) : (
              displayRows.map((row) => {
                const proc = row.process;
                const isSelected = selectedPid === proc.pid;
                const isSuspended = isProcessSuspended(proc);
                const isProtected = isCriticalProcess(proc.name);
                const isShell = proc.name.toLowerCase() === "explorer.exe";
                const diskBytesPerSec = proc.disk_read_bytes_sec + proc.disk_write_bytes_sec;
                const tone = cpuTone(proc.cpu_usage);
                const ramPct = Math.min(100, Math.max(2, (proc.memory_mb / (totalRamMb * 0.25)) * 100));
                const visualDepth = Math.min(row.depth, 7);

                return (
                  <div
                    key={proc.pid}
                    onClick={() => setSelectedPid(proc.pid)}
                    onDoubleClick={() => void openProcessDetails(proc)}
                    onContextMenu={(event) => handleProcessContextMenu(event, proc)}
                    className={`grid grid-cols-[minmax(140px,1.7fr)_56px_78px_90px_118px] items-center gap-2.5 px-4 py-2 text-xs transition-colors lg:grid-cols-[minmax(0,1.7fr)_90px_150px_150px_122px] lg:gap-3 xl:grid-cols-[minmax(200px,2.2fr)_88px_72px_92px_136px_136px_122px] ${
                      isSelected
                        ? "bg-[#00D5E8]/12"
                        : isSuspended
                        ? "bg-amber-500/5"
                        : row.matchedSelf
                        ? "bg-[#00D5E8]/[0.04]"
                        : "hover:bg-[#151C26]/65"
                    }`}
                  >
                    <div className="flex min-w-0 items-center">
                      {visualDepth > 0 && (
                        <div className="flex h-7 shrink-0 items-stretch" aria-hidden>
                          {row.ancestorHasNext.slice(0, visualDepth - 1).map((hasLine, colIdx) => (
                            <div
                              key={colIdx}
                              className="flex w-[16px] justify-center"
                            >
                              {hasLine && <span className="h-full w-px bg-[#202B38]" />}
                            </div>
                          ))}
                          <div className="relative flex w-[16px] items-center justify-center">
                            <span
                              className={`absolute left-1/2 top-0 w-px -translate-x-1/2 bg-[#202B38] ${
                                row.isLastChild ? "h-1/2" : "h-full"
                              }`}
                            />
                            <span className="absolute left-1/2 top-1/2 h-px w-1/2 bg-[#202B38]" />
                          </div>
                        </div>
                      )}

                      {viewMode === "tree" && (
                        row.hasChildren ? (
                          <button
                            type="button"
                            aria-expanded={row.isExpanded}
                            aria-label={row.isExpanded ? "Свернуть ветку" : "Развернуть ветку"}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpand(proc);
                            }}
                            className="mr-1.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-[#202B38]/80 bg-[#0B0E14] text-[#8292A3] transition-colors hover:border-[#00D5E8]/45 hover:text-[#00D5E8]"
                          >
                            <ChevronRight
                              size={12}
                              className={`transition-transform duration-150 ${
                                row.isExpanded ? "rotate-90 text-[#00D5E8]" : ""
                              }`}
                            />
                          </button>
                        ) : (
                          <span className="mr-1.5 inline-block h-5 w-5 shrink-0" />
                        )
                      )}

                      <div className="mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-[#202B38] bg-[#0B0E14] text-[#8292A3]">
                        {isSuspended ? (
                          <Pause size={12} className="text-amber-300" />
                        ) : proc.icon_base64 ? (
                          <img
                            src={`data:image/png;base64,${proc.icon_base64}`}
                            alt=""
                            draggable={false}
                            className="h-4 w-4 object-contain"
                          />
                        ) : (
                          <AppWindow size={13} />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`truncate font-semibold ${
                              row.matchedSelf ? "text-[#00D5E8]" : "text-[#E5EDF5]"
                            }`}
                            title={proc.exe_path || proc.name}
                          >
                            {proc.name}
                          </span>
                          {isShell && (
                            <span
                              className="shrink-0 rounded border border-[#202B38] bg-[#151C26] px-1.5 py-0.2 font-mono text-[9px] text-[#36AFC0]"
                              title="Системная оболочка рабочего стола, панели задач и трея Windows"
                            >
                              Оболочка Windows
                            </span>
                          )}
                          {row.hasChildren && (
                            <span
                              className="shrink-0 rounded border border-[#202B38] bg-[#0B0E14] px-1.5 py-0.2 font-mono text-[10px] text-[#8292A3]"
                              title="Непосредственные дочерние процессы (Direct Children)"
                            >
                              {row.directChildCount} прям.
                            </span>
                          )}
                          {row.totalDescendants > row.directChildCount && (
                            <span
                              className="shrink-0 rounded border border-[#202B38]/80 bg-[#0B0E14] px-1.5 py-0.2 font-mono text-[10px] text-[#526170]"
                              title="Всего потомков на всех уровнях вложенности (Total Descendants)"
                            >
                              {row.totalDescendants} в ветке
                            </span>
                          )}
                          {isSuspended && (
                            <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.2 font-mono text-[9px] text-amber-300">
                              ПАУЗА
                            </span>
                          )}
                        </div>
                        <div className="truncate font-mono text-[10px] text-[#526170]">
                          {proc.exe_path ||
                            (proc.parent_pid && proc.parent_pid !== 0
                              ? `PPID ${proc.parent_pid}`
                              : `PID ${proc.pid}`)}
                          {proc.thread_count > 0 ? (
                            <span className="xl:hidden">
                              {` · Потоки: ${proc.thread_count}${
                                proc.handle_count > 0 ? ` · Дескр.: ${proc.handle_count}` : ""
                              }`}
                            </span>
                          ) : null}
                          {diskBytesPerSec > 0 ? ` · Диск: ${formatRate(diskBytesPerSec)}` : ""}
                        </div>
                      </div>
                    </div>

                    <div className="min-w-0 font-mono text-[#8292A3]">
                      <div>{proc.pid}</div>
                      {proc.parent_pid != null && proc.parent_pid !== 0 && (
                        <div className="hidden truncate text-[10px] text-[#526170] xl:block">
                          PPID {proc.parent_pid}
                        </div>
                      )}
                    </div>

                    <div className="hidden min-w-0 text-right font-mono text-[#8292A3] xl:block">
                      {proc.thread_count > 0 ? proc.thread_count : "—"}
                    </div>

                    <div className="hidden min-w-0 text-right font-mono text-[#8292A3] xl:block">
                      {proc.handle_count > 0
                        ? proc.handle_count.toLocaleString("ru-RU")
                        : "—"}
                    </div>

                    <div className="min-w-0 text-right">
                      <div className={`font-mono ${tone.text}`}>{proc.cpu_usage.toFixed(1)}%</div>
                      <div className="mt-1 ml-auto h-1.5 w-16 overflow-hidden rounded-full bg-[#0B0E14] lg:w-24">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${tone.bar}`}
                          style={{ width: `${Math.min(100, proc.cpu_usage)}%` }}
                        />
                      </div>
                      {row.hasChildren && (
                        <div className="mt-0.5 font-mono text-[10px] text-[#526170]">
                          ветка: {row.subtreeCpu.toFixed(1)}%
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 text-right">
                      <div className="font-mono font-medium text-[#E5EDF5]">
                        {formatRam(proc.memory_mb)}
                      </div>
                      <div className="mt-1 ml-auto h-1.5 w-16 overflow-hidden rounded-full bg-[#0B0E14] lg:w-24">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#36AFC0] to-indigo-400 transition-all duration-300"
                          style={{ width: `${ramPct}%` }}
                        />
                      </div>
                      {row.hasChildren && (
                        <div className="mt-0.5 font-mono text-[10px] text-[#526170]">
                          ветка: {formatRam(row.subtreeMemoryMb)}
                        </div>
                      )}
                    </div>

                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        title="Свойства процесса"
                        onClick={(event) => {
                          event.stopPropagation();
                          void openProcessDetails(proc);
                        }}
                        className="hidden h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-transparent text-[#526170] transition-colors hover:border-[#202B38] hover:bg-[#151C26] hover:text-[#00D5E8] sm:inline-flex"
                      >
                        <Info size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={isProtected}
                        title={
                          isProtected
                            ? "Системный процесс Windows защищён"
                            : "Завершить процесс"
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          requestKill(proc, false);
                        }}
                        className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border border-transparent px-2 py-1 text-[11px] font-medium text-[#8292A3] transition-colors hover:border-rose-500/35 hover:bg-rose-500/12 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-[#8292A3] lg:px-2.5"
                      >
                        {isProtected ? <Shield size={12} /> : <XCircle size={13} />}
                        {isProtected ? "Защищён" : "Завершить"}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {processMenu && (
          <motion.div
            key={`menu-${processMenu.process.pid}-${processMenu.x}-${processMenu.y}`}
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -2 }}
            transition={{ type: "spring", stiffness: 520, damping: 34 }}
            style={{ left: processMenu.x, top: processMenu.y, transformOrigin: "top left" }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
            className="fixed z-[100] w-64 rounded-xl border border-[#202B38] bg-[#10151D] p-1.5 text-xs shadow-[0_18px_44px_rgba(0,0,0,0.85)]"
          >
            <div className="mb-1 rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-2">
              <div className="truncate font-semibold text-[#E5EDF5]">{processMenu.process.name}</div>
              <div className="font-mono text-[10px] text-[#8292A3]">
                PID {processMenu.process.pid} · {formatRam(processMenu.process.memory_mb)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                const proc = processMenu.process;
                setProcessMenu(null);
                void openProcessDetails(proc);
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[#E5EDF5] hover:bg-[#151C26]"
            >
              <Info size={14} className="shrink-0 text-[#00D5E8]" />
              Свойства процесса
            </button>
            <button
              type="button"
              onClick={() => void handleProcessOpenLocation(processMenu.process)}
              disabled={!processMenu.process.exe_path}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[#E5EDF5] hover:bg-[#151C26] disabled:cursor-not-allowed disabled:text-[#526170]"
            >
              <FolderOpen size={14} className="shrink-0 text-[#00D5E8]" />
              Открыть расположение файла
            </button>
            <button
              type="button"
              onClick={() => void handleProcessCopyPath(processMenu.process)}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[#E5EDF5] hover:bg-[#151C26]"
            >
              <Copy size={14} className="shrink-0 text-[#8292A3]" />
              Копировать путь
            </button>
            <div className="my-1 h-px bg-[#202B38]" />
            <button
              type="button"
              disabled={isCriticalProcess(processMenu.process.name)}
              onClick={() => void handleProcessSuspendToggle(processMenu.process)}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[#00D5E8] hover:bg-[#00D5E8]/10 disabled:cursor-not-allowed disabled:text-[#526170] disabled:hover:bg-transparent"
            >
              {menuProcessSuspended ? (
                <Play size={14} className="shrink-0 text-[#00D5E8]" />
              ) : (
                <Pause size={14} className="shrink-0 text-[#00D5E8]" />
              )}
              {menuProcessSuspended ? "Возобновить процесс" : "Приостановить процесс"}
            </button>
            <button
              type="button"
              disabled={isCriticalProcess(processMenu.process.name)}
              onClick={() => {
                const proc = processMenu.process;
                setProcessMenu(null);
                requestKill(proc, false);
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-rose-300 hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:text-[#526170] disabled:hover:bg-transparent"
            >
              <XCircle size={14} className="shrink-0 text-rose-400" />
              Завершить процесс
            </button>
            <button
              type="button"
              disabled={isCriticalProcess(processMenu.process.name)}
              onClick={() => {
                const proc = processMenu.process;
                setProcessMenu(null);
                requestKill(proc, true);
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-rose-300 hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:text-[#526170] disabled:hover:bg-transparent"
            >
              <Trash2 size={14} className="shrink-0 text-rose-400" />
              Завершить дерево процессов
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {pendingKill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-xl border border-[#202B38] bg-[#10151D] p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-[#E5EDF5]">
              Завершение ветки процессов
            </h3>
            <p className="mt-2 text-sm text-[#8292A3]">
              Для <span className="font-semibold text-[#E5EDF5]">{pendingKill.proc.name}</span> (PID{" "}
              <span className="font-mono text-[#00D5E8]">{pendingKill.proc.pid}</span>) будут завершены прямые дочерние ({pendingKill.directCount}) и вложенные процессы отображаемой ветки — всего{" "}
              <span className="font-mono font-semibold text-[#E5EDF5]">{pendingKill.targets.length}</span> шт. (независимые приложения из оболочки Explorer не затрагиваются):
            </p>
            <div className="mt-3 max-h-48 divide-y divide-[#202B38]/60 overflow-y-auto rounded-lg border border-[#202B38] bg-[#0B0E14] text-xs">
              {pendingKill.targets.map((item) => (
                <div
                  key={`${item.pid}-${item.start_time}`}
                  className="flex items-center justify-between gap-3 px-3 py-1.5"
                >
                  <span className="truncate font-medium text-[#E5EDF5]">{item.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-[#8292A3]">
                    PID {item.pid}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingKill(null)}
                className="cursor-pointer rounded-lg border border-[#202B38] bg-[#151C26] px-3.5 py-2 text-xs font-medium text-[#8292A3] hover:text-[#E5EDF5]"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  const item = pendingKill;
                  setPendingKill(null);
                  void handleProcessKill(item.proc, item.tree, item.targets);
                }}
                className="cyber-btn-danger cursor-pointer px-3.5 py-2 text-xs font-semibold text-rose-300"
              >
                Завершить выбранную ветку ({pendingKill.targets.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {detailsModal && (
        <div
          onClick={() => setDetailsModal(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="tactical-card tactical-brackets w-full max-w-xl rounded-xl p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#202B38] pb-3">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-[#E5EDF5]">
                  {detailsModal.data?.name ?? detailsModal.fallbackProc.name}
                </h3>
                <div className="mt-0.5 font-mono text-xs text-[#8292A3]">
                  PID {detailsModal.fallbackProc.pid}
                  {detailsModal.fallbackProc.parent_pid != null &&
                  detailsModal.fallbackProc.parent_pid !== 0
                    ? ` · PPID ${detailsModal.fallbackProc.parent_pid}`
                    : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDetailsModal(null)}
                className="cursor-pointer rounded-lg border border-[#202B38] bg-[#0B0E14] p-1.5 text-[#8292A3] hover:text-[#E5EDF5]"
              >
                <X size={14} />
              </button>
            </div>

            {detailsModal.loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-[#8292A3]">
                <Loader2 size={15} className="animate-spin text-[#00D5E8]" />
                Загрузка параметров процесса…
              </div>
            ) : detailsModal.error ? (
              <div className="mt-4 rounded-lg border border-rose-500/35 bg-rose-500/12 p-3 text-xs text-rose-300">
                {detailsModal.error}
              </div>
            ) : detailsModal.data ? (
              <div className="mt-3 space-y-3 text-xs">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                    <div className="text-[10px] text-[#526170]">Состояние</div>
                    <div className="mt-0.5 font-mono font-semibold text-[#00D5E8]">
                      {detailsModal.data.status}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                    <div className="text-[10px] text-[#526170]">Память (RAM / Virt)</div>
                    <div className="mt-0.5 font-mono font-semibold text-[#E5EDF5]">
                      {formatRam(detailsModal.data.memory_mb)} /{" "}
                      {formatRam(detailsModal.data.virtual_memory_mb)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                    <div className="text-[10px] text-[#526170]">Время работы</div>
                    <div className="mt-0.5 font-mono font-semibold text-[#E5EDF5]">
                      {formatUptime(detailsModal.data.run_time_sec)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                    <div className="text-[10px] text-[#526170]">Потоки (Threads)</div>
                    <div className="mt-0.5 font-mono font-semibold text-[#E5EDF5]">
                      {detailsModal.data.thread_count > 0 ? detailsModal.data.thread_count : "—"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                    <div className="text-[10px] text-[#526170]">Дескрипторы (Handles)</div>
                    <div className="mt-0.5 font-mono font-semibold text-[#E5EDF5]">
                      {detailsModal.data.handle_count > 0
                        ? detailsModal.data.handle_count.toLocaleString("ru-RU")
                        : "—"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                    <div className="text-[10px] text-[#526170]">Время запуска</div>
                    <div className="mt-0.5 truncate font-mono font-semibold text-[#E5EDF5]">
                      {formatStartTime(detailsModal.data.start_time)}
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] p-3 space-y-2">
                  <div className="flex justify-between gap-3">
                    <span className="shrink-0 text-[#8292A3]">Родитель</span>
                    <span className="truncate font-mono text-[#E5EDF5]">
                      {detailsModal.data.parent_name
                        ? `${detailsModal.data.parent_name} (PID ${detailsModal.data.parent_pid})`
                        : detailsModal.data.parent_pid
                        ? `PID ${detailsModal.data.parent_pid}`
                        : "Корневой процесс"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="shrink-0 text-[#8292A3]">Прямых дочерних (Direct)</span>
                    <span className="font-mono text-[#E5EDF5]">
                      {detailsModal.data.child_count}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="shrink-0 text-[#8292A3]">Всего потомков (Total)</span>
                    <span className="font-mono text-[#E5EDF5]">
                      {detailsModal.data.total_descendants ?? detailsModal.data.child_count}
                    </span>
                  </div>
                  <div>
                    <div className="text-[#8292A3]">Исполняемый файл</div>
                    <div className="mt-1 break-all rounded border border-[#202B38]/70 bg-[#10151D] px-2.5 py-1.5 font-mono text-[11px] text-[#E5EDF5]">
                      {detailsModal.data.exe_path || "Системный процесс / недоступен"}
                    </div>
                  </div>
                  {detailsModal.data.working_dir && (
                    <div>
                      <div className="text-[#8292A3]">Рабочая директория</div>
                      <div className="mt-1 break-all rounded border border-[#202B38]/70 bg-[#10151D] px-2.5 py-1.5 font-mono text-[11px] text-[#8292A3]">
                        {detailsModal.data.working_dir}
                      </div>
                    </div>
                  )}
                  {detailsModal.data.command_line && (
                    <div>
                      <div className="text-[#8292A3]">Командная строка</div>
                      <div className="mt-1 max-h-24 overflow-y-auto break-all rounded border border-[#202B38]/70 bg-[#10151D] px-2.5 py-1.5 font-mono text-[11px] text-[#8292A3]">
                        {detailsModal.data.command_line}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap justify-end gap-2">
                  {detailsModal.data.command_line && (
                    <button
                      type="button"
                      onClick={() => {
                        void copyTextToClipboard(detailsModal.data!.command_line);
                        showProcessNotice("Командная строка скопирована");
                      }}
                      className="cursor-pointer rounded-lg border border-[#202B38] bg-[#151C26] px-3 py-1.5 text-xs font-medium text-[#8292A3] hover:text-[#E5EDF5]"
                    >
                      Копировать команду
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setDetailsModal(null)}
                    className="cyber-btn cursor-pointer px-3.5 py-1.5 text-xs font-medium text-[#00D5E8]"
                  >
                    Закрыть
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
