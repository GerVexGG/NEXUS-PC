import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
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
  PageHeader,
  formatLinkSpeed,
  formatThroughputRate,
  type DiagnosticsReport,
  type HardwareTelemetry,
  type HwmonStatus,
  type TelemetrySnapshot,
} from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

type SensorGroup = "cpu" | "gpu" | "memory" | "disk" | "fan";
type SensorFilter = "all" | SensorGroup;

type SensorRow = {
  id: string;
  group: SensorGroup;
  name: string;
  raw: number | null;
  text: string;
  unit: string;
  reason?: string;
};

const filters: { id: SensorFilter; label: string }[] = [
  { id: "all", label: "Все датчики" },
  { id: "cpu", label: "Процессор (CPU)" },
  { id: "gpu", label: "Видеокарта (GPU)" },
  { id: "memory", label: "Память" },
  { id: "disk", label: "Накопители" },
  { id: "fan", label: "Охлаждение" },
];

const GROUP_LABELS: Record<SensorGroup, string> = {
  cpu: "CPU",
  gpu: "GPU",
  memory: "RAM / VRAM",
  disk: "STORAGE",
  fan: "FAN",
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
  if (!hw) return "Инициализация…";
  if (hw.cpu.hvci_enabled || status === "driver_blocked") return "Ограничение HVCI";
  if (!hw.sidecar_online) return "Сайдкар отключён";
  if (!hw.is_admin) return "Нужен Админ (MSR)";
  return "Не поддерживается";
}

function buildRows(
  hw: HardwareTelemetry | null,
  status: HwmonStatus,
  ramGb: number,
  ramPct: number
): SensorRow[] {
  const rows: SensorRow[] = [];
  const defaultGpuReason = !hw
    ? "Инициализация…"
    : !hw.sidecar_online
    ? "Сайдкар отключён"
    : "Не поддерживается";
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
      reason: formatted.raw == null ? reason ?? "Недоступно" : undefined,
    });
  };

  push("cpu-package", "cpu", "Температура пакета CPU", hw?.cpu.package_temp_c, 1, "°C", msrReason);
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
    push(`gpu-${index}-mem`, "memory", `${title} · Температура VRAM`, gpu.memory_temp_c, 1, "°C", defaultGpuReason);
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
    push(`gpu-${index}-volt`, "gpu", `${title} · Напряжение ядра`, gpu.voltage_v, 3, "В", "Не поддерживается");
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
    push(`board-${index}`, "cpu", sensor.name || `Датчик платы #${index + 1}`, sensor.temp_c, 0, "°C");
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

function SubMetricTile({
  label,
  value,
  textOverride,
  subText,
  unsupportedLabel = "Недоступно",
}: {
  label: string;
  value: { raw: number | null; text: string };
  textOverride?: string;
  subText?: string;
  unsupportedLabel?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-2">
      <div className="truncate text-[11px] text-[#8292A3]">{label}</div>
      {value.raw != null || textOverride ? (
        <div className="mt-0.5 flex items-baseline justify-between gap-1">
          <span className="truncate font-mono text-xs font-semibold text-[#E5EDF5]">
            {textOverride ?? value.text}
          </span>
          {subText && (
            <span className="shrink-0 font-mono text-[10px] text-[#526170]">{subText}</span>
          )}
        </div>
      ) : (
        <div className="mt-0.5 truncate font-mono text-[11px] text-[#526170]">
          {unsupportedLabel}
        </div>
      )}
    </div>
  );
}

export function HardwareModule({ c }: { c: NexusController }) {
  const {
    hwData,
    hwmonStatus,
    isRestartingHwmon,
    handleRestartHwmon,
    metrics,
    thermalWarnings,
    metricsReady,
    netSnapshot,
  } = c;
  const sidecarOnline = hwData?.sidecar_online === true || hwmonStatus.status === "ready";
  const sidecarStatus =
    hwmonStatus.status === "driver_blocked"
      ? {
          label: "NEXUS HWMON · ОГРАНИЧЕНИЕ HVCI",
          dot: "bg-amber-400",
          chip: "border-amber-500/35 bg-amber-500/12 text-amber-300",
        }
      : hwmonStatus.status === "restarting" || isRestartingHwmon
      ? {
          label: `NEXUS HWMON · ПЕРЕЗАПУСК (#${Math.max(1, hwmonStatus.restart_count)})`,
          dot: "bg-amber-400 animate-pulse",
          chip: "border-amber-500/35 bg-amber-500/12 text-amber-300",
        }
      : sidecarOnline && metricsReady
      ? {
          label: "NEXUS HWMON · АКТИВЕН",
          dot: "bg-[#00D5E8] shadow-[0_0_6px_rgba(0,213,232,0.8)]",
          chip: "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]",
        }
      : sidecarOnline
      ? {
          label: "NEXUS HWMON · СИНХРОНИЗАЦИЯ…",
          dot: "bg-[#00D5E8] animate-pulse",
          chip: "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]",
        }
      : {
          label: "NEXUS HWMON · АВТОНОМНЫЙ РЕЖИМ",
          dot: "bg-[#526170]",
          chip: "border-[#202B38] bg-[#10151D] text-[#8292A3]",
        };

  const [mode, setMode] = useState<"live" | "history">("live");
  const [minutes, setMinutes] = useState(60);
  const [history, setHistory] = useState<TelemetrySnapshot[]>([]);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [thresholds, setThresholds] = useState(() => ({
    cpu: c.alertThresholds?.cpu ?? 85,
    gpu: c.alertThresholds?.gpu ?? 83,
  }));
  const [hideUnavailable, setHideUnavailable] = useState(false);

  useEffect(() => {
    setThresholds({
      cpu: c.alertThresholds?.cpu ?? 85,
      gpu: c.alertThresholds?.gpu ?? 83,
    });
  }, [c.alertThresholds?.cpu, c.alertThresholds?.gpu]);

  const [exportPath, setExportPath] = useState("");
  const [exportError, setExportError] = useState("");
  const [filter, setFilter] = useState<SensorFilter>("all");
  const [extremes, setExtremes] = useState<Record<string, { min: number; max: number }>>({});
  const [selectedGpuIdx, setSelectedGpuIdx] = useState<number>(0);
  const [netFilter, setNetFilter] = useState<"all" | "physical" | "virtual">("all");
  const [showSystemTunnels, setShowSystemTunnels] = useState<boolean>(false);

  const gpus = hwData?.gpus ?? [];
  const gpu = gpus[selectedGpuIdx] ?? gpus[0];

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

  const rows = useMemo(
    () => buildRows(hwData, hwmonStatus.status, metrics.ram_used_gb, metrics.ram_percentage),
    [hwData, hwmonStatus.status, metrics.ram_used_gb, metrics.ram_percentage]
  );

  const cpuMsrBadge = useMemo(() => {
    if (!hwData) return { label: "ОЖИДАНИЕ ДАТЧИКОВ", tone: "border-[#202B38] bg-[#151C26] text-[#8292A3]" };
    if (hwData.cpu.hvci_enabled || hwmonStatus.status === "driver_blocked") {
      return { label: "ОГРАНИЧЕНИЕ HVCI (MSR)", tone: "border-amber-500/35 bg-amber-500/12 text-amber-300" };
    }
    if (!hwData.is_admin) {
      return { label: "MSR · НУЖЕН АДМИН", tone: "border-amber-500/35 bg-amber-500/12 text-amber-300" };
    }
    if (!hwData.sidecar_online) {
      return { label: "САЙДКАР ОТКЛЮЧЁН", tone: "border-[#202B38] bg-[#151C26] text-[#8292A3]" };
    }
    return { label: "ТЕЛЕМЕТРИЯ АКТИВНА", tone: "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]" };
  }, [hwData, hwmonStatus.status]);

  const cpuUnavailShort = useMemo(() => {
    if (!hwData) return "Опрос…";
    if (hwData.cpu.hvci_enabled || hwmonStatus.status === "driver_blocked") return "Блок HVCI";
    if (!hwData.is_admin) return "Нужен Админ";
    if (!hwData.sidecar_online) return "Офлайн";
    return "Недоступно";
  }, [hwData, hwmonStatus.status]);

  const cpuLoads = hwData?.cpu.core_loads ?? [];
  const maxCoreLoad = cpuLoads.length > 0 ? Math.max(...cpuLoads) : null;
  const cpuClockGhz = hwData?.cpu.avg_clock_mhz != null ? hwData.cpu.avg_clock_mhz / 1000 : null;
  const cpuBaseGhz = hwData?.cpu.base_clock_mhz != null ? hwData.cpu.base_clock_mhz / 1000 : null;
  const physCores = hwData?.cpu.physical_cores ?? 0;
  const logCores = hwData?.cpu.logical_cores ?? cpuLoads.length;
  const primaryDisk = hwData?.storage_temps[0] ?? null;

  const visible = useMemo(() => {
    const byGroup = filter === "all" ? rows : rows.filter((row) => row.group === filter);
    return hideUnavailable ? byGroup.filter((row) => row.raw != null) : byGroup;
  }, [rows, filter, hideUnavailable]);

  useEffect(() => {
    setExtremes((prev) => {
      const next = { ...prev };
      for (const row of rows) {
        if (row.raw == null) continue;
        const current = next[row.id];
        next[row.id] = current
          ? { min: Math.min(current.min, row.raw), max: Math.max(current.max, row.raw) }
          : { min: row.raw, max: row.raw };
      }
      return next;
    });
  }, [rows]);

  useEffect(() => {
    if (mode !== "history") return;
    let alive = true;
    const pull = () => {
      void c
        .loadTelemetryBundle(minutes)
        .then((bundle) => {
          if (!alive) return;
          setHistory(bundle.history);
          setReport(bundle.report);
          setThresholds({ cpu: bundle.cpuThreshold, gpu: bundle.gpuThreshold });
        })
        .catch(() => {
          if (alive) setReport(null);
        });
    };
    pull();
    const timer = window.setInterval(pull, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [mode, minutes, c.loadTelemetryBundle]);

  const spikes = useMemo(
    () =>
      [...history]
        .sort((a, b) => Math.max(b.cpu_usage, b.top_process_cpu) - Math.max(a.cpu_usage, a.top_process_cpu))
        .slice(0, 5),
    [history]
  );

  const cpuTemp = formatSensor(hwData?.cpu.package_temp_c, 1, "°C");
  const gpuTemp = formatSensor(gpu?.core_temp_c, 1, "°C");

  return (
    <motion.div
      key="hardware"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="w-full space-y-4"
    >
      <PageHeader
        title="Аппаратные датчики"
        description="Мониторинг температур, тактовых частот, напряжений и системы охлаждения в реальном времени"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-[11px] font-semibold ${sidecarStatus.chip}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${sidecarStatus.dot}`} />
              {sidecarStatus.label}
            </span>
            {(hwmonStatus.status === "offline" || hwmonStatus.status === "restarting") && (
              <button
                type="button"
                disabled={isRestartingHwmon}
                onClick={() => void handleRestartHwmon()}
                className="cyber-btn inline-flex cursor-pointer items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] font-semibold text-[#00D5E8] disabled:opacity-60"
              >
                <RefreshCw size={12} className={isRestartingHwmon ? "animate-spin" : ""} />
                ПЕРЕЗАПУСТИТЬ СЕРВИС
              </button>
            )}
          </div>
        }
      />

      {hwmonStatus.status === "driver_blocked" && (
        <div className="flex flex-col justify-between gap-3 rounded-xl border border-amber-500/35 bg-[#10151D] p-4 sm:flex-row sm:items-center">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300">
              <AlertTriangle size={16} />
            </div>
            <div>
              <div className="text-sm font-medium text-[#E5EDF5]">
                Низкоуровневый драйвер ограничен изоляцией ядра Windows (HVCI). Часть датчиков материнской платы недоступна.
              </div>
              {hwmonStatus.last_error && (
                <div className="mt-1 font-mono text-xs text-[#8292A3]">{hwmonStatus.last_error}</div>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={isRestartingHwmon}
            onClick={() => void handleRestartHwmon()}
            className="inline-flex shrink-0 cursor-pointer items-center gap-2 self-start rounded-lg border border-[#202B38] bg-[#151C26] px-3 py-2 text-xs font-medium text-[#E5EDF5] transition-colors hover:border-[#00D5E8]/40 disabled:opacity-60 sm:self-center"
          >
            <RefreshCw size={13} className={isRestartingHwmon ? "animate-spin" : ""} />
            Перезапустить службу
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["live", "Показатели в реальном времени"],
              ["history", "История и диагностика"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={`cursor-pointer rounded-lg border px-3.5 py-1.5 text-xs font-medium transition-colors ${
                mode === id
                  ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                  : "border-[#202B38] bg-[#10151D] text-[#8292A3] hover:text-[#E5EDF5]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "live" && (
          <button
            type="button"
            onClick={() => setHideUnavailable((prev) => !prev)}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              hideUnavailable
                ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                : "border-[#202B38] bg-[#10151D] text-[#8292A3] hover:text-[#E5EDF5]"
            }`}
          >
            {hideUnavailable ? <Eye size={13} /> : <EyeOff size={13} />}
            {hideUnavailable ? "Показаны только активные" : "Скрыть недоступные"}
          </button>
        )}
      </div>

      {mode === "history" ? (
        <HistoryPanel
          minutes={minutes}
          onMinutes={setMinutes}
          history={history}
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
      ) : (
        <>
          {thermalWarnings.length > 0 && (
            <div className="rounded-xl border border-rose-500/35 bg-rose-500/12 px-4 py-3 text-sm text-rose-200">
              {thermalWarnings.join(" · ")}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="tactical-card tactical-brackets flex flex-col justify-between rounded-xl p-4">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#8292A3]">
                    <Cpu size={14} className="text-[#00D5E8]" />
                    Процессор · CPU
                    {physCores > 0 && logCores > 0 && (
                      <span className="rounded border border-[#202B38] bg-[#0B0E14] px-1.5 py-0.5 font-mono text-[10px] text-[#36AFC0]">
                        {physCores}Я / {logCores}П
                      </span>
                    )}
                  </span>
                  {hwData?.cpu.package_temp_c != null ? (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${
                        hwData.cpu.package_temp_c >= thresholds.cpu
                          ? "animate-pulse border-rose-500/40 bg-rose-500/15 text-rose-300"
                          : hwData.cpu.package_temp_c >= thresholds.cpu - 10
                          ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                          : "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          hwData.cpu.package_temp_c >= thresholds.cpu
                            ? "bg-rose-500"
                            : hwData.cpu.package_temp_c >= thresholds.cpu - 10
                            ? "bg-amber-400"
                            : "bg-[#00D5E8]"
                        }`}
                      />
                      {hwData.cpu.package_temp_c >= thresholds.cpu
                        ? "КРИТИЧНО"
                        : hwData.cpu.package_temp_c >= thresholds.cpu - 10
                        ? "НАГРЕВ"
                        : "НОРМА"}
                    </span>
                  ) : (
                    <span className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${cpuMsrBadge.tone}`}>
                      {cpuMsrBadge.label}
                    </span>
                  )}
                </div>

                <h3 className="mt-1.5 truncate text-base font-semibold text-[#E5EDF5]">
                  {hwData?.cpu.name || "Центральный процессор"}
                </h3>

                <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
                  {cpuTemp.raw != null ? (
                    <div className="flex items-baseline gap-3">
                      <span className="font-mono text-3xl font-bold tracking-tight text-[#E5EDF5]">
                        {cpuTemp.text}
                      </span>
                      <span className="font-mono text-sm font-semibold text-[#00D5E8]">
                        Загрузка {metrics.cpu_usage.toFixed(1)}%
                      </span>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-baseline gap-3">
                        <span className="font-mono text-3xl font-bold tracking-tight text-[#E5EDF5]">
                          {cpuClockGhz != null ? `${cpuClockGhz.toFixed(2)} ГГц` : `${metrics.cpu_usage.toFixed(1)}%`}
                        </span>
                        <span className="font-mono text-sm font-semibold text-[#00D5E8]">
                          Загрузка ЦП {metrics.cpu_usage.toFixed(1)}%
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-[#8292A3]">
                        {hwData?.cpu.hvci_enabled
                          ? "Датчики температуры и питания MSR ограничены изоляцией ядра (HVCI)"
                          : !hwData?.is_admin
                          ? "Для чтения температур MSR требуются права Администратора"
                          : "Датчик температуры пакета CPU недоступен"}
                      </div>
                    </div>
                  )}
                  <span className="font-mono text-xs text-[#8292A3]">
                    Порог: {thresholds.cpu} °C
                  </span>
                </div>

                <div className="relative mt-3 h-2 w-full overflow-hidden rounded-sm border border-[#202B38] bg-[#0B0E14] p-[1px]">
                  <div
                    className="shimmer-bar h-full rounded-[1px] bg-gradient-to-r from-[#00D5E8] via-[#36AFC0] to-amber-400 transition-all duration-500"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(0, hwData?.cpu.package_temp_c ?? metrics.cpu_usage)
                      )}%`,
                    }}
                  />
                  <div className="hud-scale-ticks pointer-events-none absolute inset-0 z-10" />
                </div>
              </div>

              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <SubMetricTile
                    label="Загрузка ЦП"
                    value={formatSensor(metrics.cpu_usage, 1, "%")}
                    subText={maxCoreLoad != null ? `пик ${maxCoreLoad.toFixed(0)}%` : undefined}
                  />
                  <SubMetricTile
                    label="Частота (Turbo)"
                    value={formatSensor(cpuClockGhz, 2, "ГГц")}
                    subText={cpuBaseGhz != null ? `база ${cpuBaseGhz.toFixed(2)}` : undefined}
                  />
                  <SubMetricTile
                    label="Ядра / Потоки"
                    value={{ raw: physCores || null, text: physCores ? `${physCores} ядер` : "—" }}
                    textOverride={
                      physCores > 0 && logCores > 0 ? `${physCores} я. / ${logCores} п.` : undefined
                    }
                  />
                  <SubMetricTile
                    label="Темп. пакета"
                    value={cpuTemp}
                    unsupportedLabel={cpuUnavailShort}
                  />
                  <SubMetricTile
                    label="Мощность Package"
                    value={formatSensor(hwData?.cpu.power_watts, 1, "Вт")}
                    unsupportedLabel={cpuUnavailShort}
                  />
                  <SubMetricTile
                    label="Напряжение ядра"
                    value={formatSensor(hwData?.cpu.voltage_v, 3, "В")}
                    unsupportedLabel={cpuUnavailShort}
                  />
                </div>

                {cpuLoads.length > 0 && (
                  <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                    <div className="mb-1.5 flex items-center justify-between text-[10px] text-[#8292A3]">
                      <span>Загрузка логических потоков ({cpuLoads.length})</span>
                      <span className="font-mono text-[#00D5E8]">
                        {maxCoreLoad != null ? `макс ${maxCoreLoad.toFixed(0)}%` : ""}
                      </span>
                    </div>
                    <div className="flex h-5 items-end gap-[2px]">
                      {cpuLoads.map((load, idx) => {
                        const pct = Math.min(100, Math.max(4, load));
                        return (
                          <div
                            key={idx}
                            title={`Поток #${idx}: ${load.toFixed(1)}%`}
                            className="flex h-full flex-1 items-end rounded-[2px] bg-[#151C26]"
                          >
                            <div
                              className={`w-full rounded-[2px] transition-all duration-300 ${
                                load >= 85
                                  ? "bg-rose-400"
                                  : load >= 60
                                  ? "bg-amber-400"
                                  : "bg-[#00D5E8]/80"
                              }`}
                              style={{ height: `${pct}%` }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section className="tactical-card tactical-brackets flex flex-col justify-between rounded-xl p-4">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#8292A3]">
                    <Gauge size={14} className="text-[#00D5E8]" />
                    Видеокарта · GPU
                    {gpu?.vendor && (
                      <span className="rounded border border-[#202B38] bg-[#0B0E14] px-1.5 py-0.5 font-mono text-[10px] text-[#36AFC0]">
                        {gpu.vendor}
                      </span>
                    )}
                  </span>
                  {gpu?.core_temp_c != null ? (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${
                        gpu.core_temp_c >= thresholds.gpu
                          ? "animate-pulse border-rose-500/40 bg-rose-500/15 text-rose-300"
                          : gpu.core_temp_c >= thresholds.gpu - 10
                          ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                          : "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          gpu.core_temp_c >= thresholds.gpu
                            ? "bg-rose-500"
                            : gpu.core_temp_c >= thresholds.gpu - 10
                            ? "bg-amber-400"
                            : "bg-[#00D5E8]"
                        }`}
                      />
                      {gpu.core_temp_c >= thresholds.gpu
                        ? "КРИТИЧНО"
                        : gpu.core_temp_c >= thresholds.gpu - 10
                        ? "НАГРЕВ"
                        : "НОРМА"}
                    </span>
                  ) : (
                    <span className="rounded border border-[#202B38] bg-[#151C26] px-2 py-0.5 font-mono text-[10px] text-[#8292A3]">
                      {gpu ? (gpu.telemetry_source || "DXGI") : "НЕ ОБНАРУЖЕН"}
                    </span>
                  )}
                </div>

                {gpus.length > 1 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {gpus.map((item, idx) => (
                      <button
                        key={`${item.name}-${idx}`}
                        type="button"
                        onClick={() => setSelectedGpuIdx(idx)}
                        className={`cursor-pointer truncate rounded border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                          selectedGpuIdx === idx
                            ? "border-[#00D5E8]/50 bg-[#00D5E8]/12 text-[#00D5E8]"
                            : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
                        }`}
                      >
                        GPU #{idx + 1}: {item.name}
                      </button>
                    ))}
                  </div>
                )}

                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <h3 className="min-w-0 truncate text-base font-semibold text-[#E5EDF5]">
                    {gpu?.name || "Графический адаптер"}
                  </h3>
                  {gpu?.telemetry_source && (
                    <span className="shrink-0 font-mono text-[10px] text-[#526170]">
                      {gpu.telemetry_source}
                    </span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
                  {gpuTemp.raw != null ? (
                    <div className="flex items-baseline gap-3">
                      <span className="font-mono text-3xl font-bold tracking-tight text-[#E5EDF5]">
                        {gpuTemp.text}
                      </span>
                      {gpu?.load_percent != null && (
                        <span className="font-mono text-sm font-semibold text-[#00D5E8]">
                          Загрузка {gpu.load_percent.toFixed(0)}%
                        </span>
                      )}
                    </div>
                  ) : gpu?.load_percent != null ? (
                    <div className="flex items-baseline gap-3">
                      <span className="font-mono text-3xl font-bold tracking-tight text-[#E5EDF5]">
                        {gpu.load_percent.toFixed(0)}%
                      </span>
                      <span className="font-mono text-xs text-[#8292A3]">
                        Датчик температуры не поддерживается
                      </span>
                    </div>
                  ) : (
                    <div>
                      <div className="font-mono text-base font-semibold text-[#8292A3]">
                        {gpu ? "Температура не поддерживается" : "Видеоадаптер не обнаружен"}
                      </div>
                      <div className="text-xs text-[#526170]">
                        {gpu
                          ? "Доступны показатели памяти и DXGI"
                          : "Нет данных от LibreHardwareMonitor и DXGI"}
                      </div>
                    </div>
                  )}
                  <span className="font-mono text-xs text-[#8292A3]">
                    Порог: {thresholds.gpu} °C
                  </span>
                </div>

                <div className="relative mt-3 h-2 w-full overflow-hidden rounded-sm border border-[#202B38] bg-[#0B0E14] p-[1px]">
                  <div
                    className="shimmer-bar h-full rounded-[1px] bg-gradient-to-r from-[#00D5E8] via-[#36AFC0] to-amber-400 transition-all duration-500"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(
                          0,
                          gpu?.core_temp_c ?? gpu?.load_percent ?? gpu?.vram_used_percent ?? 0
                        )
                      )}%`,
                    }}
                  />
                  <div className="hud-scale-ticks pointer-events-none absolute inset-0 z-10" />
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <SubMetricTile
                  label="Загрузка ядра"
                  value={formatSensor(gpu?.load_percent, 0, "%")}
                  subText={
                    gpu?.memory_controller_load_percent != null
                      ? `КП ${gpu.memory_controller_load_percent.toFixed(0)}%`
                      : undefined
                  }
                  unsupportedLabel="Не поддерживается"
                />
                <SubMetricTile
                  label="Hotspot / Память"
                  value={formatSensor(gpu?.hotspot_temp_c, 0, "°C")}
                  textOverride={
                    gpu?.hotspot_temp_c != null
                      ? `${gpu.hotspot_temp_c.toFixed(0)}°${
                          gpu.memory_temp_c != null ? ` / ${gpu.memory_temp_c.toFixed(0)}°` : ""
                        }`
                      : gpu?.memory_temp_c != null
                      ? `${gpu.memory_temp_c.toFixed(0)} °C`
                      : undefined
                  }
                  unsupportedLabel="Не поддерживается"
                />
                <SubMetricTile
                  label="Видеопамять VRAM"
                  value={formatSensor(gpu?.vram_used_mb, 0, "МБ")}
                  textOverride={
                    gpu?.vram_used_mb != null && gpu?.vram_total_mb != null
                      ? `${(gpu.vram_used_mb / 1024).toFixed(1)} / ${(gpu.vram_total_mb / 1024).toFixed(1)} ГБ`
                      : gpu?.vram_total_mb != null
                      ? `${(gpu.vram_total_mb / 1024).toFixed(1)} ГБ`
                      : undefined
                  }
                  subText={
                    gpu?.vram_used_percent != null
                      ? `${gpu.vram_used_percent.toFixed(0)}%`
                      : undefined
                  }
                  unsupportedLabel="Недоступно"
                />
                <SubMetricTile
                  label="Частота ядра / VRAM"
                  value={formatSensor(gpu?.core_clock_mhz, 0, "МГц")}
                  textOverride={
                    gpu?.core_clock_mhz != null
                      ? `${gpu.core_clock_mhz.toFixed(0)}${
                          gpu.memory_clock_mhz != null ? ` / ${gpu.memory_clock_mhz.toFixed(0)}` : ""
                        } МГц`
                      : undefined
                  }
                  unsupportedLabel="Не поддерживается"
                />
                <SubMetricTile
                  label="Энергопотребление"
                  value={formatSensor(gpu?.power_watts, 1, "Вт")}
                  subText={
                    gpu?.voltage_v != null
                      ? `${gpu.voltage_v.toFixed(2)} В`
                      : gpu?.power_limit_percent != null
                      ? `${gpu.power_limit_percent.toFixed(0)}%`
                      : undefined
                  }
                  unsupportedLabel="Не поддерживается"
                />
                <SubMetricTile
                  label="Охлаждение кулера"
                  value={formatSensor(gpu?.fan_rpm, 0, "RPM")}
                  textOverride={
                    gpu?.fan_rpm != null
                      ? gpu.fan_rpm === 0 && (gpu.fan_percent ?? 0) === 0
                        ? "0 RPM · Стоп"
                        : `${gpu.fan_rpm.toFixed(0)} RPM`
                      : gpu?.fan_percent != null
                      ? `${gpu.fan_percent.toFixed(0)}%`
                      : undefined
                  }
                  subText={
                    gpu?.fan_rpm != null && gpu?.fan_percent != null && !(gpu.fan_rpm === 0 && gpu.fan_percent === 0)
                      ? `${gpu.fan_percent.toFixed(0)}%`
                      : undefined
                  }
                  unsupportedLabel="Не поддерживается"
                />
              </div>
            </section>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="tactical-card rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-[#8292A3]">
                <Server size={13} className="text-[#00D5E8]" />
                Системная плата
              </div>
              <div
                className="mt-1 truncate text-sm font-semibold text-[#E5EDF5]"
                title={hwData?.motherboard_name || "Системная плата"}
              >
                {hwData?.motherboard_name || "Определение модели…"}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-[#526170]">
                {hwData?.system_fans.length
                  ? `Вентиляторов шасси: ${hwData.system_fans.length}`
                  : hwData?.cpu.hvci_enabled
                  ? "SuperIO ограничен HVCI"
                  : "Базовая шина платформы"}
              </div>
            </div>

            <div className="tactical-card rounded-xl px-4 py-3">
              <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-[#8292A3]">
                <span className="inline-flex items-center gap-2">
                  <MemoryStick size={13} className="text-[#00D5E8]" />
                  Память RAM
                </span>
                <span className="font-mono text-[#00D5E8]">{metrics.ram_percentage.toFixed(0)}%</span>
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#E5EDF5]">
                {metrics.ram_used_gb.toFixed(1)} / {metrics.ram_total_gb.toFixed(0)} ГБ
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-[#526170]">
                Файл подкачки: {metrics.swap_used_gb.toFixed(1)} / {metrics.swap_total_gb.toFixed(0)} ГБ
              </div>
            </div>

            <div className="tactical-card rounded-xl px-4 py-3">
              <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-[#8292A3]">
                <span className="inline-flex items-center gap-2">
                  <HardDrive size={13} className="text-[#00D5E8]" />
                  Накопители
                </span>
                {primaryDisk?.temp_c != null && (
                  <span className="font-mono font-semibold text-[#00D5E8]">
                    {primaryDisk.temp_c.toFixed(0)} °C
                  </span>
                )}
              </div>
              <div
                className="mt-1 truncate text-sm font-semibold text-[#E5EDF5]"
                title={primaryDisk?.name || "Системный накопитель"}
              >
                {primaryDisk?.name || "Системный накопитель"}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-[#526170]">
                {primaryDisk?.used_percent != null
                  ? `Занято пространства: ${primaryDisk.used_percent.toFixed(0)}%`
                  : hwData?.storage_temps.length
                  ? `Устройств в опросе: ${hwData.storage_temps.length}`
                  : "Опрос дисков…"}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === item.id
                    ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                    : "border-[#202B38] bg-[#10151D] text-[#8292A3] hover:text-[#E5EDF5]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="tactical-card tactical-brackets overflow-x-auto rounded-xl">
            <table className="w-full min-w-[540px] text-left text-sm">
              <thead className="border-b border-[#202B38] bg-[#0B0E14] text-xs text-[#8292A3]">
                <tr>
                  <th className="px-3 py-2.5 font-medium lg:px-4">Узел</th>
                  <th className="px-3 py-2.5 font-medium lg:px-4">Датчик</th>
                  <th className="px-3 py-2.5 font-medium lg:px-4">Текущее значение</th>
                  <th className="px-3 py-2.5 font-medium lg:px-4">Минимум</th>
                  <th className="px-3 py-2.5 font-medium lg:px-4">Максимум</th>
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
                    const range = extremes[row.id];
                    const isTemp = row.unit === "°C" && row.raw != null;
                    const critLimit = row.group === "gpu" ? thresholds.gpu : thresholds.cpu;
                    const isCrit = isTemp && row.raw! >= critLimit;
                    const isWarn = isTemp && !isCrit && row.raw! >= critLimit - 10;
                    const digits = row.unit === "ГГц" || row.unit === "В" ? 2 : 0;

                    return (
                      <tr
                        key={row.id}
                        className="border-b border-[#202B38]/60 transition-colors hover:bg-[#151C26]/60 last:border-0"
                      >
                        <td className="w-24 px-3 py-2.5 lg:w-28 lg:px-4">
                          <span className="rounded border border-[#202B38] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] font-medium text-[#8292A3]">
                            {GROUP_LABELS[row.group]}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-[#E5EDF5] lg:px-4">
                          <span className="inline-flex items-center gap-2">
                            {isTemp && (
                              <span
                                className={`h-2 w-2 shrink-0 rounded-full ${
                                  isCrit
                                    ? "animate-pulse bg-rose-500"
                                    : isWarn
                                    ? "bg-amber-400"
                                    : "bg-[#00D5E8]"
                                }`}
                              />
                            )}
                            {row.name}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-mono lg:px-4">
                          {row.raw != null ? (
                            <span
                              className={
                                isCrit
                                  ? "font-bold text-rose-400"
                                  : isWarn
                                  ? "font-semibold text-amber-300"
                                  : "font-semibold text-[#E5EDF5]"
                              }
                            >
                              {row.text}
                            </span>
                          ) : (
                            <span className="inline-flex rounded border border-[#202B38] bg-[#151C26] px-2 py-0.5 text-[11px] text-[#526170]">
                              {row.reason ?? "Недоступно"}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-[#8292A3] lg:px-4">
                          {range ? `${range.min.toFixed(digits)} ${row.unit}` : <span className="text-[#526170]">Н/Д</span>}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-[#8292A3] lg:px-4">
                          {range ? `${range.max.toFixed(digits)} ${row.unit}` : <span className="text-[#526170]">Н/Д</span>}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <section className="tactical-card tactical-brackets overflow-hidden rounded-xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#202B38] px-4 py-3.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Network size={15} className="text-[#00D5E8]" />
                  <h3 className="text-sm font-semibold text-[#E5EDF5]">Сетевые адаптеры</h3>
                  <span className="rounded border border-[#202B38] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] text-[#8292A3]">
                    Физ: {physicalNetCount} · Вирт: {virtualNetCount}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[#8292A3]">
                  Реальные физические контроллеры и виртуальные сетевые интерфейсы системы
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    ["all", "Все"],
                    ["physical", "Физические"],
                    ["virtual", "Виртуальные"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setNetFilter(id)}
                    className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                      netFilter === id
                        ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                        : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setShowSystemTunnels((prev) => !prev)}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                    showSystemTunnels
                      ? "border-[#00D5E8]/40 bg-[#00D5E8]/10 text-[#00D5E8]"
                      : "border-[#202B38] bg-[#0B0E14] text-[#526170] hover:text-[#8292A3]"
                  }`}
                >
                  {showSystemTunnels ? "Скрыть минипорты" : "Минипорты OS"}
                </button>
              </div>
            </div>

            {netAdapters.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-[#8292A3]">
                {netSnapshot == null
                  ? "Опрос сетевых интерфейсов…"
                  : "Нет сетевых адаптеров, соответствующих выбранному фильтру"}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-2">
                {netAdapters.map((adapter) => {
                  const rxRate = formatThroughputRate(adapter.rx_bytes_per_sec, "mbps");
                  const txRate = formatThroughputRate(adapter.tx_bytes_per_sec, "mbps");
                  const IconComp = adapter.adapter_kind === "wifi" ? Wifi : Cable;
                  return (
                    <div
                      key={adapter.id}
                      className={`rounded-xl border p-3.5 transition-colors ${
                        adapter.is_primary
                          ? "border-[#00D5E8]/35 bg-[#0B0E14]"
                          : "border-[#202B38] bg-[#0B0E14]/90"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                              adapter.is_connected
                                ? "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]"
                                : "border-[#202B38] bg-[#10151D] text-[#526170]"
                            }`}
                          >
                            <IconComp size={15} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-sm font-semibold text-[#E5EDF5]">
                                {adapter.name}
                              </span>
                              <span
                                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                                  adapter.is_physical
                                    ? "border-[#00D5E8]/35 bg-[#00D5E8]/10 text-[#00D5E8]"
                                    : "border-indigo-500/35 bg-indigo-500/10 text-indigo-300"
                                }`}
                              >
                                {adapter.is_physical ? "Физический" : "Виртуальный"}
                              </span>
                              {adapter.is_primary && (
                                <span className="rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-300">
                                  Активный
                                </span>
                              )}
                            </div>
                            <div className="truncate text-xs text-[#8292A3]" title={adapter.description}>
                              {adapter.description}
                            </div>
                          </div>
                        </div>

                        <span
                          className={`inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                            adapter.is_connected
                              ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
                              : "border-[#202B38] bg-[#151C26] text-[#8292A3]"
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              adapter.is_connected ? "bg-emerald-400" : "bg-[#526170]"
                            }`}
                          />
                          {adapter.status_label}
                        </span>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                        <div className="rounded-lg border border-[#202B38]/70 bg-[#10151D] px-2.5 py-1.5">
                          <div className="text-[10px] text-[#526170]">Производитель</div>
                          <div className="truncate font-medium text-[#E5EDF5]">
                            {adapter.manufacturer}
                          </div>
                        </div>
                        <div className="rounded-lg border border-[#202B38]/70 bg-[#10151D] px-2.5 py-1.5">
                          <div className="text-[10px] text-[#526170]">Тип и линк</div>
                          <div className="truncate font-mono text-[11px] font-medium text-[#E5EDF5]">
                            {adapter.is_connected
                              ? formatLinkSpeed(adapter.link_speed_bps)
                              : adapter.adapter_type_label}
                          </div>
                        </div>
                        <div className="col-span-2 rounded-lg border border-[#202B38]/70 bg-[#10151D] px-2.5 py-1.5 sm:col-span-1">
                          <div className="text-[10px] text-[#526170]">Нагрузка (RX / TX)</div>
                          <div className="truncate font-mono text-[11px]">
                            <span className="text-[#00D5E8]">
                              ↓ {rxRate.value} {rxRate.unit}
                            </span>{" "}
                            <span className="text-indigo-300">
                              ↑ {txRate.value} {txRate.unit}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#8292A3]">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
                          <span>
                            IPv4:{" "}
                            <span className="text-[#E5EDF5]">
                              {adapter.ipv4_addresses[0] ?? "Не назначен"}
                            </span>
                          </span>
                          {adapter.ipv6_addresses[0] && (
                            <span className="max-w-[200px] truncate" title={adapter.ipv6_addresses.join(", ")}>
                              IPv6: <span className="text-[#E5EDF5]">{adapter.ipv6_addresses[0]}</span>
                            </span>
                          )}
                        </div>
                        {adapter.mac_address && (
                          <span className="font-mono text-[#526170]">MAC {adapter.mac_address}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </motion.div>
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
  const count = Math.max(history.length, 2);
  const pathFor = (key: (typeof series)[number]["key"]) => {
    const valid = history
      .map((point, index) => {
        const raw = point[key];
        if (raw == null || !Number.isFinite(raw)) return null;
        const x = (index / (count - 1)) * width;
        const y = height - (Math.min(ceiling, raw) / ceiling) * (height - 16) - 8;
        return { x, y };
      })
      .filter((pt): pt is { x: number; y: number } => pt !== null);

    if (valid.length === 0) return "";
    if (valid.length === 1) {
      return `M0,${valid[0].y.toFixed(1)} L${width},${valid[0].y.toFixed(1)}`;
    }
    return valid
      .map((pt, idx) => `${idx === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
      .join(" ");
  };
  const latestPoint = history[history.length - 1] ?? null;
  return (
    <div className="rounded-xl border border-[#202B38] bg-[#10151D] p-4">
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
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-40 w-full rounded-lg border border-[#202B38] bg-[#0B0E14]"
      >
        {marks.map((mark) => {
          const y = height - (Math.min(ceiling, mark.value) / ceiling) * (height - 16) - 8;
          return (
            <line
              key={mark.value}
              x1="0"
              x2={width}
              y1={y}
              y2={y}
              stroke={mark.color}
              strokeDasharray="4 4"
              strokeWidth="1"
            />
          );
        })}
        {series.map((item) => (
          <path
            key={item.key}
            d={pathFor(item.key)}
            fill="none"
            stroke={item.color}
            strokeWidth="1.75"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
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
              className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium ${
                minutes === value
                  ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                  : "border-[#202B38] bg-[#10151D] text-[#8292A3]"
              }`}
            >
              {value} минут
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onExport}
          className="cyber-btn inline-flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#00D5E8]"
        >
          <Download size={13} />
          Экспорт в CSV
        </button>
      </div>
      {exportPath && <p className="font-mono text-[11px] text-[#00D5E8]">Сохранено: {exportPath}</p>}
      {exportError && <p className="text-xs text-rose-300">{exportError}</p>}

      <section className="rounded-xl border border-[#202B38] bg-[#10151D] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[#E5EDF5]">
            Диагностика узких мест (Bottleneck & Throttling)
          </h3>
          <span className={`rounded-md border px-2.5 py-0.5 font-mono text-[11px] ${badge}`}>
            {report?.status ?? "Сбор данных"}
          </span>
        </div>
        <p className="mt-2.5 text-sm text-[#8292A3]">
          {report?.verdict ?? "Ожидание накопления точек телеметрии."}
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

      <section className="overflow-hidden rounded-xl border border-[#202B38] bg-[#10151D]">
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
