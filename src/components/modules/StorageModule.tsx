import { StorageDirectoryTree } from "./StorageDirectoryTree";
import "./StorageDirectoryTree.css";
import { ModuleHeader } from "../ui/ModuleHeader";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  FileText,
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
  copyTextToClipboard,
  formatBytes,
  getCategoryStyle,
} from "../../lib/studio";
import { useStorageScanElapsed } from "../../hooks/useStorageScanner";
import type { NexusController } from "../../hooks/useNexusController";

interface DiskHealthInfo {
  device_id?: number | null;
  serial_number?: string;
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

function StorageScanButton({
  isScanning,
  isCancelling,
  startedAt,
  hasTarget,
  onStartScan,
  onCancelScan,
}: {
  isScanning: boolean;
  isCancelling: boolean;
  startedAt: number | null;
  hasTarget: boolean;
  onStartScan: () => void;
  onCancelScan: () => void;
}) {
  const scanElapsedSec = useStorageScanElapsed(isScanning, startedAt);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={isScanning || isCancelling || !hasTarget}
        onClick={onStartScan}
        className="nexus-button nexus-button--primary"
      >
        {isScanning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {isCancelling ? "Остановка…" : isScanning ? `Сканирование · ${scanElapsedSec} с` : "Сканировать том"}
      </button>
      {(isScanning || isCancelling) && (
        <button
          type="button"
          onClick={onCancelScan}
          disabled={isCancelling}
          className="nexus-button"
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
    drivesLoading,
    drivesError,
    fetchAvailableDrives,
    selectedDriveOrPath,
    isScanning,
    isCancellingScan,
    scanStartedAt,
    scanTarget,
    scanCancelled,
    scanResult,
    scanError,
    handleStartStorageScan,
    handleCancelStorageScan,
    handleOpenPathInExplorer,
    filteredTopFiles,
    fileSearch,
    setFileSearch,
  } = c;

  const { storageLocation, goToStorage } = c;
  const { view } = storageLocation;
  const setView = (view: "analysis" | "smart") => goToStorage({ ...storageLocation, view });
  const [diskHealth, setDiskHealth] = useState<DiskHealthInfo[]>([]);
  const [diskHealthLoading, setDiskHealthLoading] = useState(true);
  const [diskHealthError, setDiskHealthError] = useState("");
  const diskHealthPending = useRef(false);
  const [profileScan, setProfileScan] = useState(false);
  const [copiedPath, setCopiedPath] = useState("");
  const [locating, setLocating] = useState(false);
  const locateRequest = useRef(0);
  const currentScanId = scanResult?.scan_id;

  useLayoutEffect(() => {
    setLocating(false);
    return () => { locateRequest.current++; };
  }, [storageLocation, currentScanId]);

  const locate = async (path: string) => {
    const scanId = currentScanId;
    if (scanId === undefined) return;
    const request = ++locateRequest.current;
    setLocating(true);
    try {
      const [folder, file] = await invoke<[string, string]>("locate_storage_file", { scanId, path });
      if (locateRequest.current === request) goToStorage({ volume: selectedDriveOrPath, scanId, folder, file, view: "analysis" });
    } catch (error) {
      if (locateRequest.current === request) c.setScanError(String(error));
    } finally {
      if (locateRequest.current === request) setLocating(false);
    }
  };

  const loadDiskHealth = useCallback(async () => {
    if (diskHealthPending.current) return;
    diskHealthPending.current = true;
    setDiskHealthLoading(true);
    try {
      const rows = await invoke<DiskHealthInfo[]>("get_disk_health_info");
      setDiskHealth(rows);
      setDiskHealthError("");
    } catch (err) {
      setDiskHealthError(String(err));
    } finally {
      diskHealthPending.current = false;
      setDiskHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "smart" && c.windowVisible) void loadDiskHealth();
  }, [view, c.windowVisible, loadDiskHealth]);

  const selectedLetter = selectedDriveOrPath.trim().slice(0, 2).toUpperCase();
  const matchedVolume = availableDrives.find(
    (d) => d.mount_point.trim().slice(0, 2).toUpperCase() === selectedLetter
  );
  const showsSystemVolume = selectedLetter === "C:" && metrics.disk_total_gb > 0;
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
      className="avs-module avs-storage w-full space-y-4"
    >
      <ModuleHeader module="storage"
        title="Анализатор накопителей"
        description="Выберите том для анализа каталогов, поиска крупных файлов и проверки S.M.A.R.T."
        actions={(view === "analysis" || isScanning || isCancellingScan) && (
          <>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--nexus-muted)]">
              <input type="checkbox" className="accent-cyan-300" checked={profileScan}
                disabled={isScanning || isCancellingScan} onChange={(event) => setProfileScan(event.target.checked)} />
              Диагностика скорости
            </label>
          <StorageScanButton
            isScanning={isScanning}
            isCancelling={isCancellingScan}
            startedAt={scanStartedAt}
            hasTarget={Boolean(selectedDriveOrPath)}
            onStartScan={() => void handleStartStorageScan(undefined, profileScan)}
            onCancelScan={() => void handleCancelStorageScan()}
          />
          </>
        )}
      />

      <div className="avs-workspace-tabs" role="group" aria-label="Представление накопителей">
        <button type="button" aria-pressed={view === "analysis"} onClick={() => setView("analysis")}><Layers size={16} /> Дерево и файлы</button>
        <button type="button" aria-pressed={view === "smart"} onClick={() => setView("smart")}><HardDrive size={16} /> Состояние S.M.A.R.T.</button>
      </div>
      {view === "analysis" && <div className="avs-volume-workspace">
      {/* Панель выбора тома и ёмкости */}
      <section className="nexus-panel avs-storage-volumes p-4" aria-label="Тома Windows" aria-busy={drivesLoading}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Выбор тома">
            {(drivesLoading || availableDrives.length === 0) && (
              <span role="status" className="text-sm text-[#a0adbb]">
                {drivesLoading ? "Получение списка томов…" : drivesError ? "Список томов недоступен" : "Доступных томов нет"}
              </span>
            )}
            {availableDrives.map((drive) => {
              const mount = drive.mount_point;
              const selected = selectedDriveOrPath.toUpperCase() === mount.toUpperCase();
              return (
                <button
                  key={mount}
                  type="button"
                  aria-pressed={selected}
                  disabled={isCancellingScan}
                  onClick={() => {
                    if (!selected) goToStorage({ volume: mount, folder: "", view: "analysis" });
                  }}
                  className="avs-volume-button"
                >
                  <HardDrive size={19} aria-hidden="true" />
                  <span className="text-sm font-semibold">{driveLabel(mount)}
                    {drive.total_bytes > 0 && <small>{formatBytes(drive.total_bytes)}</small>}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => void fetchAvailableDrives()}
              disabled={drivesLoading || isScanning || isCancellingScan}
              className="nexus-button"
              aria-label="Обновить список томов"
              title="Обновить список томов"
            >
              <RefreshCw size={14} className={drivesLoading ? "animate-spin" : ""} />
            </button>
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

        {totalGb !== null && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#1b2632]" role="meter" aria-label="Занято на томе" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usedPct)}>
            <div className="h-full rounded-full bg-[#00b8cd]" style={{ width: `${usedPct}%` }} />
          </div>
        )}

        {(scanError || drivesError) && (
          <div role="alert" className="mt-3 rounded-lg border border-rose-500/35 bg-rose-500/12 px-3 py-2 text-xs text-rose-300">
            {scanError ?? drivesError}
          </div>
        )}
      </section>

      <div className="avs-volume-content">
      {!scanResult && !isScanning && !isCancellingScan && selectedDriveOrPath && (
        <div className="avs-scan-welcome min-w-0">
          <Layers size={34} strokeWidth={1.4} aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-[#E5EDF5]">
              {scanCancelled && scanTarget === selectedDriveOrPath ? "Сканирование остановлено" : "Дерево занятого места"}
            </h3>
            <p className="mt-1 text-sm text-[#a0adbb]">Просканируйте выбранный том, чтобы увидеть объёмы каталогов и крупнейшие файлы.</p>
          </div>
        </div>
      )}

      {(isScanning || isCancellingScan) && !scanResult && (
        <div role="status" className="nexus-empty flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <Loader2 size={24} className="animate-spin text-[#00D5E8]" />
          <div className="text-sm font-semibold text-[#E5EDF5]">
            {isCancellingScan ? "Останавливаем сканирование" : "Сканируем"} {scanTarget}…
          </div>
          <p className="max-w-md text-xs text-[#8292A3]">
            {isCancellingScan ? "Ожидаем подтверждения отмены." : "Идёт подсчёт размеров каталогов и крупных файлов."}
          </p>
        </div>
      )}

      {scanResult && (
        <div className="space-y-4">
          <div className="avs-storage-result">
            <span>{formatBytes(scanResult.total_scanned_bytes)} · {scanResult.total_files_count.toLocaleString("ru-RU")} файлов
              {" · "}{(scanResult.total_dirs_count ?? 0).toLocaleString("ru-RU")} папок</span>
                {scanResult.is_partial && (
                  <details key={scanResult.root_node.path} className="avs-scan-partial">
                    <summary className="nexus-button text-amber-200">
                      <AlertTriangle size={14} aria-hidden /> Частичный результат · {(scanResult.skipped_dirs_count ?? 0) + (scanResult.skipped_files_count ?? 0)} проп.
                    </summary>
                    <div className="nexus-panel avs-scan-partial-details">
                      <dl>
                        <div><dt>Пропущено каталогов</dt><dd>{scanResult.skipped_dirs_count ?? 0}</dd></div>
                        <div><dt>Отказы в доступе</dt><dd>{scanResult.access_denied_count ?? 0}</dd></div>
                        <div><dt>Пропущено файлов</dt><dd>{scanResult.skipped_files_count ?? 0}</dd></div>
                      </dl>
                      <p>Карта учитывает только прочитанные файлы. Пропущенные пути и системные данные могут увеличить фактический объём на диске.</p>
                      {!!scanResult.skipped_samples?.length && <ul aria-label="Примеры пропущенных путей">{scanResult.skipped_samples.map((path) => <li key={path} title={path}>{path}</li>)}</ul>}
                    </div>
                  </details>
                )}
          </div>
          {scanResult.category_sizes.length > 0 && scanResult.total_scanned_bytes > 0 && (
            <section className="nexus-panel avs-storage-categories p-3" aria-labelledby="storage-category-title">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="storage-category-title" className="text-sm font-semibold">Категории файлов</h3>
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
                  if (sizeBytes <= 0) return null;
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
          {scanResult.scan_id !== undefined && (
            <StorageDirectoryTree
              key={`${scanResult.scan_id}:${storageLocation.scanId === scanResult.scan_id ? storageLocation.folder : ""}:${storageLocation.file ?? ""}`}
              scanId={scanResult.scan_id}
              folder={storageLocation.scanId === scanResult.scan_id ? storageLocation.folder : ""}
              file={storageLocation.scanId === scanResult.scan_id ? storageLocation.file : undefined}
              usedBytes={matchedVolume && matchedVolume.total_bytes > 0
                ? Math.max(0, matchedVolume.total_bytes - matchedVolume.available_bytes) : null}
              navigate={(folder) => goToStorage({ volume: selectedDriveOrPath, folder, scanId: scanResult.scan_id, view })}
              reveal={handleOpenPathInExplorer}
            />
          )}
          <details className="nexus-panel avs-large-files p-3">
            <summary className="cursor-pointer text-sm font-semibold">Крупнейшие файлы тома · {scanResult.top_files.length}</summary>
            <label className="avs-large-search">
              <Search size={14} aria-hidden />
              <input value={fileSearch} onChange={(event) => setFileSearch(event.target.value)}
                aria-label="Поиск среди крупнейших файлов" placeholder="Имя, расширение или путь" />
            </label>
            {filteredTopFiles.length === 0 ? <p className="nexus-empty">Крупные файлы не найдены</p> :
              <div className="avs-large-list">
                <table aria-label="Крупнейшие файлы тома">
                  <thead><tr><th scope="col">Имя и путь</th><th scope="col">Размер</th><th scope="col">Действия</th></tr></thead>
                  <tbody>{filteredTopFiles.map(file => (
                    <tr key={file.path}>
                      <td title={file.path}><FileText size={14} aria-hidden /><strong>{file.name}</strong><small>{file.path}</small></td>
                      <td>{formatBytes(file.size_bytes)}</td>
                      <td>
                        <button type="button" className="nexus-button" onClick={() => void locate(file.path)} disabled={locating}
                          aria-label={`Найти в дереве: ${file.name}`}>В дереве</button>
                        <button type="button" className="nexus-button" onClick={() => void handleOpenPathInExplorer(file.path)}
                          title="Показать в Проводнике" aria-label={`Показать файл: ${file.name}`}><FolderOpen size={15} /></button>
                        <button type="button" className="nexus-button" aria-label={`Копировать путь: ${file.name}`}
                          onClick={async () => {
                            try {
                              await copyTextToClipboard(file.path);
                              setCopiedPath(file.path);
                            } catch (error) { c.setScanError(String(error)); }
                          }}>
                          {copiedPath === file.path ? "Скопировано" : "Путь"}
                        </button>
                      </td>
                    </tr>))}</tbody>
                </table>
              </div>}
          </details>
          {scanResult.diagnostics && (
            <details className="nexus-panel p-4 text-sm">
              <summary className="cursor-pointer font-semibold">Диагностика сканирования</summary>
              <p className="my-2 text-xs text-[var(--nexus-muted)]">
                {formatBytes(scanResult.total_scanned_bytes)} · {scanResult.total_files_count.toLocaleString("ru-RU")} файлов
                {" · "}{scanResult.total_dirs_count?.toLocaleString("ru-RU")} каталогов
                {" · "}{scanResult.excluded_count ?? 0} исключено по правилам
              </p>
              <p className="text-xs text-[var(--nexus-muted)]">Время этапов обхода суммируется по рабочим потокам.</p>
              <dl className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs sm:grid-cols-3">
                {([
                  ["Чтение каталогов", scanResult.diagnostics.enumeration_worker_ms],
                  ["Метаданные", scanResult.diagnostics.metadata_worker_ms],
                  ["Подсчёт файлов", scanResult.diagnostics.counting_worker_ms],
                  ["Суммирование", scanResult.diagnostics.aggregation_worker_ms],
                  ["Сборка дерева", scanResult.diagnostics.tree_worker_ms],
                  ["Подготовка результата", scanResult.diagnostics.finalize_ms],
                  ["Пробная сериализация", scanResult.diagnostics.serialization_sample_ms],
                  ["Сканирование целиком", scanResult.diagnostics.elapsed_ms],
                  ["Запрос из WebView2", scanResult.ipc_roundtrip_ms],
                ] as const).map(([label, time]) => (
                  <div key={label}><dt className="text-[var(--nexus-muted)]">{label}</dt><dd>{time === undefined ? "—" : `${time.toFixed(1)} мс`}</dd></div>
                ))}
              </dl>
            </details>
          )}

        </div>
      )}
      </div></div>}
      {view === "smart" && <section className="nexus-panel avs-smart-panel p-4">
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
          <p className="mt-3 text-sm text-[#aebfdb]">{diskHealthLoading ? "Чтение параметров S.M.A.R.T. контроллера…" : "Нет доступных показаний S.M.A.R.T."}</p>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {diskHealth.map((disk, idx) => {
              const hasSmart = disk.health_percent !== null && disk.health_percent !== undefined;
              const percent = hasSmart ? disk.health_percent! : 0;
              const tone = !hasSmart
                ? "bg-[#202B38]"
                : percent >= 80
                ? "bg-gradient-to-r from-[#00D5E8] to-[#36AFC0]"
                : percent >= 50
                ? "bg-amber-400"
                : "bg-rose-400";
              const diskKey =
                disk.device_id != null
                  ? `disk-${disk.device_id}`
                  : disk.serial_number
                  ? `sn-${disk.serial_number}`
                  : `${disk.model}-${disk.kind}-${idx}`;
              return (
                <div
                  key={diskKey}
                  className="rounded-lg border border-[#202B38] bg-[#0B0E14] p-3.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#E5EDF5]">{disk.model}</div>
                      {(disk.firmware || disk.device_id != null || disk.available_spare != null) && (
                        <div className="font-mono text-[10px] text-[#526170]">
                          {disk.device_id != null ? `Диск #${disk.device_id}` : ""}
                          {disk.firmware
                            ? `${disk.device_id != null ? " · " : ""}Прошивка: ${disk.firmware}`
                            : ""}
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
                        {hasSmart ? `${percent}%` : disk.health_label || "Недоступно"}
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
      </section>}
    </motion.div>
  );
}
