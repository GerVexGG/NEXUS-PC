import { useWorkspaceNavigation } from "./useWorkspaceNavigation";
import { appendRtt, summarizeRtt, type RttSample } from "../lib/latencyHistory";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
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
  formatSpeedParts,
  getLoadBarStyles,
  getPingHudStyle,
  getTempBadgeStyle,
} from "../lib/studio";
import { getProcessIdentityKey, toProcessTargetIdentity } from "../lib/processTree";
import { appendNetworkSample, type NetworkSpeedSample } from "../lib/networkHistory";
import { useStorageScanner } from "./useStorageScanner";
import { useStartupManager } from "./useStartupManager";
import { useCleanupCenter } from "./useCleanupCenter";
import { usePowerTimer } from "./usePowerTimer";
import { useMainWindowVisible } from "./useMainWindowVisible";

export function useNexusController() {
  const windowVisible = useMainWindowVisible();
  const navigation = useWorkspaceNavigation();
  const { activeTab, setActiveTab } = navigation;
  const [externalRtt, setExternalRtt] = useState<RttSample[]>([]);
  const networkJitter = useMemo(() => summarizeRtt(externalRtt).jitterMs, [externalRtt]);
  const [metricsReady, setMetricsReady] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const metricsRequest = useRef<Promise<Metrics> | null>(null);
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
  const [history, setHistory] = useState<Array<HistoryPoint & { capturedAt: number }>>([]);
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
  const storage = useStorageScanner(navigation.storageLocation.volume, { isolateTimer: true });
  const startup = useStartupManager();
  const cleanup = useCleanupCenter(isElevatedAdmin);
  const power = usePowerTimer();

  // Состояние модуля Hardware Monitor (Мониторинг железа)
  const [hwData, setHwData] = useState<HardwareTelemetry | null>(null);
  const [hwPollError, setHwPollError] = useState<string | null>(null);
  const hwRequestGeneration = useRef(0);
  const [hwmonStatus, setHwmonStatus] = useState<HwmonStatusResponse>({
    status: "offline",
    restart_count: 0,
    last_error: null,
    telemetry_stale: false,
    sample_age_ms: null,
  });
  const [isRestartingHwmon, setIsRestartingHwmon] = useState<boolean>(false);
  const [alertThresholds, setAlertThresholds] = useState({
    cpu: 85,
    gpu: 83,
    disk: 20,
  });

  // Состояние модуля Process Explorer (Диспетчер процессов)
  const [processes, setProcesses] = useState<ProcessItem[]>([]);
  const [processSearch, setProcessSearchValue] = useState("");
  const [networkProcessPid, setNetworkProcessPid] = useState<number | null>(null);
  const networkProcessRequest = useRef<number | null>(null);
  const [processAutoRefresh, setProcessAutoRefresh] = useState<boolean>(true);
  const [processSortKey, setProcessSortKey] = useState<ProcessSortKey>("name");
  const [processSortDesc, setProcessSortDesc] = useState<boolean>(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processLoadError, setProcessLoadError] = useState<string | null>(null);
  const [processNotice, setProcessNotice] = useState<string | null>(null);
  const [processLoading, setProcessLoading] = useState<boolean>(false);
  const [selectedProcessKey, setSelectedProcessKey] = useState<string | null>(null);
  const [processActionBusy, setProcessActionBusy] = useState(false);
  const processAction = useRef(false);
  const processRequest = useRef<Promise<void> | null>(null);
  const processNoticeTimer = useRef<number | undefined>(undefined);
  const [netSnapshot, setNetSnapshot] = useState<NetworkTelemetrySnapshot | null>(null);
  const [netSnapshotError, setNetSnapshotError] = useState<string | null>(null);
  const [selectedAdapterId, setSelectedAdapterIdState] = useState<string | null>(null);
  const [netSpeedHistory, setNetSpeedHistory] = useState<NetworkSpeedSample[]>([]);
  const selectedAdapterRef = useRef<string | null>(null);
  const networkRequestId = useRef(0);
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

    invoke<{ polling_rate_ms: number; alert_cpu_temp: number; alert_gpu_temp: number; alert_disk_free_gb: number }>("get_settings")
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
          disk: Number.isFinite(s?.alert_disk_free_gb) ? s.alert_disk_free_gb : 20,
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
  const fetchProcesses = useCallback(() => {
    if (processRequest.current) return processRequest.current;
    setProcessLoading(true);
    const request = invoke<ProcessItem[]>("get_process_list")
      .then((list) => {
        setProcesses(list);
        setProcessLoadError(null);
        const requestedPid = networkProcessRequest.current;
        if (requestedPid !== null) {
          const requestedProcess = list.find((process) => process.pid === requestedPid);
          setSelectedProcessKey(requestedProcess ? getProcessIdentityKey(requestedProcess) : null);
          networkProcessRequest.current = null;
        }
        setSuspendedProcessKeys((previous) => {
          if (previous.length === 0) return previous;
          const activeKeys = new Set(list.map(getProcessIdentityKey));
          const next = previous.filter((key) => activeKeys.has(key));
          return next.length === previous.length ? previous : next;
        });
      })
      .catch((err) => setProcessLoadError(String(err)))
      .finally(() => {
        processRequest.current = null;
        setProcessLoading(false);
      });
    processRequest.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (windowVisible && activeTab === "processes") void fetchProcesses();
  }, [windowVisible, activeTab, fetchProcesses]);

  useEffect(() => {
    if (!windowVisible || activeTab !== "processes" || !processAutoRefresh) return;
    const interval = window.setInterval(() => void fetchProcesses(), PROCESS_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [windowVisible, activeTab, processAutoRefresh, fetchProcesses]);

  const setProcessSearch = useCallback((value: string) => {
    networkProcessRequest.current = null;
    setNetworkProcessPid(null);
    setProcessSearchValue(value);
  }, []);

  const openProcessFromNetwork = useCallback((pid: number) => {
    networkProcessRequest.current = pid;
    setNetworkProcessPid(pid);
    setProcessSearchValue(String(pid));
    setSelectedProcessKey(null);
    setActiveTab("processes");
  }, []);

  const selectProcess = useCallback((process: ProcessItem | null) => {
    networkProcessRequest.current = null;
    setSelectedProcessKey(process ? getProcessIdentityKey(process) : null);
  }, []);

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
    window.clearTimeout(processNoticeTimer.current);
    setProcessNotice(msg);
    processNoticeTimer.current = window.setTimeout(() => setProcessNotice(null), 3500);
  }, []);
  useEffect(() => () => window.clearTimeout(processNoticeTimer.current), []);

  const handleProcessContextMenu = useCallback(
    (proc: ProcessItem, clientX: number, clientY: number) => {
      selectProcess(proc);
      setProcessMenu({ x: clientX, y: clientY, process: proc });
    },
    [selectProcess]
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
      try {
        await copyTextToClipboard(text);
        showProcessNotice(`Скопировано: ${text}`);
      } catch (err) {
        setProcessError(String(err));
      }
    },
    [showProcessNotice]
  );

  const handleProcessSuspendToggle = useCallback(
    async (proc: ProcessItem) => {
      if (processAction.current) return;
      processAction.current = true;
      setProcessActionBusy(true);
      setProcessMenu(null);
      setProcessError(null);
      const identityKey = getProcessIdentityKey(proc);
      const isSuspended = suspendedProcessKeys.includes(identityKey) || proc.status === "Приостановлен";
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
      } finally {
        processAction.current = false;
        setProcessActionBusy(false);
      }
    },
    [suspendedProcessKeys, showProcessNotice]
  );

  const handleProcessKill = useCallback(
    async (proc: ProcessItem, tree: boolean, explicitTargets?: ProcessTargetIdentity[]) => {
      if (processAction.current) return;
      processAction.current = true;
      setProcessActionBusy(true);
      setProcessMenu(null);
      setProcessError(null);
      const target = toProcessTargetIdentity(proc);
      const targets = tree ? explicitTargets ?? [target] : [target];
      try {
        await invoke("kill_process", { target, tree, targets });
        await processRequest.current;
        const removedKeys = new Set(targets.map(getProcessIdentityKey));
        setProcesses((prev) => prev.filter((p) => !removedKeys.has(getProcessIdentityKey(p))));
        setSuspendedProcessKeys((prev) => prev.filter((k) => !removedKeys.has(k)));
        showProcessNotice(
          tree
            ? `Завершено процессов ветки ${proc.name} (PID ${proc.pid}): ${targets.length}`
            : `Процесс ${proc.name} (PID ${proc.pid}) завершён`
        );
      } catch (err) {
        setProcessError(String(err));
        await processRequest.current;
      } finally {
        processAction.current = false;
        setProcessActionBusy(false);
        void fetchProcesses();
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
    if (!windowVisible) return;
    let alive = true;
    let timer: number | undefined;
    const fetchMetrics = async () => {
      const request = metricsRequest.current ?? invoke<Metrics>("get_system_metrics");
      metricsRequest.current = request;
      try {
        const data = await request;
        if (!alive) return;
        setMetrics(data);
        const sample = data.net_ping_sample;
        setExternalRtt(previous => sample ? appendRtt(previous, sample) : previous.length ? [] : previous);
        setMetricsReady(true);
        setMetricsError(null);
        const now = new Date();
        const capturedAt = performance.now();
        const nowLabel = now.toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        setHistory((prev) => [...(prev.length && capturedAt - prev[prev.length - 1].capturedAt <= pollingRateMs * 3
          ? prev.slice(-(HISTORY_LENGTH - 1)) : []), {
          capturedAt,
          timestamp: nowLabel,
          cpu: data.cpu_usage,
          ram: data.ram_percentage,
        }]);
      } catch (err) {
        if (alive) setMetricsError(String(err));
      } finally {
        if (metricsRequest.current === request) metricsRequest.current = null;
        if (alive) timer = window.setTimeout(fetchMetrics, pollingRateMs);
      }
    };

    void fetchMetrics();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [pollingRateMs, windowVisible]);

  const showHardwareTelemetry = windowVisible && (activeTab === "hardware" || activeTab === "dashboard");
  useEffect(() => {
    if (!showHardwareTelemetry || isRestartingHwmon) return;
    const generation = ++hwRequestGeneration.current;
    let timer: number | undefined;

    const fetchHwTelemetry = async () => {
      const [telemetryRes, statusRes] = await Promise.allSettled([
        invoke<HardwareTelemetry>("get_hardware_telemetry"),
        invoke<HwmonStatusResponse>("get_hwmon_status"),
      ]);
      if (hwRequestGeneration.current !== generation) return;
      if (telemetryRes.status === "fulfilled") {
        setHwData(telemetryRes.value);
        if (telemetryRes.value.is_admin) setIsElevatedAdmin(true);
      }
      if (statusRes.status === "fulfilled") {
        setHwmonStatus(statusRes.value);
      }
      const errors = [telemetryRes, statusRes]
        .filter((result) => result.status === "rejected")
        .map((result) => String(result.reason));
      setHwPollError(errors.length ? errors.join(" · ") : null);
      timer = window.setTimeout(fetchHwTelemetry, pollingRateMs);
    };
    void fetchHwTelemetry();
    return () => {
      if (hwRequestGeneration.current === generation) hwRequestGeneration.current++;
      window.clearTimeout(timer);
    };
  }, [showHardwareTelemetry, pollingRateMs, isRestartingHwmon]);

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
    if (hwData && !hwData.telemetry_stale && !hwmonStatus.telemetry_stale && !hwPollError) {
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
  }, [hwData, alertThresholds, hwmonStatus.telemetry_stale, hwPollError]);

  const cpuTempStyle = getTempBadgeStyle(hwData?.cpu.package_temp_c);

  const loadTelemetryBundle = useCallback(async (minutes: number) => {
    const [historyRes, reportRes] = await Promise.allSettled([
      invoke<TelemetrySnapshot[]>("get_telemetry_history", { minutes }),
      invoke<DiagnosticsReport>("get_diagnostics_verdict", { minutes }),
    ]);
    const history = historyRes.status === "fulfilled" ? historyRes.value : [];
    const report = reportRes.status === "fulfilled" ? reportRes.value : null;
    const errors = [historyRes, reportRes]
      .filter((result) => result.status === "rejected")
      .map((result) => String(result.reason));
    return { history, report, error: errors.length ? errors.join(" · ") : null };
  }, []);

  const refreshNetworkTelemetry = useCallback(async (resetSession = false) => {
    const requestId = ++networkRequestId.current;
    try {
      const snap = await invoke<NetworkTelemetrySnapshot>("get_network_telemetry", {
        selectedAdapterId: selectedAdapterRef.current,
        resetSession,
      });
      if (requestId !== networkRequestId.current) return;
      setNetSnapshot(snap);
      setNetSnapshotError(null);
      if (selectedAdapterRef.current !== snap.active_adapter_id) {
        selectedAdapterRef.current = snap.active_adapter_id;
        setSelectedAdapterIdState(snap.active_adapter_id);
      }
      const adapter = snap.active_adapter_id;
      if (!adapter) {
        setNetSpeedHistory([]);
        return;
      }
      const ts = new Date(snap.timestamp_ms).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const sample = { ts, at: snap.timestamp_ms, adapter, rxBps: snap.total_rx_bytes_per_sec, txBps: snap.total_tx_bytes_per_sec };
      setNetSpeedHistory((prev) => appendNetworkSample(prev, sample, resetSession));
    } catch (err) {
      if (requestId === networkRequestId.current) setNetSnapshotError(String(err));
    }
  }, []);

  const setSelectedAdapterId = useCallback(
    (nextId: string | null) => {
      if (selectedAdapterRef.current === nextId) return;
      selectedAdapterRef.current = nextId;
      setSelectedAdapterIdState(nextId);
      setNetSpeedHistory([]);
      void refreshNetworkTelemetry(false);
    },
    [refreshNetworkTelemetry]
  );

  useEffect(() => {
    if (!windowVisible || (activeTab !== "network" && activeTab !== "hardware" && activeTab !== "dashboard")) return;
    const intervalMs = activeTab === "network" ? 1000 : 2000;
    let active = true;
    let timer: number | undefined;
    async function poll() {
      await refreshNetworkTelemetry(false);
      if (active) timer = window.setTimeout(poll, intervalMs);
    }
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [windowVisible, activeTab, refreshNetworkTelemetry]);

  const exportTelemetryCsv = useCallback(() => invoke<string>("export_telemetry_csv"), []);

  const handleRestartHwmon = useCallback(async () => {
    hwRequestGeneration.current++;
    setIsRestartingHwmon(true);
    setHwmonStatus((prev) => ({ ...prev, status: "restarting", restart_count: 0, last_error: null }));
    try {
      await invoke("restart_hwmon");
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
    ...navigation,
    windowVisible,
    metrics,
    metricsReady,
    networkJitter,
    metricsError,
    hwPollError,
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
    processLoadError,
    processActionBusy,
    setProcessError,
    processNotice,
    setProcessNotice,
    processLoading,
    setProcessLoading,
    selectedProcessKey,
    selectProcess,
    networkProcessPid,
    openProcessFromNetwork,
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
    netSnapshotError,
    selectedAdapterId,
    setSelectedAdapterId,
    netSpeedHistory,
    refreshNetworkTelemetry,
  };
}

export type NexusController = ReturnType<typeof useNexusController>;
