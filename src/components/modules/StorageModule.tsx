import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  Play,
} from "lucide-react";
import { TREEMAP_PALETTE, formatBytes } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

function driveLabel(drive: string): string {
  const letter = drive.replace(/[\\/]/g, "").toUpperCase();
  if (letter.startsWith("C")) return "Локальный диск C:";
  return `Диск ${letter.endsWith(":") ? letter : `${letter}:`}`;
}

function joinWin(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts[0].endsWith(":")) return `${parts[0]}\\${parts.slice(1).join("\\")}`;
  return parts.join("\\");
}

function groupPrefix(kind: "game" | "program" | "folder"): string {
  if (kind === "game") return "Игра";
  if (kind === "program") return "Программа";
  return "Папка";
}

function heavyGroup(path: string): { kind: "game" | "program" | "folder"; title: string; folder: string } {
  const parts = path.replace(/\//g, "\\").split("\\").filter(Boolean);
  const lower = parts.map((part) => part.toLowerCase());
  let bestRank = 0;
  let bestAt = -1;
  let bestKind: "game" | "program" = "game";
  const note = (rank: number, at: number, kind: "game" | "program") => {
    if (at <= 0 || at >= parts.length - 1 || !parts[at] || rank <= bestRank) return;
    bestRank = rank;
    bestAt = at;
    bestKind = kind;
  };
  for (let index = 0; index < lower.length; index += 1) {
    if (lower[index] === "steamapps" && lower[index + 1] === "common") note(100, index + 2, "game");
    if (lower[index] === "gog galaxy" && lower[index + 1] === "games") note(90, index + 2, "game");
    if (lower[index] === "gog games" || lower[index] === "epic games") note(85, index + 1, "game");
    if (lower[index] === "riot games") note(80, index + 1, "game");
    if (lower[index] === "games") note(70, index + 1, "game");
    if (lower[index] === "program files (x86)" || lower[index] === "program files") note(40, index + 1, "program");
  }
  if (bestAt > 0) {
    return { kind: bestKind, title: parts[bestAt], folder: joinWin(parts.slice(0, bestAt + 1)) };
  }
  const root = parts[0]?.endsWith(":") ? 1 : 0;
  const title = parts[root] && root < parts.length - 1 ? parts[root] : parts[parts.length - 2] || parts[0] || "";
  const nameAt = parts[root] && root < parts.length - 1 ? root : Math.max(0, parts.length - 2);
  return { kind: "folder", title, folder: joinWin(parts.slice(0, nameAt + 1)) };
}

export function StorageModule({ c }: { c: NexusController }) {
  const {
    metrics,
    diskUsedPercentage,
    availableDrives,
    selectedDriveOrPath,
    setSelectedDriveOrPath,
    isScanning,
    scanElapsedSec,
    scanResult,
    scanError,
    treemapStack,
    selectedTreemapNode,
    setSelectedTreemapNode,
    handleStartStorageScan,
    handleOpenPathInExplorer,
    treemapRects,
    filteredTopFiles,
    setScanResult,
    setTreemapStack,
  } = c;

  const [heavyMode, setHeavyMode] = useState<"groups" | "files">("groups");
  const heavyGroups = useMemo(() => {
    const buckets = new Map<string, { kind: "game" | "program" | "folder"; title: string; folder: string; size: number }>();
    for (const file of filteredTopFiles) {
      const group = heavyGroup(file.path);
      const key = group.folder.toLowerCase();
      const current = buckets.get(key);
      if (current) current.size += file.size_bytes;
      else buckets.set(key, { ...group, size: file.size_bytes });
    }
    return [...buckets.values()].sort((a, b) => b.size - a.size);
  }, [filteredTopFiles]);
  const selectedLetter = selectedDriveOrPath.trim().slice(0, 2).toUpperCase();
  const showsSystemVolume = selectedLetter.startsWith("C") || selectedDriveOrPath.trim() === "";
  const freeGb = showsSystemVolume ? metrics.disk_free_gb : null;
  const totalGb = showsSystemVolume ? metrics.disk_total_gb : null;
  const usedPct = showsSystemVolume ? diskUsedPercentage : 0;

  return (
    <motion.div
      key="storage"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="w-full max-w-6xl space-y-4"
    >
      <div className="rounded-xl border border-[#222b38] bg-[#111722] p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2">
              {availableDrives.map((drive) => {
                const selected = selectedDriveOrPath.toUpperCase() === drive.toUpperCase();
                return (
                  <button
                    key={drive}
                    type="button"
                    onClick={() => {
                      if (selected) return;
                      setSelectedDriveOrPath(drive);
                      setScanResult(null);
                      setTreemapStack([]);
                    }}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                      selected
                        ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                        : "border-[#222b38] bg-[#151c27] text-slate-300 hover:bg-[#1a2332]"
                    }`}
                  >
                    {driveLabel(drive)}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 font-mono text-2xl font-bold text-slate-100">
              {freeGb !== null && totalGb !== null
                ? `${freeGb.toFixed(0)} ГБ свободно`
                : selectedLetter || "Диск"}
            </div>
            <p className="mt-1 text-sm text-slate-400">
              {freeGb !== null && totalGb !== null
                ? `из ${totalGb.toFixed(0)} ГБ на системном томе`
                : "Свободное место этого тома появится в метриках только для системного диска"}
            </p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#151c27]">
              <div className="flex h-full">
                <div className="h-full bg-sky-500" style={{ width: `${Math.min(100, usedPct)}%` }} />
                <div className="h-full bg-emerald-500/35" style={{ width: `${Math.max(0, 100 - usedPct)}%` }} />
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={isScanning}
              onClick={() => void handleStartStorageScan()}
              className="inline-flex items-center gap-2 rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-[#1a2332] disabled:opacity-70"
            >
              {isScanning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {isScanning ? `Сканирование ${scanElapsedSec.toFixed(0)} с` : "Сканировать диск"}
            </button>
            <button
              type="button"
              disabled
              title="Текущая команда сканирования завершается сама и не принимает отмену"
              className="rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 text-xs font-medium text-slate-500"
            >
              Отмена
            </button>
          </div>
        </div>
        {scanError && (
          <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {scanError}
          </div>
        )}
      </div>

      {!scanResult && !isScanning && (
        <div className="flex flex-col items-center rounded-xl border border-[#222b38] bg-[#111722] px-6 py-16 text-center">
          <HardDrive size={36} className="mb-3 text-slate-400" />
          <h3 className="text-lg font-semibold text-slate-100">Диск готов к анализу</h3>
          <p className="mt-2 max-w-lg text-sm text-slate-400">
            Многопоточное сканирование выявит скрытые гигабайты кэша, загрузок и старых файлов.
          </p>
          <button
            type="button"
            onClick={() => void handleStartStorageScan()}
            className="mt-5 inline-flex items-center gap-2 rounded-lg border border-[#222b38] bg-[#151c27] px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-[#1a2332]"
          >
            <Play size={15} />
            Сканировать диск
          </button>
        </div>
      )}

      {isScanning && !scanResult && (
        <div className="flex items-center justify-center gap-3 rounded-xl border border-[#222b38] bg-[#111722] px-6 py-16 text-sm text-slate-300">
          <Loader2 size={18} className="animate-spin" />
          Идёт обход {selectedDriveOrPath}
        </div>
      )}

      {scanResult && (
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-8 rounded-xl border border-[#222b38] bg-[#111722] p-4">
            <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-slate-400">
              {treemapStack.map((node, idx) => (
                <span key={node.path + idx} className="flex items-center gap-1">
                  {idx > 0 && <ChevronRight size={12} />}
                  <button
                    type="button"
                    onClick={() => {
                      const nextStack = treemapStack.slice(0, idx + 1);
                      setTreemapStack(nextStack);
                      setSelectedTreemapNode(node);
                    }}
                    className={idx === treemapStack.length - 1 ? "text-slate-100" : "hover:text-slate-200"}
                  >
                    {node.name || node.path}
                  </button>
                </span>
              ))}
            </div>
            <div className="relative h-80 overflow-hidden rounded-xl border border-[#222b38] bg-[#0e1118] p-1.5">
              {treemapRects.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">
                  В этой папке нет вложенных каталогов
                </div>
              ) : (
                treemapRects.map((rect) => {
                  const selected = selectedTreemapNode?.path === rect.node.path;
                  const palette = TREEMAP_PALETTE[rect.colorIndex] ?? TREEMAP_PALETTE[0];
                  return (
                    <div
                      key={rect.node.path}
                      style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%`, height: `${rect.h}%` }}
                      className="absolute p-0.5"
                    >
                      <button
                        type="button"
                        title={`${rect.node.name} — ${formatBytes(rect.node.size_bytes)}`}
                        onClick={() => setSelectedTreemapNode(rect.node)}
                        onDoubleClick={() => {
                          if (rect.node.children.length > 0) {
                            setTreemapStack((prev) => [...prev, rect.node]);
                            setSelectedTreemapNode(rect.node.children[0] ?? rect.node);
                          }
                        }}
                        className={`flex h-full w-full flex-col justify-between overflow-hidden rounded-lg border p-2 text-left ${palette} ${
                          selected ? "ring-1 ring-slate-200" : ""
                        }`}
                      >
                        <span className="flex items-center justify-between gap-1 text-xs font-medium">
                          <span className="truncate">{rect.node.name}</span>
                          {rect.node.children.length > 0 && rect.w > 12 && <Folder size={12} />}
                        </span>
                        {rect.w > 12 && rect.h > 18 && (
                          <span className="truncate font-mono text-[11px]">{formatBytes(rect.node.size_bytes)}</span>
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="col-span-4 flex max-h-[420px] flex-col rounded-xl border border-[#222b38] bg-[#111722] p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-100">Тяжёлые файлы</h3>
            </div>
            <div className="mb-3 mt-2 flex gap-1">
              {(
                [
                  ["groups", "Тяжёлые папки и игры"],
                  ["files", "Одиночные файлы"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setHeavyMode(id)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    heavyMode === id
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                      : "border-[#222b38] bg-[#151c27] text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {filteredTopFiles.length === 0 ? (
                <p className="text-sm text-slate-400">Крупные файлы не найдены</p>
              ) : heavyMode === "groups" ? (
                heavyGroups.map((group) => (
                  <div key={group.folder} className="rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-slate-100">
                          [{groupPrefix(group.kind)}] {group.title}
                        </div>
                        <div className="mt-1 truncate font-mono text-[11px] text-slate-500" title={group.folder}>
                          {group.folder}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-xs text-cyan-400">{formatBytes(group.size)}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleOpenPathInExplorer(group.folder)}
                      className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-slate-100"
                    >
                      <FolderOpen size={12} />
                      Открыть
                    </button>
                  </div>
                ))
              ) : (
                filteredTopFiles.map((file, idx) => {
                  const group = heavyGroup(file.path);
                  return (
                  <div key={file.path + idx} className="rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <FileText size={14} className="shrink-0 text-slate-400" />
                            <span className="truncate text-sm text-slate-100">
                              [{groupPrefix(group.kind)}] {group.title}
                            </span>
                          </div>
                        </div>
                        <div className="mt-1 truncate font-mono text-[11px] text-slate-500" title={file.path}>
                          {file.path}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-xs text-cyan-400">{formatBytes(file.size_bytes)}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleOpenPathInExplorer(file.path)}
                      className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-slate-100"
                    >
                      <FolderOpen size={12} />
                      Открыть расположение
                    </button>
                  </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
