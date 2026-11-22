import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type DriveVolumeInfo,
  type FileEntry,
  type ScanResult,
} from "../lib/studio";

function volumeKey(path: string) { return path.trim().replace(/[\\/]+$/g, "").toUpperCase(); }

export type StorageSortBy = "size" | "name";

export interface ScanStats {
  totalScannedBytes: number;
  totalFilesCount: number;
  categorySizes: [string, number][];
}

export interface LargeFilesState {
  fileSearchQuery: string;
  activeTypeFilter: string;
  storageSortBy: StorageSortBy;
}

/**
 * Изолированный секундомер сканирования диска.
 * Вызывается локально внутри плашки/кнопки прогресса сканирования,
 * чтобы тики таймера не вызывали ре-рендер App и остальных вкладок.
 */
export function useStorageScanElapsed(isScanning: boolean, startedAt?: number | null): number {
  const [scanElapsedSec, setScanElapsedSec] = useState<number>(0);

  useEffect(() => {
    if (!isScanning) {
      setScanElapsedSec(0);
      return;
    }
    const start = startedAt ?? Date.now();
    setScanElapsedSec(Math.floor((Date.now() - start) / 1000));
    const timer = window.setInterval(() => {
      setScanElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isScanning, startedAt]);

  return scanElapsedSec;
}

export function useStorageScanner(volume: string, options?: { isolateTimer?: boolean }) {
  const isolateTimer = options?.isolateTimer ?? false;

  const [availableDrives, setAvailableDrives] = useState<DriveVolumeInfo[]>([]);
  const [drivesLoading, setDrivesLoading] = useState(true);
  const [drivesError, setDrivesError] = useState<string | null>(null);
  const scannedDrive = volume || availableDrives[0]?.mount_point || "";
  const selectedDriveRef = useRef<string>(scannedDrive);
  selectedDriveRef.current = scannedDrive;

  const [snapshots, setSnapshots] = useState<ScanResult[]>([]);
  const storageData = snapshots.find(scan => volumeKey(scan.target_path) === volumeKey(scannedDrive)) ?? null;
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null);
  const [scanTarget, setScanTarget] = useState("");
  const [scanCancelled, setScanCancelled] = useState(false);
  const [isCancellingScan, setIsCancellingScan] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [fileSearchQuery, setFileSearchQuery] = useState<string>("");
  const [activeTypeFilter, setActiveTypeFilter] = useState<string>("all");
  const [storageSortBy, setStorageSortBy] = useState<StorageSortBy>("size");

  const scanRequestIdRef = useRef<number>(0);
  const scanning = useRef(false);
  const cancelling = useRef(false);
  const fetchingDrives = useRef(false);

  // Если хук используется напрямую без изоляции таймера в дочерней плашке,
  // секундомер работает внутри самого хука; при агрегации в корневом контроллере
  // Тики изолированы в компоненте плашки прогресса при работе через контроллер.
  const scanElapsedSec = useStorageScanElapsed(!isolateTimer && isScanning, scanStartedAt);

  const fetchAvailableDrives = useCallback(async () => {
    if (fetchingDrives.current) return;
    fetchingDrives.current = true;
    setDrivesLoading(true);
    setDrivesError(null);
    try {
      const drives = await invoke<DriveVolumeInfo[]>("get_available_drives");
      setAvailableDrives(drives);
    } catch (err) {
      console.error("Ошибка получения списка дисков:", err);
      setDrivesError(String(err));
    } finally {
      fetchingDrives.current = false;
      setDrivesLoading(false);
    }
  }, []);

  const handleStartStorageScan = useCallback(
    async (targetPathOverride?: string, profile = false) => {
      const pathToScan = (targetPathOverride ?? selectedDriveRef.current).trim();
      if (!pathToScan || scanning.current || cancelling.current) return;

      const reqId = ++scanRequestIdRef.current;
      scanning.current = true;
      setIsScanning(true);
      setScanStartedAt(Date.now());
      setScanTarget(pathToScan);
      setScanCancelled(false);
      setScanError(null);

      try {
        const started = performance.now();
        const res = await invoke<ScanResult>("scan_storage", { path: pathToScan, profile });
        if (res.diagnostics) res.ipc_roundtrip_ms = performance.now() - started;
        if (scanRequestIdRef.current !== reqId) {
          return;
        }
        setSnapshots(previous => [
          res, ...previous.filter(scan => volumeKey(scan.target_path) !== volumeKey(res.target_path)),
        ].slice(0, 2));
      } catch (err) {
        if (scanRequestIdRef.current !== reqId) return;
        const msg = String(err);
        if (msg.includes("SCAN_CANCELLED")) {
          setScanCancelled(true);
          return;
        }
        console.error("Ошибка сканирования диска:", err);
        setScanError(msg);
      } finally {
        if (scanRequestIdRef.current === reqId) {
          scanning.current = false;
          setIsScanning(false);
        }
      }
    },
    []
  );

  const handleCancelStorageScan = useCallback(async () => {
    if (!scanning.current) return true;
    if (cancelling.current) return false;
    cancelling.current = true;
    setIsCancellingScan(true);
    setScanError(null);
    try {
      await invoke("cancel_storage_scan", { scanId: null });
      if (scanning.current) {
        scanRequestIdRef.current += 1;
        scanning.current = false;
        setIsScanning(false);
        setScanCancelled(true);
      }
      return true;
    } catch (err) {
      console.error("Ошибка отмены сканирования диска:", err);
      setScanError(`Не удалось остановить сканирование: ${String(err)}`);
      return false;
    } finally {
      cancelling.current = false;
      setIsCancellingScan(false);
    }
  }, []);

  const handleOpenFolder = useCallback(async (path: string) => {
    try {
      await invoke("open_item_location", { path });
    } catch (err) {
      console.error("Ошибка открытия пути в проводнике:", err);
      setScanError(String(err));
    }
  }, []);

  const scanStats = useMemo<ScanStats | null>(() => {
    if (!storageData) return null;
    return {
      totalScannedBytes: storageData.total_scanned_bytes,
      totalFilesCount: storageData.total_files_count,
      categorySizes: storageData.category_sizes,
    };
  }, [storageData]);

  const topFiles = useMemo<FileEntry[]>(() => {
    return storageData?.top_files ?? [];
  }, [storageData]);

  const largeFilesState = useMemo<LargeFilesState>(
    () => ({
      fileSearchQuery,
      activeTypeFilter,
      storageSortBy,
    }),
    [fileSearchQuery, activeTypeFilter, storageSortBy]
  );

  // Мемоизация фильтрации ТОП-100 файлов по [topFiles, fileSearchQuery, activeTypeFilter]
  const filteredTopFiles = useMemo<FileEntry[]>(() => {
    const q = fileSearchQuery.trim().toLowerCase();
    const filter = activeTypeFilter.trim().toLowerCase();
    return topFiles.filter((f) => {
      if (filter && filter !== "all") {
        const extMatch = f.extension.toLowerCase() === filter;
        const labelMatch = f.app_label.toLowerCase() === filter;
        if (!extMatch && !labelMatch) return false;
      }
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        f.extension.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q)
      );
    });
  }, [topFiles, fileSearchQuery, activeTypeFilter]);

  return {
    // Основные состояния и методы по спецификации useStorageScanner
    storageData,
    scannedDrive,
    scanStats,
    isScanning,
    setIsScanning,
    scanElapsedSec,
    topFiles,
    largeFilesState,
    storageSortBy,
    setStorageSortBy,
    fileSearchQuery,
    setFileSearchQuery,
    activeTypeFilter,
    setActiveTypeFilter,
    handleStartStorageScan,
    handleCancelStorageScan,
    handleOpenFolder,
    fetchAvailableDrives,

    // Совместимые поля и алиасы для useNexusController / StorageModule
    availableDrives,
    drivesLoading,
    drivesError,
    isCancellingScan,
    scanStartedAt,
    scanTarget,
    scanCancelled,
    setAvailableDrives,
    selectedDriveOrPath: scannedDrive,
    scanResult: storageData,
    scanError,
    setScanError,
    fileSearch: fileSearchQuery,
    setFileSearch: setFileSearchQuery,
    handleOpenPathInExplorer: handleOpenFolder,
    filteredTopFiles,
  };
}
