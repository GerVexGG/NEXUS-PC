import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Square,
} from "lucide-react";
import {
  PageHeader,
  SegmentedHudBar,
  TREEMAP_PALETTE,
  formatBytes,
  getCategoryStyle,
  type FolderNode,
} from "../../lib/studio";
import { useStorageScanElapsed } from "../../hooks/useStorageScanner";
import type { NexusController } from "../../hooks/useNexusController";

interface DiskHealthInfo {
  model: string;
  kind: string;
  firmware?: string;
  health_percent: number | null;
  health_label: string;
  available_spare?: number | null;
  power_on_hours: number | null;
  power_cycles?: number | null;
  temp_c: number | null;
  tbw_tb: number | null;
  read_tb?: number | null;
}

function driveLabel(drive: string): string {
  const letter = drive.replace(/[\\/]/g, "").toUpperCase();
  if (letter.startsWith("C")) return "Системный том C:";
  return `Том ${letter.endsWith(":") ? letter : `${letter}:`}`;
}

function joinWin(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts[0].endsWith(":")) return `${parts[0]}\\${parts.slice(1).join("\\")}`;
  return parts.join("\\");
}

function groupPrefix(kind: "game" | "program" | "folder"): string {
  if (kind === "game") return "Игра";
  if (kind === "program") return "Программа";
  return "Каталог";
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

function StorageScanButton({
  isScanning,
  onStartScan,
  onCancelScan,
}: {
  isScanning: boolean;
  onStartScan: () => void;
  onCancelScan: () => void;
}) {
  const scanElapsedSec = useStorageScanElapsed(isScanning);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={isScanning}
        onClick={onStartScan}
        className="cyber-btn inline-flex cursor-pointer items-center gap-2.5 px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-[#00D5E8] disabled:opacity-70"
      >
        {isScanning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {isScanning ? `Сканирование · ${scanElapsedSec.toFixed(0)} сек` : "Сканировать том"}
      </button>
      {isScanning && (
        <button
          type="button"
          onClick={onCancelScan}
          className="cyber-btn-danger inline-flex cursor-pointer items-center gap-1.5 px-3 py-2.5 text-xs font-medium text-rose-300"
        >
          <Square size={12} className="fill-current" />
          Остановить
        </button>
      )}
    </div>
  );
}

export function StorageModule({ c }: { c: NexusController }) {
  const {
    metrics,
    diskUsedPercentage,
    availableDrives,
    selectedDriveOrPath,
    setSelectedDriveOrPath,
    isScanning,
    scanResult,
    scanError,
    treemapStack,
    selectedTreemapNode,
    setSelectedTreemapNode,
    handleStartStorageScan,
    handleCancelStorageScan,
    handleOpenPathInExplorer,
    treemapRects,
    filteredTopFiles,
    fileSearch,
    setFileSearch,
    setScanResult,
    setTreemapStack,
  } = c;

  const [heavyMode, setHeavyMode] = useState<"groups" | "files">("groups");
  const [diskHealth, setDiskHealth] = useState<DiskHealthInfo[]>([]);
  const [diskHealthLoading, setDiskHealthLoading] = useState(false);
  const [diskHealthError, setDiskHealthError] = useState("");

  const activeFolderNode = treemapStack[treemapStack.length - 1] ?? scanResult?.root_node ?? null;

  const heavyGroups = useMemo(() => {
    const query = fileSearch.trim().toLowerCase();
    const nodes: FolderNode[] = activeFolderNode?.children ?? [];
    return nodes
      .map((node) => {
        const group = heavyGroup(`${node.path}\\item`);
        return {
          node,
          kind: group.kind,
          title: node.name || group.title,
          folder: node.path || group.folder,
          size: node.size_bytes,
        };
      })
      .filter(
        (group) =>
          !query ||
          group.title.toLowerCase().includes(query) ||
          group.folder.toLowerCase().includes(query)
      )
      .sort((a, b) => b.size - a.size);
  }, [activeFolderNode, fileSearch]);

  const loadDiskHealth = useCallback(async () => {
    setDiskHealthLoading(true);
    try {
      const rows = await invoke<DiskHealthInfo[]>("get_disk_health_info");
      setDiskHealth(rows);
      setDiskHealthError("");
    } catch (err) {
      setDiskHealthError(String(err));
    } finally {
      setDiskHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDiskHealth();
  }, [loadDiskHealth]);

  const selectedLetter = selectedDriveOrPath.trim().slice(0, 2).toUpperCase();
  const matchedVolume = availableDrives.find(
    (d) => d.mount_point.trim().slice(0, 2).toUpperCase() === selectedLetter
  );
  const showsSystemVolume = selectedLetter.startsWith("C") || selectedDriveOrPath.trim() === "";
  const freeGb =
    matchedVolume && matchedVolume.total_bytes > 0
      ? matchedVolume.available_bytes / 1024 / 1024 / 1024
      : showsSystemVolume
      ? metrics.disk_free_gb
      : null;
  const totalGb =
    matchedVolume && matchedVolume.total_bytes > 0
      ? matchedVolume.total_bytes / 1024 / 1024 / 1024
      : showsSystemVolume
      ? metrics.disk_total_gb
      : null;
  const usedPct =
    freeGb !== null && totalGb !== null && totalGb > 0
      ? Math.min(100, Math.max(0, ((totalGb - freeGb) / totalGb) * 100))
      : showsSystemVolume
      ? diskUsedPercentage
      : 0;

  return (
    <motion.div
      key="storage"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="w-full space-y-4"
    >
      <PageHeader
        title="Анализатор накопителей"
        description="Карта распределения пространства Treemap, инспекция крупных каталогов и S.M.A.R.T.-диагностика"
        actions={
          <StorageScanButton
            isScanning={isScanning}
            onStartScan={() => void handleStartStorageScan()}
            onCancelScan={() => void handleCancelStorageScan()}
          />
        }
      />

      {/* Панель выбора тома и ёмкости */}
      <div className="tactical-card tactical-brackets rounded-xl p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {availableDrives.map((drive) => {
              const mount = drive.mount_point;
              const selected = selectedDriveOrPath.toUpperCase() === mount.toUpperCase();
              return (
                <button
                  key={mount}
                  type="button"
                  onClick={() => {
                    if (selected) return;
                    setSelectedDriveOrPath(mount);
                    setScanResult(null);
                    setTreemapStack([]);
                  }}
                  className={`cursor-pointer rounded-lg border px-3.5 py-2 text-xs font-medium transition-colors ${
                    selected
                      ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                      : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
                  }`}
                >
                  {driveLabel(mount)}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-baseline gap-4 lg:text-right">
            <div>
              <span className="text-xs text-[#8292A3]">Свободно: </span>
              <span className="font-mono text-lg font-bold text-[#E5EDF5]">
                {freeGb !== null ? `${freeGb.toFixed(1)} ГБ` : "—"}
              </span>
            </div>
            <div>
              <span className="text-xs text-[#8292A3]">Ёмкость: </span>
              <span className="font-mono text-sm font-semibold text-[#8292A3]">
                {totalGb !== null ? `${totalGb.toFixed(0)} ГБ (${usedPct.toFixed(0)}% занято)` : "—"}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-3">
          <SegmentedHudBar percentage={usedPct} theme="cyan" />
        </div>

        {scanError && (
          <div className="mt-3 rounded-lg border border-rose-500/35 bg-rose-500/12 px-3 py-2 text-xs text-rose-300">
            {scanError}
          </div>
        )}
      </div>

      {/* Центральная зона: Карта Treemap и Инспектор тяжёлых объектов */}
      {!scanResult && !isScanning && (
        <div className="tactical-card tactical-brackets rounded-xl p-6">
          <div className="flex flex-col items-center justify-between gap-6 lg:flex-row">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]">
                <Layers size={22} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-[#E5EDF5]">
                    Карта пространства Treemap · {selectedDriveOrPath || "C:\\"}
                  </h3>
                  <span className="rounded border border-[#202B38] bg-[#151C26] px-2 py-0.5 font-mono text-[10px] text-[#8292A3]">
                    ГОТОВ К ОБХОДУ
                  </span>
                </div>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[#8292A3]">
                  Запустите сканирование в верхней панели для построения иерархической карты каталогов Treemap, поиска ресурсоёмких игр, кэша и крупнейших файлов на выбранном томе.
                </p>
              </div>
            </div>

            <div className="grid w-full grid-cols-3 gap-2.5 lg:w-auto lg:min-w-[360px]">
              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] p-3">
                <div className="font-mono text-[10px] text-[#00D5E8]">01 // TREEMAP</div>
                <div className="mt-1 text-xs font-medium text-[#E5EDF5]">Карта блоков</div>
                <div className="mt-0.5 text-[11px] text-[#8292A3]">Навигация по папкам</div>
              </div>
              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] p-3">
                <div className="font-mono text-[10px] text-[#00D5E8]">02 // КАТАЛОГИ</div>
                <div className="mt-1 text-xs font-medium text-[#E5EDF5]">Игры и программы</div>
                <div className="mt-0.5 text-[11px] text-[#8292A3]">Группировка объёма</div>
              </div>
              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] p-3">
                <div className="font-mono text-[10px] text-[#00D5E8]">03 // ФАЙЛЫ</div>
                <div className="mt-1 text-xs font-medium text-[#E5EDF5]">Топ объектов</div>
                <div className="mt-0.5 text-[11px] text-[#8292A3]">Поиск гигабайтов</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isScanning && !scanResult && (
        <div className="tactical-card flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-14 text-center">
          <Loader2 size={24} className="animate-spin text-[#00D5E8]" />
          <div className="text-sm font-semibold text-[#E5EDF5]">
            Многопоточный обход файловой системы {selectedDriveOrPath}…
          </div>
          <p className="max-w-md text-xs text-[#8292A3]">
            Формируется дерево каталогов и индекс наиболее крупных файлов. Вы можете остановить операцию в любой момент.
          </p>
        </div>
      )}

      {scanResult && (
        <div className="space-y-4">
          {/* Распределение типов файлов (category_sizes) */}
          {scanResult.category_sizes.length > 0 && scanResult.total_scanned_bytes > 0 && (
            <section className="tactical-card rounded-xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-[#8292A3]">
                  Распределение по категориям файлов
                </span>
                <span className="font-mono text-xs text-[#8292A3]">
                  Проиндексировано:{" "}
                  <span className="font-semibold text-[#00D5E8]">
                    {formatBytes(scanResult.total_scanned_bytes)}
                  </span>
                </span>
              </div>
              <div className="mt-2.5 flex h-2.5 w-full overflow-hidden rounded-full bg-[#0B0E14] p-0.5">
                {scanResult.category_sizes.map(([category, sizeBytes]) => {
                  const pct = (sizeBytes / scanResult.total_scanned_bytes) * 100;
                  if (pct < 0.4) return null;
                  const style = getCategoryStyle(category);
                  return (
                    <div
                      key={category}
                      title={`${category}: ${formatBytes(sizeBytes)} (${pct.toFixed(1)}%)`}
                      className={`h-full first:rounded-l-full last:rounded-r-full ${style.barClass}`}
                      style={{ width: `${pct}%` }}
                    />
                  );
                })}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
                {scanResult.category_sizes.map(([category, sizeBytes]) => {
                  const style = getCategoryStyle(category);
                  const pct =
                    scanResult.total_scanned_bytes > 0
                      ? (sizeBytes / scanResult.total_scanned_bytes) * 100
                      : 0;
                  return (
                    <div key={category} className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${style.dotClass}`} />
                      <span className="text-[#8292A3]">{category}:</span>
                      <span className={`font-mono font-semibold ${style.textClass}`}>
                        {formatBytes(sizeBytes)}
                      </span>
                      <span className="font-mono text-[10px] text-[#526170]">
                        ({pct < 1 && sizeBytes > 0 ? "<1" : pct.toFixed(0)}%)
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          {/* Главный визуальный блок Treemap */}
          <div className="tactical-card tactical-brackets flex min-w-0 flex-col justify-between rounded-xl p-4 xl:col-span-8">
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1 text-xs text-[#8292A3]">
                  {treemapStack.map((node, idx) => (
                    <span key={node.path + idx} className="flex items-center gap-1">
                      {idx > 0 && <ChevronRight size={12} className="text-[#526170]" />}
                      <button
                        type="button"
                        onClick={() => {
                          const nextStack = treemapStack.slice(0, idx + 1);
                          setTreemapStack(nextStack);
                          setSelectedTreemapNode(node);
                        }}
                        className={`cursor-pointer rounded px-1.5 py-0.5 font-mono text-xs transition-colors ${
                          idx === treemapStack.length - 1
                            ? "bg-[#00D5E8]/12 font-semibold text-[#00D5E8]"
                            : "text-[#8292A3] hover:text-[#E5EDF5]"
                        }`}
                      >
                        {node.name || node.path}
                      </button>
                    </span>
                  ))}
                </div>
                <span className="font-mono text-xs text-[#8292A3]">
                  Просканировано:{" "}
                  <span className="font-semibold text-[#00D5E8]">
                    {formatBytes(scanResult.total_scanned_bytes)}
                  </span>{" "}
                  · {scanResult.total_files_count.toLocaleString("ru-RU")} файлов
                </span>
              </div>

              <div className="relative h-[320px] overflow-hidden rounded-xl border border-[#202B38] bg-[#0B0E14] p-1.5 xl:h-[400px] 2xl:h-[480px]">
                {treemapRects.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-[#8292A3]">
                    В выбранном каталоге нет вложенных подпапок
                  </div>
                ) : (
                  treemapRects.map((rect) => {
                    const selected = selectedTreemapNode?.path === rect.node.path;
                    const palette = TREEMAP_PALETTE[rect.colorIndex] ?? TREEMAP_PALETTE[0];
                    return (
                      <div
                        key={rect.node.path}
                        style={{
                          left: `${rect.x}%`,
                          top: `${rect.y}%`,
                          width: `${rect.w}%`,
                          height: `${rect.h}%`,
                        }}
                        className="absolute p-0.5"
                      >
                        <button
                          type="button"
                          title={`${rect.node.name} — ${formatBytes(rect.node.size_bytes)} (двойной клик — войти внутрь)`}
                          onClick={() => setSelectedTreemapNode(rect.node)}
                          onDoubleClick={() => {
                            if (rect.node.children.length > 0) {
                              setTreemapStack((prev) => [...prev, rect.node]);
                              setSelectedTreemapNode(rect.node.children[0] ?? rect.node);
                            }
                          }}
                          className={`flex h-full w-full cursor-pointer flex-col justify-between overflow-hidden rounded-lg border bg-gradient-to-br p-2 text-left transition-all ${palette} ${
                            selected ? "ring-1 ring-[#00D5E8]" : ""
                          }`}
                        >
                          <span className="flex items-center justify-between gap-1 text-xs font-medium">
                            <span className="truncate">{rect.node.name}</span>
                            {rect.node.children.length > 0 && rect.w > 12 && (
                              <Folder size={12} className="shrink-0 opacity-75" />
                            )}
                          </span>
                          {rect.w > 12 && rect.h > 18 && (
                            <span className="truncate font-mono text-[11px] font-semibold">
                              {formatBytes(rect.node.size_bytes)}
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {selectedTreemapNode && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2 text-xs">
                <div className="min-w-0 flex-1 truncate font-mono text-[#8292A3]" title={selectedTreemapNode.path}>
                  <span className="font-semibold text-[#E5EDF5]">{selectedTreemapNode.name}</span> ·{" "}
                  <span className="text-[#00D5E8]">{formatBytes(selectedTreemapNode.size_bytes)}</span> ·{" "}
                  <span>{selectedTreemapNode.path}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleOpenPathInExplorer(selectedTreemapNode.path)}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded border border-[#202B38] bg-[#151C26] px-2.5 py-1 text-xs font-medium text-[#E5EDF5] hover:border-[#00D5E8]/40"
                >
                  <FolderOpen size={12} className="text-[#00D5E8]" />
                  Проводник
                </button>
              </div>
            )}
          </div>

          {/* Правая панель: Тяжёлые папки и Топ файлов */}
          <div className="tactical-card tactical-brackets flex h-[412px] min-h-0 min-w-0 flex-col rounded-xl p-4 xl:col-span-4 xl:h-[492px] 2xl:h-[572px]">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-[#E5EDF5]">Инспектор объёма</h3>
              <div className="flex gap-1">
                {(
                  [
                    ["groups", "Каталоги"],
                    ["files", "Топ файлов"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setHeavyMode(id)}
                    className={`cursor-pointer rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      heavyMode === id
                        ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                        : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="relative mt-2.5">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#526170]"
              />
              <input
                type="text"
                value={fileSearch}
                onChange={(event) => setFileSearch(event.target.value)}
                placeholder="Фильтр по названию или пути…"
                className="w-full rounded-lg border border-[#202B38] bg-[#0B0E14] py-1.5 pl-8 pr-2.5 text-xs text-[#E5EDF5] outline-none placeholder:text-[#526170] focus:border-[#00D5E8]/50"
              />
            </div>

            <div className="mt-2.5 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {heavyMode === "groups" ? (
                heavyGroups.length === 0 ? (
                  <p className="py-6 text-center text-xs text-[#8292A3]">Крупные каталоги не найдены</p>
                ) : (
                  heavyGroups.map((group) => (
                    <div
                      key={group.folder}
                      className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2 transition-colors hover:border-[#00D5E8]/30"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-[#E5EDF5]">
                            <span className="text-[#8292A3]">[{groupPrefix(group.kind)}]</span> {group.title}
                          </div>
                          <div
                            className="mt-0.5 truncate font-mono text-[11px] text-[#526170]"
                            title={group.folder}
                          >
                            {group.folder}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-xs font-semibold text-[#00D5E8]">
                          {formatBytes(group.size)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => void handleOpenPathInExplorer(group.folder)}
                          className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-[#8292A3] hover:text-[#00D5E8]"
                        >
                          <FolderOpen size={11} />
                          Открыть в проводнике
                        </button>
                        {group.node.children.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              setTreemapStack((prev) => [...prev, group.node]);
                              setSelectedTreemapNode(group.node.children[0] ?? group.node);
                            }}
                            className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-[#00D5E8] hover:underline"
                          >
                            <Layers size={11} />
                            Открыть в Treemap
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )
              ) : filteredTopFiles.length === 0 ? (
                <p className="py-6 text-center text-xs text-[#8292A3]">Крупные файлы не найдены</p>
              ) : (
                filteredTopFiles.map((file, idx) => {
                  const group = heavyGroup(file.path);
                  return (
                    <div
                      key={file.path + idx}
                      className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2 transition-colors hover:border-[#00D5E8]/30"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <FileText size={13} className="shrink-0 text-[#8292A3]" />
                            <span className="truncate text-xs font-medium text-[#E5EDF5]">
                              {file.name || group.title}
                            </span>
                          </div>
                          <div
                            className="mt-0.5 truncate font-mono text-[11px] text-[#526170]"
                            title={file.path}
                          >
                            {file.path}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-xs font-semibold text-[#00D5E8]">
                          {formatBytes(file.size_bytes)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleOpenPathInExplorer(file.path)}
                        className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-[#8292A3] hover:text-[#00D5E8]"
                      >
                        <FolderOpen size={11} />
                        Показать файл
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          </div>
        </div>
      )}

      {/* Физическое состояние накопителей (S.M.A.R.T.) */}
      <section className="tactical-card tactical-brackets rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <HardDrive size={15} className="text-[#00D5E8]" />
            <h3 className="text-sm font-semibold text-[#E5EDF5]">
              Физическое состояние накопителей (S.M.A.R.T.)
            </h3>
            <span className="rounded border border-[#202B38] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] text-[#8292A3]">
              Обнаружено: {diskHealth.length}
            </span>
          </div>
          <button
            type="button"
            disabled={diskHealthLoading}
            onClick={() => void loadDiskHealth()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-1 text-xs font-medium text-[#8292A3] transition-colors hover:border-[#00D5E8]/40 hover:text-[#00D5E8] disabled:opacity-50"
          >
            <RefreshCw size={12} className={diskHealthLoading ? "animate-spin" : ""} />
            Обновить SMART
          </button>
        </div>

        {diskHealthError && <p className="mt-2 text-xs text-rose-300">{diskHealthError}</p>}
        {diskHealth.length === 0 && !diskHealthError ? (
          <p className="mt-3 text-sm text-[#8292A3]">Чтение параметров S.M.A.R.T. контроллера…</p>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {diskHealth.map((disk) => {
              const hasSmart = disk.health_percent !== null && disk.health_percent !== undefined;
              const percent = hasSmart ? disk.health_percent! : 0;
              const tone = !hasSmart
                ? "bg-[#202B38]"
                : percent >= 80
                ? "bg-gradient-to-r from-[#00D5E8] to-[#36AFC0]"
                : percent >= 50
                ? "bg-amber-400"
                : "bg-rose-400";
              return (
                <div
                  key={disk.model + disk.kind}
                  className="rounded-lg border border-[#202B38] bg-[#0B0E14] p-3.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#E5EDF5]">{disk.model}</div>
                      {disk.firmware && (
                        <div className="font-mono text-[10px] text-[#526170]">
                          Прошивка: {disk.firmware}
                          {disk.available_spare != null ? ` · Резерв: ${disk.available_spare}%` : ""}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 rounded border border-[#00D5E8]/30 bg-[#00D5E8]/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-[#00D5E8]">
                      {disk.kind}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[#8292A3]">
                    <span>
                      Ресурс:{" "}
                      <span className="font-mono font-semibold text-[#E5EDF5]">
                        {hasSmart ? `${percent}%` : "Недоступно"}
                      </span>
                      {hasSmart ? ` (${disk.health_label})` : ""}
                    </span>
                    {!hasSmart && (
                      <span className="rounded border border-[#202B38] bg-[#151C26] px-1.5 py-0.5 font-mono text-[10px] text-[#526170]">
                        SMART закрыт контроллером
                      </span>
                    )}
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#151C26]">
                    {hasSmart && <div className={`h-full ${tone}`} style={{ width: `${percent}%` }} />}
                  </div>
                  <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px] text-[#8292A3] sm:grid-cols-3">
                    <div>
                      <span className="text-[#526170]">Наработка: </span>
                      <span className="text-[#E5EDF5]">
                        {disk.power_on_hours == null ? "Н/Д" : `${disk.power_on_hours.toLocaleString("ru-RU")} ч`}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#526170]">Темп.: </span>
                      <span className="text-[#E5EDF5]">
                        {disk.temp_c == null ? "Н/Д" : `${disk.temp_c} °C`}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#526170]">Запись: </span>
                      <span className="text-[#E5EDF5]">
                        {disk.tbw_tb == null ? "Н/Д" : `${disk.tbw_tb.toFixed(2)} ТБ`}
                      </span>
                    </div>
                    {disk.read_tb != null && (
                      <div>
                        <span className="text-[#526170]">Чтение: </span>
                        <span className="text-[#E5EDF5]">{disk.read_tb.toFixed(2)} ТБ</span>
                      </div>
                    )}
                    {disk.power_cycles != null && (
                      <div>
                        <span className="text-[#526170]">Включений: </span>
                        <span className="text-[#E5EDF5]">{disk.power_cycles.toLocaleString("ru-RU")}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </motion.div>
  );
}
