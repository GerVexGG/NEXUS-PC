import { motion } from "framer-motion";
import {
  HardDrive,
  Cpu,
  Activity,
  Thermometer,
  Fan,
  ShieldCheck,
  Flame,
} from "lucide-react";
import {
  SegmentedHudBar,
  SpotlightCard,
  cardItemVariants,
  cardsContainerVariants,
  getTempBadgeStyle,
} from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

export function HardwareModule({ c }: { c: NexusController }) {
  const {
    metrics,
    hwData,
    thermalWarnings,
    cpuTempStyle,
  } = c;
  return (
            <motion.div
              key="hardware"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="space-y-6 max-w-6xl w-full"
            >
              {/* Заголовок и статус LibreHardwareMonitor */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-100">
                    Аппаратный мониторинг (Hardware Monitor)
                  </h2>
                  <p className="text-sm text-[#8793a5] mt-1">
                    Глубокая телеметрия датчиков CPU, GPU Hotspot, кулеров и накопителей (LibreHardwareMonitor)
                  </p>
                </div>

                <div className="flex items-center gap-2.5 self-start sm:self-auto">
                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono border ${
                      hwData?.sidecar_online
                        ? "bg-sky-500/10 text-sky-400 border-sky-500/25"
                        : "bg-amber-500/10 text-amber-400 border-amber-500/25"
                    }`}
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${
                        hwData?.sidecar_online
                          ? "bg-sky-400 animate-pulse"
                          : "bg-amber-400"
                      }`}
                    />
                    {hwData?.sidecar_online ? "LHM Sidecar Online" : "Инициализация..."}
                  </span>

                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono border ${
                      hwData?.is_admin
                        ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/25"
                        : "bg-zinc-900/80 text-[#8793a5] border-white/[0.07]"
                    }`}
                    title="Для чтения низкоуровневых датчиков кулеров SuperIO и температур ядер рекомендуется запуск от имени Администратора"
                  >
                    <ShieldCheck size={14} />
                    {hwData?.is_admin ? "Admin Mode" : "Standard Mode"}
                  </span>
                </div>
              </div>

              {/* 1. Блок предупреждений / Health Status */}
              {thermalWarnings.length > 0 ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="p-4 sm:p-5 rounded-2xl backdrop-blur-xl bg-gradient-to-r from-rose-500/20 via-amber-500/15 to-zinc-900/80 border border-rose-500/40 shadow-[0_0_30px_rgba(244,63,94,0.25)] flex items-start gap-3.5"
                >
                  <div className="p-2.5 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-400 shrink-0">
                    <Flame size={20} className="animate-pulse" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold text-rose-300 uppercase tracking-wider font-mono">
                      Внимание: критический температурный режим (&gt; 85°C)
                    </h3>
                    <ul className="text-xs sm:text-sm font-mono text-[#e8edf4] space-y-0.5">
                      {thermalWarnings.map((warn, i) => (
                        <li key={i}>• {warn}</li>
                      ))}
                    </ul>
                  </div>
                </motion.div>
              ) : (
                <div className="p-4 rounded-2xl backdrop-blur-xl bg-sky-500/[0.06] border border-sky-500/20 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-400">
                      <Thermometer size={18} />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-[#e8edf4]">
                        Температурный режим всех узлов в пределах нормы
                      </div>
                      <div className="text-xs font-mono text-[#8793a5]">
                        Порог тревоги CPU Package / GPU Hotspot: 85.0°C • Плата:{" "}
                        <span className="text-[#c5d0de]">
                          {hwData?.motherboard_name || "Определяется..."}
                        </span>
                      </div>
                    </div>
                  </div>
                  <span className="hidden sm:inline-flex text-xs font-mono px-2.5 py-1 rounded-lg bg-sky-500/15 text-sky-400 border border-sky-500/30">
                    HEALTH OK
                  </span>
                </div>
              )}

              {/* Сетка карточек: CPU и GPU */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 lg:grid-cols-2 gap-5"
              >
                {/* 2. Карточка CPU */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(56, 189, 248, 0.14)"
                  className="p-5 sm:p-6"
                >
                  <div className="space-y-5">
                    <div className="flex items-start justify-between gap-3 pb-4 border-b border-white/[0.06]">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/25 text-sky-400 shrink-0">
                          <Cpu size={20} />
                        </div>
                        <div className="min-w-0">
                          <span className="text-[11px] font-mono uppercase tracking-wider text-[#8793a5]">
                            Центральный процессор (CPU)
                          </span>
                          <h3 className="text-base font-bold text-[#e8edf4] truncate">
                            {hwData?.cpu.name || "Определение модели CPU..."}
                          </h3>
                        </div>
                      </div>

                      <span
                        className={`text-xs font-mono px-2.5 py-1 rounded-lg border shrink-0 ${cpuTempStyle.badgeClass}`}
                      >
                        {hwData?.cpu.package_temp_c !== null &&
                        hwData?.cpu.package_temp_c !== undefined
                          ? `${hwData.cpu.package_temp_c.toFixed(1)}°C • ${cpuTempStyle.label}`
                          : "Датчик Т°: Н/Д"}
                      </span>
                    </div>

                    {/* Основные показатели CPU */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="p-3 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                        <span className="text-[11px] font-mono text-[#8793a5]">
                          CPU Package
                        </span>
                        <div
                          className={`text-xl font-bold font-mono mt-1 ${cpuTempStyle.textClass}`}
                        >
                          {hwData?.cpu.package_temp_c != null
                            ? `${hwData.cpu.package_temp_c.toFixed(1)}°C`
                            : `${metrics.cpu_usage.toFixed(0)}% исп.`}
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                        <span className="text-[11px] font-mono text-[#8793a5]">
                          Частота ядер
                        </span>
                        <div className="text-xl font-bold font-mono text-[#e8edf4] mt-1">
                          {hwData?.cpu.avg_clock_mhz != null
                            ? `${(hwData.cpu.avg_clock_mhz / 1000).toFixed(2)} ГГц`
                            : "—"}
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                        <span className="text-[11px] font-mono text-[#8793a5]">
                          Потребление
                        </span>
                        <div className="text-xl font-bold font-mono text-sky-400 mt-1">
                          {hwData?.cpu.power_watts != null
                            ? `${hwData.cpu.power_watts.toFixed(1)} W`
                            : "—"}
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                        <span className="text-[11px] font-mono text-[#8793a5]">
                          Вольтаж (VID)
                        </span>
                        <div className="text-xl font-bold font-mono text-cyan-400 mt-1">
                          {hwData?.cpu.voltage_v != null
                            ? `${hwData.cpu.voltage_v.toFixed(3)} V`
                            : "—"}
                        </div>
                      </div>
                    </div>

                    {/* Список температур по ядрам */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs font-mono text-[#8793a5]">
                        <span>Датчики ядер процессора</span>
                        {hwData?.cpu.max_core_temp_c != null && (
                          <span>
                            Пик:{" "}
                            <strong className="text-[#d5dde8]">
                              {hwData.cpu.max_core_temp_c.toFixed(1)}°C
                            </strong>
                          </span>
                        )}
                      </div>

                      {hwData?.cpu.core_temps && hwData.cpu.core_temps.length > 0 ? (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-40 overflow-y-auto pr-1">
                          {hwData.cpu.core_temps.map((core, idx) => {
                            const cStyle = getTempBadgeStyle(core.temp_c);
                            return (
                              <div
                                key={core.name + idx}
                                className="px-3 py-2 rounded-lg bg-zinc-950/60 border border-white/[0.05] flex items-center justify-between text-xs font-mono"
                              >
                                <span className="text-[#8793a5] truncate mr-2">
                                  {core.name}
                                </span>
                                <span className={`font-bold ${cStyle.textClass}`}>
                                  {core.temp_c.toFixed(0)}°C
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="p-3 rounded-xl bg-zinc-950/50 border border-white/[0.04] text-xs font-mono text-[#8793a5]">
                          {hwData?.is_admin
                            ? "Индивидуальные датчики ядер не предоставлены драйвером CPU"
                            : "Запустите приложение от имени Администратора для чтения температур отдельных ядер CPU Ring0"}
                        </div>
                      )}
                    </div>
                  </div>
                </SpotlightCard>

                {/* 3. Карточка GPU (с выделенным Hotspot и индикатором вертушек) */}
                {hwData?.gpus && hwData.gpus.length > 0 ? (
                  hwData.gpus.map((gpu, gIdx) => {
                    const hotspotStyle = getTempBadgeStyle(
                      gpu.hotspot_temp_c ?? gpu.core_temp_c
                    );
                    const coreStyle = getTempBadgeStyle(gpu.core_temp_c);
                    const fanPct = Math.min(100, Math.max(0, gpu.fan_percent ?? 0));

                    return (
                      <SpotlightCard
                        key={gpu.name + gIdx}
                        variants={cardItemVariants}
                        spotlightColor="rgba(34, 211, 238, 0.14)"
                        className="p-5 sm:p-6"
                      >
                        <div className="space-y-5">
                          <div className="flex items-start justify-between gap-3 pb-4 border-b border-white/[0.06]">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/25 text-cyan-400 shrink-0">
                                <Activity size={20} />
                              </div>
                              <div className="min-w-0">
                                <span className="text-[11px] font-mono uppercase tracking-wider text-[#8793a5]">
                                  Графический адаптер (GPU #{gIdx + 1})
                                </span>
                                <h3 className="text-base font-bold text-[#e8edf4] truncate">
                                  {gpu.name}
                                </h3>
                              </div>
                            </div>

                            <span
                              className={`text-xs font-mono px-2.5 py-1 rounded-lg border shrink-0 ${hotspotStyle.badgeClass}`}
                            >
                              {hotspotStyle.label}
                            </span>
                          </div>

                          {/* Крупный блок температур: Core, HOTSPOT, VRAM */}
                          <div className="grid grid-cols-3 gap-3">
                            <div className="p-3.5 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                              <span className="text-[11px] font-mono text-[#8793a5]">
                                Чип (GPU Core)
                              </span>
                              <div
                                className={`text-2xl font-bold font-mono mt-1 ${coreStyle.textClass}`}
                              >
                                {gpu.core_temp_c != null
                                  ? `${gpu.core_temp_c.toFixed(1)}°C`
                                  : "—"}
                              </div>
                            </div>

                            {/* Выделенный крупно GPU Hotspot */}
                            <div className="p-3.5 rounded-xl bg-gradient-to-br from-amber-500/15 via-rose-500/10 to-zinc-950 border border-amber-500/35 shadow-[0_0_20px_rgba(245,158,11,0.12)]">
                              <span className="text-[11px] font-mono uppercase tracking-wider text-amber-300 font-semibold flex items-center gap-1">
                                <Flame size={12} /> HOTSPOT
                              </span>
                              <div
                                className={`text-2xl sm:text-3xl font-extrabold font-mono mt-0.5 ${hotspotStyle.textClass}`}
                              >
                                {gpu.hotspot_temp_c != null
                                  ? `${gpu.hotspot_temp_c.toFixed(1)}°C`
                                  : gpu.core_temp_c != null
                                  ? `${gpu.core_temp_c.toFixed(1)}°C`
                                  : "—"}
                              </div>
                            </div>

                            <div className="p-3.5 rounded-xl bg-zinc-950/70 border border-white/[0.05]">
                              <span className="text-[11px] font-mono text-[#8793a5]">
                                Память (VRAM)
                              </span>
                              <div className="text-2xl font-bold font-mono text-cyan-400 mt-1">
                                {gpu.memory_temp_c != null
                                  ? `${gpu.memory_temp_c.toFixed(1)}°C`
                                  : "—"}
                              </div>
                            </div>
                          </div>

                          {/* Частоты, питание и вольтаж */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs font-mono">
                            <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-white/[0.04]">
                              <span className="text-[#8793a5] block">Ядро МГц</span>
                              <span className="text-[#e8edf4] font-bold text-sm">
                                {gpu.core_clock_mhz != null
                                  ? `${gpu.core_clock_mhz.toFixed(0)} MHz`
                                  : "—"}
                              </span>
                            </div>
                            <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-white/[0.04]">
                              <span className="text-[#8793a5] block">Память МГц</span>
                              <span className="text-[#e8edf4] font-bold text-sm">
                                {gpu.memory_clock_mhz != null
                                  ? `${gpu.memory_clock_mhz.toFixed(0)} MHz`
                                  : "—"}
                              </span>
                            </div>
                            <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-white/[0.04]">
                              <span className="text-[#8793a5] block">Потребление</span>
                              <span className="text-sky-400 font-bold text-sm">
                                {gpu.power_watts != null
                                  ? `${gpu.power_watts.toFixed(1)} W`
                                  : "—"}
                              </span>
                            </div>
                            <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-white/[0.04]">
                              <span className="text-[#8793a5] block">Вольтаж</span>
                              <span className="text-cyan-400 font-bold text-sm">
                                {gpu.voltage_v != null
                                  ? `${gpu.voltage_v.toFixed(3)} V`
                                  : "—"}
                              </span>
                            </div>
                          </div>

                          {/* Индикатор вертушек GPU (RPM и сегментированная шкала %) */}
                          <div className="p-3.5 rounded-xl bg-[#151c27]/90 border border-white/[0.06] space-y-2.5">
                            <div className="flex items-center justify-between text-xs font-mono">
                              <span className="flex items-center gap-2 text-[#c5d0de]">
                                <Fan
                                  size={15}
                                  className={
                                    (gpu.fan_rpm ?? 0) > 0
                                      ? "text-cyan-400 animate-spin"
                                      : "text-[#8793a5]"
                                  }
                                />
                                Охлаждение GPU (Кулеры)
                              </span>
                              <div className="flex items-center gap-2">
                                <span className="text-[#e8edf4] font-bold tabular-nums">
                                  {gpu.fan_rpm != null
                                    ? gpu.fan_rpm.toFixed(0)
                                    : "0"}
                                </span>
                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                                  RPM
                                </span>
                                <span className="text-cyan-400 font-semibold tabular-nums ml-1">
                                  {gpu.fan_percent != null
                                    ? `${gpu.fan_percent.toFixed(0)}%`
                                    : "0%"}
                                </span>
                              </div>
                            </div>
                            <SegmentedHudBar
                              percentage={fanPct}
                              segments={24}
                              theme="cyan"
                            />
                          </div>
                        </div>
                      </SpotlightCard>
                    );
                  })
                ) : (
                  <SpotlightCard
                    variants={cardItemVariants}
                    spotlightColor="rgba(34, 211, 238, 0.12)"
                    className="p-6 flex flex-col justify-center items-center text-center"
                  >
                    <Activity size={28} className="text-cyan-400 mb-2 opacity-80" />
                    <div className="text-sm font-semibold text-[#d5dde8]">
                      Датчики дискретной видеокарты (GPU)
                    </div>
                    <p className="text-xs font-mono text-[#8793a5] mt-1 max-w-sm">
                      Ожидание ответа от LibreHardwareMonitor или в системе используется встроенное видеоядро без открытых термодатчиков.
                    </p>
                  </SpotlightCard>
                )}
              </motion.div>

              {/* 4. Карточка системных вентиляторов и температур накопителей SSD/HDD */}
              <motion.div
                variants={cardsContainerVariants}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 lg:grid-cols-2 gap-5"
              >
                {/* Системные вентиляторы и датчики материнской платы */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(56, 189, 248, 0.12)"
                  className="p-5 sm:p-6"
                >
                  <div className="space-y-4">
                    <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
                      <div className="flex items-center gap-2.5">
                        <Fan size={18} className="text-sky-400" />
                        <h3 className="text-base font-semibold text-[#e8edf4]">
                          Вентиляторы корпуса и датчики платы
                        </h3>
                      </div>
                      <span className="text-xs font-mono text-[#8793a5]">
                        Кулеров: {hwData?.system_fans.length ?? 0}
                      </span>
                    </div>

                    {hwData?.system_fans && hwData.system_fans.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {hwData.system_fans.map((fan, fIdx) => (
                          <div
                            key={fan.name + fIdx}
                            className="p-3 rounded-xl bg-zinc-950/70 border border-white/[0.05] flex items-center justify-between"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <Fan
                                size={15}
                                className={
                                  fan.rpm > 0
                                    ? "text-sky-400 animate-spin shrink-0"
                                    : "text-zinc-600 shrink-0"
                                }
                              />
                              <span className="text-xs font-mono text-[#c5d0de] truncate">
                                {fan.name}
                              </span>
                            </div>
                            <span className="text-sm font-mono font-bold text-sky-400 shrink-0">
                              {fan.rpm.toFixed(0)} RPM
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="p-4 rounded-xl bg-zinc-950/50 border border-white/[0.04] text-xs font-mono text-[#8793a5]">
                        Обороты корпусных вентиляторов (SuperIO) недоступны без прав Администратора или управляются напрямую через BIOS.
                      </div>
                    )}

                    {hwData?.motherboard_temps &&
                      hwData.motherboard_temps.length > 0 && (
                        <div className="pt-2 space-y-2">
                          <span className="text-xs font-mono text-[#8793a5] block">
                            Термодатчики системной платы:
                          </span>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {hwData.motherboard_temps.slice(0, 6).map((t, idx) => {
                              const st = getTempBadgeStyle(t.temp_c);
                              return (
                                <div
                                  key={t.name + idx}
                                  className="px-3 py-2 rounded-lg bg-zinc-950/60 border border-white/[0.05] flex items-center justify-between text-xs font-mono"
                                >
                                  <span className="text-[#8793a5] truncate mr-2">
                                    {t.name}
                                  </span>
                                  <span className={`font-bold ${st.textClass}`}>
                                    {t.temp_c.toFixed(0)}°C
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                  </div>
                </SpotlightCard>

                {/* Температуры накопителей SSD / HDD */}
                <SpotlightCard
                  variants={cardItemVariants}
                  spotlightColor="rgba(34, 211, 238, 0.12)"
                  className="p-5 sm:p-6"
                >
                  <div className="space-y-4">
                    <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
                      <div className="flex items-center gap-2.5">
                        <HardDrive size={18} className="text-cyan-400" />
                        <h3 className="text-base font-semibold text-[#e8edf4]">
                          Температуры накопителей (SSD / NVMe / HDD)
                        </h3>
                      </div>
                      <span className="text-xs font-mono text-[#8793a5]">
                        Устройств: {hwData?.storage_temps.length ?? 0}
                      </span>
                    </div>

                    {hwData?.storage_temps && hwData.storage_temps.length > 0 ? (
                      <div className="space-y-2.5">
                        {hwData.storage_temps.map((st, idx) => {
                          const tempBadge = getTempBadgeStyle(st.temp_c);
                          return (
                            <div
                              key={st.name + idx}
                              className="p-3.5 rounded-xl bg-zinc-950/70 border border-white/[0.05] flex items-center justify-between gap-4"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-[#e8edf4] truncate">
                                  {st.name}
                                </div>
                                {st.used_percent != null && (
                                  <div className="flex items-center gap-2 mt-1.5">
                                    <div className="w-28 h-1 bg-zinc-800 rounded-full overflow-hidden">
                                      <div
                                        style={{
                                          width: `${Math.min(100, st.used_percent)}%`,
                                        }}
                                        className="h-full bg-cyan-400 rounded-full"
                                      />
                                    </div>
                                    <span className="text-[11px] font-mono text-[#8793a5]">
                                      Занято: {st.used_percent.toFixed(0)}%
                                    </span>
                                  </div>
                                )}
                              </div>

                              <span
                                className={`text-xs font-mono font-bold px-2.5 py-1 rounded-lg border shrink-0 ${tempBadge.badgeClass}`}
                              >
                                {st.temp_c != null
                                  ? `${st.temp_c.toFixed(1)}°C`
                                  : "SMART Н/Д"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="p-4 rounded-xl bg-zinc-950/50 border border-white/[0.04] text-xs font-mono text-[#8793a5]">
                        Опрос SMART-датчиков накопителей...
                      </div>
                    )}
                  </div>
                </SpotlightCard>
              </motion.div>
            </motion.div>
  );
}
