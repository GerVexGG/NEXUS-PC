import { motion } from "framer-motion";
import {
  HardDrive,
  Cpu,
  Activity,
  Wifi,
  ArrowDown,
  ArrowUp,
  Radio,
} from "lucide-react";
import {
  LoadHistoryChart,
  SegmentedHudBar,
  SpotlightCard,
  cardItemVariants,
  cardsContainerVariants,
} from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

export function DashboardModule({ c }: { c: NexusController }) {
  const {
    metrics,
    history,
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
  } = c;
  return (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="space-y-5 max-w-6xl w-full"
            >
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 border-b border-white/[0.06] pb-3.5">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-sky-400/90 mb-0.5">
                    OBSIDIAN CYBER-HUD // REALTIME TELEMETRY
                  </div>
                  <h2 className="text-2xl font-bold text-[#e8edf4] tracking-tight">
                    Приборная панель системы
                  </h2>
                </div>
                <div className="flex items-center gap-2 text-[11px] font-mono text-[#8793a5]">
                  <span className="px-2.5 py-1 rounded bg-[#151c27] border border-white/[0.07] tabular-nums">
                    ОПРОС: <strong className="text-sky-400">1000 MS</strong>
                  </span>
                  <span className="px-2.5 py-1 rounded bg-[#151c27] border border-white/[0.07] tabular-nums">
                    ШЛЮЗ:{" "}
                    <strong className={isGatewayOnline ? "text-emerald-400" : "text-rose-400"}>
                      {isGatewayOnline ? "ONLINE" : "TIMEOUT"}
                    </strong>
                  </span>
                </div>
              </div>

              {/* Верхний ряд: 3 главных системных прибора (CPU, RAM+Swap, Накопитель) */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 md:grid-cols-3 gap-4"
              >
                {/* 1. CPU HUD Module */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(56, 189, 248, 0.14)"
                  accentColor="emerald"
                  className="min-w-0 p-5"
                >
                  <div>
                    <div className="flex items-center justify-between mb-3 gap-2">
                      <div>
                        <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-[#8793a5] block">
                          SYS.MOD // 01
                        </span>
                        <span className="text-sm font-semibold text-[#d5dde8]">
                          Центральный процессор
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-sky-500/10 border border-sky-500/25">
                        <Cpu size={16} className={cpuLoadStyles.badgeTextClass} />
                      </div>
                    </div>

                    <div className="flex items-baseline gap-2 my-3">
                      <span className="text-3xl sm:text-4xl font-extrabold font-mono tabular-nums text-[#e8edf4] tracking-tight">
                        {metrics.cpu_usage.toFixed(1)}
                      </span>
                      <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">
                        % LOAD
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <SegmentedHudBar
                      percentage={metrics.cpu_usage}
                      segments={20}
                      theme="emerald"
                    />
                    <div className="flex items-center justify-between text-[11px] text-[#8793a5] font-mono pt-1 border-t border-white/[0.05]">
                      <span>СТАТУС ЯДРА</span>
                      <span className={`font-bold ${cpuLoadStyles.badgeTextClass}`}>
                        {metrics.cpu_usage > 90
                          ? "CRITICAL LOAD"
                          : metrics.cpu_usage > 70
                          ? "HIGH LOAD"
                          : "NOMINAL"}
                      </span>
                    </div>
                  </div>
                </SpotlightCard>

                {/* 2. RAM + Swap HUD Module */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(34, 211, 238, 0.14)"
                  accentColor="cyan"
                  className="min-w-0 p-5"
                >
                  <div>
                    <div className="flex items-center justify-between mb-3 gap-2">
                      <div>
                        <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-[#8793a5] block">
                          SYS.MOD // 02
                        </span>
                        <span className="text-sm font-semibold text-[#d5dde8]">
                          Оперативная память
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/25">
                        <Activity size={16} className={ramLoadStyles.badgeTextClass} />
                      </div>
                    </div>

                    <div className="flex items-baseline justify-between gap-2 my-3">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-3xl sm:text-4xl font-extrabold font-mono tabular-nums text-[#e8edf4] tracking-tight">
                          {metrics.ram_used_gb.toFixed(1)}
                        </span>
                        <span className="text-sm font-mono text-[#8793a5] tabular-nums">
                          / {metrics.ram_total_gb.toFixed(0)}
                        </span>
                        <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                          GB
                        </span>
                      </div>
                      <span className={`text-xs font-mono font-bold tabular-nums ${ramLoadStyles.badgeTextClass}`}>
                        {metrics.ram_percentage.toFixed(0)}%
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <SegmentedHudBar
                      percentage={metrics.ram_percentage}
                      segments={20}
                      theme="cyan"
                    />
                    <div className="flex items-center justify-between text-[11px] font-mono pt-1 border-t border-white/[0.05]">
                      <span className="text-[#8793a5]">SWAP БУФЕР:</span>
                      <span className="text-[#c5d0de] tabular-nums">
                        {metrics.swap_used_gb.toFixed(1)} / {metrics.swap_total_gb.toFixed(1)}{" "}
                        <span className="text-cyan-400">GB</span> ({swapPercentage.toFixed(0)}%)
                      </span>
                    </div>
                  </div>
                </SpotlightCard>

                {/* 3. Primary Storage HUD Module */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(56, 189, 248, 0.14)"
                  accentColor="emerald"
                  className="min-w-0 p-5"
                >
                  <div>
                    <div className="flex items-center justify-between mb-3 gap-2">
                      <div>
                        <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-[#8793a5] block">
                          SYS.MOD // 03
                        </span>
                        <span className="text-sm font-semibold text-[#d5dde8]">
                          Системный накопитель
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-sky-500/10 border border-sky-500/25">
                        <HardDrive size={16} className={diskLoadStyles.badgeTextClass} />
                      </div>
                    </div>

                    <div className="flex items-baseline justify-between gap-2 my-3">
                      <div className="flex items-baseline gap-2">
                        <span className="text-3xl sm:text-4xl font-extrabold font-mono tabular-nums text-[#e8edf4] tracking-tight">
                          {metrics.disk_free_gb}
                        </span>
                        <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">
                          GB FREE
                        </span>
                      </div>
                      <span className="text-xs font-mono text-[#8793a5] tabular-nums">
                        {diskUsedPercentage.toFixed(0)}% ИСП.
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <SegmentedHudBar
                      percentage={diskUsedPercentage}
                      segments={20}
                      theme="emerald"
                    />
                    <div className="flex items-center justify-between text-[11px] text-[#8793a5] font-mono pt-1 border-t border-white/[0.05]">
                      <span>ОБЩИЙ ОБЪЕМ</span>
                      <span className="text-[#c5d0de] tabular-nums">
                        {metrics.disk_total_gb} <span className="text-sky-400">GB</span>
                      </span>
                    </div>
                  </div>
                </SpotlightCard>
              </motion.div>

              {/* Второй ряд: Полноценная тройная панель сетевой телеметрии (Network HUD) */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
              >
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(34, 211, 238, 0.12)"
                  accentColor="cyan"
                  className="p-5 sm:p-6"
                >
                  <div className="space-y-4">
                    {/* Шапка Network HUD со шлюзом и общим статусом подключения */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 border-b border-white/[0.06]">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.18)]">
                          <Wifi size={18} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-cyan-400">
                              NET.HUD // TRIPLE TELEMETRY
                            </span>
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.05] text-[#8793a5]">
                              TCP 1.1.1.1:53
                            </span>
                          </div>
                          <h3 className="text-base font-bold text-[#e8edf4] tracking-tight">
                            Сетевой контур и задержка канала (Network HUD)
                          </h3>
                        </div>
                      </div>

                      <div className="flex items-center gap-2.5 self-start sm:self-auto font-mono text-xs">
                        <div className="px-3 py-1.5 rounded-lg bg-[#07090d] border border-white/[0.07] flex items-center gap-2">
                          <span
                            className={`h-2 w-2 rounded-full ${
                              isNetworkActive
                                ? "bg-sky-400 shadow-[0_0_8px_#38bdf8] animate-pulse"
                                : isGatewayOnline
                                ? "bg-cyan-400"
                                : "bg-zinc-600"
                            }`}
                          />
                          <span className="text-[#8793a5]">КАНАЛ:</span>
                          <span
                            className={
                              isNetworkActive
                                ? "text-sky-400 font-bold"
                                : isGatewayOnline
                                ? "text-cyan-300 font-semibold"
                                : "text-[#8793a5]"
                            }
                          >
                            {isNetworkActive
                              ? "АКТИВНЫЙ ТРАФИК"
                              : isGatewayOnline
                              ? " В СЕТИ (STANDBY)"
                              : "НЕТ ОТВЕТА"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Тройная приборная сетка: 1. PING, 2. DOWNLOAD, 3. UPLOAD */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {/* 1. PING (Задержка шлюза в мс) */}
                      <div className="relative p-4 rounded-xl bg-[#151c27]/90 border border-white/[0.07] flex flex-col justify-between space-y-3 hud-dot-matrix">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider text-[#8793a5]">
                            <Radio size={14} className={pingStyle.colorClass} />
                            1. PING / ЗАДЕРЖКА
                          </span>
                          <span
                            className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${pingStyle.badgeClass}`}
                          >
                            {pingStyle.statusLabel}
                          </span>
                        </div>

                        <div className="flex items-baseline gap-2">
                          <span
                            className={`text-3xl sm:text-4xl font-extrabold font-mono tabular-nums tracking-tight ${pingStyle.colorClass}`}
                          >
                            {pingStyle.valueText}
                          </span>
                          <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-white/[0.06] text-[#c5d0de] border border-white/[0.08]">
                            MS
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          <div className="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden border border-white/[0.05]">
                            <div
                              style={{ width: `${pingStyle.barPercent}%` }}
                              className={`h-full rounded-full transition-all duration-500 ${
                                metrics.net_ping_ms === 0 || metrics.net_ping_ms >= 999
                                  ? "bg-zinc-700"
                                  : metrics.net_ping_ms < 40
                                  ? "bg-gradient-to-r from-sky-500 to-teal-400 shadow-[0_0_10px_#38bdf8]"
                                  : metrics.net_ping_ms <= 90
                                  ? "bg-gradient-to-r from-amber-500 to-yellow-400 shadow-[0_0_10px_#fbbf24]"
                                  : "bg-gradient-to-r from-rose-500 to-red-400 shadow-[0_0_10px_#f43f5e]"
                              }`}
                            />
                          </div>
                          <div className="flex justify-between text-[10px] font-mono text-[#8793a5]">
                            <span>&lt;40ms Идеально</span>
                            <span>40-90ms Средне</span>
                            <span>&gt;90ms Пик</span>
                          </div>
                        </div>
                      </div>

                      {/* 2. DOWNLOAD (Входящий поток) */}
                      <div className="relative p-4 rounded-xl bg-[#151c27]/90 border border-white/[0.07] flex flex-col justify-between space-y-3 hud-dot-matrix">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider text-[#8793a5]">
                            <span className="p-1 rounded bg-sky-500/15 border border-sky-500/30 text-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.3)]">
                              <ArrowDown size={13} />
                            </span>
                            2. DOWNLOAD / ПРИЕМ
                          </span>
                          <span className="text-[10px] font-mono text-sky-400/90 uppercase">
                            RX STREAM
                          </span>
                        </div>

                        <div className="flex items-baseline gap-2">
                          <span className="text-3xl sm:text-4xl font-extrabold font-mono tabular-nums text-[#e8edf4] tracking-tight">
                            {rxParts.value}
                          </span>
                          <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">
                            {rxParts.unit}
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          <div className="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden border border-white/[0.05]">
                            <div
                              style={{ width: `${rxPulsePct}%` }}
                              className="h-full rounded-full bg-gradient-to-r from-sky-500 via-teal-400 to-sky-300 shadow-[0_0_12px_rgba(56,189,248,0.65)] transition-all duration-300"
                            />
                          </div>
                          <div className="flex justify-between text-[10px] font-mono text-[#8793a5]">
                            <span>Входящий импульс</span>
                            <span className="text-sky-400 tabular-nums">
                              {metrics.net_rx_kbps.toFixed(1)} KB/S
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* 3. UPLOAD (Исходящий поток) */}
                      <div className="relative p-4 rounded-xl bg-[#151c27]/90 border border-white/[0.07] flex flex-col justify-between space-y-3 hud-dot-matrix">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider text-[#8793a5]">
                            <span className="p-1 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.3)]">
                              <ArrowUp size={13} />
                            </span>
                            3. UPLOAD / ОТДАЧА
                          </span>
                          <span className="text-[10px] font-mono text-cyan-400/90 uppercase">
                            TX STREAM
                          </span>
                        </div>

                        <div className="flex items-baseline gap-2">
                          <span className="text-3xl sm:text-4xl font-extrabold font-mono tabular-nums text-[#e8edf4] tracking-tight">
                            {txParts.value}
                          </span>
                          <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                            {txParts.unit}
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          <div className="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden border border-white/[0.05]">
                            <div
                              style={{ width: `${txPulsePct}%` }}
                              className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-sky-400 to-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.65)] transition-all duration-300"
                            />
                          </div>
                          <div className="flex justify-between text-[10px] font-mono text-[#8793a5]">
                            <span>Исходящий импульс</span>
                            <span className="text-cyan-400 tabular-nums">
                              {metrics.net_tx_kbps.toFixed(1)} KB/S
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </SpotlightCard>
              </motion.div>

              {/* Третий ряд: 60-секундный живой неоновый график */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
              >
                <LoadHistoryChart history={history} />
              </motion.div>
            </motion.div>
  );
}
