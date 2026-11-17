import { useEffect, useState, type ReactNode } from "react";
import { Cpu, Gauge, HardDrive, MemoryStick, Power, Terminal, Trash2 } from "lucide-react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { LoadHistoryChart, PageHeader, SegmentedHudBar } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

function pingTone(pingMs: number): { value: string; label: string; className: string } {
  if (!Number.isFinite(pingMs) || pingMs <= 0 || pingMs >= 999) {
    return { value: "—", label: "Нет ответа", className: "text-[#8292A3]" };
  }
  if (pingMs <= 80) {
    return {
      value: `${pingMs}`,
      label: pingMs <= 40 ? "Отлично" : "Норма",
      className: "text-[#00D5E8]",
    };
  }
  if (pingMs <= 120) {
    return { value: `${pingMs}`, label: "Средне", className: "text-amber-400" };
  }
  return { value: `${pingMs}`, label: "Высокий пинг", className: "text-rose-400" };
}

function PingSpark({ samples }: { samples: number[] }) {
  if (samples.length < 2) {
    return <div className="mt-2 h-7 font-mono text-[11px] text-[#526170]">Ожидание замеров канала…</div>;
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const span = Math.max(8, max - min);
  const width = 240;
  const height = 28;
  const coords = samples.map((value, index) => {
    const x = (index / (samples.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 8) - 4;
    return { x, y };
  });
  const line = coords
    .map((pt, index) => `${index === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 h-7 w-full overflow-visible" aria-hidden>
      <defs>
        <linearGradient id="pingAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00D5E8" stopOpacity="0.24" />
          <stop offset="100%" stopColor="#36AFC0" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="pingLineGrad" x1="0" y1="0" x2={width} y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00D5E8" />
          <stop offset="100%" stopColor="#36AFC0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#pingAreaGrad)" />
      <path
        d={line}
        fill="none"
        stroke="url(#pingLineGrad)"
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MiniTrendSpark({ values, highLoad }: { values: number[]; highLoad: boolean }) {
  const safe = values.length >= 2 ? values : [values[0] ?? 0, values[0] ?? 0];
  const w = 48;
  const h = 16;
  const line = safe
    .map((val, idx) => {
      const x = (idx / Math.max(1, safe.length - 1)) * w;
      const clamped = Math.min(100, Math.max(0, val));
      const y = h - (clamped / 100) * (h - 4) - 2;
      return `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-4 w-12 shrink-0 overflow-visible" aria-hidden>
      <path
        d={line}
        fill="none"
        stroke={highLoad ? "#f43f5e" : "#00D5E8"}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MetricCard({
  label,
  icon,
  value,
  subValue,
  detail,
  percent,
  badgeText,
  badgeTone = "normal",
  sparkValues,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  subValue?: string;
  detail: string;
  percent: number;
  badgeText: string;
  badgeTone?: "normal" | "warn" | "critical";
  sparkValues?: number[];
}) {
  const isHigh = badgeTone === "critical";
  const badgeClasses =
    badgeTone === "critical"
      ? "border-rose-500/35 bg-rose-500/12 text-rose-300"
      : badgeTone === "warn"
      ? "border-amber-500/35 bg-amber-500/12 text-amber-300"
      : "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]";

  return (
    <div className="tactical-card tactical-brackets flex min-w-0 flex-col justify-between gap-2.5 rounded-xl p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[#8292A3]">
          <span className="text-[#00D5E8]">{icon}</span>
          <span>{label}</span>
        </div>
        <div className="flex items-center gap-2">
          {sparkValues && <MiniTrendSpark values={sparkValues} highLoad={isHigh} />}
          <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${badgeClasses}`}>
            {badgeText}
          </span>
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <div className="font-mono text-2xl font-bold tracking-tight text-[#E5EDF5] xl:text-[26px]">
          {value}
        </div>
        {subValue && (
          <div className="font-mono text-xs font-medium text-[#8292A3]">{subValue}</div>
        )}
      </div>

      <div className="truncate text-xs text-[#8292A3]" title={detail}>
        {detail}
      </div>
      <SegmentedHudBar percentage={percent} theme="cyan" />
    </div>
  );
}

export function DashboardModule({ c }: { c: NexusController }) {
  const {
    metrics,
    history,
    diskUsedPercentage,
    isGatewayOnline,
    rxParts,
    txParts,
    hwData,
    setActiveTab,
    isElevatedAdmin,
    metricsReady,
  } = c;

  const [netBusy, setNetBusy] = useState(false);
  const [netHint, setNetHint] = useState<string | null>(null);
  const [routes, setRoutes] = useState<Array<{ label: string; host: string; ping_ms: number; jitter_ms: number }>>([]);
  const [gameSamples, setGameSamples] = useState<number[]>([]);
  const [dnsState, setDnsState] = useState<"idle" | "pending" | "done">("idle");
  const [dnsError, setDnsError] = useState<string | null>(null);

  useEffect(() => {
    const loadRoutes = () => {
      invoke<Array<{ label: string; host: string; ping_ms: number; jitter_ms: number }>>("probe_game_routes")
        .then((next) => {
          setRoutes(next);
          const moscow = next.find((route) => route.label.includes("Москва") && route.ping_ms > 0);
          if (moscow) {
            setGameSamples((prev) => [...prev, moscow.ping_ms].slice(-15));
          }
        })
        .catch(() => setRoutes([]));
    };
    loadRoutes();
    const timer = window.setInterval(loadRoutes, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const gameRoute = routes.find((route) => route.label.includes("Москва") && route.ping_ms > 0);
  const ping = pingTone(gameRoute?.ping_ms ?? 0);
  const jitter = gameRoute ? gameRoute.jitter_ms : null;
  const stable = jitter !== null && jitter <= 7;

  const cpuName = hwData?.cpu.name?.trim();
  const cpuTemp = hwData?.cpu.package_temp_c ?? hwData?.cpu.max_core_temp_c ?? null;
  const cpuClockGhz =
    hwData?.cpu.avg_clock_mhz != null ? (hwData.cpu.avg_clock_mhz / 1000).toFixed(2) : null;
  const physCores = hwData?.cpu.physical_cores ?? 0;
  const logCores = hwData?.cpu.logical_cores ?? 0;
  const coreCount = hwData?.cpu.core_temps.length ?? 0;
  const cpuDetail = cpuName
    ? physCores > 0 && logCores > 0
      ? `${cpuName} · ${physCores}Я/${logCores}П`
      : coreCount > 0
      ? `${cpuName} · ${coreCount} ядер`
      : cpuName
    : "Вычислительная нагрузка процессора";

  const isHwPolled = hwData !== null;
  const primaryGpu = hwData?.gpus[0] ?? null;
  const gpuTemp = primaryGpu?.core_temp_c ?? primaryGpu?.hotspot_temp_c ?? null;
  const gpuLoad = primaryGpu?.load_percent ?? null;
  const gpuClock = primaryGpu?.core_clock_mhz ?? null;
  const gpuPower = primaryGpu?.power_watts ?? null;
  const gpuVramUsed = primaryGpu?.vram_used_mb ?? null;
  const gpuVramTotal = primaryGpu?.vram_total_mb ?? null;
  const gpuValue = !isHwPolled
    ? "Опрос…"
    : gpuTemp !== null
    ? `${gpuTemp.toFixed(0)} °C`
    : gpuLoad !== null
    ? `${gpuLoad.toFixed(0)}%`
    : gpuClock !== null
    ? `${gpuClock.toFixed(0)} МГц`
    : primaryGpu
    ? "Обнаружен"
    : "Не найден";
  const gpuSubValue =
    gpuTemp !== null && gpuLoad !== null
      ? `${gpuLoad.toFixed(0)}%${gpuPower !== null ? ` · ${gpuPower.toFixed(0)} Вт` : ""}`
      : gpuPower !== null
      ? `${gpuPower.toFixed(0)} Вт`
      : gpuClock !== null && gpuTemp !== null
      ? `${gpuClock.toFixed(0)} МГц`
      : gpuVramUsed !== null && gpuVramTotal !== null
      ? `${(gpuVramUsed / 1024).toFixed(1)}/${(gpuVramTotal / 1024).toFixed(0)} ГБ`
      : undefined;
  const gpuDetail = !isHwPolled
    ? "Подключение к датчикам GPU…"
    : primaryGpu
    ? [
        primaryGpu.name?.trim() || "Графический ускоритель",
        gpuVramUsed !== null && gpuVramTotal !== null
          ? `VRAM ${(gpuVramUsed / 1024).toFixed(1)}/${(gpuVramTotal / 1024).toFixed(0)} ГБ`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Дискретный или DXGI-ускоритель не обнаружен";
  const gpuPercent =
    gpuLoad !== null
      ? Math.min(100, Math.max(0, gpuLoad))
      : gpuTemp !== null
      ? Math.min(100, Math.max(12, ((gpuTemp - 25) / 70) * 100))
      : primaryGpu?.fan_percent ?? 0;

  const linkLabel = isGatewayOnline ? "Шлюз активен" : "Шлюз недоступен";
  const cpuSpark = history.slice(-12).map((h) => h.cpu);
  const ramSpark = history.slice(-12).map((h) => h.ram);

  return (
    <motion.div
      key="dashboard"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="w-full space-y-4"
    >
      <PageHeader
        title="Обзор системы"
        description="Ключевые показатели вычислительных узлов, накопителей и сетевого канала в реальном времени"
        actions={
          <div
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-[11px] font-semibold ${
              metricsReady
                ? "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]"
                : "border-amber-500/35 bg-amber-500/12 text-amber-300"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                metricsReady ? "bg-[#00D5E8] shadow-[0_0_6px_rgba(0,213,232,0.8)]" : "animate-pulse bg-amber-400"
              }`}
            />
            {metricsReady ? "ТЕЛЕМЕТРИЯ АКТИВНА" : "ОПРОС ДАТЧИКОВ…"}
          </div>
        }
      />

      {!metricsReady ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {["cpu", "gpu", "ram", "disk"].map((key) => (
            <div key={key} className="tactical-card h-32 animate-pulse rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Процессор (CPU)"
            icon={<Cpu size={14} />}
            value={`${metrics.cpu_usage.toFixed(1)}%`}
            subValue={
              cpuTemp !== null
                ? `${cpuTemp.toFixed(0)} °C`
                : cpuClockGhz !== null
                ? `${cpuClockGhz} ГГц`
                : undefined
            }
            detail={cpuDetail}
            percent={metrics.cpu_usage}
            badgeText={metrics.cpu_usage >= 85 ? "НАГРУЗКА" : "АКТИВЕН"}
            badgeTone={metrics.cpu_usage >= 85 ? "critical" : metrics.cpu_usage >= 70 ? "warn" : "normal"}
            sparkValues={cpuSpark}
          />
          <MetricCard
            label="Видеокарта (GPU)"
            icon={<Gauge size={14} />}
            value={gpuValue}
            subValue={gpuSubValue}
            detail={gpuDetail}
            percent={gpuPercent}
            badgeText={
              !isHwPolled
                ? "ОЖИДАНИЕ"
                : gpuTemp !== null && gpuTemp >= 82
                ? "НАГРЕВ"
                : primaryGpu
                ? "НОРМА"
                : "НЕТ ДАТЧИКА"
            }
            badgeTone={
              gpuTemp !== null && gpuTemp >= 82
                ? "critical"
                : gpuTemp !== null && gpuTemp >= 72
                ? "warn"
                : "normal"
            }
          />
          <MetricCard
            label="Память (RAM)"
            icon={<MemoryStick size={14} />}
            value={`${metrics.ram_used_gb.toFixed(1)} ГБ`}
            subValue={`из ${metrics.ram_total_gb.toFixed(0)} ГБ`}
            detail={`Занято ${metrics.ram_percentage.toFixed(0)}% оперативной памяти`}
            percent={metrics.ram_percentage}
            badgeText={metrics.ram_percentage >= 88 ? "ДЕФИЦИТ" : "СТАБИЛЬНО"}
            badgeTone={metrics.ram_percentage >= 88 ? "critical" : metrics.ram_percentage >= 75 ? "warn" : "normal"}
            sparkValues={ramSpark}
          />
          <MetricCard
            label="Накопитель (Диск)"
            icon={<HardDrive size={14} />}
            value={`${metrics.disk_free_gb.toFixed(0)} ГБ`}
            subValue={`из ${metrics.disk_total_gb.toFixed(0)} ГБ`}
            detail={`Свободно · Занято ${diskUsedPercentage.toFixed(0)}% системного тома`}
            percent={diskUsedPercentage}
            badgeText={diskUsedPercentage >= 90 ? "ЗАПОЛНЕН" : "НОРМА"}
            badgeTone={diskUsedPercentage >= 90 ? "critical" : diskUsedPercentage >= 80 ? "warn" : "normal"}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <LoadHistoryChart history={history} />
        </div>

        <div className="flex min-w-0 flex-col gap-3 lg:col-span-4">
          <div className="tactical-card tactical-brackets rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wider text-[#8292A3]">
                Сетевой канал и маршруты
              </div>
              <span className="rounded border border-[#202B38] bg-[#151C26] px-2 py-0.5 font-mono text-[10px] font-medium text-[#00D5E8]">
                {linkLabel}
              </span>
            </div>

            <div className="mt-2.5 grid grid-cols-2 gap-2 rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
              <div>
                <div className="text-[11px] text-[#8292A3]">Приём (RX)</div>
                <div className="font-mono text-sm font-semibold text-[#00D5E8]">
                  ↓ {rxParts.value} {rxParts.unit}
                </div>
              </div>
              <div className="border-l border-[#202B38] pl-3">
                <div className="text-[11px] text-[#8292A3]">Отдача (TX)</div>
                <div className="font-mono text-sm font-semibold text-[#E5EDF5]">
                  ↑ {txParts.value} {txParts.unit}
                </div>
              </div>
            </div>

            <div className="mt-2.5 flex items-end justify-between gap-3">
              <div>
                <div className={`font-mono text-lg font-bold tracking-tight ${ping.className}`}>
                  {ping.value === "—" ? "—" : `${ping.value} мс`}
                </div>
                <div className="text-xs text-[#8292A3]">Москва · {ping.label}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm font-semibold text-[#E5EDF5]">
                  {jitter === null ? "—" : `±${jitter} мс`}
                </div>
                <div
                  className={`font-mono text-[11px] ${
                    jitter === null ? "text-[#526170]" : stable ? "text-[#00D5E8]" : "text-amber-300"
                  }`}
                >
                  {jitter === null ? "Замер канала" : stable ? "Канал стабилен" : "Есть джиттер"}
                </div>
              </div>
            </div>

            <PingSpark samples={gameSamples} />

            <div className="mt-2 space-y-2">
              <div className="space-y-1">
                {(routes.length > 0
                  ? routes
                  : [
                      { label: "DNS / Магистраль", host: "1.1.1.1", ping_ms: 0, jitter_ms: 0 },
                      { label: "СНГ / Москва", host: "162.159.135.234", ping_ms: 0, jitter_ms: 0 },
                      { label: "Европа / Cloudflare", host: "1.0.0.1", ping_ms: 0, jitter_ms: 0 },
                    ]
                ).map((route) => (
                  <div
                    key={route.host}
                    className="flex items-center justify-between rounded-md border border-[#202B38] bg-[#0B0E14] px-2.5 py-1 text-xs"
                  >
                    <span className="text-[#8292A3]">{route.label}</span>
                    <span className="font-mono font-medium text-[#E5EDF5]">
                      {route.ping_ms > 0 ? `${route.ping_ms} мс ±${route.jitter_ms}` : "—"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={dnsState === "pending"}
                  onClick={() => {
                    setDnsError(null);
                    setDnsState("pending");
                    invoke("flush_dns")
                      .then(() => {
                        setDnsState("done");
                        window.setTimeout(() => setDnsState("idle"), 3000);
                      })
                      .catch((err) => {
                        setDnsState("idle");
                        setDnsError(String(err));
                      });
                  }}
                  className="cyber-btn cursor-pointer px-2 py-1.5 font-mono text-[11px] font-semibold text-[#00D5E8] disabled:opacity-60"
                >
                  {dnsState === "done" ? "✓ DNS ОЧИЩЕН" : dnsState === "pending" ? "ОЧИСТКА…" : "СБРОС DNS"}
                </button>
                <button
                  type="button"
                  disabled={netBusy}
                  onClick={() => {
                    if (!isElevatedAdmin) {
                      setNetHint("Требуются права Администратора (кнопка в верхней панели)");
                      return;
                    }
                    setNetBusy(true);
                    setNetHint(null);
                    invoke("set_packet_priority", { enabled: true })
                      .then(() => setNetHint("Применено"))
                      .catch((err) => setNetHint(String(err)))
                      .finally(() => setNetBusy(false));
                  }}
                  className="cyber-btn cursor-pointer px-2 py-1.5 font-mono text-[11px] font-semibold text-[#00D5E8] disabled:opacity-60"
                >
                  {netHint === "Применено" ? "✓ ПРИМЕНЕНО" : netBusy ? "ПРИМЕНЕНИЕ…" : "ПРИОРИТЕТ ПАКЕТОВ"}
                </button>
              </div>
              {netHint && netHint !== "Применено" && <p className="text-xs text-amber-300">{netHint}</p>}
              {dnsError && <p className="text-xs text-rose-300">{dnsError}</p>}
            </div>
          </div>

          <div className="tactical-card tactical-brackets rounded-xl p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[#8292A3]">
              Быстрые переходы
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setActiveTab("cleanup")}
                className="group flex cursor-pointer items-center justify-between rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-2 text-xs font-medium text-[#E5EDF5] transition-colors hover:border-[#00D5E8]/40 hover:bg-[#151C26]"
              >
                <span>Очистка</span>
                <Trash2 size={13} className="text-[#8292A3] transition-colors group-hover:text-[#00D5E8]" />
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("storage")}
                className="group flex cursor-pointer items-center justify-between rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-2 text-xs font-medium text-[#E5EDF5] transition-colors hover:border-[#00D5E8]/40 hover:bg-[#151C26]"
              >
                <span>Накопители</span>
                <HardDrive size={13} className="text-[#8292A3] transition-colors group-hover:text-[#00D5E8]" />
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("scripts")}
                className="group flex cursor-pointer items-center justify-between rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-2 text-xs font-medium text-[#E5EDF5] transition-colors hover:border-[#00D5E8]/40 hover:bg-[#151C26]"
              >
                <span>Скрипты</span>
                <Terminal size={13} className="text-[#8292A3] transition-colors group-hover:text-[#00D5E8]" />
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("power")}
                className="group flex cursor-pointer items-center justify-between rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-2 text-xs font-medium text-[#E5EDF5] transition-colors hover:border-[#00D5E8]/40 hover:bg-[#151C26]"
              >
                <span>Питание</span>
                <Power size={13} className="text-[#8292A3] transition-colors group-hover:text-[#00D5E8]" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
