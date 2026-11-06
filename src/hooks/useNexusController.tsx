import { useState, useEffect, useRef, type MouseEvent } from "react";
import {
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CleanupCategory,
  CleanupReport,
  FolderNode,
  HISTORY_LENGTH,
  HardwareTelemetry,
  HistoryPoint,
  Metrics,
  PROCESS_REFRESH_MS,
  ProcessContextMenuState,
  ProcessItem,
  ProcessSortKey,
  ScanResult,
  StartupItem,
  StoredTimerState,
  TIMER_STORAGE_KEY,
  computeTreemapRects,
  copyTextToClipboard,
  createInitialHistory,
  formatSpeedParts,
  getLoadBarStyles,
  getPingHudStyle,
  getTempBadgeStyle,
} from "../lib/studio";

export function useNexusController() {
  const [activeTab, setActiveTab] = useState<
    "dashboard" | "startup" | "storage" | "hardware" | "cleanup" | "power" | "processes"
  >("dashboard");
  const [metrics, setMetrics] = useState<Metrics>({
    cpu_usage: 0,
    ram_used_gb: 0,
    ram_total_gb: 0,
    ram_percentage: 0,
    swap_used_gb: 0,
    swap_total_gb: 0,
    disk_free_gb: 0,
    disk_total_gb: 0,
    net_rx_kbps: 0,
    net_tx_kbps: 0,
    net_ping_ms: 0,
  });
  const [history, setHistory] = useState<HistoryPoint[]>(createInitialHistory);

  // Состояние кастомного тайтлбара и привилегий процесса
  const [isElevatedAdmin, setIsElevatedAdmin] = useState<boolean>(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState<boolean>(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  // Состояние модуля Startup Manager (Автозагрузка)
  const [startupItems, setStartupItems] = useState<StartupItem[]>([]);
  const [startupSearch, setStartupSearch] = useState<string>("");
  const [startupLoading, setStartupLoading] = useState<boolean>(false);
  const [startupError, setStartupError] = useState<string | null>(null);

  // Состояние модуля Storage Analyzer (Анализатор накопителей)
  const [availableDrives, setAvailableDrives] = useState<string[]>(["C:\\"]);
  const [selectedDriveOrPath, setSelectedDriveOrPath] = useState<string>("C:\\");
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanElapsedSec, setScanElapsedSec] = useState<number>(0);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [treemapStack, setTreemapStack] = useState<FolderNode[]>([]);
  const [selectedTreemapNode, setSelectedTreemapNode] = useState<FolderNode | null>(
    null
  );
  const [fileSearch, setFileSearch] = useState<string>("");

  // Состояние модуля Hardware Monitor (Мониторинг железа)
  const [hwData, setHwData] = useState<HardwareTelemetry | null>(null);

  // Состояние модуля Cleanup Center (Безопасная очистка накопителя)
  const [cleanupCategories, setCleanupCategories] = useState<CleanupCategory[]>([]);
  const [selectedCleanupIds, setSelectedCleanupIds] = useState<string[]>([]);
  const [isScanningCleanup, setIsScanningCleanup] = useState<boolean>(false);
  const [isCleaning, setIsCleaning] = useState<boolean>(false);
  const [confirmCleanupOpen, setConfirmCleanupOpen] = useState<boolean>(false);
  const [cleanupReport, setCleanupReport] = useState<CleanupReport | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  // Состояние модуля Process Explorer (Диспетчер процессов)
  const [processes, setProcesses] = useState<ProcessItem[]>([]);
  const [processSearch, setProcessSearch] = useState<string>("");
  const [processAutoRefresh, setProcessAutoRefresh] = useState<boolean>(true);
  const [processSortKey, setProcessSortKey] = useState<ProcessSortKey>("cpu");
  const [processSortDesc, setProcessSortDesc] = useState<boolean>(true);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processNotice, setProcessNotice] = useState<string | null>(null);
  const [processLoading, setProcessLoading] = useState<boolean>(false);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [suspendedPids, setSuspendedPids] = useState<number[]>([]);
  const [processMenu, setProcessMenu] = useState<ProcessContextMenuState | null>(null);
  const processMenuRef = useRef<ProcessContextMenuState | null>(null);
  processMenuRef.current = processMenu;

  // Состояние модуля управления питанием
  const [restartMode, setRestartMode] = useState<boolean>(false);
  const [customMinutes, setCustomMinutes] = useState<string>("");
  const [timerState, setTimerState] = useState<StoredTimerState | null>(() => {
    try {
      const raw = localStorage.getItem(TIMER_STORAGE_KEY);
      if (!raw) return null;
      const parsed: StoredTimerState = JSON.parse(raw);
      if (parsed.endTime > Date.now()) {
        return parsed;
      }
      localStorage.removeItem(TIMER_STORAGE_KEY);
      return null;
    } catch {
      return null;
    }
  });
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() => {
    if (!timerState) return 0;
    return Math.max(0, Math.ceil((timerState.endTime - Date.now()) / 1000));
  });
  const [powerError, setPowerError] = useState<string | null>(null);

  // Проверка прав Администратора при старте приложения
  useEffect(() => {
    invoke<boolean>("is_elevated_admin")
      .then((elevated) => setIsElevatedAdmin(Boolean(elevated)))
      .catch((err) => console.error("Ошибка проверки прав администратора:", err));
  }, []);

  // Глобальные горячие клавиши: F11 — полноэкранный режим, Escape — выход из Fullscreen
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key !== "F11" && e.key !== "Escape") return;
      try {
        const win = getCurrentWindow();
        const isFullscreen = await win.isFullscreen();
        if (e.key === "F11") {
          e.preventDefault();
          await win.setFullscreen(!isFullscreen);
        } else if (isFullscreen && !processMenuRef.current) {
          e.preventDefault();
          await win.setFullscreen(false);
        }
      } catch (err) {
        console.error("Ошибка переключения полноэкранного режима:", err);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Опрос списка процессов (Process Explorer) с интервалом автообновления
  const fetchProcesses = async () => {
    try {
      const list = await invoke<ProcessItem[]>("get_process_list");
      setProcesses(list);
      setProcessError(null);
      // Убираем из списка замороженных PID, которых больше не существует
      setSuspendedPids((prev) => prev.filter((pid) => list.some((p) => p.pid === pid)));
    } catch (err) {
      console.error("Ошибка получения списка процессов:", err);
      setProcessError(String(err));
    } finally {
      setProcessLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "processes") return;
    if (processes.length === 0) setProcessLoading(true);
    fetchProcesses();
    if (!processAutoRefresh) return;
    const interval = setInterval(fetchProcesses, PROCESS_REFRESH_MS);
    return () => clearInterval(interval);
  }, [activeTab, processAutoRefresh]);

  // Закрытие контекстного меню по клику вне области, Escape, прокрутке или смене вкладки
  useEffect(() => {
    if (!processMenu) return;
    const close = () => setProcessMenu(null);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [processMenu]);

  useEffect(() => {
    setProcessMenu(null);
  }, [activeTab]);

  const showProcessNotice = (msg: string) => {
    setProcessNotice(msg);
    setTimeout(() => setProcessNotice((cur) => (cur === msg ? null : cur)), 2600);
  };

  const handleProcessContextMenu = (e: MouseEvent<HTMLDivElement>, proc: ProcessItem) => {
    e.preventDefault();
    e.stopPropagation();
    const MENU_W = 248;
    const MENU_H = 250;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    setSelectedPid(proc.pid);
    setProcessMenu({ x: Math.max(8, x), y: Math.max(8, y), process: proc });
  };

  const handleProcessSort = (key: ProcessSortKey) => {
    if (processSortKey === key) {
      setProcessSortDesc((prev) => !prev);
    } else {
      setProcessSortKey(key);
      setProcessSortDesc(key !== "name");
    }
  };

  const handleProcessOpenLocation = async (proc: ProcessItem) => {
    setProcessMenu(null);
    if (!proc.exe_path) {
      setProcessError(`Путь к файлу процесса ${proc.name} недоступен (требуются права Администратора)`);
      return;
    }
    try {
      await invoke("open_item_location", { path: proc.exe_path });
    } catch (err) {
      setProcessError(String(err));
    }
  };

  const handleProcessCopyPath = async (proc: ProcessItem) => {
    setProcessMenu(null);
    const text = proc.exe_path || proc.name;
    await copyTextToClipboard(text);
    showProcessNotice(`Скопировано: ${text}`);
  };

  const handleProcessSuspendToggle = async (proc: ProcessItem) => {
    setProcessMenu(null);
    const isSuspended = suspendedPids.includes(proc.pid);
    try {
      await invoke("suspend_process", { pid: proc.pid, suspend: !isSuspended });
      setSuspendedPids((prev) =>
        isSuspended ? prev.filter((p) => p !== proc.pid) : [...prev, proc.pid]
      );
      showProcessNotice(
        isSuspended
          ? `Процесс ${proc.name} (PID ${proc.pid}) возобновлён`
          : `Процесс ${proc.name} (PID ${proc.pid}) заморожен`
      );
    } catch (err) {
      setProcessError(String(err));
    }
  };

  const handleProcessKill = async (proc: ProcessItem, tree: boolean) => {
    setProcessMenu(null);
    try {
      await invoke("kill_process", { pid: proc.pid, tree });
      setProcesses((prev) => prev.filter((p) => p.pid !== proc.pid));
      showProcessNotice(
        tree
          ? `Дерево процессов ${proc.name} (PID ${proc.pid}) завершено`
          : `Процесс ${proc.name} (PID ${proc.pid}) завершён`
      );
      setTimeout(fetchProcesses, 400);
    } catch (err) {
      setProcessError(String(err));
    }
  };

  // Обработчики безрамочного окна (Frameless Window Controls)
  const handleWindowMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (err) {
      console.error("Ошибка сворачивания окна:", err);
    }
  };

  const handleWindowToggleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch (err) {
      console.error("Ошибка разворачивания окна:", err);
    }
  };

  const handleWindowClose = async () => {
    try {
      await invoke("app_exit");
    } catch {
      try {
        await getCurrentWindow().close();
      } catch (err) {
        console.error("Ошибка закрытия окна:", err);
      }
    }
  };

  const handleRestartAsAdmin = async () => {
    setAdminError(null);
    setAdminMenuOpen(false);
    try {
      await invoke("restart_as_admin");
    } catch (err) {
      console.error("Ошибка перезапуска от имени Администратора:", err);
      setAdminError(String(err));
    }
  };

  // Обработчик анализа целей очистки (Cleanup Center)
  const handleScanCleanup = async () => {
    if (isScanningCleanup || isCleaning) return;
    setIsScanningCleanup(true);
    setCleanupError(null);
    setConfirmCleanupOpen(false);
    try {
      const categories = await invoke<CleanupCategory[]>("scan_cleanup_targets");
      setCleanupCategories(categories);
      // По умолчанию отмечаем все непустые категории (кроме требующих прав админа, если нет админки)
      const autoSelect = categories
        .filter((c) => c.size_bytes > 0 && (!c.requires_admin || isElevatedAdmin))
        .map((c) => c.id);
      setSelectedCleanupIds(
        autoSelect.length > 0 ? autoSelect : categories.map((c) => c.id)
      );
    } catch (err) {
      console.error("Ошибка сканирования категорий очистки:", err);
      setCleanupError(String(err));
    } finally {
      setIsScanningCleanup(false);
    }
  };

  const handleToggleCleanupCategory = (id: string) => {
    setConfirmCleanupOpen(false);
    setSelectedCleanupIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleExecuteCleanup = async () => {
    if (selectedCleanupIds.length === 0 || isCleaning) return;
    setIsCleaning(true);
    setCleanupError(null);
    setConfirmCleanupOpen(false);
    try {
      const report = await invoke<CleanupReport>("execute_cleanup", {
        categoryIds: selectedCleanupIds,
      });
      setCleanupReport(report);
      // Обновляем размеры категорий после завершения очистки
      const refreshed = await invoke<CleanupCategory[]>("scan_cleanup_targets");
      setCleanupCategories(refreshed);
    } catch (err) {
      console.error("Ошибка выполнения очистки:", err);
      setCleanupError(String(err));
    } finally {
      setIsCleaning(false);
    }
  };

  useEffect(() => {
    // Опрашиваем Rust раз в секунду и пополняем кольцевой буфер на 60 точек
    const fetchMetrics = async () => {
      try {
        const data = await invoke<Metrics>("get_system_metrics");
        setMetrics(data);

        const nowLabel = new Date().toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        setHistory((prev) => {
          const next = prev.slice(-(HISTORY_LENGTH - 1));
          next.push({
            timestamp: nowLabel,
            cpu: data.cpu_usage,
            ram: data.ram_percentage,
          });
          return next;
        });
      } catch (err) {
        console.error("Ошибка чтения метрик:", err);
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 1000);
    return () => clearInterval(interval);
  }, []);

  // Опрос датчиков LibreHardwareMonitor раз в 1 секунду при активной вкладке «Железо»
  useEffect(() => {
    if (activeTab !== "hardware") return;

    const fetchHwTelemetry = async () => {
      try {
        const data = await invoke<HardwareTelemetry>("get_hardware_telemetry");
        setHwData(data);
        if (data.is_admin) {
          setIsElevatedAdmin(true);
        }
      } catch (err) {
        console.error("Ошибка получения аппаратной телеметрии:", err);
      }
    };

    fetchHwTelemetry();
    const interval = setInterval(fetchHwTelemetry, 1000);
    return () => clearInterval(interval);
  }, [activeTab]);

  // Загрузка списка автозагрузки при переходе на вкладку «Автозагрузка»
  const fetchStartupItems = async () => {
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
  };

  useEffect(() => {
    if (activeTab === "startup") {
      fetchStartupItems();
    } else if (activeTab === "storage") {
      invoke<string[]>("get_available_drives")
        .then((drives) => {
          if (drives && drives.length > 0) {
            setAvailableDrives(drives);
            setSelectedDriveOrPath((prev) => (prev ? prev : drives[0]));
          }
        })
        .catch((err) => console.error("Ошибка получения списка дисков:", err));
    } else if (activeTab === "cleanup" && cleanupCategories.length === 0) {
      handleScanCleanup();
    }
  }, [activeTab]);

  // Секундомер ожидания во время многопоточного сканирования диска
  useEffect(() => {
    if (!isScanning) {
      setScanElapsedSec(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setScanElapsedSec((Date.now() - start) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, [isScanning]);

  const handleStartStorageScan = async (targetPathOverride?: string) => {
    const pathToScan = (targetPathOverride ?? selectedDriveOrPath).trim();
    if (!pathToScan || isScanning) return;

    setIsScanning(true);
    setScanError(null);
    try {
      const res = await invoke<ScanResult>("scan_storage", { path: pathToScan });
      setScanResult(res);
      setTreemapStack([res.root_node]);
      setSelectedTreemapNode(res.root_node.children[0] ?? res.root_node);
    } catch (err) {
      console.error("Ошибка сканирования диска:", err);
      setScanError(String(err));
    } finally {
      setIsScanning(false);
    }
  };

  const handleOpenPathInExplorer = async (path: string) => {
    try {
      await invoke("open_item_location", { path });
    } catch (err) {
      console.error("Ошибка открытия пути в проводнике:", err);
      setScanError(String(err));
    }
  };

  const handleToggleStartup = async (item: StartupItem) => {
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
  };

  const handleOpenItemLocation = async (item: StartupItem) => {
    setStartupError(null);
    try {
      await invoke("open_item_location", {
        path: item.clean_path || item.command,
      });
    } catch (err) {
      console.error("Ошибка открытия папки:", err);
      setStartupError(String(err));
    }
  };

  // Живой обратный отсчет таймера (работает независимо от выбранной вкладки Sidebar)
  useEffect(() => {
    if (!timerState) {
      setRemainingSeconds(0);
      return;
    }

    const updateRemaining = () => {
      const diff = Math.ceil((timerState.endTime - Date.now()) / 1000);
      if (diff <= 0) {
        setRemainingSeconds(0);
        setTimerState(null);
        localStorage.removeItem(TIMER_STORAGE_KEY);
      } else {
        setRemainingSeconds(diff);
      }
    };

    updateRemaining();
    const interval = setInterval(updateRemaining, 1000);
    return () => clearInterval(interval);
  }, [timerState]);

  const handleStartTimer = async (minutes: number) => {
    setPowerError(null);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setPowerError("Введите корректное время в минутах (больше 0)");
      return;
    }

    const seconds = Math.round(minutes * 60);
    try {
      await invoke("schedule_shutdown", {
        seconds,
        restart: restartMode,
      });

      const newState: StoredTimerState = {
        endTime: Date.now() + seconds * 1000,
        totalSeconds: seconds,
        restart: restartMode,
      };
      setTimerState(newState);
      setRemainingSeconds(seconds);
      localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(newState));
    } catch (err) {
      console.error("Ошибка при запуске таймера:", err);
      setPowerError(String(err));
    }
  };

  const handleCancelTimer = async () => {
    setPowerError(null);
    try {
      await invoke("cancel_shutdown");
    } catch (err) {
      console.error("Ошибка при отмене таймера:", err);
      setPowerError(String(err));
    } finally {
      setTimerState(null);
      setRemainingSeconds(0);
      localStorage.removeItem(TIMER_STORAGE_KEY);
    }
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const mins = parseFloat(customMinutes);
    if (!isNaN(mins) && mins > 0) {
      handleStartTimer(mins);
      setCustomMinutes("");
    } else {
      setPowerError("Укажите положительное количество минут");
    }
  };

  const timerProgress =
    timerState && timerState.totalSeconds > 0
      ? Math.min(100, Math.max(0, (remainingSeconds / timerState.totalSeconds) * 100))
      : 0;

  const swapPercentage =
    metrics.swap_total_gb > 0
      ? Math.min(100, (metrics.swap_used_gb / metrics.swap_total_gb) * 100)
      : 0;

  const diskUsedPercentage =
    metrics.disk_total_gb > 0
      ? Math.min(
          100,
          ((metrics.disk_total_gb - metrics.disk_free_gb) / metrics.disk_total_gb) * 100
        )
      : 0;

  const isNetworkActive = metrics.net_rx_kbps > 0.1 || metrics.net_tx_kbps > 0.1;
  const isGatewayOnline = metrics.net_ping_ms > 0 && metrics.net_ping_ms < 999;
  const pingStyle = getPingHudStyle(metrics.net_ping_ms);
  const rxParts = formatSpeedParts(metrics.net_rx_kbps);
  const txParts = formatSpeedParts(metrics.net_tx_kbps);
  const rxPulsePct =
    metrics.net_rx_kbps <= 0
      ? 0
      : Math.min(100, Math.max(8, Math.log10(metrics.net_rx_kbps + 1) * 25));
  const txPulsePct =
    metrics.net_tx_kbps <= 0
      ? 0
      : Math.min(100, Math.max(8, Math.log10(metrics.net_tx_kbps + 1) * 25));

  const cpuLoadStyles = getLoadBarStyles(metrics.cpu_usage, "emerald");
  const ramLoadStyles = getLoadBarStyles(metrics.ram_percentage, "cyan");
  const diskLoadStyles = getLoadBarStyles(diskUsedPercentage, "emerald");

  // Статистика и фильтрация автозагрузки
  const totalStartupCount = startupItems.length;
  const activeStartupCount = startupItems.filter((i) => i.enabled).length;
  const brokenStartupCount = startupItems.filter((i) => !i.file_exists).length;

  const filteredStartupItems = startupItems.filter((item) => {
    const q = startupSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      item.name.toLowerCase().includes(q) ||
      item.clean_path.toLowerCase().includes(q) ||
      item.location.toLowerCase().includes(q)
    );
  });

  // Данные текущего уровня Treemap и фильтрация ТОП-100 файлов
  const currentTreemapRoot =
    treemapStack.length > 0
      ? treemapStack[treemapStack.length - 1]
      : scanResult?.root_node ?? null;

  const treemapRects = currentTreemapRoot
    ? computeTreemapRects(currentTreemapRoot.children)
    : [];

  const filteredTopFiles = (scanResult?.top_files ?? []).filter((f) => {
    const q = fileSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      f.name.toLowerCase().includes(q) ||
      f.extension.toLowerCase().includes(q) ||
      f.path.toLowerCase().includes(q)
    );
  });

  // Проверка перегрева для блока предупреждений Hardware Monitor (> 85°C)
  const thermalWarnings: string[] = [];
  if (hwData) {
    if (hwData.cpu.package_temp_c !== null && hwData.cpu.package_temp_c > 85) {
      thermalWarnings.push(
        `Повышенный нагрев CPU Package: ${hwData.cpu.package_temp_c.toFixed(1)}°C`
      );
    }
    for (const g of hwData.gpus) {
      if (g.hotspot_temp_c !== null && g.hotspot_temp_c > 85) {
        thermalWarnings.push(
          `Повышенный нагрев GPU Hotspot (${g.name}): ${g.hotspot_temp_c.toFixed(1)}°C`
        );
      } else if (g.core_temp_c !== null && g.core_temp_c > 85) {
        thermalWarnings.push(
          `Повышенный нагрев GPU Core (${g.name}): ${g.core_temp_c.toFixed(1)}°C`
        );
      }
    }
  }

  const cpuTempStyle = getTempBadgeStyle(hwData?.cpu.package_temp_c);

  // Агрегированная статистика для Cleanup Center
  const totalCleanupBytes = cleanupCategories.reduce(
    (acc, cat) => acc + cat.size_bytes,
    0
  );
  const selectedCleanupCategories = cleanupCategories.filter((cat) =>
    selectedCleanupIds.includes(cat.id)
  );
  const selectedCleanupBytes = selectedCleanupCategories.reduce(
    (acc, cat) => acc + cat.size_bytes,
    0
  );
  const selectedCleanupFilesCount = selectedCleanupCategories.reduce(
    (acc, cat) => acc + cat.files_count,
    0
  );

  // Фильтрация и сортировка процессов (Process Explorer)
  const processQuery = processSearch.trim().toLowerCase();
  const visibleProcesses = processes
    .filter((p) => {
      if (!processQuery) return true;
      return (
        p.name.toLowerCase().includes(processQuery) ||
        p.pid.toString().includes(processQuery) ||
        p.exe_path.toLowerCase().includes(processQuery)
      );
    })
    .sort((a, b) => {
      let diff = 0;
      switch (processSortKey) {
        case "name":
          diff = a.name.localeCompare(b.name, "ru");
          break;
        case "cpu":
          diff = a.cpu_usage - b.cpu_usage;
          break;
        case "memory":
          diff = a.memory_mb - b.memory_mb;
          break;
        case "disk":
          diff =
            a.disk_read_bytes_sec + a.disk_write_bytes_sec -
            (b.disk_read_bytes_sec + b.disk_write_bytes_sec);
          break;
        case "runtime":
          diff = a.run_time_sec - b.run_time_sec;
          break;
      }
      if (diff === 0) diff = a.pid - b.pid;
      return processSortDesc ? -diff : diff;
    });

  const totalProcessCpu = Math.min(
    100,
    processes.reduce((acc, p) => acc + p.cpu_usage, 0)
  );
  const totalProcessMemoryGb = processes.reduce((acc, p) => acc + p.memory_mb, 0) / 1024;
  const menuProcessSuspended = processMenu
    ? suspendedPids.includes(processMenu.process.pid)
    : false;

  const renderSortHeader = (key: ProcessSortKey, label: string, alignRight = true) => {
    const isActive = processSortKey === key;
    return (
      <button
        type="button"
        onClick={() => handleProcessSort(key)}
        className={`flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.14em] transition-colors cursor-pointer ${
          alignRight ? "justify-end" : "justify-start"
        } ${isActive ? "text-sky-300" : "text-[#8793a5] hover:text-[#c5d0de]"}`}
      >
        <span>{label}</span>
        {isActive ? (
          processSortDesc ? (
            <ChevronDown size={11} />
          ) : (
            <ChevronUp size={11} />
          )
        ) : (
          <span className="w-[11px]" />
        )}
      </button>
    );
  };

  return {
    activeTab,
    setActiveTab,
    metrics,
    setMetrics,
    history,
    setHistory,
    isElevatedAdmin,
    setIsElevatedAdmin,
    adminMenuOpen,
    setAdminMenuOpen,
    adminError,
    setAdminError,
    startupItems,
    setStartupItems,
    startupSearch,
    setStartupSearch,
    startupLoading,
    setStartupLoading,
    startupError,
    setStartupError,
    availableDrives,
    setAvailableDrives,
    selectedDriveOrPath,
    setSelectedDriveOrPath,
    isScanning,
    setIsScanning,
    scanElapsedSec,
    setScanElapsedSec,
    scanResult,
    setScanResult,
    scanError,
    setScanError,
    treemapStack,
    setTreemapStack,
    selectedTreemapNode,
    setSelectedTreemapNode,
    fileSearch,
    setFileSearch,
    hwData,
    setHwData,
    cleanupCategories,
    setCleanupCategories,
    selectedCleanupIds,
    setSelectedCleanupIds,
    isScanningCleanup,
    setIsScanningCleanup,
    isCleaning,
    setIsCleaning,
    confirmCleanupOpen,
    setConfirmCleanupOpen,
    cleanupReport,
    setCleanupReport,
    cleanupError,
    setCleanupError,
    processes,
    setProcesses,
    processSearch,
    setProcessSearch,
    processAutoRefresh,
    setProcessAutoRefresh,
    processSortKey,
    setProcessSortKey,
    processSortDesc,
    setProcessSortDesc,
    processError,
    setProcessError,
    processNotice,
    setProcessNotice,
    processLoading,
    setProcessLoading,
    selectedPid,
    setSelectedPid,
    suspendedPids,
    setSuspendedPids,
    processMenu,
    setProcessMenu,
    processMenuRef,
    restartMode,
    setRestartMode,
    customMinutes,
    setCustomMinutes,
    timerState,
    setTimerState,
    remainingSeconds,
    setRemainingSeconds,
    powerError,
    setPowerError,
    fetchProcesses,
    showProcessNotice,
    handleProcessContextMenu,
    handleProcessSort,
    handleProcessOpenLocation,
    handleProcessCopyPath,
    handleProcessSuspendToggle,
    handleProcessKill,
    handleWindowMinimize,
    handleWindowToggleMaximize,
    handleWindowClose,
    handleRestartAsAdmin,
    handleScanCleanup,
    handleToggleCleanupCategory,
    handleExecuteCleanup,
    fetchStartupItems,
    handleStartStorageScan,
    handleOpenPathInExplorer,
    handleToggleStartup,
    handleOpenItemLocation,
    handleStartTimer,
    handleCancelTimer,
    handleCustomSubmit,
    timerProgress,
    swapPercentage,
    diskUsedPercentage,
    isNetworkActive,
    isGatewayOnline,
    pingStyle,
    rxParts,
    txParts,
    rxPulsePct,
    txPulsePct,
    cpuLoadStyles,
    ramLoadStyles,
    diskLoadStyles,
    totalStartupCount,
    activeStartupCount,
    brokenStartupCount,
    filteredStartupItems,
    currentTreemapRoot,
    treemapRects,
    filteredTopFiles,
    thermalWarnings,
    cpuTempStyle,
    totalCleanupBytes,
    selectedCleanupCategories,
    selectedCleanupBytes,
    selectedCleanupFilesCount,
    processQuery,
    visibleProcesses,
    totalProcessCpu,
    totalProcessMemoryGb,
    menuProcessSuspended,
    renderSortHeader,
  };
}

export type NexusController = ReturnType<typeof useNexusController>;
