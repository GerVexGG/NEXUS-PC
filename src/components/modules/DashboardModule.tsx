import { HardDrive, Power, Trash2 } from "lucide-react";
import { motion } from "framer-motion";
import { LoadHistoryChart, SegmentedHudBar } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

function pingTone(pingMs: number): { value: string; label: string; className: string } {
  if (!Number.isFinite(pingMs) || pingMs <= 0 || pingMs >= 999) {
    return { value: "—", label: "Нет связи", className: "text-slate-400" };
  }
  if (pingMs < 40) {
    return { value: `${pingMs}`, label: "Отлично", className: "text-emerald-400" };
  }
  if (pingMs <= 80) {
    return { value: `${pingMs}`, label: "Средне", className: "text-amber-400" };
  }
  return { value: `${pingMs}`, label: "Высокая задержка", className: "text-rose-400" };
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
  } = c;

  const ping = pingTone(metrics.net_ping_ms);
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
        <div className="inline-flex items-center gap-2 self-start rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Система активна
        </div>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-4">
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

      <div className="mt-4 grid grid-cols-12 gap-4">
        <div className="col-span-8">
          <LoadHistoryChart history={history} />
        </div>

        <div className="col-span-4 flex flex-col gap-4">
          <div className="rounded-xl border border-[#222b38] bg-[#111722] p-4">
            <div className="text-sm text-slate-400">Сетевое подключение</div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <div className={`font-mono text-xl font-bold ${ping.className}`}>{ping.value}</div>
                <div className="mt-1 text-xs text-slate-500">мс · {ping.label}</div>
              </div>
            </div>
            <div className="mt-4 space-y-2 text-sm">
              <div className="flex items-center justify-between rounded-lg bg-[#151c27] px-3 py-2">
                <span className="text-slate-400">Приём</span>
                <span className="font-mono text-slate-100">
                  {rxParts.value} {rxParts.unit}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-[#151c27] px-3 py-2">
                <span className="text-slate-400">Отдача</span>
                <span className="font-mono text-slate-100">
                  {txParts.value} {txParts.unit}
                </span>
              </div>
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
