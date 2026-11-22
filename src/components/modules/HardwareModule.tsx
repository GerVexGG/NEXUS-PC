import { useWorkspaceState } from "../../hooks/useWorkspaceState";
import { ModuleHeader } from "../ui/ModuleHeader";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Cable,
  Cpu,
  Download,
  Eye,
  EyeOff,
  Gauge,
  HardDrive,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  Wifi,
} from "lucide-react";
import {
  formatLinkSpeed,
  formatThroughputRate,
  type DiagnosticsReport,
  type HardwareTelemetry,
  type HwmonStatus,
  type TelemetrySnapshot,
} from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";
import { cpuPackageUnavailableReason, summarizeSensors, type SensorState } from "../../lib/sensorSummary";

const sensorStateLabels: Record<SensorState, string> = {
  normal: "В норме", warning: "Предупреждение", unavailable: "Недоступно", stale: "Устарело",
};

type SensorGroup = "cpu" | "gpu" | "board" | "memory" | "disk" | "fan";
type SensorFilter = "all" | SensorGroup;

type SensorRow = {
  id: string;
  group: SensorGroup;
  name: string;
  raw: number | null;
  text: string;
  unit: string;
  digits: number;
  reason?: string;
};

const filters: { id: SensorFilter; label: string }[] = [
  { id: "all", label: "Все датчики" },
  { id: "cpu", label: "Процессор (CPU)" },
  { id: "gpu", label: "Видеокарта (GPU)" },
  { id: "board", label: "Системная плата" },
  { id: "memory", label: "Память" },
  { id: "disk", label: "Накопители" },
  { id: "fan", label: "Охлаждение" },
];

const GROUP_LABELS: Record<SensorGroup, string> = {
  cpu: "CPU",
  gpu: "GPU",
  board: "Плата",
  memory: "Память",
  disk: "Диск",
  fan: "Охлаждение",
};

function formatSensor(
  value: number | null | undefined | "",
  digits: number,
  unit: string
): { raw: number | null; text: string; unit: string } {
  if (value == null || value === "" || !Number.isFinite(value)) {
    return { raw: null, text: "Недоступно", unit };
  }
  return { raw: value, text: `${value.toFixed(digits)} ${unit}`, unit };
}

function cpuMsrReason(hw: HardwareTelemetry | null, status: HwmonStatus): string {
  if (!hw) return "Ожидание данных";
  if (status === "driver_blocked") return "Windows заблокировала драйвер датчиков";
  if (hw.cpu.hvci_enabled) return "Недоступно при включённой целостности памяти (HVCI)";
  if (!hw.sidecar_online) return "Служба датчиков недоступна";
  if (!hw.is_admin) return "Могут требоваться права администратора";
  return "Недоступно";
}

function buildRows(
  hw: HardwareTelemetry | null,
  status: HwmonStatus,
  ramGb: number | null,
  ramPct: number | null
): SensorRow[] {
  const rows: SensorRow[] = [];
  const defaultGpuReason = !hw
    ? "Ожидание данных"
    : !hw.sidecar_online
    ? "Служба датчиков недоступна"
    : "Недоступно";
  const msrReason = cpuMsrReason(hw, status);

  const push = (
    id: string,
    group: SensorGroup,
    name: string,
    value: number | null | undefined,
    digits: number,
    unit: string,
    reason?: string
  ) => {
    const formatted = formatSensor(value, digits, unit);
    rows.push({
      id,
      group,
      name,
      raw: formatted.raw,
      text: formatted.text,
      unit,
      digits,
      reason: formatted.raw == null ? reason ?? "Недоступно" : undefined,
    });
  };

  const packageReason = cpuPackageUnavailableReason({
    sample: !!hw, online: !!hw?.sidecar_online, driverBlocked: status === "driver_blocked",
    hvciConfigured: !!hw?.cpu.hvci_enabled, elevated: !!hw?.is_admin,
  });
  push("cpu-package", "cpu", "Температура пакета CPU", hw?.cpu.package_temp_c, 1, "°C", packageReason);
  push(
    "cpu-clock",
    "cpu",
    "Текущая частота CPU",
    hw?.cpu.avg_clock_mhz != null ? hw.cpu.avg_clock_mhz / 1000 : null,
    2,
    "ГГц",
    !hw ? "Инициализация…" : "Недоступно"
  );
  if (hw?.cpu.base_clock_mhz != null) {
    push("cpu-base-clk", "cpu", "Базовая частота CPU", hw.cpu.base_clock_mhz / 1000, 2, "ГГц");
  }
  push("cpu-load", "cpu", "Общая загрузка ЦП", hw?.cpu.usage_percent, 1, "%");
  push("cpu-power", "cpu", "Энергопотребление CPU", hw?.cpu.power_watts, 1, "Вт", msrReason);
  push("cpu-voltage", "cpu", "Напряжение ядра CPU", hw?.cpu.voltage_v, 3, "В", msrReason);
  hw?.cpu.core_temps.forEach((core, index) => {
    push(`cpu-core-${index}`, "cpu", core.name || `Ядро #${index + 1}`, core.temp_c, 0, "°C", msrReason);
  });

  hw?.gpus.forEach((gpu, index) => {
    const title = gpu.name || `GPU #${index + 1}`;
    push(`gpu-${index}-core`, "gpu", `${title} · Температура ядра`, gpu.core_temp_c, 1, "°C", defaultGpuReason);
    push(`gpu-${index}-hot`, "gpu", `${title} · Hotspot`, gpu.hotspot_temp_c, 1, "°C", defaultGpuReason);
    push(`gpu-${index}-mem`, "gpu", `${title} · Температура VRAM`, gpu.memory_temp_c, 1, "°C", defaultGpuReason);
    push(`gpu-${index}-load`, "gpu", `${title} · Загрузка ядра`, gpu.load_percent, 0, "%", defaultGpuReason);
    push(`gpu-${index}-core-clk`, "gpu", `${title} · Частота ядра`, gpu.core_clock_mhz, 0, "МГц", defaultGpuReason);
    push(`gpu-${index}-mem-clk`, "gpu", `${title} · Частота памяти`, gpu.memory_clock_mhz, 0, "МГц", defaultGpuReason);
    push(`gpu-${index}-vram-used`, "memory", `${title} · Занято VRAM`, gpu.vram_used_mb, 0, "МБ", "Недоступно");
    push(`gpu-${index}-vram-total`, "memory", `${title} · Всего VRAM`, gpu.vram_total_mb, 0, "МБ", "Недоступно");
    push(`gpu-${index}-mem-ctrl`, "gpu", `${title} · Контроллер памяти`, gpu.memory_controller_load_percent, 0, "%", defaultGpuReason);
    push(`gpu-${index}-video`, "gpu", `${title} · Видеодвижок`, gpu.video_engine_load_percent, 0, "%", defaultGpuReason);
    push(`gpu-${index}-power`, "gpu", `${title} · Мощность`, gpu.power_watts, 1, "Вт", defaultGpuReason);
    if (gpu.power_limit_percent != null) {
      push(`gpu-${index}-power-lim`, "gpu", `${title} · Лимит энергопотребления`, gpu.power_limit_percent, 0, "%");
    }
    push(`gpu-${index}-volt`, "gpu", `${title} · Напряжение ядра`, gpu.voltage_v, 3, "В", defaultGpuReason);
    if (gpu.d3d_shared_mb != null) {
      push(`gpu-${index}-shared`, "memory", `${title} · Общая память D3D`, gpu.d3d_shared_mb, 0, "МБ");
    }
    if (gpu.pcie_rx_mb_s != null) {
      push(`gpu-${index}-pcie-rx`, "gpu", `${title} · Шина PCIe Rx`, gpu.pcie_rx_mb_s, 1, "МБ/с");
    }
    if (gpu.pcie_tx_mb_s != null) {
      push(`gpu-${index}-pcie-tx`, "gpu", `${title} · Шина PCIe Tx`, gpu.pcie_tx_mb_s, 1, "МБ/с");
    }
    if (gpu.fans && gpu.fans.length > 0) {
      gpu.fans.forEach((fan, fanIdx) => {
        push(`gpu-${index}-fan-${fanIdx}`, "fan", `${title} · ${fan.name}`, fan.rpm, 0, "RPM");
        if (fan.percent != null) {
          push(`gpu-${index}-fan-${fanIdx}-pct`, "fan", `${title} · ${fan.name} (ШИМ)`, fan.percent, 0, "%");
        }
      });
    } else {
      push(`gpu-${index}-fan`, "fan", `${title} · Вентилятор`, gpu.fan_rpm, 0, "RPM", defaultGpuReason);
      if (gpu.fan_percent != null) {
        push(`gpu-${index}-fan-pct`, "fan", `${title} · Обороты кулера`, gpu.fan_percent, 0, "%");
      }
    }
  });

  push("ram-used", "memory", "Используемая память RAM", ramGb, 1, "ГБ");
  push("ram-pct", "memory", "Загрузка памяти RAM", ramPct, 0, "%");

  hw?.storage_temps.forEach((disk, index) => {
    push(
      `disk-${index}-temp`,
      "disk",
      `${disk.name || `Накопитель #${index + 1}`} · Температура`,
      disk.temp_c,
      1,
      "°C",
      "Недоступно"
    );
    push(
      `disk-${index}-used`,
      "disk",
      `${disk.name || `Накопитель #${index + 1}`} · Занято`,
      disk.used_percent,
      0,
      "%",
      "Недоступно"
    );
  });

  hw?.motherboard_temps.forEach((sensor, index) => {
    push(`board-${index}`, "board", sensor.name || `Датчик платы #${index + 1}`, sensor.temp_c, 0, "°C");
  });

  hw?.system_fans.forEach((fan, index) => {
    const name = fan.name || `Вентилятор корпуса #${index + 1}`;
    push(`fan-${index}`, "fan", name, fan.rpm, 0, "RPM");
    if (fan.percent != null) {
      push(`fan-${index}-pct`, "fan", `${name} · ШИМ`, fan.percent, 0, "%");
    }
  });

  return rows;
}

function SensorSummary({
  device, title, name, icon, action, load, readings, children,
}: {
  device: "cpu" | "gpu";
  load: number | null | undefined;
  title: string;
  name: string;
  icon: ReactNode;
  action?: ReactNode;
  readings: { label: string; value: string | null }[];
  children?: ReactNode;
}) {
  const available = readings.filter(({ value }) => value !== null);
  return (
    <section className="nexus-panel avs-sensor-card min-w-0 p-4 sm:p-5" data-device={device}>
      <div className="avs-sensor-top">
        <div>
        <h2 className="flex items-center gap-2 text-sm font-medium text-[var(--nexus-muted)]">
          <span className="text-[var(--nexus-accent)]">{icon}</span> {title}
        </h2>
          <p className="avs-sensor-name">{name}</p>
          {action && <div className="avs-device-source">{action}</div>}
        </div>
        <div className="avs-gauge" aria-label={`Загрузка · ${reading(load, 1, "%") ?? "недоступно"}`}>
          <svg viewBox="0 0 60 60" aria-hidden="true">
            <circle cx="30" cy="30" r="25" fill="none" stroke="#8aa2db26" strokeWidth="3" />
            {load != null && Number.isFinite(load) && <circle cx="30" cy="30" r="25" fill="none" stroke="currentColor" strokeWidth="3"
              pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, load))} 100`} />}
          </svg>
          <strong>{reading(load, 1, "%") ?? "—"}</strong>
          <small>загрузка</small>
        </div>
      </div>
      {available.length > 0 ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-[var(--nexus-line)] pt-3 sm:grid-cols-3">
          {available.map(({ label, value }) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-[var(--nexus-muted)]">{label}</dt>
              <dd className="mt-0.5 break-words font-mono text-sm font-medium tabular-nums text-[var(--nexus-text)]">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-3 text-sm text-[var(--nexus-muted)]">Показания недоступны</p>
      )}
      {children}
    </section>
  );
}

function reading(value: number | null | undefined, digits: number, unit: string): string | null {
  return value == null || !Number.isFinite(value) ? null : `${value.toFixed(digits)}${unit === "%" ? "%" : ` ${unit}`}`;
}

export function HardwareModule({ c }: { c: NexusController }) {
  const {
    hwData,
    hwmonStatus,
    isRestartingHwmon,
    handleRestartHwmon,
    metrics,
    metricsError,
    hwPollError,
    metricsReady,
    netSnapshot,
  } = c;
  const telemetryStale = Boolean(hwData?.telemetry_stale || hwmonStatus.telemetry_stale || (hwData && hwPollError));
  const sampleAgeSec =
    (hwData?.sample_age_ms ?? hwmonStatus.sample_age_ms) != null
      ? Math.round(((hwData?.sample_age_ms ?? hwmonStatus.sample_age_ms) ?? 0) / 1000)
      : null;
  const driverBlocked = hwmonStatus.status === "driver_blocked";
  const restarting = hwmonStatus.status === "restarting" || isRestartingHwmon;
  const sidecarOnline = hwData?.sidecar_online === true && hwmonStatus.status === "ready";
  const sidecarStatus = restarting ? "Служба перезапускается"
    : driverBlocked ? "Доступ к драйверу ограничен"
    : telemetryStale ? "Показания устарели"
    : sidecarOnline ? "Датчики подключены"
    : hwData ? "Доступны показания Windows" : "Ожидание датчиков";
  const canRestart = hwmonStatus.status === "offline" || restarting || driverBlocked || telemetryStale;

  const [mode, setMode] = useWorkspaceState<"live" | "sensors" | "adapters" | "history">("hardware.mode", "live");
  const [minutes, setMinutes] = useWorkspaceState("hardware.minutes", 60);
  const [history, setHistory] = useState<TelemetrySnapshot[]>([]);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const thresholds = c.alertThresholds;
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [hideUnavailable, setHideUnavailable] = useWorkspaceState("hardware.hideUnavailable", false);

  const [exportPath, setExportPath] = useState("");
  const [exportError, setExportError] = useState("");
  const [filter, setFilter] = useWorkspaceState<SensorFilter>("hardware.filter", "all");
  const [extremes, setExtremes] = useState<Record<string, { min: number; max: number }>>({});
  const [selectedGpuIdx, setSelectedGpuIdx] = useWorkspaceState<number>("hardware.selectedGpuIdx", 0);
  const [netFilter, setNetFilter] = useWorkspaceState<"all" | "physical" | "virtual">("hardware.netFilter", "all");
  const [showSystemTunnels, setShowSystemTunnels] = useWorkspaceState<boolean>("hardware.showSystemTunnels", false);

  const gpus = hwData?.gpus ?? [];
  const gpu = gpus[selectedGpuIdx] ?? gpus[0];
  const packageReason = cpuPackageUnavailableReason({
    sample: !!hwData, online: !!hwData?.sidecar_online, driverBlocked,
    hvciConfigured: !!hwData?.cpu.hvci_enabled, elevated: !!hwData?.is_admin,
  });
  const overview = summarizeSensors([
    { name: "Пакет CPU", value: hwData?.cpu.package_temp_c, limit: thresholds.cpu, direction: "maximum", unit: "°C", stale: telemetryStale, reason: packageReason },
    ...(gpus.length ? gpus : [null]).map((device, index) => ({
      name: device?.name ? `Ядро GPU · ${device.name}` : gpus.length > 1 ? `Ядро GPU ${index + 1}` : "Ядро GPU",
      value: device?.core_temp_c, limit: thresholds.gpu, direction: "maximum" as const, unit: "°C", stale: telemetryStale,
    })),
    { name: "Свободное место C:", value: metricsReady && metrics.disk_total_gb > 0 ? metrics.disk_free_gb : null,
      limit: thresholds.disk, direction: "minimum", unit: "ГБ", stale: Boolean(metricsError) },
  ]);

  useEffect(() => {
    if (selectedGpuIdx > 0 && selectedGpuIdx >= gpus.length) {
      setSelectedGpuIdx(0);
    }
  }, [gpus.length, selectedGpuIdx]);

  const netAdapters = useMemo(() => {
    const all = netSnapshot?.adapters ?? [];
    const base = showSystemTunnels ? all : all.filter((a) => !a.is_system_tunnel);
    if (netFilter === "physical") return base.filter((a) => a.is_physical);
    if (netFilter === "virtual") return base.filter((a) => !a.is_physical);
    return base;
  }, [netSnapshot, netFilter, showSystemTunnels]);

  const physicalNetCount = useMemo(
    () => (netSnapshot?.adapters ?? []).filter((a) => a.is_physical).length,
    [netSnapshot]
  );
  const virtualNetCount = useMemo(
    () =>
      (netSnapshot?.adapters ?? []).filter(
        (a) => !a.is_physical && (showSystemTunnels || !a.is_system_tunnel)
      ).length,
    [netSnapshot, showSystemTunnels]
  );

  const ramReady = metricsReady && metrics.ram_total_gb > 0;
  const rows = useMemo(
    () => buildRows(hwData, hwmonStatus.status, ramReady ? metrics.ram_used_gb : null, ramReady ? metrics.ram_percentage : null),
    [hwData, hwmonStatus.status, ramReady, metrics.ram_used_gb, metrics.ram_percentage]
  );

  const cpuLoads = hwData?.cpu.core_loads ?? [];
  const cpuClockGhz = hwData?.cpu.avg_clock_mhz != null ? hwData.cpu.avg_clock_mhz / 1000 : null;
  const cpuBaseGhz = hwData?.cpu.base_clock_mhz != null ? hwData.cpu.base_clock_mhz / 1000 : null;
  const physCores = hwData?.cpu.physical_cores ?? 0;
  const logCores = hwData?.cpu.logical_cores ?? cpuLoads.length;

  const visible = useMemo(() => {
    const byGroup = filter === "all" ? filters.slice(1).flatMap(({ id }) => rows.filter((row) => row.group === id))
      : rows.filter((row) => row.group === filter);
    return hideUnavailable ? byGroup.filter((row) => row.raw != null) : byGroup;
  }, [rows, filter, hideUnavailable]);

  useEffect(() => {
    setExtremes((prev) => {
      let next = prev;
      for (const row of rows) {
        if (row.raw == null || (telemetryStale && !row.id.startsWith("ram-")) ||
            (metricsError && row.id.startsWith("ram-"))) continue;
        const key = `${row.id}:${row.name}`;
        const current = prev[key];
        if (current && current.min <= row.raw && current.max >= row.raw) continue;
        if (next === prev) next = { ...prev };
        next[key] = current
          ? { min: Math.min(current.min, row.raw), max: Math.max(current.max, row.raw) }
          : { min: row.raw, max: row.raw };
      }
      return next;
    });
  }, [rows, telemetryStale, metricsError]);

  useEffect(() => {
    if (mode !== "history" || !c.windowVisible) return;
    let alive = true;
    let timer: number | undefined;
    const pull = async () => {
      const bundle = await c.loadTelemetryBundle(minutes);
      if (!alive) return;
      setHistory(bundle.history);
      setReport(bundle.report);
      setHistoryError(bundle.error);
      timer = window.setTimeout(pull, 2000);
    };
    void pull();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [mode, minutes, c.loadTelemetryBundle, c.windowVisible]);

  const spikes = useMemo(
    () =>
      [...history]
        .sort((a, b) => Math.max(b.cpu_usage, b.top_process_cpu) - Math.max(a.cpu_usage, a.top_process_cpu))
        .slice(0, 5),
    [history]
  );

  return (
    <div className="avs-module avs-hardware @container w-full space-y-4">
      <ModuleHeader module="hardware"
        title="Аппаратные датчики"
        description="Температуры, нагрузка и питание компонентов"
        actions={
          <span role="status" className="inline-flex items-center gap-2 text-xs text-[var(--nexus-muted)]">
            <span className={`size-1.5 rounded-full ${sidecarOnline && !telemetryStale && !driverBlocked ? "bg-[var(--nexus-accent)]" : "bg-amber-400"}`} />
            {sidecarStatus}
          </span>
        }
      />

      <details className="nexus-panel px-4 py-3 text-sm avs-hardware-summary">
        <summary className="cursor-pointer">
          <strong>Основные показатели</strong>
          <span className="ml-3 text-[var(--nexus-muted)]">
            {!overview.evaluated && "Нет оценки · "}
            {overview.counts.normal} в норме · {overview.counts.warning} предупрежд. · {overview.counts.unavailable} недоступно
            {overview.counts.stale > 0 && ` · ${overview.counts.stale} устарело`}
          </span>
        </summary>
        <dl className="mt-2 divide-y divide-[var(--nexus-line)] text-xs">
          {overview.readings.map((item, index) => (
            <div key={index} className="flex flex-wrap justify-between gap-x-4 py-1.5">
              <dt>{item.name} <span className="text-[var(--nexus-muted)]">· порог {item.limit} {item.unit}</span></dt>
              <dd className={item.state === "warning" || item.state === "stale" ? "text-amber-300" : "text-[var(--nexus-muted)]"}>
                {reading(item.value, item.unit === "°C" ? 1 : 0, item.unit) ?? "Н/Д"} · {sensorStateLabels[item.state]}
                {item.state === "unavailable" && item.reason && <span> · {item.reason}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </details>

      {(canRestart || hwPollError) && (
        <div className="nexus-panel flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium text-amber-300">
              <AlertTriangle size={16} aria-hidden />
              {driverBlocked
                ? "Windows заблокировала драйвер телеметрии. Часть датчиков может быть недоступна."
                : restarting ? "Служба запускает датчики повторно."
                : telemetryStale ? "Показаны последние полученные значения."
                : hwPollError ? "Часть показаний не удалось обновить."
                : "Датчики службы мониторинга недоступны."}
              {telemetryStale && sampleAgeSec !== null && <span className="font-mono">{sampleAgeSec} с</span>}
            </p>
            {(hwPollError || hwmonStatus.last_error) && (
              <details className="mt-1.5 text-xs text-[var(--nexus-muted)]">
                <summary className="cursor-pointer">Подробности</summary>
                <p className="mt-1 break-words">{hwPollError || hwmonStatus.last_error}</p>
              </details>
            )}
          </div>
          {canRestart && (
            <button type="button" disabled={restarting} onClick={() => void handleRestartHwmon()} className="nexus-button">
              <RefreshCw size={14} aria-hidden />
              {restarting ? "Перезапуск…" : "Перезапустить службу"}
            </button>
          )}
        </div>
      )}

      <div className="avs-workspace-tabs" role="group" aria-label="Просмотр датчиков">
        {([
          ["live", "Оборудование", Cpu],
          ["sensors", "Датчики", Activity],
          ["adapters", "Интерфейсы", Network],
          ["history", "История и диагностика", Gauge],
        ] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)}><Icon size={16} />{label}</button>
        ))}
      </div>

      {mode === "history" ? (
        <HistoryPanel
          minutes={minutes}
          onMinutes={setMinutes}
          history={history}
          historyError={historyError}
          report={report}
          thresholds={thresholds}
          spikes={spikes}
          exportPath={exportPath}
          exportError={exportError}
          onExport={() => {
            setExportError("");
            void c
              .exportTelemetryCsv()
              .then((path) => setExportPath(path))
              .catch((err) => setExportError(String(err)));
          }}
        />
      ) : mode === "live" ? (
        <>
          {metricsError && (
            <p role="status" className="break-words px-1 text-sm text-amber-300">
              Системные метрики не обновились. {metricsError}
            </p>
          )}

          <div className="avs-device-board">
          <div className="avs-device-stack">
            <SensorSummary device="cpu" title="Процессор" load={metricsReady ? metrics.cpu_usage : null} icon={<Cpu size={17} />} name={hwData?.cpu.name?.trim() || "CPU"}
              readings={[
                { label: telemetryStale ? "Пакет CPU · последний замер" : "Температура пакета", value: reading(hwData?.cpu.package_temp_c, 1, "°C") },
                { label: "Частота", value: reading(cpuClockGhz, 2, "ГГц") },
                { label: "Базовая частота", value: reading(cpuBaseGhz, 2, "ГГц") },
                { label: "Ядра / потоки", value: physCores > 0 && logCores > 0 ? `${physCores} / ${logCores}` : null },
                { label: "Мощность пакета", value: reading(hwData?.cpu.power_watts, 1, "Вт") },
                { label: "Напряжение ядра", value: reading(hwData?.cpu.voltage_v, 3, "В") },
              ]}
            >
              {hwData && hwData.cpu.package_temp_c == null && (
                <p className="mt-3 text-xs text-[var(--nexus-muted)]">{packageReason}</p>
              )}
              {cpuLoads.length > 0 && (
                <div className="mt-4 border-t border-[var(--nexus-line)] pt-3">
                  <div className="mb-2 flex flex-wrap justify-between gap-x-2 text-xs text-[var(--nexus-muted)]">
                    <span>Загрузка логических потоков</span>
                    <span className="font-mono tabular-nums">{cpuLoads.length} · макс. {Math.max(...cpuLoads).toFixed(0)}%</span>
                  </div>
                  <div className="flex h-5 items-end gap-[2px]">
                    {cpuLoads.map((load, index) => (
                      <div key={index} title={`Поток ${index + 1} · ${load.toFixed(1)}%`}
                        className="flex h-full min-w-0 flex-1 items-end rounded-sm bg-[var(--nexus-line)]">
                        <div className="w-full rounded-sm bg-[var(--nexus-accent)]" style={{ height: `${Math.min(100, Math.max(0, load))}%` }} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </SensorSummary>

            <SensorSummary device="gpu" title="Графика" load={gpu?.load_percent} icon={<Gauge size={17} />}
              name={gpu?.name || (hwData ? "Адаптер не обнаружен" : "Ожидание данных")}
              action={gpus.length > 1 ? (
                <select aria-label="Графический адаптер" className="nexus-button max-w-48" value={selectedGpuIdx}
                  onChange={(event) => setSelectedGpuIdx(Number(event.target.value))}>
                  {gpus.map((item, index) => <option key={`${item.name}-${index}`} value={index}>{item.name}</option>)}
                </select>
              ) : gpu?.telemetry_source ? (
                <span className="text-xs text-[var(--nexus-muted)]">{gpu.telemetry_source}</span>
              ) : undefined}
              readings={[
                { label: "Температура ядра", value: reading(gpu?.core_temp_c, 1, "°C") },
                { label: "Hotspot", value: reading(gpu?.hotspot_temp_c, 1, "°C") },
                { label: "Температура памяти", value: reading(gpu?.memory_temp_c, 1, "°C") },
                { label: "Видеопамять", value: gpu?.vram_used_mb != null && gpu.vram_total_mb != null
                  ? `${(gpu.vram_used_mb / 1024).toFixed(1)} / ${(gpu.vram_total_mb / 1024).toFixed(1)} ГБ`
                  : reading(gpu?.vram_total_mb != null ? gpu.vram_total_mb / 1024 : null, 1, "ГБ") },
                { label: "Частота ядра", value: reading(gpu?.core_clock_mhz, 0, "МГц") },
                { label: "Мощность платы", value: reading(gpu?.power_watts, 1, "Вт") },
                { label: "Вентилятор", value: reading(gpu?.fan_rpm, 0, "об/мин") ?? reading(gpu?.fan_percent, 0, "%") },
              ]}
            />
          </div>

          <section className="nexus-panel avs-hardware-inventory">
            <h2>Конфигурация системы</h2>
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm text-[var(--nexus-muted)]"><Server size={16} className="text-[var(--nexus-accent)]" /> Системная плата</h2>
              <p className="mt-1.5 break-words text-sm font-semibold text-[var(--nexus-text)]">{hwData?.motherboard_name || "Модель недоступна"}</p>
              {!!hwData?.system_fans.length && <p className="mt-1 text-xs text-[var(--nexus-muted)]">Корпусных вентиляторов · {hwData.system_fans.length}</p>}
            </div>
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm text-[var(--nexus-muted)]"><MemoryStick size={16} className="text-[var(--nexus-accent)]" /> Оперативная память</h2>
              <p className="mt-1.5 font-mono text-sm font-semibold tabular-nums text-[var(--nexus-text)]">
                {ramReady ? `${metrics.ram_used_gb.toFixed(1)} / ${metrics.ram_total_gb.toFixed(1)} ГБ` : "Показания недоступны"}
              </p>
              {metricsReady && metrics.swap_total_gb > 0 && (
                <p className="mt-1 text-xs text-[var(--nexus-muted)]">Подкачка · {metrics.swap_used_gb.toFixed(1)} / {metrics.swap_total_gb.toFixed(1)} ГБ</p>
              )}
            </div>
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm text-[var(--nexus-muted)]"><HardDrive size={16} className="text-[var(--nexus-accent)]" /> Накопители</h2>
              {hwData?.storage_temps.length ? (
                <ul className="mt-1 divide-y divide-[var(--nexus-line)]">
                  {hwData.storage_temps.map((disk, index) => (
                    <li key={`${disk.name}-${index}`} className="flex items-baseline justify-between gap-2 py-1.5 text-xs">
                      <span className="min-w-0 truncate text-[var(--nexus-text)]" title={disk.name}>{disk.name || "Накопитель"}</span>
                      <span className="shrink-0 font-mono tabular-nums text-[var(--nexus-muted)]">{reading(disk.temp_c, 0, "°C") ?? "Нет данных"}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-1.5 text-sm text-[var(--nexus-muted)]">Показания недоступны</p>}
            </div>
          </section>

          </div>
        </>
      ) : mode === "sensors" ? (
          <div className="avs-sensor-workspace">
            <aside className="nexus-panel avs-sensor-index" aria-label="Группы датчиков">
              <h2>Группы</h2>
              {filters.map((item) => (
                <button key={item.id} type="button" onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>
                  <span>{item.label}</span>
                  <small>{rows.filter((row) => item.id === "all" || row.group === item.id).length}</small>
                </button>
              ))}
            </aside>
            <section className="nexus-panel min-w-0 overflow-hidden">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--nexus-line)] px-4 py-3">
                <h2 className="text-base font-semibold">Показания датчиков</h2>
                <button type="button" className="nexus-button" aria-pressed={hideUnavailable} onClick={() => setHideUnavailable((prev) => !prev)}>
                  {hideUnavailable ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
                  {hideUnavailable ? "Показать все датчики" : "Скрыть недоступные"}
                </button>
              </header>
            <div className="overflow-x-auto" role="region" aria-label="Показания датчиков" tabIndex={0}>
            <table className="w-full min-w-[570px] text-left text-sm">
              <thead className="border-b border-[#202B38] bg-[#0B0E14] text-xs text-[#8292A3]">
                <tr>
                  <th scope="col" className="px-3 py-2.5 font-medium lg:px-4">Узел</th>
                  <th scope="col" className="px-3 py-2.5 font-medium lg:px-4">Датчик</th>
                  <th scope="col" className="px-3 py-2.5 font-medium lg:px-4">{telemetryStale ? "Последний замер" : "Текущее значение"}</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium lg:px-4">Мин.</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium lg:px-4">Макс.</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-[#8292A3]">
                      Нет доступных показаний для выбранного фильтра
                    </td>
                  </tr>
                ) : (
                  visible.map((row) => {
                    const range = extremes[`${row.id}:${row.name}`];
                    const critLimit = row.id === "cpu-package" ? thresholds.cpu : /^gpu-\d+-core$/.test(row.id) ? thresholds.gpu : null;
                    const isCrit = !telemetryStale && row.unit === "°C" && row.raw !== null && critLimit !== null && row.raw >= critLimit;

                    return (
                      <tr
                        key={row.id}
                        className="border-b border-[#202B38]/60 transition-colors hover:bg-[#151C26]/60 last:border-0"
                      >
                        <td className="w-24 px-3 py-2 text-xs text-[var(--nexus-muted)] lg:px-4">
                          {GROUP_LABELS[row.group]}
                        </td>
                        <td className="break-words px-3 py-2 text-[var(--nexus-text)] lg:px-4">
                          {row.name}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs tabular-nums lg:px-4">
                          {row.raw != null ? (
                            <span className={`inline-flex items-center gap-1.5 whitespace-nowrap font-semibold ${isCrit ? "text-rose-300" : "text-[var(--nexus-text)]"}`}>
                              {isCrit && <span title="Превышен порог нагрева"><AlertTriangle size={14} aria-label="Превышен порог нагрева" /></span>}
                              {row.text}
                            </span>
                          ) : (
                            <span className="text-[var(--nexus-muted)]">
                              {row.reason ?? "Недоступно"}
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs tabular-nums text-[var(--nexus-muted)] lg:px-4">
                          {range ? `${range.min.toFixed(row.digits)} ${row.unit}` : <span className="text-[var(--nexus-muted)]">—</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs tabular-nums text-[var(--nexus-muted)] lg:px-4">
                          {range ? `${range.max.toFixed(row.digits)} ${row.unit}` : <span className="text-[var(--nexus-muted)]">—</span>}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            </div>
          </section>

          </div>
      ) : (
          <section className="nexus-panel min-w-0 overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--nexus-line)] px-4 py-3">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <Network size={16} className="text-[var(--nexus-accent)]" aria-hidden />
                <h2 className="text-base font-semibold text-[var(--nexus-text)]">Сетевые адаптеры</h2>
                {netSnapshot && <span className="text-xs text-[var(--nexus-muted)]">Физические · {physicalNetCount} / Виртуальные · {virtualNetCount}</span>}
              </div>
              <div className="flex flex-wrap gap-1.5" aria-label="Фильтр сетевых адаптеров">
                {([["all", "Все"], ["physical", "Физические"], ["virtual", "Виртуальные"]] as const).map(([id, label]) => (
                  <button key={id} type="button" className="nexus-button" aria-pressed={netFilter === id} onClick={() => setNetFilter(id)}>{label}</button>
                ))}
                <button type="button" className="nexus-button" aria-pressed={showSystemTunnels} onClick={() => setShowSystemTunnels((prev) => !prev)}>
                  Системные туннели
                </button>
              </div>
            </header>

            {c.netSnapshotError && <p role="alert" className="nexus-message nexus-message--error m-3">
              Сетевые адаптеры не обновились. {c.netSnapshotError}
            </p>}
            {netAdapters.length === 0 ? (
              <p className="nexus-empty py-8 text-center text-sm">
                {c.netSnapshotError && !netSnapshot ? "Сетевые показания недоступны" : netSnapshot === null ? "Ожидание сетевых показаний" : "Для выбранного фильтра адаптеров нет"}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--nexus-line)]">
                {netAdapters.map((adapter) => {
                  const rxRate = formatThroughputRate(adapter.rx_bytes_per_sec, "mbps");
                  const txRate = formatThroughputRate(adapter.tx_bytes_per_sec, "mbps");
                  const Icon = adapter.adapter_kind === "wifi" ? Wifi : Cable;
                  return (
                    <li key={adapter.id} className="grid min-w-0 gap-x-4 gap-y-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <Icon size={15} className="text-[var(--nexus-accent)]" aria-hidden />
                          <span className="break-all text-sm font-semibold text-[var(--nexus-text)]">{adapter.name}</span>
                          <span className={adapter.is_connected ? "text-xs text-emerald-300" : "text-xs text-[var(--nexus-muted)]"}>
                            {adapter.status_label}{adapter.is_primary ? " · Основной" : ""}
                          </span>
                        </div>
                        {adapter.description && <p className="mt-1 truncate text-xs text-[var(--nexus-muted)]" title={adapter.description}>{adapter.description}</p>}
                        <p className="mt-1 text-xs text-[var(--nexus-muted)]">
                          {[adapter.is_physical ? "Физический" : "Виртуальный", adapter.adapter_type_label, adapter.manufacturer].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <dl className="grid min-w-0 grid-cols-2 items-start gap-x-4 gap-y-1.5 text-xs">
                        <div>
                          <dt className="text-[var(--nexus-muted)]">Линия</dt>
                          <dd className="mt-0.5 font-mono text-[var(--nexus-text)]">{adapter.is_connected ? formatLinkSpeed(adapter.link_speed_bps) : "Нет линка"}</dd>
                        </div>
                        <div>
                          <dt className="text-[var(--nexus-muted)]">Приём / отдача</dt>
                          <dd className="mt-0.5 font-mono tabular-nums text-[var(--nexus-text)]">{rxRate.value} {rxRate.unit} / {txRate.value} {txRate.unit}</dd>
                        </div>
                        <div>
                          <dt className="text-[var(--nexus-muted)]">IPv4</dt>
                          <dd className="mt-0.5 break-all font-mono text-[var(--nexus-text)]">{adapter.ipv4_addresses[0] ?? "Не назначен"}</dd>
                        </div>
                        {adapter.ipv6_addresses[0] && (
                          <div>
                            <dt className="text-[var(--nexus-muted)]">IPv6</dt>
                            <dd className="mt-0.5 truncate font-mono text-[var(--nexus-text)]" title={adapter.ipv6_addresses.join(", ")}>
                              {adapter.ipv6_addresses[0]}
                            </dd>
                          </div>
                        )}
                        {adapter.mac_address && (
                          <div>
                            <dt className="text-[var(--nexus-muted)]">MAC</dt>
                            <dd className="mt-0.5 break-all font-mono text-[var(--nexus-text)]">{adapter.mac_address}</dd>
                          </div>
                        )}
                      </dl>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
      )}
    </div>
  );
}

function clock(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function SeriesChart({
  history,
  series,
  ceiling,
  marks,
}: {
  history: TelemetrySnapshot[];
  series: {
    key: "cpu_usage" | "gpu_usage" | "ram_used_percent" | "cpu_temp" | "gpu_temp";
    color: string;
    label: string;
  }[];
  ceiling: number;
  marks: { value: number; color: string }[];
}) {
  const width = 640;
  const height = 168;
  const first = history[0];
  const latestPoint = history[history.length - 1];
  const span = Math.max(1, (latestPoint?.timestamp ?? 0) - (first?.timestamp ?? 0));
  const y = (value: number) => height - (Math.min(ceiling, Math.max(0, value)) / ceiling) * (height - 16) - 8;
  const pathFor = (key: (typeof series)[number]["key"]) => {
    let connected = false;
    let available = false;
    const d = history.map((point) => {
      const raw = point[key];
      if (raw == null || !Number.isFinite(raw)) {
        connected = false;
        return "";
      }
      available = true;
      const x = ((point.timestamp - first.timestamp) / span) * width;
      const coord = `${x.toFixed(1)},${y(raw).toFixed(1)}`;
      const command = connected ? `L${coord}` : `M${coord} L${coord}`;
      connected = true;
      return command;
    }).join(" ");
    return { d, available };
  };
  const plots = series.map((item) => ({ ...item, ...pathFor(item.key) }));
  return (
    <div className="nexus-panel min-w-0 p-4">
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#8292A3]">
        {series.map((item) => {
          const val = latestPoint ? latestPoint[item.key] : null;
          const unit = item.key.includes("temp") ? "°C" : "%";
          return (
            <span key={item.key} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: item.color }} />
              <span>{item.label}</span>
              <span className="font-mono font-semibold text-[#E5EDF5]">
                {val != null && Number.isFinite(val) ? `${val.toFixed(0)}${unit}` : "—"}
              </span>
            </span>
          );
        })}
      </div>
      {history.length < 2 || !plots.some(({ available }) => available) ? (
        <p className="nexus-empty grid min-h-40 place-items-center text-center text-sm">
          {plots.some(({ available }) => available) ? "График появится после двух замеров" : "Для графика пока нет показаний"}
        </p>
      ) : <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-40 w-full rounded-lg border border-[var(--nexus-line)] bg-[var(--nexus-bg)]"
        aria-hidden
      >
        {marks.map((mark) => {
          return (
            <line
              key={mark.color}
              x1="0"
              x2={width}
              y1={y(mark.value)}
              y2={y(mark.value)}
              stroke={mark.color}
              strokeDasharray="4 4"
              strokeWidth="1"
            />
          );
        })}
        {plots.map((item) => (
          <path
            key={item.key}
            d={item.d}
            fill="none"
            stroke={item.color}
            strokeWidth="1.75"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>}
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-[#526170]">
        <span>{history[0] ? clock(history[0].timestamp) : "—"}</span>
        <span>{history.length > 0 ? clock(history[history.length - 1].timestamp) : "—"}</span>
      </div>
    </div>
  );
}

function HistoryPanel({
  minutes,
  onMinutes,
  history,
  historyError,
  report,
  thresholds,
  spikes,
  exportPath,
  exportError,
  onExport,
}: {
  minutes: number;
  onMinutes: (value: number) => void;
  history: TelemetrySnapshot[];
  historyError: string | null;
  report: DiagnosticsReport | null;
  thresholds: { cpu: number; gpu: number };
  spikes: TelemetrySnapshot[];
  exportPath: string;
  exportError: string;
  onExport: () => void;
}) {
  const badge =
    report?.stability === "Критично"
      ? "border-rose-500/35 bg-rose-500/12 text-rose-300"
      : report?.stability === "Отлично"
      ? "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]"
      : "border-amber-500/35 bg-amber-500/12 text-amber-300";
  const tempCeiling = Math.max(
    100,
    thresholds.cpu,
    thresholds.gpu,
    ...history.flatMap((point) => [point.cpu_temp ?? 0, point.gpu_temp ?? 0])
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {[15, 30, 60].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onMinutes(value)}
              aria-pressed={minutes === value}
              className="nexus-button"
            >
              {value} минут
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onExport}
          className="nexus-button"
        >
          <Download size={13} />
          Экспорт в CSV
        </button>
      </div>
      {exportPath && <p className="font-mono text-[11px] text-[#00D5E8]">Сохранено: {exportPath}</p>}
      {exportError && <p className="text-xs text-rose-300">{exportError}</p>}
      {historyError && <p role="alert" className="break-words text-sm text-amber-300">{historyError}</p>}

      <section className="nexus-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[#E5EDF5]">
            Диагностика нагрузки
          </h3>
          <span className={`rounded-md border px-2.5 py-0.5 font-mono text-[11px] ${badge}`}>
            {report?.status ?? (historyError ? "Недоступна" : "Сбор данных")}
          </span>
        </div>
        <p className="mt-2.5 text-sm text-[#8292A3]">
          {report?.verdict ?? (historyError ? "Не удалось обновить отчёт." : "Ожидание первых измерений.")}
        </p>
        {report && report.incidents.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-[#8292A3]">
            {report.incidents.map((item) => (
              <li key={item.message}>{item.message}</li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-medium text-[#8292A3]">Загрузка CPU, GPU и RAM</div>
          <SeriesChart
            history={history}
            ceiling={100}
            marks={[]}
            series={[
              { key: "cpu_usage", color: "#00D5E8", label: "CPU" },
              { key: "gpu_usage", color: "#36AFC0", label: "GPU" },
              { key: "ram_used_percent", color: "#818CF8", label: "RAM" },
            ]}
          />
        </div>
        <div>
          <div className="mb-2 text-xs font-medium text-[#8292A3]">Температурный профиль</div>
          <SeriesChart
            history={history}
            ceiling={tempCeiling}
            marks={[
              { value: thresholds.cpu, color: "#f59e0b" },
              { value: thresholds.gpu, color: "#f43f5e" },
            ]}
            series={[
              { key: "cpu_temp", color: "#f59e0b", label: "CPU °C" },
              { key: "gpu_temp", color: "#f43f5e", label: "GPU °C" },
            ]}
          />
        </div>
      </div>

      <section className="nexus-panel overflow-hidden">
        <div className="border-b border-[#202B38] px-4 py-3 text-sm font-semibold text-[#E5EDF5]">
          Пиковые нагрузки ЦП
        </div>
        {spikes.length === 0 ? (
          <p className="px-4 py-6 text-sm text-[#8292A3]">Пиковых точек пока не зафиксировано</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="bg-[#0B0E14] text-[#8292A3]">
              <tr className="border-b border-[#202B38]">
                <th className="px-4 py-2 font-medium">Время</th>
                <th className="px-4 py-2 font-medium">Пик нагрузки</th>
                <th className="px-4 py-2 font-medium">Активный процесс</th>
              </tr>
            </thead>
            <tbody>
              {spikes.map((point) => (
                <tr key={point.timestamp} className="border-b border-[#202B38]/50 last:border-0">
                  <td className="px-4 py-2 font-mono text-[#8292A3]">{clock(point.timestamp)}</td>
                  <td className="px-4 py-2 font-mono font-semibold text-[#00D5E8]">
                    {Math.max(point.cpu_usage, point.top_process_cpu).toFixed(0)}%
                  </td>
                  <td className="px-4 py-2 text-[#E5EDF5]">{point.top_process_name || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
