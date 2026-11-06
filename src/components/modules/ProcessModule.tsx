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
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import type { ProcessItem, ProcessSortKey } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

const CRITICAL_PROCESSES = new Set([
  "system",
  "smss",
  "csrss",
  "wininit",
  "services",
  "lsass",
  "svchost",
  "winlogon",
  "dwm",
  "explorer",
  "registry",
  "fontdrvhost",
  "sihost",
]);

function isCriticalProcess(name: string): boolean {
  return CRITICAL_PROCESSES.has(name.toLowerCase().replace(/\.exe$/i, ""));
}

function formatRam(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} ГБ`;
  if (mb >= 10) return `${mb.toFixed(0)} МБ`;
  return `${mb.toFixed(1)} МБ`;
}

function cpuTone(value: number): { text: string; bar: string } {
  if (value > 30) return { text: "text-rose-400", bar: "bg-rose-400" };
  if (value > 10) return { text: "text-amber-400", bar: "bg-amber-400" };
  return { text: "text-slate-200", bar: "bg-slate-400" };
}

export function ProcessModule({ c }: { c: NexusController }) {
  const {
    processes,
    processSearch,
    setProcessSearch,
    processAutoRefresh,
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
    handleProcessSort,
    processSortKey,
    processSortDesc,
    visibleProcesses,
    totalProcessCpu,
    menuProcessSuspended,
  } = c;
  const [pendingKill, setPendingKill] = useState<ProcessItem | null>(null);

  const requestKill = (proc: ProcessItem) => {
    if (isCriticalProcess(proc.name)) {
      setPendingKill(proc);
      return;
    }
    void handleProcessKill(proc, false);
  };

  const header = (key: ProcessSortKey, label: string, alignRight = false) => {
    const active = processSortKey === key;
    return (
      <button
        type="button"
        onClick={() => handleProcessSort(key)}
        className={`flex items-center gap-1 text-[11px] font-medium ${
          alignRight ? "justify-end" : "justify-start"
        } ${active ? "text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
      >
        <span>{label}</span>
        {active ? processSortDesc ? <ChevronDown size={12} /> : <ChevronUp size={12} /> : <span className="w-3" />}
      </button>
    );
  };

  const searching = processSearch.trim().length > 0;

  return (
    <>
      <motion.div
        key="processes"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="w-full max-w-6xl space-y-4"
      >
        <div className="flex flex-col justify-between gap-4 border-b border-[#222b38] pb-3.5 lg:flex-row lg:items-end">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-100">Диспетчер процессов</h2>
            <p className="mt-0.5 text-sm text-slate-400">Мониторинг системных ресурсов и запущенных задач</p>
          </div>
          <span className="inline-flex items-center rounded-lg border border-[#222b38] bg-[#111722] px-3 py-2 font-mono text-xs text-slate-300">
            Всего процессов: {processes.length} | Нагрузка ЦП: {totalProcessCpu.toFixed(1)}%
          </span>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={processSearch}
              onChange={(event) => setProcessSearch(event.target.value)}
              placeholder="Поиск по имени .exe или PID"
              className="w-full rounded-lg border border-[#222b38] bg-[#111722] py-2 pr-16 pl-9 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-slate-500"
            />
            <span className="absolute top-1/2 right-3 -translate-y-1/2 font-mono text-[10px] text-slate-500">
              {visibleProcesses.length}/{processes.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void fetchProcesses()}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#222b38] bg-[#111722] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-[#151c27]"
          >
            <RefreshCw size={13} className={processLoading ? "animate-spin" : ""} />
            Обновить список
          </button>
          <span
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-[11px] ${
              processAutoRefresh
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                : "border-[#222b38] bg-[#151c27] text-slate-400"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${processAutoRefresh ? "bg-emerald-400" : "bg-slate-500"}`} />
            {processAutoRefresh ? "Автообновление" : "Пауза"}
          </span>
        </div>

        <AnimatePresence>
          {processError && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="flex items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
            >
              <span>{processError}</span>
              <button type="button" onClick={() => setProcessError(null)} className="shrink-0">
                <X size={13} />
              </button>
            </motion.div>
          )}
          {processNotice && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="truncate rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-300"
            >
              {processNotice}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="overflow-hidden rounded-xl border border-[#222b38] bg-[#111722]">
          <div className="grid grid-cols-[minmax(0,1.6fr)_90px_150px_120px_120px] gap-3 border-b border-[#222b38] bg-[#151c27] px-4 py-2.5">
            {header("name", "Имя процесса")}
            {header("pid", "PID")}
            {header("cpu", "CPU %", true)}
            {header("memory", "Память (RAM)", true)}
            <span className="text-right text-[11px] font-medium text-slate-400">Действия</span>
          </div>

          <div
            onScroll={() => setProcessMenu(null)}
            className="max-h-[calc(100vh-340px)] min-h-[240px] divide-y divide-[#222b38] overflow-y-auto"
          >
            {processLoading && processes.length === 0 ? (
              <div className="flex items-center justify-center gap-2 p-10 text-xs text-slate-400">
                <Loader2 size={14} className="animate-spin text-sky-400" />
                Чтение списка процессов...
              </div>
            ) : visibleProcesses.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-10 text-sm text-slate-400">
                <Search size={18} />
                {searching ? "Процесс не найден" : "Список процессов пуст"}
              </div>
            ) : (
              visibleProcesses.map((proc) => {
                const isSelected = selectedPid === proc.pid;
                const isSuspended = suspendedPids.includes(proc.pid);
                const tone = cpuTone(proc.cpu_usage);
                return (
                  <div
                    key={proc.pid}
                    onClick={() => setSelectedPid(proc.pid)}
                    onContextMenu={(event) => handleProcessContextMenu(event, proc)}
                    className={`grid grid-cols-[minmax(0,1.6fr)_90px_150px_120px_120px] items-center gap-3 px-4 py-2.5 text-xs ${
                      isSelected ? "bg-sky-500/10" : isSuspended ? "bg-cyan-500/5" : "hover:bg-[#151c27]"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden text-slate-500">
                        {isSuspended ? (
                          <Pause size={11} className="text-cyan-300" />
                        ) : proc.icon_base64 ? (
                          <img
                            src={`data:image/png;base64,${proc.icon_base64}`}
                            alt=""
                            draggable={false}
                            className="h-4 w-4 object-contain"
                          />
                        ) : (
                          <AppWindow size={12} />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-slate-100" title={proc.exe_path || proc.name}>
                          {proc.name}
                        </div>
                        <div className="font-mono text-[10px] text-slate-500">PID {proc.pid}</div>
                      </div>
                    </div>
                    <div className="font-mono text-slate-300">{proc.pid}</div>
                    <div className="text-right">
                      <div className={`font-mono font-medium ${tone.text}`}>{proc.cpu_usage.toFixed(1)}%</div>
                      <div className="mt-1 ml-auto h-1 w-16 overflow-hidden rounded-full bg-[#151c27]">
                        <div
                          className={`h-full rounded-full ${tone.bar}`}
                          style={{ width: `${Math.min(100, proc.cpu_usage)}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-right font-mono text-slate-200">{formatRam(proc.memory_mb)}</div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          requestKill(proc);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-transparent px-2 py-1 text-[11px] text-slate-400 transition-colors hover:bg-rose-500/20 hover:text-rose-300"
                      >
                        <XCircle size={13} />
                        Завершить
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {processMenu && (
          <motion.div
            key={`menu-${processMenu.process.pid}-${processMenu.x}-${processMenu.y}`}
            initial={{ opacity: 0, scale: 0.94, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -2 }}
            transition={{ type: "spring", stiffness: 520, damping: 34 }}
            style={{ left: processMenu.x, top: processMenu.y, transformOrigin: "top left" }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
            className="fixed z-[100] w-64 rounded-xl border border-[#222b38] bg-[#111722] p-1.5 text-xs shadow-[0_18px_44px_rgba(0,0,0,0.85)]"
          >
            <div className="mb-1 rounded-lg border border-[#222b38] bg-[#151c27] px-2.5 py-2">
              <div className="truncate font-semibold text-slate-100">{processMenu.process.name}</div>
              <div className="font-mono text-[10px] text-slate-500">
                PID {processMenu.process.pid} · {formatRam(processMenu.process.memory_mb)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleProcessOpenLocation(processMenu.process)}
              disabled={!processMenu.process.exe_path}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-200 hover:bg-[#151c27] disabled:cursor-not-allowed disabled:text-slate-600"
            >
              <FolderOpen size={14} className="shrink-0 text-sky-400" />
              Открыть расположение файла
            </button>
            <button
              type="button"
              onClick={() => void handleProcessCopyPath(processMenu.process)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-200 hover:bg-[#151c27]"
            >
              <Copy size={14} className="shrink-0 text-slate-400" />
              Копировать путь
            </button>
            <div className="my-1 h-px bg-[#222b38]" />
            <button
              type="button"
              onClick={() => void handleProcessSuspendToggle(processMenu.process)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-cyan-200 hover:bg-cyan-500/10"
            >
              {menuProcessSuspended ? <Play size={14} className="shrink-0 text-cyan-400" /> : <Pause size={14} className="shrink-0 text-cyan-400" />}
              {menuProcessSuspended ? "Возобновить процесс" : "Приостановить"}
            </button>
            <button
              type="button"
              onClick={() => {
                const proc = processMenu.process;
                setProcessMenu(null);
                requestKill(proc);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-rose-300 hover:bg-rose-500/15"
            >
              <XCircle size={14} className="shrink-0 text-rose-400" />
              Завершить процесс
            </button>
            <button
              type="button"
              onClick={() => void handleProcessKill(processMenu.process, true)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-rose-300 hover:bg-rose-500/15"
            >
              <Trash2 size={14} className="shrink-0 text-rose-400" />
              Завершить дерево процессов
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {pendingKill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-md rounded-xl border border-[#222b38] bg-[#111722] p-4 shadow-2xl">
            <h3 className="text-base font-semibold text-slate-100">Системный процесс</h3>
            <p className="mt-2 text-sm text-slate-300">
              {pendingKill.name} (PID <span className="font-mono">{pendingKill.pid}</span>) — критический системный процесс.
              Завершение может нарушить работу Windows. Продолжить?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingKill(null)}
                className="rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 text-xs font-medium text-slate-300 hover:bg-[#1a2332]"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  const proc = pendingKill;
                  setPendingKill(null);
                  void handleProcessKill(proc, false);
                }}
                className="rounded-lg border border-rose-500/30 bg-rose-500/20 px-3 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/30"
              >
                Завершить
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
