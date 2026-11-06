import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import {
  formatRate,
  formatUptime,
  getLoadBarStyles,
  type ProcessItem,
} from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

const SYSTEM_PROCESSES = ["svchost", "lsass", "csrss", "services", "dwm"];
const USER_PROCESSES = ["steam", "chrome", "discord", "cursor"];

function processTone(name: string): "system" | "user" | "plain" {
  const normalized = name.toLowerCase().replace(/\.exe$/, "");
  if (SYSTEM_PROCESSES.includes(normalized)) return "system";
  if (USER_PROCESSES.some((item) => normalized.includes(item))) return "user";
  return "plain";
}

function buildProcessRows(list: ProcessItem[], collapsed: number[]) {
  const present = new Set(list.map((proc) => proc.pid));
  const children = new Map<number, ProcessItem[]>();
  const roots: ProcessItem[] = [];
  for (const proc of list) {
    const parent = proc.parent_pid;
    if (parent != null && parent !== proc.pid && present.has(parent)) {
      const bucket = children.get(parent);
      if (bucket) bucket.push(proc);
      else children.set(parent, [proc]);
    } else {
      roots.push(proc);
    }
  }
  const hidden = new Set(collapsed);
  const rows: { proc: ProcessItem; depth: number; hasChildren: boolean }[] = [];
  const walk = (nodes: ProcessItem[], depth: number) => {
    for (const proc of nodes) {
      const kids = children.get(proc.pid) ?? [];
      rows.push({ proc, depth, hasChildren: kids.length > 0 });
      if (kids.length > 0 && !hidden.has(proc.pid)) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
}

export function ProcessModule({ c }: { c: NexusController }) {
  const {
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
    suspendedPids,
    processMenu,
    setProcessMenu,
    fetchProcesses,
    handleProcessContextMenu,
    handleProcessOpenLocation,
    handleProcessCopyPath,
    handleProcessSuspendToggle,
    handleProcessKill,
    visibleProcesses,
    totalProcessCpu,
    totalProcessMemoryGb,
    menuProcessSuspended,
    renderSortHeader,
  } = c;
  const [collapsedPids, setCollapsedPids] = useState<number[]>([]);
  const processRows = buildProcessRows(visibleProcesses, collapsedPids);
  return (
<>
            <motion.div
              key="processes"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="space-y-4 max-w-6xl w-full"
            >
              {/* Шапка Process Explorer */}
              <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-white/[0.06] pb-3.5">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-100">
                    Диспетчер процессов
                  </h2>
                  <p className="mt-0.5 text-sm text-slate-400">
                    ПКМ по строке — действия с процессом • Клик по заголовку — сортировка
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                  <span className="px-2.5 py-1.5 rounded-lg bg-[#0e1118] border border-white/[0.07] text-[#8793a5] tabular-nums">
                    ПРОЦЕССОВ: <strong className="text-[#e8edf4]">{processes.length}</strong>
                  </span>
                  <span className="px-2.5 py-1.5 rounded-lg bg-[#0e1118] border border-white/[0.07] text-[#8793a5] tabular-nums">
                    CPU Σ:{" "}
                    <strong className={getLoadBarStyles(totalProcessCpu).badgeTextClass}>
                      {totalProcessCpu.toFixed(1)}%
                    </strong>
                  </span>
                  <span className="px-2.5 py-1.5 rounded-lg bg-[#0e1118] border border-white/[0.07] text-[#8793a5] tabular-nums">
                    RAM Σ: <strong className="text-cyan-300">{totalProcessMemoryGb.toFixed(2)} GB</strong>
                  </span>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setProcessAutoRefresh((prev) => !prev)}
                    title={processAutoRefresh ? "Приостановить автообновление" : "Включить автообновление"}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-colors cursor-pointer ${
                      processAutoRefresh
                        ? "bg-sky-500/15 text-sky-300 border-sky-500/35"
                        : "bg-amber-500/15 text-amber-300 border-amber-500/35"
                    }`}
                  >
                    {processAutoRefresh ? <Pause size={12} /> : <Play size={12} />}
                    <span>{processAutoRefresh ? "LIVE 1.5s" : "ПАУЗА"}</span>
                  </motion.button>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.95 }}
                    onClick={fetchProcesses}
                    title="Обновить сейчас"
                    className="inline-flex items-center justify-center h-[30px] w-[30px] rounded-lg bg-[#0e1118] hover:bg-white/[0.06] text-[#c5d0de] border border-white/[0.07] cursor-pointer"
                  >
                    <RefreshCw size={13} className={processLoading ? "animate-spin" : ""} />
                  </motion.button>
                </div>
              </div>

              {/* Поиск по имени, PID или пути */}
              <div className="relative">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#8793a5]"
                />
                <input
                  type="text"
                  value={processSearch}
                  onChange={(e) => setProcessSearch(e.target.value)}
                  placeholder="Мгновенный поиск по имени процесса, PID или пути к файлу..."
                  className="w-full pl-10 pr-24 py-2.5 rounded-xl bg-[#0e1118] border border-white/[0.07] text-sm font-mono text-[#e8edf4] placeholder-zinc-600 focus:outline-none focus:border-sky-500/40 focus:shadow-[0_0_18px_rgba(56,189,248,0.1)] transition-all"
                />
                <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[10px] font-mono text-[#8793a5] tabular-nums">
                  {visibleProcesses.length} / {processes.length}
                </span>
              </div>

              {/* Уведомления и ошибки действий */}
              <AnimatePresence>
                {processError && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-mono flex items-center justify-between gap-3"
                  >
                    <span>{processError}</span>
                    <button
                      type="button"
                      onClick={() => setProcessError(null)}
                      className="text-rose-300 hover:text-rose-100 cursor-pointer shrink-0"
                    >
                      <X size={13} />
                    </button>
                  </motion.div>
                )}
                {processNotice && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="p-3 rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-300 text-xs font-mono truncate"
                  >
                    {processNotice}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Сортируемая таблица процессов */}
              <div className="relative rounded-xl bg-[#111722]/95 border border-white/[0.07] shadow-[0_12px_36px_rgba(0,0,0,0.6)] overflow-hidden">
                <div className="grid grid-cols-[minmax(0,1fr)_90px_110px_170px_110px] gap-3 px-4 py-2.5 bg-[#0e1118] border-b border-white/[0.07]">
                  {renderSortHeader("name", "Процесс / PID", false)}
                  {renderSortHeader("cpu", "CPU %")}
                  {renderSortHeader("memory", "RAM (МБ)")}
                  {renderSortHeader("disk", "Диск R / W")}
                  {renderSortHeader("runtime", "Время")}
                </div>

                <div
                  onScroll={() => setProcessMenu(null)}
                  className="max-h-[calc(100vh-340px)] min-h-[240px] overflow-y-auto divide-y divide-white/[0.035]"
                >
                  {processLoading && processes.length === 0 ? (
                    <div className="p-10 flex items-center justify-center gap-2 text-xs font-mono text-[#8793a5]">
                      <Loader2 size={14} className="animate-spin text-sky-400" />
                      Построение матрицы процессов...
                    </div>
                  ) : visibleProcesses.length === 0 ? (
                    <div className="p-10 text-center text-xs font-mono text-[#8793a5]">
                      Процессы по запросу не найдены
                    </div>
                  ) : (
                    processRows.map(({ proc, depth, hasChildren }) => {
                      const isSelected = selectedPid === proc.pid;
                      const isSuspended = suspendedPids.includes(proc.pid);
                      const tone = processTone(proc.name);
                      const cpuStyle = getLoadBarStyles(proc.cpu_usage * 2.5);
                      const hasDisk =
                        proc.disk_read_bytes_sec > 0 || proc.disk_write_bytes_sec > 0;
                      const collapsed = collapsedPids.includes(proc.pid);
                      return (
                        <div
                          key={proc.pid}
                          onClick={() => setSelectedPid(proc.pid)}
                          onContextMenu={(e) => handleProcessContextMenu(e, proc)}
                          className={`grid grid-cols-[minmax(0,1fr)_90px_110px_170px_110px] gap-3 px-4 py-2 items-center text-xs font-mono cursor-default transition-colors ${
                            isSelected
                              ? "bg-sky-500/[0.09] shadow-[inset_2px_0_0_#38bdf8]"
                              : isSuspended
                              ? "bg-cyan-500/[0.06] shadow-[inset_2px_0_0_#22d3ee]"
                              : tone === "system"
                              ? "bg-[#1a2433] text-[#93a4ba]"
                              : tone === "user"
                              ? "bg-[#151c27]"
                              : "hover:bg-white/[0.025]"
                          }`}
                        >
                          <div
                            className="min-w-0 flex items-center gap-2"
                            style={{ paddingLeft: depth > 0 ? depth * 20 : 0 }}
                          >
                            {hasChildren ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCollapsedPids((prev) =>
                                    prev.includes(proc.pid)
                                      ? prev.filter((id) => id !== proc.pid)
                                      : [...prev, proc.pid]
                                  );
                                }}
                                className="h-4 w-4 inline-flex items-center justify-center text-[#8793a5] hover:text-sky-300 cursor-pointer shrink-0"
                                title={collapsed ? "Развернуть ветку" : "Свернуть ветку"}
                              >
                                {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                              </button>
                            ) : (
                              <span className={depth > 0 ? "h-4 w-4 shrink-0" : "hidden"} />
                            )}
                            <div
                              className={`h-4 w-4 rounded flex items-center justify-center shrink-0 overflow-hidden ${
                                isSuspended ? "text-cyan-300" : "text-[#8793a5]"
                              }`}
                            >
                              {isSuspended ? (
                                <Pause size={11} />
                              ) : proc.icon_base64 ? (
                                <img
                                  src={`data:image/png;base64,${proc.icon_base64}`}
                                  alt=""
                                  draggable={false}
                                  className="h-4 w-4 object-contain"
                                />
                              ) : (
                                <AppWindow size={11} />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`truncate font-semibold ${
                                    isSuspended ? "text-cyan-200" : "text-[#e8edf4]"
                                  }`}
                                  title={proc.exe_path || proc.name}
                                >
                                  {proc.name}
                                </span>
                                {isSuspended && (
                                  <span className="text-[9px] px-1 py-px rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shrink-0">
                                    FROZEN
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-[#8793a5] tabular-nums">
                                PID {proc.pid}
                                {proc.parent_pid != null && ` • PPID ${proc.parent_pid}`}
                              </div>
                            </div>
                          </div>

                          <div className={`text-right rounded px-1 ${proc.cpu_usage > 2 ? "bg-sky-500/15" : ""}`}>
                            <div className={`font-bold tabular-nums ${proc.cpu_usage > 2 ? "text-sky-300" : proc.cpu_usage >= 0.1 ? cpuStyle.badgeTextClass : "text-zinc-600"}`}>
                              {proc.cpu_usage.toFixed(1)}
                            </div>
                            <div className="mt-1 h-0.5 w-full bg-white/[0.05] rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${cpuStyle.barClass}`}
                                style={{ width: `${Math.min(100, proc.cpu_usage)}%` }}
                              />
                            </div>
                          </div>

                          <div
                            className={`text-right tabular-nums ${
                              proc.memory_mb >= 1024
                                ? "text-amber-300 font-bold"
                                : proc.memory_mb >= 300
                                ? "text-cyan-300"
                                : "text-[#c5d0de]"
                            }`}
                          >
                            {proc.memory_mb.toFixed(1)}
                          </div>

                          <div className={`text-right tabular-nums text-[11px] ${hasDisk ? "text-[#c5d0de]" : "text-zinc-600"}`}>
                            <span className={proc.disk_read_bytes_sec > 0 ? "text-sky-400" : ""}>
                              {formatRate(proc.disk_read_bytes_sec)}
                            </span>
                            <span className="text-zinc-600"> / </span>
                            <span className={proc.disk_write_bytes_sec > 0 ? "text-cyan-400" : ""}>
                              {formatRate(proc.disk_write_bytes_sec)}
                            </span>
                          </div>

                          <div className="text-right tabular-nums text-[#8793a5]">
                            {formatUptime(proc.run_time_sec)}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </motion.div>

      {/* Кастомное контекстное меню процесса (ПКМ) */}
      <AnimatePresence>
        {processMenu && (
          <motion.div
            key={`menu-${processMenu.process.pid}-${processMenu.x}-${processMenu.y}`}
            initial={{ opacity: 0, scale: 0.94, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -2 }}
            transition={{ type: "spring", stiffness: 520, damping: 34 }}
            style={{ left: processMenu.x, top: processMenu.y, transformOrigin: "top left" }}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            className="fixed z-[100] w-62 rounded-xl backdrop-blur-2xl bg-[#111722]/97 border border-white/[0.12] shadow-[0_18px_44px_rgba(0,0,0,0.85)] p-1.5 font-mono text-xs"
          >
            <div className="px-2.5 py-2 mb-1 rounded-lg bg-[#151c27] border border-white/[0.06]">
              <div className="text-[#e8edf4] font-bold truncate">{processMenu.process.name}</div>
              <div className="text-[10px] text-[#8793a5] tabular-nums">
                PID {processMenu.process.pid} • {processMenu.process.memory_mb.toFixed(1)} MB
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleProcessOpenLocation(processMenu.process)}
              disabled={!processMenu.process.exe_path}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[#d5dde8] hover:bg-white/[0.06] disabled:text-zinc-600 disabled:hover:bg-transparent transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <FolderOpen size={14} className="text-sky-400 shrink-0" />
              <span>Открыть расположение файла</span>
            </button>

            <button
              type="button"
              onClick={() => handleProcessCopyPath(processMenu.process)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[#d5dde8] hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <Copy size={14} className="text-[#8793a5] shrink-0" />
              <span>Копировать путь</span>
            </button>

            <div className="my-1 h-px bg-white/[0.08]" />

            <button
              type="button"
              onClick={() => handleProcessSuspendToggle(processMenu.process)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-cyan-200 hover:bg-cyan-500/10 transition-colors cursor-pointer"
            >
              {menuProcessSuspended ? (
                <Play size={14} className="text-cyan-400 shrink-0" />
              ) : (
                <Pause size={14} className="text-cyan-400 shrink-0" />
              )}
              <span>{menuProcessSuspended ? "Возобновить процесс" : "Приостановить (Заморозить)"}</span>
            </button>

            <button
              type="button"
              onClick={() => handleProcessKill(processMenu.process, false)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer"
            >
              <XCircle size={14} className="text-rose-400 shrink-0" />
              <span className="font-semibold">Завершить процесс</span>
            </button>

            <button
              type="button"
              onClick={() => handleProcessKill(processMenu.process, true)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-rose-300/90 hover:bg-rose-500/15 transition-colors cursor-pointer"
            >
              <Trash2 size={14} className="text-rose-400 shrink-0" />
              <span>Завершить дерево процессов</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

</>
  );
}
