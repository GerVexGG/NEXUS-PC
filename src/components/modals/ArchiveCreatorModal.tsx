import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  FilePlus,
  Folder,
  FolderArchive,
  FolderOpen,
  FolderPlus,
  Loader2,
  Trash2,
  X,
} from "lucide-react";

export interface ArchiveSourceItem {
  path: string;
  name: string;
  is_dir: boolean;
  size_bytes: number;
  file_count: number;
  parent_dir: string;
}

export interface ArchiverCapabilities {
  zip_available: boolean;
  rar_available: boolean;
  rar_path: string | null;
  default_output_dir: string;
}

export interface ArchiveProgressState {
  running: boolean;
  phase: string;
  current_item: string;
  processed_files: number;
  total_files: number;
  processed_bytes: number;
  total_bytes: number;
  percent: number;
}

export interface ArchiveCreateResult {
  archive_path: string;
  format: string;
  size_bytes: number;
  total_files: number;
  elapsed_ms: number;
}

type ArchiveFormat = "zip" | "rar";
type CompressionLevel = "store" | "fast" | "normal" | "max";

const COMPRESSION_OPTIONS: { id: CompressionLevel; label: string; hint: string }[] = [
  { id: "store", label: "Без сжатия", hint: "Максимальная скорость" },
  { id: "fast", label: "Быстрое", hint: "Лёгкое сжатие" },
  { id: "normal", label: "Обычное", hint: "Баланс" },
  { id: "max", label: "Максимальное", hint: "Меньший размер" },
];

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export function ArchiveCreatorModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [capabilities, setCapabilities] = useState<ArchiverCapabilities | null>(null);
  const [format, setFormat] = useState<ArchiveFormat>("zip");
  const [sources, setSources] = useState<ArchiveSourceItem[]>([]);
  const [archiveName, setArchiveName] = useState<string>("nexus_archive");
  const [destDir, setDestDir] = useState<string>("");
  const [compression, setCompression] = useState<CompressionLevel>("normal");

  const [picking, setPicking] = useState<boolean>(false);
  const [creating, setCreating] = useState<boolean>(false);
  const [progress, setProgress] = useState<ArchiveProgressState | null>(null);
  const [result, setResult] = useState<ArchiveCreateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void invoke<ArchiverCapabilities>("archive_get_capabilities")
      .then((caps) => {
        setCapabilities(caps);
        setDestDir((prev) => (prev.trim() ? prev : caps.default_output_dir));
      })
      .catch((err) => setError(String(err)));
  }, [open]);

  useEffect(() => {
    if (!open || !creating) return;
    let active = true;
    const poll = () => {
      void invoke<ArchiveProgressState>("archive_get_progress")
        .then((p) => {
          if (active) setProgress(p);
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 160);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open, creating]);

  const totalStats = useMemo(() => {
    let bytes = 0;
    let files = 0;
    let oversizedSingle = false;
    for (const s of sources) {
      bytes += s.size_bytes;
      files += s.file_count;
      if (!s.is_dir && s.size_bytes > 0xffffffff) {
        oversizedSingle = true;
      }
    }
    return { bytes, files, oversizedSingle };
  }, [sources]);

  const zipLimitReason =
    format === "zip"
      ? totalStats.oversizedSingle || totalStats.bytes > 0xffffffff
        ? "Суммарный объём или размер файла превышает лимит классического ZIP (4 ГБ). Выберите формат RAR или разделите файлы."
        : totalStats.files + sources.length > 65535
        ? "Число объектов превышает лимит классического ZIP (65 535 записей). Выберите формат RAR."
        : null
      : null;

  if (!open) return null;

  const mergeInspectedPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    const inspected = await invoke<ArchiveSourceItem[]>("archive_inspect_paths", { paths });
    setSources((prev) => {
      const existing = new Set(prev.map((p) => p.path.toLowerCase()));
      const merged = [...prev];
      for (const item of inspected) {
        if (!existing.has(item.path.toLowerCase())) {
          existing.add(item.path.toLowerCase());
          merged.push(item);
        }
      }
      return merged;
    });
    setResult(null);
    setError(null);
  };

  const handleAddFiles = async () => {
    setPicking(true);
    setError(null);
    try {
      const paths = await invoke<string[]>("archive_pick_files");
      await mergeInspectedPaths(paths);
    } catch (err) {
      setError(String(err));
    } finally {
      setPicking(false);
    }
  };

  const handleAddFolder = async () => {
    setPicking(true);
    setError(null);
    try {
      const folder = await invoke<string | null>("archive_pick_folder", {
        title: "Выберите папку для добавления в архив",
      });
      if (folder) {
        await mergeInspectedPaths([folder]);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setPicking(false);
    }
  };

  const handlePickDestination = async () => {
    setPicking(true);
    setError(null);
    try {
      const folder = await invoke<string | null>("archive_pick_folder", {
        title: "Выберите папку для сохранения архива",
      });
      if (folder) setDestDir(folder);
    } catch (err) {
      setError(String(err));
    } finally {
      setPicking(false);
    }
  };

  const handleRemoveSource = (path: string) => {
    setSources((prev) => prev.filter((item) => item.path !== path));
  };

  const handleCreateArchive = async () => {
    if (sources.length === 0) {
      setError("Добавьте хотя бы один файл или папку");
      return;
    }
    if (!archiveName.trim()) {
      setError("Укажите имя выходного архива");
      return;
    }
    if (!destDir.trim()) {
      setError("Укажите папку для сохранения архива");
      return;
    }
    if (zipLimitReason) {
      setError(zipLimitReason);
      return;
    }
    if (format === "rar" && capabilities && !capabilities.rar_available) {
      setError(
        "Архиватор WinRAR (Rar.exe / WinRAR.exe) не обнаружен в системе. Выберите формат ZIP или установите WinRAR."
      );
      return;
    }

    setCreating(true);
    setError(null);
    setResult(null);
    setProgress(null);
    try {
      const created = await invoke<ArchiveCreateResult>("archive_create", {
        req: {
          format,
          sources: sources.map((s) => s.path),
          destination_dir: destDir.trim(),
          archive_name: archiveName.trim(),
          compression_level: compression,
        },
      });
      setResult(created);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleCancelArchive = async () => {
    try {
      await invoke("archive_cancel");
    } catch {
      /* отменено */
    }
  };

  const rarMissing = format === "rar" && capabilities !== null && !capabilities.rar_available;
  const normalizedExtName = (() => {
    const clean = archiveName.trim().replace(/\.(zip|rar)$/i, "") || "nexus_archive";
    return `${clean}.${format}`;
  })();

  return (
    <div
      onClick={() => {
        if (!creating) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
        className="tactical-card tactical-brackets flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl shadow-[0_24px_64px_rgba(0,0,0,0.85)]"
      >
        {/* Заголовок */}
        <div className="flex items-center justify-between gap-3 border-b border-[#202B38] bg-[#0B0E14] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#00D5E8]/35 bg-[#00D5E8]/10 text-[#00D5E8]">
              <FolderArchive size={16} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[#E5EDF5]">Создать архив</h2>
              <p className="text-[11px] text-[#8292A3]">
                Упаковка выбранных файлов и папок в ZIP или RAR без изменения исходников
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={creating}
            aria-label="Закрыть окно создания архива"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-[#202B38] bg-[#10151D] p-1.5 text-[#8292A3] transition-colors hover:text-[#E5EDF5] disabled:opacity-45"
          >
            <X size={14} />
          </button>
        </div>

        {/* Тело модального окна */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {/* Выбор формата */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <button
              type="button"
              disabled={creating}
              onClick={() => {
                setFormat("zip");
                setError(null);
              }}
              className={`flex cursor-pointer items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-all ${
                format === "zip"
                  ? "border-[#00D5E8]/50 bg-[#00D5E8]/10"
                  : "border-[#202B38] bg-[#0B0E14] hover:border-[#202B38] hover:bg-[#151C26]"
              }`}
            >
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold text-[#E5EDF5]">
                  <Archive size={14} className="text-[#00D5E8]" />
                  <span>Формат ZIP (.zip)</span>
                </div>
                <div className="mt-0.5 text-[11px] text-[#8292A3]">
                  Встроенный потоковый архиватор Deflate / Store
                </div>
              </div>
              <span className="rounded border border-[#00D5E8]/30 bg-[#00D5E8]/12 px-2 py-0.5 font-mono text-[10px] font-semibold text-[#00D5E8]">
                ГОТОВ
              </span>
            </button>

            <button
              type="button"
              disabled={creating}
              onClick={() => {
                setFormat("rar");
                setError(null);
              }}
              className={`flex cursor-pointer items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-all ${
                format === "rar"
                  ? "border-[#00D5E8]/50 bg-[#00D5E8]/10"
                  : "border-[#202B38] bg-[#0B0E14] hover:border-[#202B38] hover:bg-[#151C26]"
              }`}
            >
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold text-[#E5EDF5]">
                  <Archive size={14} className="text-amber-300" />
                  <span>Формат RAR (.rar)</span>
                </div>
                <div className="mt-0.5 text-[11px] text-[#8292A3]">
                  {capabilities?.rar_available
                    ? "Системный WinRAR CLI обнаружен"
                    : "Требуется установленный WinRAR"}
                </div>
              </div>
              <span
                className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                  capabilities?.rar_available
                    ? "border-[#00D5E8]/30 bg-[#00D5E8]/12 text-[#00D5E8]"
                    : "border-amber-500/35 bg-amber-500/12 text-amber-300"
                }`}
              >
                {capabilities?.rar_available ? "WINRAR" : "НЕ НАЙДЕН"}
              </span>
            </button>
          </div>

          {rarMissing && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" />
              <div>
                WinRAR (<span className="font-mono">Rar.exe</span> /{" "}
                <span className="font-mono">WinRAR.exe</span>) не найден в системе.
                Чтобы не создавать некорректный файл, создание <span className="font-mono">.rar</span> отключено
                до установки WinRAR — выберите формат ZIP.
              </div>
            </div>
          )}

          {zipLimitReason && (
            <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-400" />
              <div>{zipLimitReason}</div>
            </div>
          )}

          {/* Панель добавления источников */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={creating || picking}
                  onClick={() => void handleAddFiles()}
                  className="cyber-btn inline-flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#00D5E8] disabled:opacity-50"
                >
                  <FilePlus size={13} />
                  Добавить файлы
                </button>
                <button
                  type="button"
                  disabled={creating || picking}
                  onClick={() => void handleAddFolder()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-1.5 text-xs font-medium text-[#E5EDF5] transition-colors hover:border-[#00D5E8]/40 disabled:opacity-50"
                >
                  <FolderPlus size={13} className="text-[#00D5E8]" />
                  Добавить папку
                </button>
              </div>

              <div className="flex items-center gap-3 font-mono text-[11px] text-[#8292A3]">
                <span>
                  Элементов: <span className="text-[#E5EDF5]">{sources.length}</span> · Файлов:{" "}
                  <span className="text-[#E5EDF5]">{totalStats.files}</span> ·{" "}
                  <span className="text-[#00D5E8]">{formatSize(totalStats.bytes)}</span>
                </span>
                {sources.length > 0 && !creating && (
                  <button
                    type="button"
                    onClick={() => setSources([])}
                    className="cursor-pointer text-[#8292A3] hover:text-rose-300"
                  >
                    Очистить
                  </button>
                )}
              </div>
            </div>

            <div className="max-h-52 min-h-[130px] divide-y divide-[#202B38]/60 overflow-y-auto rounded-xl border border-[#202B38] bg-[#0B0E14]">
              {sources.length === 0 ? (
                <div className="flex h-[128px] flex-col items-center justify-center gap-1 text-xs text-[#526170]">
                  <FolderArchive size={20} className="text-[#526170]" />
                  <span>Добавьте файлы и/или папки для упаковки в архив</span>
                </div>
              ) : (
                sources.map((item) => (
                  <div
                    key={item.path}
                    className="flex items-center justify-between gap-3 px-3.5 py-2 text-xs hover:bg-[#10151D]"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      {item.is_dir ? (
                        <Folder size={14} className="shrink-0 text-amber-300" />
                      ) : (
                        <FilePlus size={14} className="shrink-0 text-[#00D5E8]" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-[#E5EDF5]">{item.name}</span>
                          <span className="shrink-0 rounded border border-[#202B38] bg-[#10151D] px-1.5 py-0.2 font-mono text-[10px] text-[#8292A3]">
                            {item.is_dir ? `Папка · ${item.file_count} ф.` : "Файл"}
                          </span>
                        </div>
                        <div className="truncate font-mono text-[10px] text-[#526170]">
                          {item.parent_dir || item.path}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className="font-mono text-[11px] text-[#E5EDF5]">
                        {formatSize(item.size_bytes)}
                      </span>
                      <button
                        type="button"
                        disabled={creating}
                        title="Убрать из списка"
                        onClick={() => handleRemoveSource(item.path)}
                        className="cursor-pointer rounded p-1 text-[#526170] hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-40"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Настройки архива */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-[#8292A3]">Имя архива</label>
              <div className="flex items-center overflow-hidden rounded-lg border border-[#202B38] bg-[#0B0E14] focus-within:border-[#00D5E8]/50">
                <input
                  type="text"
                  disabled={creating}
                  value={archiveName}
                  onChange={(e) => setArchiveName(e.target.value)}
                  placeholder="nexus_archive"
                  className="min-w-0 flex-1 bg-transparent px-3 py-2 text-xs font-medium text-[#E5EDF5] outline-none placeholder:text-[#526170]"
                />
                <span className="border-l border-[#202B38] bg-[#10151D] px-2.5 py-2 font-mono text-[11px] text-[#00D5E8]">
                  .{format}
                </span>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-[#526170]">
                Файл: {normalizedExtName}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-[#8292A3]">
                Место сохранения
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  disabled={creating}
                  value={destDir}
                  onChange={(e) => setDestDir(e.target.value)}
                  placeholder="C:\Users\...\Desktop"
                  className="min-w-0 flex-1 rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2 font-mono text-xs text-[#E5EDF5] outline-none placeholder:text-[#526170] focus:border-[#00D5E8]/50"
                />
                <button
                  type="button"
                  disabled={creating || picking}
                  onClick={() => void handlePickDestination()}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#10151D] px-3 py-2 text-xs font-medium text-[#E5EDF5] hover:border-[#00D5E8]/40 disabled:opacity-50"
                >
                  <FolderOpen size={13} className="text-[#00D5E8]" />
                  Обзор…
                </button>
              </div>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-[#8292A3]">Степень сжатия</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {COMPRESSION_OPTIONS.map((opt) => {
                const active = compression === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={creating}
                    onClick={() => setCompression(opt.id)}
                    className={`cursor-pointer rounded-lg border px-2.5 py-2 text-left transition-colors ${
                      active
                        ? "border-[#00D5E8]/50 bg-[#00D5E8]/12"
                        : "border-[#202B38] bg-[#0B0E14] hover:text-[#E5EDF5]"
                    }`}
                  >
                    <div
                      className={`text-xs font-medium ${
                        active ? "text-[#00D5E8]" : "text-[#E5EDF5]"
                      }`}
                    >
                      {opt.label}
                    </div>
                    <div className="mt-0.5 text-[10px] text-[#526170]">{opt.hint}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Прогресс / Ошибка / Результат */}
          {creating && (
            <div className="space-y-2 rounded-xl border border-[#00D5E8]/35 bg-[#0B0E14] p-3.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2 font-medium text-[#E5EDF5]">
                  <Loader2 size={14} className="animate-spin text-[#00D5E8]" />
                  {progress?.current_item || "Упаковка архива…"}
                </span>
                <span className="font-mono font-semibold text-[#00D5E8]">
                  {(progress?.percent ?? 0).toFixed(0)}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[#10151D]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#00D5E8] to-[#36AFC0] transition-all duration-150"
                  style={{ width: `${Math.min(100, Math.max(2, progress?.percent ?? 5))}%` }}
                />
              </div>
              <div className="flex justify-between font-mono text-[10px] text-[#8292A3]">
                <span>
                  Файлы: {progress?.processed_files ?? 0} / {progress?.total_files ?? totalStats.files}
                </span>
                <span>
                  {formatSize(progress?.processed_bytes ?? 0)} /{" "}
                  {formatSize(progress?.total_bytes ?? totalStats.bytes)}
                </span>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-500/35 bg-rose-500/12 px-3.5 py-2.5 text-xs text-rose-300">
              {error}
            </div>
          )}

          {result && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#00D5E8]/40 bg-[#00D5E8]/10 px-4 py-3 text-xs">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center gap-1.5 font-semibold text-[#00D5E8]">
                  <CheckCircle2 size={14} />
                  <span>Архив успешно создан</span>
                </div>
                <div className="truncate font-mono text-[11px] text-[#E5EDF5]" title={result.archive_path}>
                  {result.archive_path}
                </div>
                <div className="font-mono text-[10px] text-[#8292A3]">
                  Размер: {formatSize(result.size_bytes)} · Файлов: {result.total_files} · Время:{" "}
                  {(result.elapsed_ms / 1000).toFixed(2)} с
                </div>
              </div>
              <button
                type="button"
                onClick={() => void invoke("open_item_location", { path: result.archive_path })}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[#00D5E8]/40 bg-[#0B0E14] px-3 py-1.5 font-medium text-[#00D5E8] hover:bg-[#10151D]"
              >
                <FolderOpen size={13} />
                Показать в Проводнике
              </button>
            </div>
          )}
        </div>

        {/* Подвал */}
        <div className="flex items-center justify-end gap-2.5 border-t border-[#202B38] bg-[#0B0E14] px-5 py-3">
          {creating ? (
            <button
              type="button"
              onClick={() => void handleCancelArchive()}
              className="cyber-btn-danger cursor-pointer px-4 py-2 text-xs font-semibold text-rose-300"
            >
              Отменить
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-lg border border-[#202B38] bg-[#10151D] px-4 py-2 text-xs font-medium text-[#8292A3] hover:text-[#E5EDF5]"
              >
                Закрыть
              </button>
              <button
                type="button"
                disabled={sources.length === 0 || rarMissing || zipLimitReason !== null}
                onClick={() => void handleCreateArchive()}
                className="cyber-btn inline-flex cursor-pointer items-center gap-2 px-5 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-[#00D5E8] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <FolderArchive size={14} />
                Создать архив
              </button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
