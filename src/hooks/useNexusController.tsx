import { useState, useEffect, useRef, useMemo, useCallback, type MouseEvent } from "react";
import {
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  HISTORY_LENGTH,
  type HardwareTelemetry,
  type HwmonStatusResponse,
  type HistoryPoint,
  type Metrics,
  type NetworkTelemetrySnapshot,
  PROCESS_REFRESH_MS,
  type ProcessContextMenuState,
  type ProcessItem,
  type ProcessSortKey,
  type ProcessTargetIdentity,
  type DiagnosticsReport,
  type TelemetrySnapshot,
  copyTextToClipboard,
  createInitialHistory,
  formatSpeedParts,
  getLoadBarStyles,
  getPingHudStyle,
  getTempBadgeStyle,
} from "../lib/studio";
import { getProcessIdentityKey, toProcessTargetIdentity } from "../lib/processTree";
import { useStorageScanner } from "./useStorageScanner";
import { useStartupManager } from "./useStartupManager";
import { useCleanupCenter } from "./useCleanupCenter";
import { usePowerTimer } from "./usePowerTimer";

export function useNexusController() {
  const [activeTab, setActiveTab] = useState<
    "dashboard" | "startup" | "storage" | "hardware" | "cleanup" | "power" | "processes" | "network" | "drop" | "scripts" | "settings"
  >("dashboard");
  const [metricsReady, setMetricsReady] = useState(false);
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
    net_ping_method: "",
  });
  const [history, setHistory] = useState<HistoryPoint[]>(createInitialHistory);
  const [pollingRateMs, setPollingRateMsState] = useState<number>(2000);
  const setPollingRateMs = useCallback((ms: number) => {
    setPollingRateMsState(ms === 1000 || ms === 2000 || ms === 5000 ? ms : 2000);
  }, []);

  // Состояние кастомного тайтлбара и привилегий процесса
  const [isElevatedAdmin, setIsElevatedAdmin] = useState<boolean>(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState<boolean>(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  // Подключение изолированных доменных хуков
  // В useStorageScanner передаём isolateTimer: true, чтобы 10 Гц тики секундомера
  // не вызывали ре-рендер App и всех открытых вкладок (таймер локализован в плашке StorageModule).
  const storage = useStorageScanner({ isolateTimer: true });
  const startup = useStartupManager();
  const cleanup = useCleanupCenter(isElevatedAdmin);
  const power = usePowerTimer();

  // Состояние модуля Hardware Monitor (Мониторинг железа)
  const [hwData, setHwData] = useState<HardwareTelemetry | null>(null);
  const [hwmonStatus, setHwmonStatus] = useState<HwmonStatusResponse>({
    status: "offline",
    restart_count: 0,
    last_error: null,
    telemetry_stale: false,
    sample_age_ms: null,
  });
  const [isRestartingHwmon, setIsRestartingHwmon] = useState<boolean>(false);
  const [alertThresholds, setAlertThresholds] = useState<{ cpu: number; gpu: number }>({
    cpu: 85,
    gpu: 83,
  });

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
  const [netSnapshot, setNetSnapshot] = useState<NetworkTelemetrySnapshot | null>(null);
  const [selectedAdapterId, setSelectedAdapterIdState] = useState<string | null>(null);
  const [netSpeedHistory, setNetSpeedHistory] = useState<
    Array<{ ts: string; rxBps: number; txBps: number }>
  >([]);
  const selectedAdapterRef = useRef<string | null>(null);
  selectedAdapterRef.current = selectedAdapterId;
  const [suspendedProcessKeys, setSuspendedProcessKeys] = useState<string[]>([]);
  const suspendedPids = useMemo(
    () =>
      suspendedProcessKeys
        .map((key) => Number(key.split(":", 1)[0]))
        .filter((pid) => Number.isFinite(pid) && pid > 0),
    [suspendedProcessKeys]
  );
  const isProcessSuspended = useCallback(
    (proc: Pick<ProcessItem, "pid" | "start_time" | "name">) =>
      suspendedProcessKeys.includes(getProcessIdentityKey(proc)),
    [suspendedProcessKeys]
  );
  const [processMenu, setProcessMenu] = useState<ProcessContextMenuState | null>(null);
  const processMenuRef = useRef<ProcessContextMenuState | null>(null);
  processMenuRef.current = processMenu;

  // Проверка прав Администратора и загрузка порогов температур при старте приложения
  useEffect(() => {
    invoke<boolean>("is_elevated_admin")
      .then((elevated) => setIsElevatedAdmin(Boolean(elevated)))
      .catch((err) => console.error("Ошибка проверки прав администратора:", err));

    invoke<{ polling_rate_ms: number; alert_cpu_temp: number; alert_gpu_temp: number }>("get_settings")
      .then((s) => {
        if (
          s?.polling_rate_ms === 1000 ||
          s?.polling_rate_ms === 2000 ||
          s?.polling_rate_ms === 5000
        ) {
          setPollingRateMsState(s.polling_rate_ms);
        }
        setAlertThresholds({
          cpu: Number.isFinite(s?.alert_cpu_temp) ? s.alert_cpu_temp : 85,
          gpu: Number.isFinite(s?.alert_gpu_temp) ? s.alert_gpu_temp : 83,
        });
      })
      .catch(() => {
        /* используем фоллбэк 85 / 83 и 2000 мс */
      });
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
  const fetchProcesses = useCallback(async () => {
    try {
      const list = await invoke<ProcessItem[]>("get_process_list");
      setProcesses(list);
      setProcessError(null);
      // Привязываем состояние заморозки к полной идентичности (PID + start_time + name),
      // чтобы завершение процесса и повторное использование PID не наследовало заморозку.
      const activeKeys = new Set(list.map(getProcessIdentityKey));
      setSuspendedProcessKeys((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.filter((k) => activeKeys.has(k));
        return next.length === prev.length ? prev : next;
      });
    } catch (err) {
      console.error("Ошибка получения списка процессов:", err);
      setProcessError(String(err));
    } finally {
      setProcessLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab !== "processes") return;
    if (processes.length === 0) setProcessLoading(true);
    void fetchProcesses();
    if (!processAutoRefresh) return;
    const interval = window.setInterval(() => void fetchProcesses(), PROCESS_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [activeTab, processAutoRefresh, fetchProcesses, processes.length]);

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

  const showProcessNotice = useCallback((msg: string) => {
    setProcessNotice(msg);
    window.setTimeout(() => setProcessNotice((cur) => (cur === msg ? null : cur)), 2600);
  }, []);

  const handleProcessContextMenu = useCallback(
    (e: MouseEvent<HTMLDivElement>, proc: ProcessItem) => {
      e.preventDefault();
      e.stopPropagation();
      const MENU_W = 248;
      const MENU_H = 250;
      const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
      const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
      setSelectedPid(proc.pid);
      setProcessMenu({ x: Math.max(8, x), y: Math.max(8, y), process: proc });
    },
    []
  );

  const handleProcessSort = useCallback(
    (key: ProcessSortKey) => {
      if (processSortKey === key) {
        setProcessSortDesc((prev) => !prev);
      } else {
        setProcessSortKey(key);
        setProcessSortDesc(key !== "name" && key !== "pid");
      }
    },
    [processSortKey]
  );

  const handleProcessOpenLocation = useCallback(async (proc: ProcessItem) => {
    setProcessMenu(null);
    if (!proc.exe_path) {
      setProcessError(
        `Путь к файлу процесса ${proc.name} недоступен (требуются права Администратора)`
      );
      return;
    }
    try {
      await invoke("open_item_location", { path: proc.exe_path });
    } catch (err) {
      setProcessError(String(err));
    }
  }, []);

  const handleProcessCopyPath = useCallback(
    async (proc: ProcessItem) => {
      setProcessMenu(null);
      const text = proc.exe_path || proc.name;
      await copyTextToClipboard(text);
      showProcessNotice(`Скопировано: ${text}`);
    },
    [showProcessNotice]
  );

  const handleProcessSuspendToggle = useCallback(
    async (proc: ProcessItem) => {
      setProcessMenu(null);
      const identityKey = getProcessIdentityKey(proc);
      const isSuspended = suspendedProcessKeys.includes(identityKey);
      const target = toProcessTargetIdentity(proc);
      try {
        if (isSuspended) {
          await invoke("resume_process", { target });
        } else {
          await invoke("suspend_process", { target, suspend: true });
        }
        setSuspendedProcessKeys((prev) =>
          isSuspended ? prev.filter((k) => k !== identityKey) : [...prev, identityKey]
        );
        showProcessNotice(
          isSuspended
            ? `Процесс ${proc.name} (PID ${proc.pid}) возобновлён`
            : `Процесс ${proc.name} (PID ${proc.pid}) заморожен`
        );
      } catch (err) {
        setProcessError(String(err));
      }
    },
    [suspendedProcessKeys, showProcessNotice]
  );

  const handleProcessKill = useCallback(
    async (proc: ProcessItem, tree: boolean, explicitTargets?: ProcessTargetIdentity[]) => {
      setProcessMenu(null);
      const target = toProcessTargetIdentity(proc);
      const targets = tree ? explicitTargets ?? [target] : [target];
      try {
        await invoke("kill_process", { target, tree, targets });
        const removedKeys = new Set(targets.map(getProcessIdentityKey));
        setProcesses((prev) => prev.filter((p) => !removedKeys.has(getProcessIdentityKey(p))));
        setSuspendedProcessKeys((prev) => prev.filter((k) => !removedKeys.has(k)));
        showProcessNotice(
          tree
            ? `Завершено процессов ветки ${proc.name} (PID ${proc.pid}): ${targets.length}`
            : `Процесс ${proc.name} (PID ${proc.pid}) завершён`
        );
        window.setTimeout(() => void fetchProcesses(), 400);
      } catch (err) {
        setProcessError(String(err));
      }
    },
    [fetchProcesses, showProcessNotice]
  );

  // Обработчики безрамочного окна (Frameless Window Controls)
  const handleWindowMinimize = useCallback(async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (err) {
      console.error("Ошибка сворачивания окна:", err);
    }
  }, []);

  const handleWindowToggleMaximize = useCallback(async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch (err) {
      console.error("Ошибка разворачивания окна:", err);
    }
  }, []);

  const handleWindowClose = useCallback(async () => {
    try {
      await invoke("app_exit");
    } catch {
      try {
        await getCurrentWindow().close();
      } catch (err) {
        console.error("Ошибка закрытия окна:", err);
      }
    }
  }, []);

  const handleRestartAsAdmin = useCallback(async () => {
    setAdminError(null);
    setAdminMenuOpen(false);
    try {
      await invoke("restart_as_admin");
    } catch (err) {
      console.error("Ошибка перезапуска от имени Администратора:", err);
      setAdminError(String(err));
    }
  }, []);

  useEffect(() => {
    // Опрашиваем Rust с заданным интервалом pollingRateMs и пополняем кольцевой буфер на 60 точек
    const fetchMetrics = async () => {
      try {
        const data = await invoke<Metrics>("get_system_metrics");
        setMetrics(data);
        setMetricsReady(true);

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

    const rate =
      pollingRateMs === 1000 || pollingRateMs === 2000 || pollingRateMs === 5000
        ? pollingRateMs
        : 2000;
    void fetchMetrics();
    const interval = window.setInterval(() => void fetchMetrics(), rate);
    return () => window.clearInterval(interval);
  }, [pollingRateMs]);

  // Опрос датчиков LibreHardwareMonitor на вкладках «Обзор» и «Железо»
  useEffect(() => {
    if (activeTab !== "hardware" && activeTab !== "dashboard") return;

    const fetchHwTelemetry = async () => {
      try {
        const [telemetryRes, statusRes] = await Promise.allSettled([
          invoke<HardwareTelemetry>("get_hardware_telemetry"),
          invoke<HwmonStatusResponse>("get_hwmon_status"),
        ]);
        if (telemetryRes.status === "fulfilled") {
          setHwData(telemetryRes.value);
          if (telemetryRes.value.is_admin) {
            setIsElevatedAdmin(true);
          }
        }
        if (statusRes.status === "fulfilled") {
          setHwmonStatus(statusRes.value);
        }
      } catch (err) {
        console.error("Ошибка получения аппаратной телеметрии:", err);
      }
    };

    const rate =
      pollingRateMs === 1000 || pollingRateMs === 2000 || pollingRateMs === 5000
        ? pollingRateMs
        : 2000;
    void fetchHwTelemetry();
    const timer = window.setInterval(() => void fetchHwTelemetry(), rate);
    return () => window.clearInterval(timer);
  }, [activeTab, pollingRateMs]);

  // Автозагрузка данных при переходе между вкладками
  const { fetchStartupItems } = startup;
  const { fetchAvailableDrives } = storage;
  const { handleAnalyzeCleanup, cleanupCategories } = cleanup;
  const { syncTimerFromBackend } = power;

  useEffect(() => {
    if (activeTab === "startup") {
      void fetchStartupItems();
    } else if (activeTab === "storage") {
      void fetchAvailableDrives();
    } else if (activeTab === "cleanup" && cleanupCategories.length === 0) {
      void handleAnalyzeCleanup();
    } else if (activeTab === "power") {
      void syncTimerFromBackend();
    }
  }, [activeTab, fetchStartupItems, fetchAvailableDrives, handleAnalyzeCleanup, cleanupCategories.length, syncTimerFromBackend]);

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

  const cpuLoadStyles = getLoadBarStyles(metrics.cpu_usage, "cyan");
  const ramLoadStyles = getLoadBarStyles(metrics.ram_percentage, "cyan");
  const diskLoadStyles = getLoadBarStyles(diskUsedPercentage, "cyan");

  // Проверка перегрева для блока предупреждений Hardware Monitor по пользовательским порогам
  const thermalWarnings = useMemo<string[]>(() => {
    const cpuWarnLimit = Number.isFinite(alertThresholds.cpu) ? alertThresholds.cpu : 85;
    const gpuWarnLimit = Number.isFinite(alertThresholds.gpu) ? alertThresholds.gpu : 83;
    const warnings: string[] = [];
    if (hwData) {
      if (hwData.cpu.package_temp_c !== null && hwData.cpu.package_temp_c >= cpuWarnLimit) {
        warnings.push(
          `Повышенный нагрев CPU Package: ${hwData.cpu.package_temp_c.toFixed(1)}°C (порог ${cpuWarnLimit}°C)`
        );
      }
      for (const g of hwData.gpus) {
        if (g.hotspot_temp_c !== null && g.hotspot_temp_c >= gpuWarnLimit) {
          warnings.push(
            `Повышенный нагрев GPU Hotspot (${g.name}): ${g.hotspot_temp_c.toFixed(1)}°C (порог ${gpuWarnLimit}°C)`
          );
        } else if (g.core_temp_c !== null && g.core_temp_c >= gpuWarnLimit) {
          warnings.push(
            `Повышенный нагрев GPU Core (${g.name}): ${g.core_temp_c.toFixed(1)}°C (порог ${gpuWarnLimit}°C)`
          );
        }
      }
    }
    return warnings;
  }, [hwData, alertThresholds]);

  const cpuTempStyle = getTempBadgeStyle(hwData?.cpu.package_temp_c);

  // Мемоизация фильтрации и сортировки процессов (Process Explorer)
  const processQuery = processSearch.trim().toLowerCase();
  const visibleProcesses = useMemo<ProcessItem[]>(() => {
    return processes
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
          case "pid":
            diff = a.pid - b.pid;
            break;
          case "cpu":
            diff = a.cpu_usage - b.cpu_usage;
            break;
          case "memory":
            diff = a.memory_mb - b.memory_mb;
            break;
          case "disk":
            diff =
              a.disk_read_bytes_sec +
              a.disk_write_bytes_sec -
              (b.disk_read_bytes_sec + b.disk_write_bytes_sec);
            break;
          case "runtime":
            diff = a.run_time_sec - b.run_time_sec;
            break;
          case "threads":
            diff = (a.thread_count ?? 0) - (b.thread_count ?? 0);
            break;
          case "handles":
            diff = (a.handle_count ?? 0) - (b.handle_count ?? 0);
            break;
        }
        if (diff === 0) diff = a.pid - b.pid;
        return processSortDesc ? -diff : diff;
      });
  }, [processes, processQuery, processSortKey, processSortDesc]);

  const totalProcessCpu = useMemo(
    () => Math.min(100, processes.reduce((acc, p) => acc + p.cpu_usage, 0)),
    [processes]
  );
  const totalProcessMemoryGb = useMemo(
    () => processes.reduce((acc, p) => acc + p.memory_mb, 0) / 1024,
    [processes]
  );
  const menuProcessSuspended = processMenu ? isProcessSuspended(processMenu.process) : false;

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

  const loadTelemetryBundle = useCallback(async (minutes: number) => {
    const [historyRes, reportRes, settingsRes] = await Promise.allSettled([
      invoke<TelemetrySnapshot[]>("get_telemetry_history", { minutes }),
      invoke<DiagnosticsReport>("get_diagnostics_verdict", { minutes }),
      invoke<{ alert_cpu_temp: number; alert_gpu_temp: number }>("get_settings"),
    ]);
    const history = historyRes.status === "fulfilled" ? historyRes.value : [];
    const report = reportRes.status === "fulfilled" ? reportRes.value : null;
    const cpuThreshold =
      settingsRes.status === "fulfilled" && Number.isFinite(settingsRes.value.alert_cpu_temp)
        ? settingsRes.value.alert_cpu_temp
        : 85;
    const gpuThreshold =
      settingsRes.status === "fulfilled" && Number.isFinite(settingsRes.value.alert_gpu_temp)
        ? settingsRes.value.alert_gpu_temp
        : 83;
    setAlertThresholds({ cpu: cpuThreshold, gpu: gpuThreshold });
    return { history, report, cpuThreshold, gpuThreshold };
  }, []);

  const refreshNetworkTelemetry = useCallback(async (resetSession = false) => {
    try {
      const snap = await invoke<NetworkTelemetrySnapshot>("get_network_telemetry", {
        selectedAdapterId: selectedAdapterRef.current,
        resetSession,
      });
      setNetSnapshot(snap);
      if (!selectedAdapterRef.current && snap.active_adapter_id) {
        selectedAdapterRef.current = snap.active_adapter_id;
        setSelectedAdapterIdState(snap.active_adapter_id);
      }
      const ts = new Date().toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      setNetSpeedHistory((prev) => {
        const next = [
          ...prev,
          {
            ts,
            rxBps: snap.total_rx_bytes_per_sec,
            txBps: snap.total_tx_bytes_per_sec,
          },
        ];
        return next.length > 60 ? next.slice(next.length - 60) : next;
      });
    } catch (err) {
      console.error("Ошибка чтения сетевых интерфейсов:", err);
    }
  }, []);

  const setSelectedAdapterId = useCallback(
    (nextId: string | null) => {
      selectedAdapterRef.current = nextId;
      setSelectedAdapterIdState(nextId);
      setNetSpeedHistory([]);
      void refreshNetworkTelemetry(false);
    },
    [refreshNetworkTelemetry]
  );

  useEffect(() => {
    if (activeTab !== "network" && activeTab !== "hardware" && activeTab !== "dashboard") return;
    void refreshNetworkTelemetry(false);
    const intervalMs = activeTab === "network" ? 1000 : 2000;
    const timer = window.setInterval(() => {
      void refreshNetworkTelemetry(false);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [activeTab, refreshNetworkTelemetry]);

  const exportTelemetryCsv = useCallback(() => invoke<string>("export_telemetry_csv"), []);

  const handleRestartHwmon = useCallback(async () => {
    setIsRestartingHwmon(true);
    setHwmonStatus((prev) => ({ ...prev, status: "restarting", restart_count: 0, last_error: null }));
    try {
      await invoke("restart_hwmon");
      const [telemetryRes, statusRes] = await Promise.allSettled([
        invoke<HardwareTelemetry>("get_hardware_telemetry"),
        invoke<HwmonStatusResponse>("get_hwmon_status"),
      ]);
      if (telemetryRes.status === "fulfilled") {
        setHwData(telemetryRes.value);
      }
      if (statusRes.status === "fulfilled") {
        setHwmonStatus(statusRes.value);
      }
    } catch (err) {
      setHwmonStatus((prev) => ({
        ...prev,
        status: "offline",
        last_error: String(err),
      }));
    } finally {
      setIsRestartingHwmon(false);
    }
  }, []);

  return {
    activeTab,
    setActiveTab,
    metrics,
    metricsReady,
    setMetrics,
    history,
    setHistory,
    isElevatedAdmin,
    setIsElevatedAdmin,
    adminMenuOpen,
    setAdminMenuOpen,
    adminError,
    setAdminError,

    // Startup Manager (useStartupManager)
    ...startup,

    // Storage Scanner (useStorageScanner)
    ...storage,

    // Cleanup Center (useCleanupCenter)
    ...cleanup,

    // Power Timer (usePowerTimer)
    ...power,

    // Hardware Monitor
    hwData,
    setHwData,
    hwmonStatus,
    setHwmonStatus,
    isRestartingHwmon,
    handleRestartHwmon,
    alertThresholds,
    setAlertThresholds,
    pollingRateMs,
    setPollingRateMs,
    thermalWarnings,
    cpuTempStyle,

    // Process Explorer
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
    isProcessSuspended,
    processMenu,
    setProcessMenu,
    processMenuRef,
    fetchProcesses,
    showProcessNotice,
    handleProcessContextMenu,
    handleProcessSort,
    handleProcessOpenLocation,
    handleProcessCopyPath,
    handleProcessSuspendToggle,
    handleProcessKill,
    processQuery,
    visibleProcesses,
    totalProcessCpu,
    totalProcessMemoryGb,
    menuProcessSuspended,
    renderSortHeader,

    // Window & Telemetry
    handleWindowMinimize,
    handleWindowToggleMaximize,
    handleWindowClose,
    handleRestartAsAdmin,
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
    loadTelemetryBundle,
    exportTelemetryCsv,

    // Network Monitor (Adapters & 60s Throughput)
    netSnapshot,
    selectedAdapterId,
    setSelectedAdapterId,
    netSpeedHistory,
    refreshNetworkTelemetry,
  };
}

export type NexusController = ReturnType<typeof useNexusController>;
