import { useEffect, useState } from "react";
import { HardDrive, Power, Trash2 } from "lucide-react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { LoadHistoryChart, SegmentedHudBar } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

function pingTone(pingMs: number): { value: string; label: string; className: string } {
  if (!Number.isFinite(pingMs) || pingMs <= 0 || pingMs >= 999) {
    return { value: "—", label: "Нет связи", className: "text-slate-400" };
  }
  if (pingMs <= 80) {
    return {
      value: `${pingMs}`,
      label: pingMs <= 40 ? "Отлично" : "Норма",
      className: "text-emerald-400",
    };
  }
  if (pingMs <= 120) {
    return { value: `${pingMs}`, label: "Средне", className: "text-amber-400" };
  }
  return { value: `${pingMs}`, label: "Высокий пинг", className: "text-rose-400" };
}

function PingSpark({ samples }: { samples: number[] }) {
  if (samples.length < 2) {
    return <div className="mt-3 h-9 font-mono text-[11px] text-slate-500">TELEMETRY SYNC…</div>;
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const span = Math.max(8, max - min);
  const width = 240;
  const height = 36;
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
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 h-9 w-full overflow-visible" aria-hidden>
      <defs>
        <linearGradient id="pingAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00F0FF" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="pingLineGrad" x1="0" y1="0" x2={width} y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00F0FF" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#pingAreaGrad)" />
      <path
        d={line}
        fill="none"
        stroke="url(#pingLineGrad)"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ filter: "drop-shadow(0 0 6px rgba(0, 240, 255, 0.45))" }}
      />
    </svg>
  );
}

function MiniTrendSpark({ values, highLoad }: { values: number[]; highLoad: boolean }) {
  const safe = values.length >= 2 ? values : [20, 26, 22, 30, 28, 34];
  const w = 52;
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
        stroke={highLoad ? "#f43f5e" : "#00F0FF"}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          filter: highLoad
            ? "drop-shadow(0 0 5px rgba(244,63,94,0.6))"
            : "drop-shadow(0 0 5px rgba(0,240,255,0.55))",
        }}
      />
    </svg>
  );
}

function MetricCard({
  label,
  value,
  detail,
  percent,
  theme,
  badgeLabel,
  sparkValues,
}: {
  label: string;
  value: string;
  detail: string;
  percent: number;
  theme?: "emerald" | "cyan";
  badgeLabel?: "REALTIME" | "STABLE" | "HIGH LOAD";
  sparkValues?: number[];
}) {
  const resolvedBadge = badgeLabel ?? (percent >= 80 ? "HIGH LOAD" : percent >= 45 ? "REALTIME" : "STABLE");
  const isHigh = resolvedBadge === "HIGH LOAD";

  return (
    <div className="tactical-card tactical-brackets flex min-w-0 flex-col justify-between gap-3 rounded-xl p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="font-mono text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</div>
        <div className="flex items-center gap-2">
          {sparkValues && <MiniTrendSpark values={sparkValues} highLoad={isHigh} />}
          <span
            className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-widest ${
              isHigh
                ? "border-rose-500/40 bg-rose-500/15 text-rose-300 shadow-[0_0_10px_rgba(244,63,94,0.2)]"
                : resolvedBadge === "REALTIME"
                  ? "border-cyan-500/35 bg-cyan-500/12 text-cyan-300"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
            }`}
          >
            {resolvedBadge}
          </span>
        </div>
      </div>
      <div className="font-mono text-3xl font-bold tracking-tight text-white drop-shadow-sm">{value}</div>
      <div className="truncate text-xs text-slate-400">{detail}</div>
      <SegmentedHudBar percentage={percent} theme={theme} />
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
  const coreCount = hwData?.cpu.core_temps.length ?? 0;
  const cpuDetail = cpuName
    ? coreCount > 0
      ? `${cpuName} · ${coreCount} ядер`
      : cpuName
    : "Текущая загрузка процессора";
  const linkLabel = isGatewayOnline ? "Шлюз доступен" : "Шлюз не отвечает";
  const cpuSpark = history.slice(-12).map((h) => h.cpu);
  const ramSpark = history.slice(-12).map((h) => h.ram);
  const netPercent = Math.min(100, (metrics.net_rx_kbps + metrics.net_tx_kbps) / 100);

  return (
    <motion.div
      key="dashboard"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="w-full max-w-6xl"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400/90">
            SPECTRE // TACTICAL TELEMETRY
          </div>
          <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-slate-100">Обзор системы</h2>
          <p className="mt-0.5 text-sm text-slate-400">Приборная панель контроля ресурсов в реальном времени</p>
        </div>
        <div
          className={`inline-flex items-center gap-2 self-start rounded border px-3 py-1 font-mono text-[11px] font-bold tracking-wider ${
            metricsReady
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-amber-500/30 bg-amber-500/10 text-amber-300"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${metricsReady ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "animate-pulse bg-amber-400"}`} />
          {metricsReady ? "CORE TELEMETRY: ACTIVE" : "INITIALIZING SENSORS..."}
        </div>
      </div>

      {!metricsReady ? (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {["cpu", "ram", "disk", "net"].map((key) => (
            <div key={key} className="tactical-card h-36 animate-pulse rounded-xl" />
          ))}
        </div>
      ) : (
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Процессор"
          value={`${metrics.cpu_usage.toFixed(1)}%`}
          detail={cpuDetail}
          percent={metrics.cpu_usage}
          badgeLabel={metrics.cpu_usage >= 80 ? "HIGH LOAD" : "REALTIME"}
          sparkValues={cpuSpark}
        />
        <MetricCard
          label="Память"
          value={`${metrics.ram_used_gb.toFixed(1)} / ${metrics.ram_total_gb.toFixed(0)} GB`}
          detail={`${metrics.ram_percentage.toFixed(0)}% занято`}
          percent={metrics.ram_percentage}
          theme="cyan"
          badgeLabel={metrics.ram_percentage >= 85 ? "HIGH LOAD" : "STABLE"}
          sparkValues={ramSpark}
        />
        <MetricCard
          label="Системный накопитель"
          value={`${metrics.disk_free_gb.toFixed(0)} GB`}
          detail={`Свободно · ${diskUsedPercentage.toFixed(0)}% занято из ${metrics.disk_total_gb.toFixed(0)} GB`}
          percent={diskUsedPercentage}
          badgeLabel={diskUsedPercentage >= 90 ? "HIGH LOAD" : "STABLE"}
        />
        <MetricCard
          label="Сетевая активность"
          value={`↓ ${rxParts.value} ${rxParts.unit}`}
          detail={`↑ ${txParts.value} ${txParts.unit} · ${linkLabel}`}
          percent={netPercent}
          theme="cyan"
          badgeLabel="REALTIME"
          sparkValues={gameSamples}
        />
      </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <LoadHistoryChart history={history} />
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:col-span-4">
          <div className="tactical-card tactical-brackets rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div className="font-mono text-xs font-semibold uppercase tracking-wider text-slate-400">
                Сетевое подключение
              </div>
              <span className="rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-widest text-cyan-300">
                NET PROBE
              </span>
            </div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <div className={`font-mono text-2xl font-bold tracking-tight ${ping.className}`}>
                  {ping.value === "—" ? "—" : `${ping.value} ms`}
                </div>
                <div className="mt-1 text-xs text-slate-500">Москва · {ping.label}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm font-bold text-slate-100">
                  {jitter === null ? "—" : `±${jitter} ms`}
                </div>
                <div
                  className={`mt-1 font-mono text-[11px] ${
                    jitter === null ? "text-slate-500" : stable ? "text-emerald-300" : "text-amber-300"
                  }`}
                >
                  {jitter === null ? "Сбор данных" : stable ? "STABLE LINK" : "JITTER DETECTED"}
                </div>
              </div>
            </div>
            <PingSpark samples={gameSamples} />
            <div className="mt-3 space-y-2">
              <div className="space-y-1">
                {(routes.length > 0 ? routes : [
                  { label: "DNS / Магистраль", host: "1.1.1.1", ping_ms: 0, jitter_ms: 0 },
                  { label: "СНГ / Москва", host: "162.159.135.234", ping_ms: 0, jitter_ms: 0 },
                  { label: "Европа / Cloudflare", host: "1.0.0.1", ping_ms: 0, jitter_ms: 0 },
                ]).map((route) => (
                  <div key={route.host} className="flex items-center justify-between rounded border border-slate-800/80 bg-[#080b11] px-3 py-1.5 text-xs">
                    <span className="text-slate-400">{route.label}</span>
                    <span className="font-mono font-semibold text-slate-100">
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
                  className="cyber-btn px-2 py-2 font-mono text-[11px] font-semibold text-cyan-200 disabled:opacity-60"
                >
                  {dnsState === "done" ? (
                    <span className="text-emerald-300">✓ DNS ОЧИЩЕН</span>
                  ) : dnsState === "pending" ? (
                    "ОЧИСТКА DNS…"
                  ) : (
                    "СБРОС DNS"
                  )}
                </button>
                <button
                  type="button"
                  disabled={netBusy}
                  onClick={() => {
                    if (!isElevatedAdmin) {
                      setNetHint("Требуются права Администратора (кнопка в шапке)");
                      return;
                    }
                    setNetBusy(true);
                    setNetHint(null);
                    invoke("set_packet_priority", { enabled: true })
                      .then(() => setNetHint("Применено"))
                      .catch((err) => setNetHint(String(err)))
                      .finally(() => setNetBusy(false));
                  }}
                  className="cyber-btn px-2 py-2 font-mono text-[11px] font-semibold text-cyan-200 disabled:opacity-60"
                >
                  {netHint === "Применено" ? (
                    <span className="text-emerald-300">ПРИМЕНЕНО</span>
                  ) : netBusy ? (
                    "ПРИМЕНЕНИЕ…"
                  ) : (
                    "ОПТИМИЗАЦИЯ СТЕКА"
                  )}
                </button>
              </div>
              {netHint && netHint !== "Применено" && <p className="text-xs text-slate-300">{netHint}</p>}
              {dnsError && <p className="text-xs text-rose-300">{dnsError}</p>}
            </div>
          </div>

          <div className="tactical-card tactical-brackets rounded-xl p-4">
            <div className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider text-slate-400">
              Быстрые действия
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setActiveTab("cleanup")}
                className="group flex items-center justify-between rounded-lg border border-slate-800/90 bg-[#080b11] p-2.5 text-xs font-medium text-slate-200 transition-all hover:border-cyan-500/40 hover:bg-[#0e131d]"
              >
                <span>Очистка системы</span>
                <Trash2 size={14} className="transition-transform group-hover:scale-110 group-hover:text-cyan-400" />
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("storage")}
                className="group flex items-center justify-between rounded-lg border border-slate-800/90 bg-[#080b11] p-2.5 text-xs font-medium text-slate-200 transition-all hover:border-cyan-500/40 hover:bg-[#0e131d]"
              >
                <span>Анализ диска</span>
                <HardDrive size={14} className="transition-transform group-hover:scale-110 group-hover:text-cyan-400" />
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("power")}
                className="group flex items-center justify-between rounded-lg border border-slate-800/90 bg-[#080b11] p-2.5 text-xs font-medium text-slate-200 transition-all hover:border-cyan-500/40 hover:bg-[#0e131d]"
              >
                <span>Таймер питания</span>
                <Power size={14} className="transition-transform group-hover:scale-110 group-hover:text-cyan-400" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
