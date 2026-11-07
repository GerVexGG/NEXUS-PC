import { useState, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StartupItem } from "../lib/studio";

export type StartupFilterType = "all" | "on" | "off";

export function useStartupManager() {
  const [startupItems, setStartupItems] = useState<StartupItem[]>([]);
  const [startupSearch, setStartupSearch] = useState<string>("");
  const [startupFilter, setStartupFilter] = useState<StartupFilterType>("all");
  const [startupLoading, setStartupLoading] = useState<boolean>(false);
  const [startupError, setStartupError] = useState<string | null>(null);

  const fetchStartupItems = useCallback(async () => {
    setStartupLoading(true);
    setStartupError(null);
    try {
      const items = await invoke<StartupItem[]>("get_startup_items");
      setStartupItems(items);
    } catch (err) {
      console.error("Ошибка чтения автозагрузки:", err);
      setStartupError(String(err));
    } finally {
      setStartupLoading(false);
    }
  }, []);

  const handleToggleStartupItem = useCallback(async (item: StartupItem) => {
    if (
      item.phantom ||
      (!item.id.startsWith("reg|") &&
        !item.id.startsWith("dir|") &&
        !item.id.startsWith("folder|") &&
        !item.id.startsWith("msix|"))
    ) {
      return;
    }
    const nextEnabled = !item.enabled;
    setStartupError(null);

    setStartupItems((prev) =>
      prev.map((entry) =>
        entry.id === item.id ? { ...entry, enabled: nextEnabled } : entry
      )
    );

    try {
      await invoke("toggle_startup_item", {
        id: item.id,
        enable: nextEnabled,
      });
    } catch (err) {
      console.error("Ошибка переключения автозагрузки:", err);
      setStartupError(String(err));
      setStartupItems((prev) =>
        prev.map((entry) =>
          entry.id === item.id ? { ...entry, enabled: item.enabled } : entry
        )
      );
    }
  }, []);

  const handleDeleteStartupItem = useCallback(async (item: StartupItem) => {
    setStartupError(null);
    try {
      await invoke("remove_startup_entry", {
        entryId: item.id,
        source: item.location,
      });
      setStartupItems((prev) => prev.filter((entry) => entry.id !== item.id));
    } catch (err) {
      console.error("Ошибка удаления записи автозагрузки:", err);
      setStartupError(String(err));
    }
  }, []);

  const handleOpenItemLocation = useCallback(async (item: StartupItem) => {
    setStartupError(null);
    try {
      await invoke("open_item_location", {
        path: item.clean_path || item.command,
      });
    } catch (err) {
      console.error("Ошибка открытия папки:", err);
      setStartupError(String(err));
    }
  }, []);

  const totalStartupCount = useMemo(() => startupItems.length, [startupItems]);
  const activeStartupCount = useMemo(
    () => startupItems.filter((i) => i.enabled).length,
    [startupItems]
  );
  const brokenStartupCount = useMemo(
    () => startupItems.filter((i) => !i.file_exists).length,
    [startupItems]
  );

  // Мемоизация фильтрации автозагрузки по [startupItems, startupSearch, startupFilter]
  const filteredStartupItems = useMemo<StartupItem[]>(() => {
    const q = startupSearch.trim().toLowerCase();
    return startupItems.filter((item) => {
      if (startupFilter === "on" && (!item.enabled || item.phantom)) {
        return false;
      }
      if (startupFilter === "off" && (item.enabled || item.phantom)) {
        return false;
      }
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.clean_path.toLowerCase().includes(q) ||
        item.location.toLowerCase().includes(q)
      );
    });
  }, [startupItems, startupSearch, startupFilter]);

  return {
    // Основные состояния и методы по спецификации useStartupManager
    startupItems,
    setStartupItems,
    startupSearch,
    setStartupSearch,
    startupFilter,
    setStartupFilter,
    startupLoading,
    setStartupLoading,
    startupError,
    setStartupError,
    fetchStartupItems,
    handleToggleStartupItem,
    handleDeleteStartupItem,
    handleOpenItemLocation,

    // Совместимые поля и алиасы для useNexusController / StartupModule
    handleToggleStartup: handleToggleStartupItem,
    handleRemoveStartup: handleDeleteStartupItem,
    totalStartupCount,
    activeStartupCount,
    brokenStartupCount,
    filteredStartupItems,
  };
}
