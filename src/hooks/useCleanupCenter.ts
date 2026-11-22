import { useState, useMemo, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CleanupCategory, CleanupReport } from "../lib/studio";
import { canSelectCleanup, recommendedCleanupIds } from "../lib/cleanupSelection";

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
  const busy = useRef(false);

  const cleanupProgress = useMemo<CleanupProgressState>(
    () => ({
      isAnalyzing: isScanningCleanup,
      isCleaning,
    }),
    [isScanningCleanup, isCleaning]
  );

  const handleAnalyzeCleanup = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setIsScanningCleanup(true);
    setCleanupError(null);
    setConfirmCleanupOpen(false);
    try {
      const categories = await invoke<CleanupCategory[]>("scan_cleanup_targets");
      setCleanupCategories(categories);
      setSelectedCategories(recommendedCleanupIds(categories, isElevatedAdmin));
      setLastCleanupResult(null);
    } catch (err) {
      console.error("Ошибка сканирования категорий очистки:", err);
      setCleanupError(String(err));
    } finally {
      busy.current = false;
      setIsScanningCleanup(false);
    }
  }, [isElevatedAdmin]);

  const toggleCategorySelection = useCallback((id: string) => {
    const category = cleanupCategories.find((entry) => entry.id === id);
    if (busy.current || !category || !canSelectCleanup(category, isElevatedAdmin)) return;
    setConfirmCleanupOpen(false);
    setSelectedCategories((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }, [cleanupCategories, isElevatedAdmin]);

  const handleRunCleanup = useCallback(async () => {
    if (busy.current) return;
    const included = cleanupCategories.filter((category) =>
      selectedCategories.includes(category.id) && canSelectCleanup(category, isElevatedAdmin)
    );
    if (included.length === 0) return;
    busy.current = true;
    setIsCleaning(true);
    setCleanupError(null);
    setConfirmCleanupOpen(false);
    try {
      const report = await invoke<CleanupReport>("execute_cleanup", {
        categoryIds: included.map((category) => category.id),
      });
      setLastCleanupResult(report);
      // Обновляем размеры категорий после завершения очистки
      const refreshed = await invoke<CleanupCategory[]>("scan_cleanup_targets");
      setCleanupCategories(refreshed);
      setSelectedCategories((prev) => prev.filter((id) =>
        refreshed.some((category) => category.id === id && canSelectCleanup(category, isElevatedAdmin))
      ));
    } catch (err) {
      console.error("Ошибка выполнения очистки:", err);
      setCleanupError(String(err));
    } finally {
      busy.current = false;
      setIsCleaning(false);
    }
  }, [cleanupCategories, isElevatedAdmin, selectedCategories]);

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
