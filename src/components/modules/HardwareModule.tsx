import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { HardwareTelemetry } from "../../lib/studio";
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

function formatSensor(value: number | null | undefined, digits: number, unit: string): { raw: number | null; text: string } {
  if (value == null || !Number.isFinite(value) || value === 0) {
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
    push(`fan-${index}`, "fan", fan.name || `Вентилятор ${index + 1}`, fan.rpm, 0, "RPM");
  });

  return rows;
}

export function HardwareModule({ c }: { c: NexusController }) {
  const { hwData, metrics, thermalWarnings } = c;
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
        <span
          className={`inline-flex items-center gap-2 self-start rounded-full border px-3 py-1 text-xs ${
            hwData?.sidecar_online
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
              : "border-[#222b38] bg-[#151c27] text-slate-400"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${hwData?.sidecar_online ? "bg-emerald-400" : "bg-slate-500"}`} />
          {hwData?.sidecar_online ? "Sidecar активен" : "Служба остановлена"}
        </span>
      </div>

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
            <span>VRAM <span className="block font-mono text-slate-100">Н/Д</span></span>
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
    </motion.div>
  );
}
