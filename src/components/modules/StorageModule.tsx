import { motion, AnimatePresence } from "framer-motion";
import {
  HardDrive,
  Play,
  FolderOpen,
  Search,
  Folder,
  FileText,
  ChevronRight,
  CornerUpLeft,
  Loader2,
} from "lucide-react";
import {
  SpotlightCard,
  TREEMAP_PALETTE,
  cardItemVariants,
  cardsContainerVariants,
  formatBytes,
  getCategoryStyle,
} from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

export function StorageModule({ c }: { c: NexusController }) {
  const {
    availableDrives,
    selectedDriveOrPath,
    setSelectedDriveOrPath,
    isScanning,
    scanElapsedSec,
    scanResult,
    scanError,
    treemapStack,
    setTreemapStack,
    selectedTreemapNode,
    setSelectedTreemapNode,
    fileSearch,
    setFileSearch,
    handleStartStorageScan,
    handleOpenPathInExplorer,
    treemapRects,
    filteredTopFiles,
  } = c;
  return (
            <motion.div
              key="storage"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="space-y-6 max-w-6xl w-full"
            >
              <div>
                <h2 className="text-2xl font-bold text-[#e8edf4] tracking-tight">
                  Анализатор накопителей (Storage Analyzer)
                </h2>
                <p className="text-sm text-[#8793a5] mt-1">
                  Многопоточное сканирование дисков, карта занятого пространства (Treemap) и ТОП-100 тяжелых файлов
                </p>
              </div>

              <SpotlightCard
                spotlightColor="rgba(56, 189, 248, 0.12)"
                className="p-5 sm:p-6"
              >
                <div className="space-y-4">
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-mono uppercase tracking-wider text-[#8793a5] mr-1">
                        Диски:
                      </span>
                      {availableDrives.map((drive) => {
                        const isSelected =
                          selectedDriveOrPath.toUpperCase() === drive.toUpperCase();
                        return (
                          <motion.button
                            key={drive}
                            type="button"
                            whileHover={{ y: -1 }}
                            whileTap={{ scale: 0.96 }}
                            onClick={() => setSelectedDriveOrPath(drive)}
                            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-mono font-semibold transition-all cursor-pointer border ${
                              isSelected
                                ? "bg-sky-500/20 text-sky-300 border-sky-500/40 shadow-[0_0_16px_rgba(56,189,248,0.2)]"
                                : "bg-zinc-900/80 text-[#c5d0de] border-white/[0.07] hover:border-white/15"
                            }`}
                          >
                            <HardDrive size={14} className="text-sky-400" />
                            <span>{drive}</span>
                          </motion.button>
                        );
                      })}
                    </div>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 flex-1 lg:max-w-xl">
                      <input
                        type="text"
                        value={selectedDriveOrPath}
                        onChange={(e) => setSelectedDriveOrPath(e.target.value)}
                        placeholder="Укажите диск или путь (например C:\ или C:\Users)"
                        className="flex-1 px-4 py-2.5 rounded-xl bg-zinc-950/85 border border-white/[0.08] text-xs sm:text-sm font-mono text-[#e8edf4] placeholder-zinc-500 focus:outline-none focus:border-sky-500/50 transition-all"
                      />
                      <motion.button
                        type="button"
                        whileHover={{ scale: isScanning ? 1 : 1.02 }}
                        whileTap={{ scale: isScanning ? 1 : 0.97 }}
                        disabled={isScanning}
                        onClick={() => handleStartStorageScan()}
                        className={`inline-flex items-center justify-center gap-2.5 px-5 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer border shrink-0 ${
                          isScanning
                            ? "bg-sky-500/10 text-sky-300/80 border-sky-500/25 cursor-wait"
                            : "bg-gradient-to-r from-sky-500/25 to-teal-500/25 hover:from-sky-500/35 hover:to-teal-500/35 text-sky-300 border-sky-500/40 shadow-[0_0_24px_rgba(56,189,248,0.18)]"
                        }`}
                      >
                        {isScanning ? (
                          <>
                            <Loader2 size={16} className="animate-spin text-sky-400" />
                            <span>Сканирование...</span>
                          </>
                        ) : (
                          <>
                            <Play size={16} />
                            <span>Начать сканирование</span>
                          </>
                        )}
                      </motion.button>
                    </div>
                  </div>

                  <AnimatePresence>
                    {isScanning && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="pt-3 border-t border-white/[0.06] flex items-center justify-between text-xs font-mono text-sky-400"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="relative flex h-2.5 w-2.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-sky-400" />
                          </span>
                          <span>
                            Многопоточный обход{" "}
                            <strong className="text-[#e8edf4]">{selectedDriveOrPath}</strong>{" "}
                            через jwalk...
                          </span>
                        </div>
                        <span className="px-2.5 py-1 rounded-lg bg-zinc-950/80 border border-white/[0.06] text-[#c5d0de]">
                          Время: {scanElapsedSec.toFixed(1)} сек
                        </span>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <AnimatePresence>
                    {scanError && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-mono"
                      >
                        {scanError}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </SpotlightCard>

              {scanResult && (
                <motion.div
                  variants={cardsContainerVariants}
                  initial="hidden"
                  animate="show"
                  className="space-y-6"
                >
                  <SpotlightCard
                    variants={cardItemVariants}
                    spotlightColor="rgba(34, 211, 238, 0.12)"
                    className="p-5 sm:p-6"
                  >
                    <div className="space-y-5">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                          <span className="text-xs font-mono uppercase tracking-wider text-[#8793a5]">
                            Сводка сканирования • {scanResult.target_path}
                          </span>
                          <div className="flex flex-wrap items-baseline gap-4 mt-1">
                            <span className="text-2xl sm:text-3xl font-bold text-[#e8edf4] tracking-tight">
                              {formatBytes(scanResult.total_scanned_bytes)}
                            </span>
                            <span className="text-xs sm:text-sm font-mono text-[#8793a5]">
                              Проверено файлов:{" "}
                              <strong className="text-sky-400">
                                {scanResult.total_files_count.toLocaleString("ru-RU")}
                              </strong>
                            </span>
                          </div>
                        </div>

                        <motion.button
                          type="button"
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.96 }}
                          onClick={() => handleOpenPathInExplorer(scanResult.target_path)}
                          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-800/80 hover:bg-zinc-700/80 text-xs font-mono text-[#d5dde8] border border-white/[0.07] cursor-pointer self-start sm:self-auto"
                        >
                          <FolderOpen size={14} className="text-sky-400" />
                          <span>Открыть корень в Проводнике</span>
                        </motion.button>
                      </div>

                      <div className="space-y-3">
                        <div className="w-full h-3 rounded-full bg-zinc-950/90 border border-white/[0.06] overflow-hidden flex p-0.5 gap-0.5">
                          {scanResult.category_sizes.map(([catName, catBytes]) => {
                            const pct =
                              scanResult.total_scanned_bytes > 0
                                ? (catBytes / scanResult.total_scanned_bytes) * 100
                                : 0;
                            if (pct < 0.4) return null;
                            const st = getCategoryStyle(catName);
                            return (
                              <div
                                key={catName}
                                title={`${catName}: ${formatBytes(catBytes)} (${pct.toFixed(1)}%)`}
                                style={{ width: `${pct}%` }}
                                className={`h-full first:rounded-l-full last:rounded-r-full transition-all duration-500 ${st.barClass}`}
                              />
                            );
                          })}
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 pt-1">
                          {scanResult.category_sizes.map(([catName, catBytes]) => {
                            const pct =
                              scanResult.total_scanned_bytes > 0
                                ? (catBytes / scanResult.total_scanned_bytes) * 100
                                : 0;
                            const st = getCategoryStyle(catName);
                            return (
                              <div
                                key={catName}
                                className="p-2.5 rounded-xl bg-zinc-950/60 border border-white/[0.05] flex flex-col justify-between"
                              >
                                <div className="flex items-center gap-2 text-xs text-[#8793a5] truncate">
                                  <span
                                    className={`h-2 w-2 rounded-full shrink-0 ${st.dotClass}`}
                                  />
                                  <span className="truncate">{catName}</span>
                                </div>
                                <div className="mt-1.5 flex items-baseline justify-between gap-1 font-mono">
                                  <span className="text-xs font-bold text-[#e8edf4]">
                                    {formatBytes(catBytes)}
                                  </span>
                                  <span className={`text-[10px] ${st.textClass}`}>
                                    {pct.toFixed(1)}%
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </SpotlightCard>

                  <SpotlightCard
                    variants={cardItemVariants}
                    spotlightColor="rgba(56, 189, 248, 0.1)"
                    className="p-5 sm:p-6"
                  >
                    <div className="space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div>
                          <h3 className="text-base font-semibold text-[#e8edf4]">
                            Карта распределения папок (Treemap)
                          </h3>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono text-[#8793a5] mt-1">
                            {treemapStack.map((node, idx) => (
                              <span key={node.path + idx} className="flex items-center gap-1">
                                {idx > 0 && <ChevronRight size={12} className="text-zinc-600" />}
                                <button
                                  type="button"
                                  onClick={() => {
                                    const nextStack = treemapStack.slice(0, idx + 1);
                                    setTreemapStack(nextStack);
                                    setSelectedTreemapNode(node);
                                  }}
                                  className={`hover:text-sky-400 transition-colors cursor-pointer ${
                                    idx === treemapStack.length - 1
                                      ? "text-sky-400 font-semibold"
                                      : "text-[#8793a5]"
                                  }`}
                                >
                                  {node.name || node.path}
                                </button>
                              </span>
                            ))}
                          </div>
                        </div>

                        {treemapStack.length > 1 && (
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.96 }}
                            onClick={() => {
                              const nextStack = treemapStack.slice(0, -1);
                              setTreemapStack(nextStack);
                              setSelectedTreemapNode(nextStack[nextStack.length - 1]);
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-800/80 hover:bg-zinc-700/80 text-xs font-mono text-[#d5dde8] border border-white/[0.08] cursor-pointer self-start sm:self-auto"
                          >
                            <CornerUpLeft size={13} className="text-sky-400" />
                            <span>На уровень выше</span>
                          </motion.button>
                        )}
                      </div>

                      <div className="relative w-full h-80 rounded-2xl bg-[#080a0e] border border-white/[0.07] overflow-hidden p-1.5">
                        {treemapRects.length === 0 ? (
                          <div className="w-full h-full flex items-center justify-center text-xs font-mono text-[#8793a5]">
                            Нет вложенных подпапок для построения карты
                          </div>
                        ) : (
                          <div className="relative w-full h-full">
                            {treemapRects.map((rect) => {
                              const isSelected =
                                selectedTreemapNode?.path === rect.node.path;
                              const pctOfDisk =
                                scanResult.total_scanned_bytes > 0
                                  ? (rect.node.size_bytes /
                                      scanResult.total_scanned_bytes) *
                                    100
                                  : 0;
                              const paletteClass =
                                TREEMAP_PALETTE[rect.colorIndex] ?? TREEMAP_PALETTE[0];

                              return (
                                <div
                                  key={rect.node.path}
                                  style={{
                                    left: `${rect.x}%`,
                                    top: `${rect.y}%`,
                                    width: `${rect.w}%`,
                                    height: `${rect.h}%`,
                                  }}
                                  className="absolute p-1 transition-all duration-300"
                                >
                                  <button
                                    type="button"
                                    onClick={() => setSelectedTreemapNode(rect.node)}
                                    onDoubleClick={() => {
                                      if (rect.node.children.length > 0) {
                                        setTreemapStack((prev) => [...prev, rect.node]);
                                        setSelectedTreemapNode(
                                          rect.node.children[0] ?? rect.node
                                        );
                                      }
                                    }}
                                    title={`${rect.node.name} — ${formatBytes(
                                      rect.node.size_bytes
                                    )} (${pctOfDisk.toFixed(1)}%)`}
                                    className={`w-full h-full rounded-xl bg-gradient-to-br border p-2.5 flex flex-col justify-between text-left overflow-hidden transition-all cursor-pointer ${paletteClass} ${
                                      isSelected
                                        ? "ring-2 ring-sky-400 shadow-[0_0_20px_rgba(56,189,248,0.3)]"
                                        : ""
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-1 min-w-0">
                                      <span className="font-semibold text-xs truncate">
                                        {rect.node.name}
                                      </span>
                                      {rect.node.children.length > 0 &&
                                        rect.w > 14 &&
                                        rect.h > 18 && (
                                          <Folder
                                            size={12}
                                            className="shrink-0 opacity-75"
                                          />
                                        )}
                                    </div>

                                    {rect.w > 10 && rect.h > 16 && (
                                      <div className="font-mono text-[11px] leading-tight truncate opacity-90">
                                        <div className="font-bold">
                                          {formatBytes(rect.node.size_bytes)}
                                        </div>
                                        {rect.h > 26 && (
                                          <div className="text-[10px] opacity-75">
                                            {pctOfDisk.toFixed(1)}% от диска
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {selectedTreemapNode && (
                        <div className="p-4 rounded-xl bg-zinc-950/85 border border-white/[0.08] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2.5">
                              <Folder size={16} className="text-sky-400 shrink-0" />
                              <span className="font-bold text-sm text-[#e8edf4] truncate">
                                {selectedTreemapNode.name}
                              </span>
                              <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-400 border border-sky-500/30">
                                {formatBytes(selectedTreemapNode.size_bytes)}
                              </span>
                              <span className="text-xs font-mono text-[#8793a5]">
                                (
                                {scanResult.total_scanned_bytes > 0
                                  ? (
                                      (selectedTreemapNode.size_bytes /
                                        scanResult.total_scanned_bytes) *
                                      100
                                    ).toFixed(1)
                                  : "0.0"}
                                % от просканированного объёма)
                              </span>
                            </div>
                            <p className="text-xs font-mono text-[#8793a5] truncate">
                              {selectedTreemapNode.path}
                            </p>
                          </div>

                          <div className="flex items-center gap-2.5 shrink-0">
                            {selectedTreemapNode.children.length > 0 && (
                              <motion.button
                                type="button"
                                whileTap={{ scale: 0.96 }}
                                onClick={() => {
                                  setTreemapStack((prev) => [
                                    ...prev,
                                    selectedTreemapNode,
                                  ]);
                                  setSelectedTreemapNode(
                                    selectedTreemapNode.children[0] ??
                                      selectedTreemapNode
                                  );
                                }}
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-500/30 text-xs font-mono cursor-pointer"
                              >
                                <span>Войти в папку</span>
                                <ChevronRight size={14} />
                              </motion.button>
                            )}

                            <motion.button
                              type="button"
                              whileTap={{ scale: 0.96 }}
                              onClick={() =>
                                handleOpenPathInExplorer(selectedTreemapNode.path)
                              }
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-[#d5dde8] border border-white/[0.08] text-xs font-mono cursor-pointer"
                            >
                              <FolderOpen size={14} className="text-sky-400" />
                              <span>Открыть в проводнике</span>
                            </motion.button>
                          </div>
                        </div>
                      )}
                    </div>
                  </SpotlightCard>

                  <SpotlightCard
                    variants={cardItemVariants}
                    spotlightColor="rgba(34, 211, 238, 0.1)"
                    className="p-5 sm:p-6"
                  >
                    <div className="space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div>
                          <h3 className="text-base font-semibold text-[#e8edf4]">
                            ТОП-100 самых тяжелых файлов
                          </h3>
                          <p className="text-xs font-mono text-[#8793a5] mt-0.5">
                            Отсортировано по убыванию размера • Найдено:{" "}
                            {filteredTopFiles.length}
                          </p>
                        </div>

                        <div className="relative w-full sm:w-80">
                          <Search
                            size={15}
                            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#8793a5]"
                          />
                          <input
                            type="text"
                            value={fileSearch}
                            onChange={(e) => setFileSearch(e.target.value)}
                            placeholder="Фильтр по имени или расширению..."
                            className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-zinc-950/80 border border-white/[0.07] text-xs font-mono text-[#e8edf4] placeholder-zinc-500 focus:outline-none focus:border-sky-500/40"
                          />
                        </div>
                      </div>

                      <div className="max-h-96 overflow-y-auto rounded-xl border border-white/[0.06] bg-zinc-950/50 divide-y divide-white/[0.04]">
                        {filteredTopFiles.length === 0 ? (
                          <div className="p-8 text-center text-xs font-mono text-[#8793a5]">
                            Файлы по заданному фильтру не найдены
                          </div>
                        ) : (
                          filteredTopFiles.map((file, idx) => {
                            const maxFileBytes =
                              scanResult.top_files[0]?.size_bytes || 1;
                            const relWidth = Math.min(
                              100,
                              Math.max(2, (file.size_bytes / maxFileBytes) * 100)
                            );

                            return (
                              <div
                                key={file.path + idx}
                                className="px-4 py-3 hover:bg-white/[0.03] transition-colors flex items-center justify-between gap-4"
                              >
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <span className="w-7 text-xs font-mono text-[#8793a5] shrink-0">
                                    #{idx + 1}
                                  </span>
                                  <FileText
                                    size={16}
                                    className="text-cyan-400 shrink-0"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-medium text-[#e8edf4] truncate">
                                        {file.name}
                                      </span>
                                      {file.extension && (
                                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-[#c5d0de] border border-white/[0.06] shrink-0">
                                          .{file.extension}
                                        </span>
                                      )}
                                    </div>
                                    <p
                                      title={file.path}
                                      className="text-[11px] font-mono text-[#8793a5] truncate mt-0.5"
                                    >
                                      {file.path}
                                    </p>
                                  </div>
                                </div>

                                <div className="flex items-center gap-4 shrink-0">
                                  <div className="w-28 hidden md:block">
                                    <div className="text-right text-xs font-mono font-bold text-sky-400 mb-1">
                                      {formatBytes(file.size_bytes)}
                                    </div>
                                    <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
                                      <div
                                        style={{ width: `${relWidth}%` }}
                                        className="h-full bg-gradient-to-r from-sky-400 to-cyan-400 rounded-full"
                                      />
                                    </div>
                                  </div>

                                  <span className="md:hidden text-xs font-mono font-bold text-sky-400">
                                    {formatBytes(file.size_bytes)}
                                  </span>

                                  <motion.button
                                    type="button"
                                    whileHover={{ scale: 1.06 }}
                                    whileTap={{ scale: 0.94 }}
                                    onClick={() => handleOpenPathInExplorer(file.path)}
                                    title="Показать файл в проводнике"
                                    className="p-2 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-[#c5d0de] hover:text-sky-400 border border-white/[0.06] transition-colors cursor-pointer"
                                  >
                                    <FolderOpen size={15} />
                                  </motion.button>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </SpotlightCard>
                </motion.div>
              )}
            </motion.div>
  );
}
