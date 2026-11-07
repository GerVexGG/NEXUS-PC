import { useState, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CleanupCategory, CleanupReport } from "../lib/studio";

export interface CleanupProgressState {
  isAnalyzing: boolean;
  isCleaning: boolean;
}

export function useCleanupCenter(isElevatedAdmin: boolean) {
  const [cleanupCategories, setCleanupCategories] = useState<CleanupCategory[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [isScanningCleanup, setIsScanningCleanup] = useState<boolean>(false);
  const [isCleaning, setIsCleaning] = useState<boolean>(false);
  const [confirmCleanupOpen, setConfirmCleanupOpen] = useState<boolean>(false);
  const [lastCleanupResult, setLastCleanupResult] = useState<CleanupReport | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const cleanupProgress = useMemo<CleanupProgressState>(
    () => ({
      isAnalyzing: isScanningCleanup,
      isCleaning,
    }),
    [isScanningCleanup, isCleaning]
  );

  const handleAnalyzeCleanup = useCallback(async () => {
    if (isScanningCleanup || isCleaning) return;
    setIsScanningCleanup(true);
    setCleanupError(null);
    setConfirmCleanupOpen(false);
    try {
      const categories = await invoke<CleanupCategory[]>("scan_cleanup_targets");
      setCleanupCategories(categories);
      // По умолчанию отмечаем все непустые категории (кроме требующих прав админа, если нет админки)
      const autoSelect = categories
        .filter(
          (c) =>
            c.size_bytes > 0 &&
            c.id !== "recycle_bin" &&
            c.id !== "windows_update" &&
            (!c.requires_admin || isElevatedAdmin)
        )
        .map((c) => c.id);
      setSelectedCategories(autoSelect.length > 0 ? autoSelect : []);
    } catch (err) {
      console.error("Ошибка сканирования категорий очистки:", err);
      setCleanupError(String(err));
    } finally {
      setIsScanningCleanup(false);
    }
  }, [isScanningCleanup, isCleaning, isElevatedAdmin]);

  const toggleCategorySelection = useCallback((id: string) => {
    setConfirmCleanupOpen(false);
    setSelectedCategories((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }, []);

  const handleRunCleanup = useCallback(async () => {
    if (selectedCategories.length === 0 || isCleaning) return;
    setIsCleaning(true);
    setCleanupError(null);
    setConfirmCleanupOpen(false);
    try {
      const report = await invoke<CleanupReport>("execute_cleanup", {
        categoryIds: selectedCategories,
      });
      setLastCleanupResult(report);
      // Обновляем размеры категорий после завершения очистки
      const refreshed = await invoke<CleanupCategory[]>("scan_cleanup_targets");
      setCleanupCategories(refreshed);
    } catch (err) {
      console.error("Ошибка выполнения очистки:", err);
      setCleanupError(String(err));
    } finally {
      setIsCleaning(false);
    }
  }, [selectedCategories, isCleaning]);

  const totalCleanupBytes = useMemo(
    () => cleanupCategories.reduce((acc, cat) => acc + cat.size_bytes, 0),
    [cleanupCategories]
  );

  const selectedCleanupCategories = useMemo(
    () => cleanupCategories.filter((cat) => selectedCategories.includes(cat.id)),
    [cleanupCategories, selectedCategories]
  );

  const selectedCleanupBytes = useMemo(
    () => selectedCleanupCategories.reduce((acc, cat) => acc + cat.size_bytes, 0),
    [selectedCleanupCategories]
  );

  const selectedCleanupFilesCount = useMemo(
    () => selectedCleanupCategories.reduce((acc, cat) => acc + cat.files_count, 0),
    [selectedCleanupCategories]
  );

  return {
    // Основные состояния и методы по спецификации useCleanupCenter
    cleanupCategories,
    setCleanupCategories,
    selectedCategories,
    setSelectedCategories,
    isCleaning,
    setIsCleaning,
    cleanupProgress,
    lastCleanupResult,
    setLastCleanupResult,
    handleAnalyzeCleanup,
    handleRunCleanup,
    toggleCategorySelection,

    // Совместимые поля и алиасы для useNexusController / CleanupModule
    selectedCleanupIds: selectedCategories,
    setSelectedCleanupIds: setSelectedCategories,
    isScanningCleanup,
    setIsScanningCleanup,
    confirmCleanupOpen,
    setConfirmCleanupOpen,
    cleanupReport: lastCleanupResult,
    setCleanupReport: setLastCleanupResult,
    cleanupError,
    setCleanupError,
    handleScanCleanup: handleAnalyzeCleanup,
    handleToggleCleanupCategory: toggleCategorySelection,
    handleExecuteCleanup: handleRunCleanup,
    totalCleanupBytes,
    selectedCleanupCategories,
    selectedCleanupBytes,
    selectedCleanupFilesCount,
  };
}
