import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type DriveVolumeInfo,
  type FileEntry,
  type FolderNode,
  type ScanResult,
  type TreemapRect,
  computeTreemapRects,
} from "../lib/studio";

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
 * Изолированный 10 Гц (100 мс) таймер секундомера сканирования диска.
 * Вызывается локально внутри плашки/кнопки прогресса сканирования,
 * чтобы тики таймера не вызывали ре-рендер App и остальных вкладок.
 */
export function useStorageScanElapsed(isScanning: boolean): number {
  const [scanElapsedSec, setScanElapsedSec] = useState<number>(0);

  useEffect(() => {
    if (!isScanning) {
      setScanElapsedSec(0);
      return;
    }
    const start = Date.now();
    const timer = window.setInterval(() => {
      setScanElapsedSec((Date.now() - start) / 1000);
    }, 100);
    return () => window.clearInterval(timer);
  }, [isScanning]);

  return scanElapsedSec;
}

export function useStorageScanner(options?: { isolateTimer?: boolean }) {
  const isolateTimer = options?.isolateTimer ?? false;

  const [availableDrives, setAvailableDrives] = useState<DriveVolumeInfo[]>([
    { mount_point: "C:\\", total_bytes: 0, available_bytes: 0 },
  ]);
  const [scannedDrive, setScannedDrive] = useState<string>("C:\\");
  const selectedDriveRef = useRef<string>(scannedDrive);
  selectedDriveRef.current = scannedDrive;

  const [storageData, setStorageData] = useState<ScanResult | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [treemapStack, setTreemapStack] = useState<FolderNode[]>([]);
  const [selectedTreemapNode, setSelectedTreemapNode] = useState<FolderNode | null>(null);

  const [fileSearchQuery, setFileSearchQuery] = useState<string>("");
  const [activeTypeFilter, setActiveTypeFilter] = useState<string>("all");
  const [storageSortBy, setStorageSortBy] = useState<StorageSortBy>("size");

  const scanRequestIdRef = useRef<number>(0);

  // Если хук используется напрямую без изоляции таймера в дочерней плашке,
  // секундомер работает внутри самого хука; при агрегации в корневом контроллере
  // 10 Гц тики изолированы в компоненте плашки прогресса через useStorageScanElapsed.
  const scanElapsedSec = useStorageScanElapsed(!isolateTimer && isScanning);

  const fetchAvailableDrives = useCallback(async () => {
    try {
      const drives = await invoke<DriveVolumeInfo[]>("get_available_drives");
      if (drives && drives.length > 0) {
        setAvailableDrives(drives);
        setScannedDrive((prev) => (prev ? prev : drives[0].mount_point));
      }
    } catch (err) {
      console.error("Ошибка получения списка дисков:", err);
    }
  }, []);

  const handleStartStorageScan = useCallback(
    async (targetPathOverride?: string) => {
      const pathToScan = (targetPathOverride ?? selectedDriveRef.current).trim();
      if (!pathToScan || isScanning) return;

      const reqId = ++scanRequestIdRef.current;
      setIsScanning(true);
      setScanError(null);
      setStorageData(null);

      try {
        const res = await invoke<ScanResult>("scan_storage", { path: pathToScan });
        if (scanRequestIdRef.current !== reqId) {
          return;
        }
        const current = selectedDriveRef.current.trim().replace(/[\\/]+$/g, "").toUpperCase();
        const scanned = res.target_path.trim().replace(/[\\/]+$/g, "").toUpperCase();
        if (current.slice(0, 2) !== scanned.slice(0, 2)) {
          return;
        }
        setStorageData(res);
        setTreemapStack([res.root_node]);
        setSelectedTreemapNode(res.root_node.children[0] ?? res.root_node);
      } catch (err) {
        if (scanRequestIdRef.current !== reqId) return;
        console.error("Ошибка сканирования диска:", err);
        setScanError(String(err));
      } finally {
        if (scanRequestIdRef.current === reqId) {
          setIsScanning(false);
        }
      }
    },
    [isScanning]
  );

  const handleCancelStorageScan = useCallback(() => {
    scanRequestIdRef.current += 1;
    setIsScanning(false);
  }, []);

  const handleOpenFolder = useCallback(async (path: string) => {
    try {
      await invoke("open_item_location", { path });
    } catch (err) {
      console.error("Ошибка открытия пути в проводнике:", err);
      setScanError(String(err));
    }
  }, []);

  const handleDeleteFile = useCallback((path: string) => {
    setStorageData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        top_files: prev.top_files.filter((file) => file.path !== path),
      };
    });
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

  const currentTreemapRoot = useMemo<FolderNode | null>(() => {
    if (treemapStack.length > 0) {
      return treemapStack[treemapStack.length - 1];
    }
    return storageData?.root_node ?? null;
  }, [treemapStack, storageData]);

  // Мемоизация расчёта прямоугольников Treemap по [storageData, storageSortBy, currentTreemapRoot]
  const treemapRects = useMemo<TreemapRect[]>(() => {
    const root = currentTreemapRoot ?? storageData?.root_node ?? null;
    if (!root) return [];
    const sortedChildren =
      storageSortBy === "name"
        ? [...root.children].sort((a, b) => a.name.localeCompare(b.name, "ru"))
        : root.children;
    return computeTreemapRects(sortedChildren);
  }, [storageData, storageSortBy, currentTreemapRoot]);

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
    setStorageData,
    scannedDrive,
    setScannedDrive,
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
    handleDeleteFile,
    fetchAvailableDrives,

    // Совместимые поля и алиасы для useNexusController / StorageModule
    availableDrives,
    setAvailableDrives,
    selectedDriveOrPath: scannedDrive,
    setSelectedDriveOrPath: setScannedDrive,
    scanResult: storageData,
    setScanResult: setStorageData,
    scanError,
    setScanError,
    treemapStack,
    setTreemapStack,
    selectedTreemapNode,
    setSelectedTreemapNode,
    fileSearch: fileSearchQuery,
    setFileSearch: setFileSearchQuery,
    handleOpenPathInExplorer: handleOpenFolder,
    currentTreemapRoot,
    treemapRects,
    filteredTopFiles,
  };
}
