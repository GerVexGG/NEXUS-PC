import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Download, RefreshCw } from "lucide-react";
import type { DiagnosticsReport, HardwareTelemetry, TelemetrySnapshot } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

type SensorGroup = "cpu" | "gpu" | "memory" | "disk" | "fan";
type SensorFilter = "all" | SensorGroup;

type SensorRow = {
  id: string;
  group: SensorGroup;
  name: string;
  raw: number | null;
  text: string;
};

const filters: { id: SensorFilter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "cpu", label: "CPU" },
  { id: "gpu", label: "GPU" },
  { id: "memory", label: "Память" },
  { id: "disk", label: "Диски" },
  { id: "fan", label: "Вентиляторы" },
];

function formatSensor(value: number | null | undefined | "", digits: number, unit: string): { raw: number | null; text: string } {
  if (value == null || value === "" || !Number.isFinite(value)) {
    return { raw: null, text: "—" };
  }
  return { raw: value, text: `${value.toFixed(digits)} ${unit}` };
}

function buildRows(hw: HardwareTelemetry | null, ramGb: number, ramPct: number): SensorRow[] {
  const rows: SensorRow[] = [];
  const push = (id: string, group: SensorGroup, name: string, value: number | null | undefined, digits: number, unit: string) => {
    const formatted = formatSensor(value, digits, unit);
    rows.push({ id, group, name, raw: formatted.raw, text: formatted.text });
  };

  push("cpu-package", "cpu", "CPU Package", hw?.cpu.package_temp_c, 1, "°C");
  push("cpu-clock", "cpu", "Средняя частота", hw?.cpu.avg_clock_mhz != null ? hw.cpu.avg_clock_mhz / 1000 : null, 2, "GHz");
  push("cpu-power", "cpu", "Мощность CPU", hw?.cpu.power_watts, 1, "W");
  push("cpu-voltage", "cpu", "Напряжение CPU", hw?.cpu.voltage_v, 3, "V");
  hw?.cpu.core_temps.forEach((core, index) => {
    push(`cpu-core-${index}`, "cpu", core.name || `Ядро ${index + 1}`, core.temp_c, 0, "°C");
  });

  hw?.gpus.forEach((gpu, index) => {
    const title = gpu.name || `GPU ${index + 1}`;
    push(`gpu-${index}-core`, "gpu", `${title} · температура`, gpu.core_temp_c, 1, "°C");
    push(`gpu-${index}-hot`, "gpu", `${title} · Hotspot`, gpu.hotspot_temp_c, 1, "°C");
    push(`gpu-${index}-mem`, "memory", `${title} · температура памяти`, gpu.memory_temp_c, 1, "°C");
    push(`gpu-${index}-core-clk`, "gpu", `${title} · частота ядра`, gpu.core_clock_mhz, 0, "MHz");
    push(`gpu-${index}-mem-clk`, "gpu", `${title} · частота памяти`, gpu.memory_clock_mhz, 0, "MHz");
    push(`gpu-${index}-power`, "gpu", `${title} · мощность`, gpu.power_watts, 1, "W");
    push(`gpu-${index}-volt`, "gpu", `${title} · напряжение`, gpu.voltage_v, 3, "V");
    push(`gpu-${index}-fan`, "fan", `${title} · кулер`, gpu.fan_rpm, 0, "RPM");
    if (gpu.fan_percent != null) {
      push(`gpu-${index}-fan-pct`, "fan", `${title} · обороты`, gpu.fan_percent, 0, "%");
    }
  });

  push("ram-used", "memory", "Оперативная память", ramGb, 1, "GB");
  push("ram-pct", "memory", "Занято памяти", ramPct, 0, "%");

  hw?.storage_temps.forEach((disk, index) => {
    push(`disk-${index}-temp`, "disk", disk.name || `Накопитель ${index + 1}`, disk.temp_c, 1, "°C");
    push(`disk-${index}-used`, "disk", `${disk.name || "Накопитель"} · занято`, disk.used_percent, 0, "%");
  });

  hw?.motherboard_temps.forEach((sensor, index) => {
    push(`board-${index}`, "cpu", sensor.name || `Плата ${index + 1}`, sensor.temp_c, 0, "°C");
  });

  hw?.system_fans.forEach((fan, index) => {
    const name = fan.name || `Вентилятор ${index + 1}`;
    push(`fan-${index}`, "fan", name, fan.rpm, 0, "RPM");
    if (fan.percent != null) {
      push(`fan-${index}-pct`, "fan", `${name} · обороты`, fan.percent, 0, "%");
    }
  });

  return rows;
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
  } = c;
  const sidecarOnline = hwData?.sidecar_online === true || hwmonStatus.status === "ready";
  const sidecarStatus =
    hwmonStatus.status === "driver_blocked"
      ? {
          label: "Драйвер заблокирован (HVCI)",
          dot: "bg-amber-400",
          chip: "border-amber-500/30 bg-amber-500/10 text-amber-300",
        }
      : hwmonStatus.status === "restarting" || isRestartingHwmon
        ? {
            label: `Перезапуск датчиков (попытка ${Math.max(1, hwmonStatus.restart_count)})...`,
            dot: "bg-amber-400 animate-pulse",
            chip: "border-amber-500/30 bg-amber-500/10 text-amber-300",
          }
        : sidecarOnline && metricsReady
          ? {
              label: "Датчики активны",
              dot: "bg-emerald-400",
              chip: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
            }
          : sidecarOnline
            ? {
                label: "Подключение...",
                dot: "bg-amber-400",
                chip: "border-amber-500/20 bg-amber-500/10 text-amber-300",
              }
            : {
                label: "Служба недоступна",
                dot: "bg-slate-500",
                chip: "border-[#222b38] bg-[#151c27] text-slate-400",
              };
  const [mode, setMode] = useState<"live" | "history">("live");
  const [minutes, setMinutes] = useState(60);
  const [history, setHistory] = useState<TelemetrySnapshot[]>([]);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [thresholds, setThresholds] = useState(() => ({
    cpu: c.alertThresholds?.cpu ?? 85,
    gpu: c.alertThresholds?.gpu ?? 83,
  }));

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
  const gpu = hwData?.gpus[0];
  const rows = useMemo(
    () => buildRows(hwData, metrics.ram_used_gb, metrics.ram_percentage),
    [hwData, metrics.ram_used_gb, metrics.ram_percentage],
  );
  const visible = filter === "all" ? rows : rows.filter((row) => row.group === filter);

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
      void c.loadTelemetryBundle(minutes).then((bundle) => {
        if (!alive) return;
        setHistory(bundle.history);
        setReport(bundle.report);
        setThresholds({ cpu: bundle.cpuThreshold, gpu: bundle.gpuThreshold });
      }).catch(() => {
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
    () => [...history].sort((a, b) => Math.max(b.cpu_usage, b.top_process_cpu) - Math.max(a.cpu_usage, a.top_process_cpu)).slice(0, 5),
    [history],
  );

  return (
    <motion.div
      key="hardware"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="w-full max-w-6xl space-y-4"
    >
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-2xl font-semibold text-slate-100">Аппаратный мониторинг</h2>
          <p className="mt-1 text-sm text-slate-400">Показатели температур, частот и напряжений</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start">
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${sidecarStatus.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${sidecarStatus.dot}`} />
            {sidecarStatus.label}
          </span>
          {(hwmonStatus.status === "offline" || hwmonStatus.status === "restarting") && (
            <button
              type="button"
              disabled={isRestartingHwmon}
              onClick={() => void handleRestartHwmon()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#222b38] bg-[#151c27] px-2.5 py-1 text-xs font-medium text-slate-200 transition-colors hover:bg-[#1a2332] disabled:opacity-60"
            >
              <RefreshCw size={12} className={isRestartingHwmon ? "animate-spin" : ""} />
              Перезапустить службу
            </button>
          )}
        </div>
      </div>

      {hwmonStatus.status === "driver_blocked" && (
        <div className="flex flex-col justify-between gap-3 rounded-xl border border-amber-500/30 bg-[#111722] p-4 sm:flex-row sm:items-center">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300">
              <AlertTriangle size={16} />
            </div>
            <div>
              <div className="text-sm font-medium text-slate-100">
                Аппаратный драйвер заблокирован изоляцией ядра Windows (HVCI). Часть температур может быть недоступна
              </div>
              {hwmonStatus.last_error && (
                <div className="mt-1 font-mono text-xs text-slate-400">{hwmonStatus.last_error}</div>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={isRestartingHwmon}
            onClick={() => void handleRestartHwmon()}
            className="inline-flex shrink-0 items-center gap-2 self-start rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-[#1a2332] disabled:opacity-60 sm:self-center"
          >
            <RefreshCw size={13} className={isRestartingHwmon ? "animate-spin" : ""} />
            Перезапустить службу
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {([
          ["live", "Датчики в реальном времени"],
          ["history", "История и Диагностика"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              mode === id
                ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                : "border-[#222b38] bg-[#111722] text-slate-400 hover:text-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
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
            void c.exportTelemetryCsv()
              .then((path) => setExportPath(path))
              .catch((err) => setExportError(String(err)));
          }}
        />
      ) : (
      <>
      {thermalWarnings.length > 0 && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {thermalWarnings.join(" · ")}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-[#222b38] bg-[#111722] p-4">
          <div className="text-sm text-slate-400">Процессор</div>
          <h3 className="mt-1 truncate text-base font-medium text-slate-100">{hwData?.cpu.name || "Модель не определена"}</h3>
          <div className="mt-3 font-mono text-2xl font-bold text-slate-100">
            {formatSensor(hwData?.cpu.package_temp_c, 1, "°C").text}
          </div>
          <div className="mt-2 flex gap-4 text-xs text-slate-400">
            <span>Частота <span className="font-mono text-slate-100">{formatSensor(hwData?.cpu.avg_clock_mhz != null ? hwData.cpu.avg_clock_mhz / 1000 : null, 2, "GHz").text}</span></span>
            <span>Мощность <span className="font-mono text-slate-100">{formatSensor(hwData?.cpu.power_watts, 1, "W").text}</span></span>
          </div>
        </section>

        <section className="rounded-xl border border-[#222b38] bg-[#111722] p-4">
          <div className="text-sm text-slate-400">Видеокарта</div>
          <h3 className="mt-1 truncate text-base font-medium text-slate-100">{gpu?.name || "Адаптер не обнаружен"}</h3>
          <div className="mt-3 font-mono text-2xl font-bold text-slate-100">
            {formatSensor(gpu?.core_temp_c, 1, "°C").text}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-slate-400">
            <span>Hotspot <span className="block font-mono text-slate-100">{formatSensor(gpu?.hotspot_temp_c, 1, "°C").text}</span></span>
            <span>VRAM <span className="block font-mono text-slate-100">{formatSensor(gpu?.memory_temp_c, 0, "°C").text}</span></span>
            <span>Кулер <span className="block font-mono text-slate-100">{formatSensor(gpu?.fan_rpm, 0, "RPM").text}</span></span>
          </div>
        </section>
      </div>

      <div className="flex flex-wrap gap-2">
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setFilter(item.id)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              filter === item.id
                ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                : "border-[#222b38] bg-[#111722] text-slate-400 hover:text-slate-200"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-[#222b38] bg-[#111722]">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="border-b border-[#222b38]">
              <th className="px-4 py-2 font-medium">Датчик</th>
              <th className="px-4 py-2 font-medium">Текущее значение</th>
              <th className="px-4 py-2 font-medium">Минимум</th>
              <th className="px-4 py-2 font-medium">Максимум</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-400">
                  Датчики этой категории ещё не ответили
                </td>
              </tr>
            ) : (
              visible.map((row) => {
                const range = extremes[row.id];
                const unit = row.text.includes(" ") ? row.text.slice(row.text.lastIndexOf(" ") + 1) : "";
                return (
                  <tr key={row.id} className="border-b border-[#222b38]/70 last:border-0">
                    <td className="px-4 py-2.5 text-slate-200">{row.name}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-100">{row.text}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-400">
                      {range ? `${range.min.toFixed(row.text.includes("GHz") || row.text.includes(" V") ? 2 : 0)} ${unit}` : "—"}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-400">
                      {range ? `${range.max.toFixed(row.text.includes("GHz") || row.text.includes(" V") ? 2 : 0)} ${unit}` : "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      </>
      )}
    </motion.div>
  );
}

function clock(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function SeriesChart({
  history,
  series,
  ceiling,
  marks,
}: {
  history: TelemetrySnapshot[];
  series: { key: "cpu_usage" | "gpu_usage" | "ram_used_percent" | "cpu_temp" | "gpu_temp"; color: string; label: string }[];
  ceiling: number;
  marks: { value: number; color: string }[];
}) {
  const width = 640;
  const height = 168;
  const count = Math.max(history.length, 2);
  const pathFor = (key: (typeof series)[number]["key"]) => {
    let started = false;
    return history
      .map((point, index) => {
        const raw = point[key];
        if (raw == null || !Number.isFinite(raw)) return "";
        const x = (index / (count - 1)) * width;
        const y = height - (Math.min(ceiling, raw) / ceiling) * (height - 16) - 8;
        const command = started ? "L" : "M";
        started = true;
        return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };
  return (
    <div className="rounded-xl border border-[#222b38] bg-[#111722] p-4">
      <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-slate-400">
        {series.map((item) => (
          <span key={item.key} className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full">
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
          <path key={item.key} d={pathFor(item.key)} fill="none" stroke={item.color} strokeWidth="1.6" />
        ))}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
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
  const badge = report?.stability === "Критично"
    ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
    : report?.stability === "Отлично"
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
      : "border-amber-500/20 bg-amber-500/10 text-amber-300";
  const tempCeiling = Math.max(100, thresholds.cpu, thresholds.gpu, ...history.flatMap((point) => [point.cpu_temp ?? 0, point.gpu_temp ?? 0]));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {[15, 30, 60].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onMinutes(value)}
              className={`rounded-full border px-3 py-1 text-xs ${
                minutes === value ? "border-sky-500/30 bg-sky-500/10 text-sky-300" : "border-[#222b38] bg-[#111722] text-slate-400"
              }`}
            >
              {value} минут
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onExport}
          className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/20 px-3 py-1.5 text-xs text-sky-300 hover:bg-sky-500/30"
        >
          <Download size={13} />
          Экспорт в CSV
        </button>
      </div>
      {exportPath && <p className="font-mono text-[11px] text-emerald-400">Сохранено: {exportPath}</p>}
      {exportError && <p className="text-xs text-rose-300">{exportError}</p>}

      <section className="rounded-xl border border-[#222b38] bg-[#111722] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-100">Диагностика узких мест (Bottleneck & Throttling)</h3>
          <span className={`rounded-full border px-2.5 py-1 text-[11px] ${badge}`}>{report?.status ?? "Сбор данных"}</span>
        </div>
        <p className="mt-3 text-sm text-slate-300">{report?.verdict ?? "Ожидание первых точек истории."}</p>
        {report && report.incidents.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-slate-400">
            {report.incidents.map((item) => (
              <li key={item.message}>{item.message}</li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <div>
          <div className="mb-2 text-xs text-slate-400">Загрузка CPU, GPU и RAM</div>
          <SeriesChart
            history={history}
            ceiling={100}
            marks={[]}
            series={[
              { key: "cpu_usage", color: "#38bdf8", label: "CPU" },
              { key: "gpu_usage", color: "#22d3ee", label: "GPU" },
              { key: "ram_used_percent", color: "#34d399", label: "RAM" },
            ]}
          />
        </div>
        <div>
          <div className="mb-2 text-xs text-slate-400">Температуры</div>
          <SeriesChart
            history={history}
            ceiling={tempCeiling}
            marks={[
              { value: thresholds.cpu, color: "#f59e0b" },
              { value: thresholds.gpu, color: "#fb7185" },
            ]}
            series={[
              { key: "cpu_temp", color: "#f59e0b", label: "CPU" },
              { key: "gpu_temp", color: "#fb7185", label: "GPU" },
            ]}
          />
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-[#222b38] bg-[#111722]">
        <div className="border-b border-[#222b38] px-4 py-3 text-sm font-semibold text-slate-100">Пиковые нагрузки ЦП</div>
        {spikes.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-400">Пиковых точек пока нет</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-[#222b38]">
                <th className="px-4 py-2 font-medium">Время</th>
                <th className="px-4 py-2 font-medium">Пик</th>
                <th className="px-4 py-2 font-medium">Процесс</th>
              </tr>
            </thead>
            <tbody>
              {spikes.map((point) => (
                <tr key={point.timestamp} className="border-b border-[#222b38]/50 last:border-0">
                  <td className="px-4 py-2 font-mono text-slate-300">{clock(point.timestamp)}</td>
                  <td className="px-4 py-2 font-mono text-slate-100">{Math.max(point.cpu_usage, point.top_process_cpu).toFixed(0)}%</td>
                  <td className="px-4 py-2 text-slate-200">{point.top_process_name || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
