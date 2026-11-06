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
    return <div className="mt-3 h-9 text-[11px] text-slate-500">Сбор стабильности…</div>;
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const span = Math.max(8, max - min);
  const width = 240;
  const height = 36;
  const line = samples
    .map((value, index) => {
      const x = (index / (samples.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 6) - 3;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 h-9 w-full" aria-hidden>
      <path d={line} fill="none" stroke="#38bdf8" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function MetricCard({
  label,
  value,
  detail,
  percent,
  theme,
}: {
  label: string;
  value: string;
  detail: string;
  percent: number;
  theme?: "emerald" | "cyan";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-[#222b38] bg-[#111722] p-4">
      <div className="text-sm text-slate-400">{label}</div>
      <div className="font-mono text-2xl font-bold text-slate-100">{value}</div>
      <div className="text-xs text-slate-500">{detail}</div>
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
          <h2 className="text-2xl font-semibold text-slate-100">Обзор системы</h2>
          <p className="mt-1 text-sm text-slate-400">Состояние компьютера в реальном времени</p>
        </div>
        <div
          className={`inline-flex items-center gap-2 self-start rounded-full border px-3 py-1 text-xs ${
            metricsReady
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
              : "border-amber-500/20 bg-amber-500/10 text-amber-400"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${metricsReady ? "bg-emerald-400" : "animate-pulse bg-amber-400"}`} />
          {metricsReady ? "Система активна" : "Инициализация метрик..."}
        </div>
      </div>

      {!metricsReady ? (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {["cpu", "ram", "disk", "net"].map((key) => (
            <div key={key} className="h-32 animate-pulse rounded-xl border border-[#222b38] bg-[#111722]" />
          ))}
        </div>
      ) : (
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Процессор"
          value={`${metrics.cpu_usage.toFixed(1)}%`}
          detail={cpuDetail}
          percent={metrics.cpu_usage}
        />
        <MetricCard
          label="Память"
          value={`${metrics.ram_used_gb.toFixed(1)} / ${metrics.ram_total_gb.toFixed(0)} GB`}
          detail={`${metrics.ram_percentage.toFixed(0)}% занято`}
          percent={metrics.ram_percentage}
          theme="cyan"
        />
        <MetricCard
          label="Системный накопитель"
          value={`${metrics.disk_free_gb.toFixed(0)} GB свободно`}
          detail={`${diskUsedPercentage.toFixed(0)}% заполнено из ${metrics.disk_total_gb.toFixed(0)} GB`}
          percent={diskUsedPercentage}
        />
        <MetricCard
          label="Сетевая активность"
          value={`↓ ${rxParts.value} ${rxParts.unit}`}
          detail={`↑ ${txParts.value} ${txParts.unit} · ${linkLabel}`}
          percent={Math.min(100, (metrics.net_rx_kbps + metrics.net_tx_kbps) / 100)}
          theme="cyan"
        />
      </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <LoadHistoryChart history={history} />
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:col-span-4">
          <div className="rounded-xl border border-[#222b38] bg-[#111722] p-4">
            <div className="text-sm text-slate-400">Сетевое подключение</div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <div className={`font-mono text-xl font-bold ${ping.className}`}>
                  {ping.value === "—" ? "—" : `${ping.value} ms`}
                </div>
                <div className="mt-1 text-xs text-slate-500">Москва · {ping.label}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm font-semibold text-slate-100">
                  {jitter === null ? "—" : `±${jitter} ms`}
                </div>
                <div
                  className={`mt-1 text-xs ${
                    jitter === null ? "text-slate-500" : stable ? "text-emerald-300" : "text-amber-300"
                  }`}
                >
                  {jitter === null ? "Сбор данных" : stable ? "Стабильно" : "Пакетный джиттер"}
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
                  <div key={route.host} className="flex items-center justify-between rounded-lg bg-[#151c27] px-3 py-1.5 text-xs">
                    <span className="text-slate-400">{route.label}</span>
                    <span className="font-mono text-slate-100">
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
                  className="rounded-lg border border-[#222b38] bg-[#151c27] px-2 py-2 text-xs font-medium text-slate-200 hover:bg-[#1a2332] disabled:opacity-70"
                >
                  {dnsState === "done" ? (
                    <span className="text-emerald-300">✓ Кэш DNS очищен</span>
                  ) : dnsState === "pending" ? (
                    "Очистка DNS…"
                  ) : (
                    "Сброс DNS"
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
                  className="rounded-lg border border-[#222b38] bg-[#151c27] px-2 py-2 text-xs font-medium text-slate-200 hover:bg-[#1a2332] disabled:opacity-70"
                >
                  {netHint === "Применено" ? (
                    <span className="text-emerald-300">Применено</span>
                  ) : netBusy ? (
                    "Применение…"
                  ) : (
                    "Оптимизация сетевого стека"
                  )}
                </button>
              </div>
              {netHint && netHint !== "Применено" && <p className="text-xs text-slate-300">{netHint}</p>}
              {dnsError && <p className="text-xs text-rose-300">{dnsError}</p>}
            </div>
          </div>

          <div className="rounded-xl border border-[#222b38] bg-[#111722] p-4">
            <div className="mb-3 text-sm text-slate-400">Быстрые действия</div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setActiveTab("cleanup")}
                className="flex items-center justify-between rounded-lg border border-[#222b38] bg-[#151c27] p-2.5 text-xs font-medium text-slate-200 transition-colors hover:bg-[#1a2332]"
              >
                <span>Очистка системы</span>
                <Trash2 size={14} />
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("storage")}
                className="flex items-center justify-between rounded-lg border border-[#222b38] bg-[#151c27] p-2.5 text-xs font-medium text-slate-200 transition-colors hover:bg-[#1a2332]"
              >
                <span>Анализ диска</span>
                <HardDrive size={14} />
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("power")}
                className="flex items-center justify-between rounded-lg border border-[#222b38] bg-[#151c27] p-2.5 text-xs font-medium text-slate-200 transition-colors hover:bg-[#1a2332]"
              >
                <span>Таймер питания</span>
                <Power size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
