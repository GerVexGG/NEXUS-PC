import { formatJitter, JITTER_HELP } from "../../lib/latencyHistory";
import { useWorkspaceState } from "../../hooks/useWorkspaceState";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Cable, Check, ChevronDown,
  CircuitBoard, Clock3, Cpu, FolderOpen, Gauge, HardDrive, Layers3, MemoryStick,
  Network, Power, Radio, Smartphone, Terminal, Trash2, type LucideIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { formatCountdown, type HistoryPoint } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";
import "./DashboardAurora.css";

type Sample = HistoryPoint & { capturedAt: number };
type RouteSample = { responseMs: number | null; capturedAt: number };
type ChartKey = "cpu" | "ram";

interface RouteProbe {
  host: string;
  label: string;
  ping_ms: number;
  rtt_range_ms: number | null;
  method?: string;
}

const series = [
  { key: "cpu", color: "#4ae7ec", label: "CPU" },
  { key: "ram", color: "#b19aff", label: "RAM" },
] as const;

const quickLinks = [
  { tab: "processes", label: "Процессы", Icon: Layers3, hue: "mint" },
  { tab: "cleanup", label: "Центр очистки", Icon: Trash2, hue: "violet" },
  { tab: "power", label: "Питание", Icon: Power, hue: "blue" },
  { tab: "drop", label: "AURORA Drop", Icon: Smartphone, hue: "violet" },
  { tab: "scripts", label: "Скрипты", Icon: Terminal, hue: "blue" },
] as const;

const dayFormat = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" });
const percentage = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const chartY = (value: number) => 100 - Math.min(100, Math.max(0, value));

function RouteTrend({ samples }: { samples: RouteSample[] }) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const values = samples.flatMap(({ responseMs }) => responseMs === null ? [] : [responseMs]);
  if (!first || !last || values.length < 2) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const elapsed = Math.max(1, last.capturedAt - first.capturedAt);
  let continuous = false;
  const d = samples.map(({ responseMs, capturedAt }) => {
    if (responseMs === null) { continuous = false; return ""; }
    const x = ((capturedAt - first.capturedAt) / elapsed) * 200;
    const y = 28 - ((responseMs - low) / Math.max(1, high - low)) * 22;
    const command = continuous ? "L" : "M";
    continuous = true;
    return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <details className="av-dash-trend">
      <summary>История задержки · Москва</summary>
      <svg viewBox="0 0 200 34" preserveAspectRatio="none" aria-hidden>
        <path d={d} fill="none" stroke="var(--dash-cyan)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <p>Мин. {low} мс · макс. {high} мс · {values.length} ответов</p>
    </details>
  );
}

const Resource = memo(function Resource({ icon: Icon, label, value, unit, detail, percent, hue, readings, children, onOpen }: {
  icon: LucideIcon; label: string; value: string | null; unit: string; detail: string;
  percent?: number; hue: string; readings: { label: string; value: string | null }[];
  children?: React.ReactNode; onOpen: () => void;
}) {
  return (
    <button type="button" className="av-dash-resource av-dash-panel" data-hue={hue} onClick={onOpen}
      title={detail} aria-label={`${label}. ${value === null ? "Нет показаний" : value + " " + unit}. ${detail}. Открыть датчики`}>
      <span className="av-resource-top">
        <span className="av-resource-symbol"><Icon size={21} aria-hidden /></span>
        <span className="av-resource-name"><strong>{label}</strong><small>{detail}</small></span>
        <ArrowUpRight size={14} className="av-resource-arrow" aria-hidden />
      </span>
      <span className="av-resource-value">{value ?? "—"} {value !== null && <small>{unit}</small>}</span>
      {children ?? <span className="av-resource-meter" aria-hidden>
        {percent !== undefined && <i style={{ transform: `scaleX(${Math.min(100, Math.max(0, percent)) / 100})` }} />}
      </span>}
      <span className="av-resource-readings">
        {readings.map((entry) => <span key={entry.label}><b>{entry.value ?? "—"}</b><small>{entry.label}</small></span>)}
      </span>
    </button>
  );
});

const CpuTrend = memo(function CpuTrend({ history }: { history: Sample[] }) {
  const samples = history.slice(-24);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const id = useId();
  if (!first || !last || first === last) return <span className="av-cpu-trend" aria-hidden />;
  const span = Math.max(1, last.capturedAt - first.capturedAt);
  const path = samples.map((sample, index) =>
    `${index ? "L" : "M"} ${(220 * (sample.capturedAt - first.capturedAt) / span).toFixed(2)},${(3 + chartY(sample.cpu) * .35).toFixed(2)}`
  ).join(" ");
  return <svg viewBox="0 0 220 42" preserveAspectRatio="none" className="av-cpu-trend" aria-hidden>
    <defs><linearGradient id={id} x2="0" y2="1"><stop stopColor="#15d9f3" stopOpacity=".36"/><stop offset="1" stopColor="#15d9f3" stopOpacity="0"/></linearGradient></defs>
    <path d={`${path} L220 42 L0 42 Z`} fill={`url(#${id})`} />
    <path d={path} stroke="#63ecff" strokeWidth="1.7" fill="none" vectorEffect="non-scaling-stroke" />
  </svg>;
});

function NetworkTrend({ history }: { history: NexusController["netSpeedHistory"] }) {
  const samples = history.slice(-26);
  if (samples.length < 2) return null;
  const peak = Math.max(1, ...samples.map(({ rxBps, txBps }) => Math.max(rxBps, txBps)));
  return <svg role="img" aria-label="Последние замеры приёма и отдачи" className="av-net-trend"
    viewBox={`0 0 ${samples.length * 8} 30`} preserveAspectRatio="none">
    {samples.map(({ at, rxBps, txBps }, index) => {
      const rx = 30 * rxBps / peak;
      const tx = 30 * txBps / peak;
      return <g key={at}>
        <rect x={index * 8} y={30 - rx} width="3" height={rx} rx=".7" fill="#31d7f5" />
        <rect x={index * 8 + 3.5} y={30 - tx} width="3" height={tx} rx=".7" fill="#ad80ff" />
      </g>;
    })}
  </svg>;
}

const SystemHistory = memo(function SystemHistory({ history }: { history: Sample[] }) {
  const gradientId = useId();
  const [windowSeconds, setWindowSeconds] = useWorkspaceState("dashboard.windowSeconds", 0);
  const [cursor, setCursor] = useState<number | null>(null);
  const samples = useMemo(() => {
    const latest = history[history.length - 1];
    if (!windowSeconds || !latest) return history;
    return history.filter((point) => point.capturedAt >= latest.capturedAt - windowSeconds * 1000);
  }, [history, windowSeconds]);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = Math.max(1, (last?.capturedAt ?? 0) - (first?.capturedAt ?? 0));
  const selected = cursor === null ? -1 : samples.findIndex(({ capturedAt }) => capturedAt === cursor);
  const index = selected >= 0 ? selected : samples.length - 1;
  const point = samples[index];
  const paths = useMemo(() => {
    if (!samples.length) return { cpu: "", ram: "" };
    const start = samples[0].capturedAt;
    const path = (key: ChartKey) => samples.map((sample, index) => {
      const x = ((sample.capturedAt - start) / span) * 600;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${chartY(sample[key]).toFixed(2)}`;
    }).join(" ");
    return { cpu: path("cpu"), ram: path("ram") };
  }, [samples, span]);
  const markerX = point ? ((point.capturedAt - first.capturedAt) / span) * 600 : 0;

  return (
    <section className="av-dash-panel av-dash-chart">
      <header className="av-dash-panel-head">
        <h2><Activity size={18} aria-hidden />Динамика нагрузки</h2>
        <label className="av-dash-period">
          <select aria-label="Интервал графика" value={windowSeconds}
            onChange={(event) => { setWindowSeconds(Number(event.target.value)); setCursor(null); }}>
            <option value={0}>Все замеры</option><option value={60}>За минуту</option><option value={30}>За 30 секунд</option>
          </select>
          <ChevronDown size={12} aria-hidden />
        </label>
      </header>
      <div className="av-chart-readout">
        {series.map(({ key, label, color }) => (
          <div key={key}>
            <span className="av-chart-label"><i style={{ backgroundColor: color }} />{label}</span>
            <strong>{point ? percentage.format(point[key]) : "—"}{point && <small> %</small>}</strong>
          </div>
        ))}
        <span className="av-chart-sample" title="Время выбранного замера"><Clock3 size={12} aria-hidden />{point?.timestamp ?? "Ожидание данных"}</span>
      </div>
      {samples.length < 2 || !point || !last ? (
        <div className="av-dash-chart-empty"><Activity size={23} aria-hidden />График появится после двух замеров</div>
      ) : (
        <div className="av-chart-plot">
          <div className="av-chart-axis-y" aria-hidden><span>100%</span><span>50%</span><span>0%</span></div>
          <svg viewBox="0 0 600 100" preserveAspectRatio="none" tabIndex={0} role="slider"
            aria-label="Замер нагрузки. Используйте стрелки для просмотра истории."
            aria-valuemin={1} aria-valuemax={samples.length} aria-valuenow={index + 1}
            aria-valuetext={`${point.timestamp}, CPU ${percentage.format(point.cpu)}%, RAM ${percentage.format(point.ram)}%`}
            onPointerMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const target = ((event.clientX - bounds.left) / bounds.width) * span + first.capturedAt;
              let closest = first;
              for (const sample of samples) {
                if (Math.abs(sample.capturedAt - target) < Math.abs(closest.capturedAt - target)) closest = sample;
              }
              setCursor(closest.capturedAt);
            }}
            onPointerLeave={() => setCursor(null)} onBlur={() => setCursor(null)}
            onKeyDown={(event) => {
              let next = index;
              switch (event.key) {
                case "ArrowLeft": next = Math.max(0, index - 1); break;
                case "ArrowRight": next = Math.min(samples.length - 1, index + 1); break;
                case "Home": next = 0; break;
                case "End": next = samples.length - 1; break;
                default: return;
              }
              event.preventDefault();
              setCursor(samples[next].capturedAt);
            }}>
            <defs>{series.map(({ key, color }) => (
              <linearGradient key={key} id={gradientId + key} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity=".34" />
                <stop offset="100%" stopColor={color} stopOpacity=".015" />
              </linearGradient>
            ))}</defs>
            {[0, 25, 50, 75, 100].map((y) => <path key={y} d={`M0 ${y}H600`} className="av-chart-gridline" />)}
            {[0, 150, 300, 450, 600].map((x) => <path key={x} d={`M${x} 0V100`} className="av-chart-gridline av-chart-gridline--minor" />)}
            {series.map(({ key }) => <path key={key} d={`${paths[key]} L600,100 H0 Z`} fill={`url(#${gradientId + key})`} />)}
            {series.map(({ key, color }) => <path key={key} d={paths[key]} fill="none" stroke={color}
              strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
            {selected >= 0 && <path d={`M${markerX} 0V100`} className="av-chart-crosshair" />}
          </svg>
          <div className="av-chart-axis-x"><span>{first.timestamp}</span><span>{last.timestamp}</span></div>
        </div>
      )}
    </section>
  );
});

function NetworkPanel({ c }: { c: NexusController }) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useWorkspaceState("dashboard.diagnosticsOpen", false);
  const [routes, setRoutes] = useState<RouteProbe[] | null>(null);
  const [routeSamples, setRouteSamples] = useState<RouteSample[]>([]);
  const [routesError, setRoutesError] = useState("");
  const [diagnostic, setDiagnostic] = useState<"dns" | "priority" | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const routeRequest = useRef<Promise<RouteProbe[]> | null>(null);
  const primary = c.netSnapshotError ? undefined : c.netSnapshot?.adapters.find((adapter) => adapter.is_primary && adapter.is_connected);
  const primaryHistory = primary && c.netSpeedHistory[0]?.adapter === primary.id ? c.netSpeedHistory : [];
  useEffect(() => {
    if (!diagnosticsOpen || !c.windowVisible) return;
    setRoutes(null);
    setRouteSamples([]);
    setRoutesError("");
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      const request = routeRequest.current ?? invoke<RouteProbe[]>("probe_game_routes");
      routeRequest.current = request;
      try {
        const next = await request;
        if (!alive) return;
        setRoutes(next.filter((route) => route.label && route.host));
        const capturedAt = performance.now();
        const latency = next.find((route) => route.label.includes("Москва"))?.ping_ms ?? 0;
        setRouteSamples((current) => [...current.slice(-14), { responseMs: latency > 0 ? latency : null, capturedAt }]);
        setRoutesError("");
      } catch (error) {
        if (alive) setRoutesError(String(error));
      } finally {
        if (routeRequest.current === request) routeRequest.current = null;
        if (alive) timer = window.setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [diagnosticsOpen, c.windowVisible]);

  const runDiagnostic = async (operation: "dns" | "priority") => {
    if (operation === "priority" && !c.isElevatedAdmin) {
      setFeedback({ text: "Для изменения приоритета пакетов нужны права администратора.", error: true });
      return;
    }
    setDiagnostic(operation);
    setFeedback(null);
    try {
      if (operation === "dns") await invoke("flush_dns");
      else await invoke("set_packet_priority", { enabled: true });
      setFeedback({ text: operation === "dns" ? "Кеш DNS очищен." : "Приоритет пакетов применён.", error: false });
    } catch (error) {
      setFeedback({ text: String(error), error: true });
    } finally {
      setDiagnostic(null);
    }
  };

  return (
    <section className="av-dash-panel av-dash-net">
      <header className="av-dash-panel-head">
        <h2><Network size={18} aria-hidden />Сеть {primary?.name && <small className="av-net-adapter" title={`Основное подключение · ${primary.name}`}>{primary.name}</small>}</h2>
        <button className="av-dash-link" type="button" onClick={() => c.setActiveTab("network")}>Монитор <ArrowRight size={14} aria-hidden /></button>
      </header>
      <dl className="av-net-readings">
        {[{ label: "Приём", Icon: ArrowDownLeft, speed: c.rxParts }, { label: "Отдача", Icon: ArrowUpRight, speed: c.txParts }].map(({ label, Icon, speed }) => (
          <div key={label}><dt><Icon size={14} />{label}</dt><dd>{c.metricsReady ? <>{speed.value.replace(".", ",")} <small>{speed.unit === "MB/S" ? "МБ/с" : "КБ/с"}</small></> : "—"}</dd></div>
        ))}
        <div title={c.metrics.net_ping_sample?.host ?? "Внешний контрольный адрес"}><dt><Radio size={14} />Внешний замер</dt><dd>{!c.metricsError && c.metrics.net_ping_sample?.rtt_ms != null ? <>{c.metrics.net_ping_sample.rtt_ms < 1 ? "<1" : c.metrics.net_ping_sample.rtt_ms} <small>мс · {c.metrics.net_ping_method}</small></> : "—"}</dd></div>
        <div className="av-net-jitter" title={JITTER_HELP}><dt>Джиттер</dt><dd>{formatJitter(c.metricsError ? null : c.networkJitter)}</dd></div>
      </dl>
      <NetworkTrend history={primaryHistory} />
      <details className="av-net-diagnostics" open={diagnosticsOpen} onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}>
        <summary><Cable size={15} aria-hidden />Маршруты и диагностика<ChevronDown size={15} aria-hidden /></summary>
        {routesError && <p role="alert" className="av-dash-error">{routesError}</p>}
        {routes === null && !routesError ? <p>Запрос задержки…</p> : routes && routes.length > 0 ? (
          <ul>{routes.map((route) => (
            <li key={route.host}>
              <span title={route.host}>{route.label}</span>
              <span>{route.ping_ms > 0 ? `${route.ping_ms} мс${route.rtt_range_ms != null ? ` · диапазон ${route.rtt_range_ms} мс` : ""}${route.method ? " · " + route.method : ""}` : "Нет ответа"}</span>
            </li>
          ))}</ul>
        ) : !routesError && <p>Нет результатов опроса</p>}
        <RouteTrend samples={routeSamples} />
        <div className="av-net-actions">
          <button type="button" className="nexus-button" disabled={diagnostic !== null} onClick={() => void runDiagnostic("dns")}>{diagnostic === "dns" ? "Очистка…" : "Сброс DNS"}</button>
          <button type="button" className="nexus-button" disabled={diagnostic !== null} onClick={() => void runDiagnostic("priority")}>{diagnostic === "priority" ? "Применение…" : "Повысить приоритет пакетов"}</button>
        </div>
        {feedback && <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "av-dash-error" : "av-dash-success"}>{!feedback.error && <Check size={14} />}{feedback.text}</p>}
      </details>
    </section>
  );
}

export function DashboardModule({ c }: { c: NexusController }) {
  const { setActiveTab, metrics, history, metricsReady, metricsError, hwData, hwmonStatus, hwPollError, diskUsedPercentage } = c;
  const openHardware = useCallback(() => setActiveTab("hardware"), [setActiveTab]);
  const openStorage = useCallback(() => setActiveTab("storage"), [setActiveTab]);
  const hwStale = Boolean(hwPollError || hwData?.telemetry_stale || hwmonStatus.telemetry_stale);
  const gpu = hwData?.gpus[0];
  const gpuLoad = gpu?.load_percent ?? null;
  const gpuTemp = gpu?.core_temp_c ?? null;
  const gpuClock = gpu?.core_clock_mhz ?? null;
  const cpuTemp = hwData?.cpu.package_temp_c ?? null;
  const ramReady = metricsReady && metrics.ram_total_gb > 0;
  const diskReady = metricsReady && metrics.disk_total_gb > 0;
  const metricsMessage = metricsError
    ? (metricsReady ? "Последний полученный замер" : "Системные метрики недоступны")
    : metricsReady ? "Телеметрия активна" : "Ожидание первого замера";
  const formatReading = (value: number | null | undefined, suffix: string) =>
    value == null || !Number.isFinite(value) ? null : `${percentage.format(value)} ${suffix}`;
  const showClock = (mhz: number | null | undefined) => formatReading(mhz == null ? null : mhz / 1000, "ГГц");
  const cpu = hwData?.cpu;
  const gpuLoadReady = !hwStale && gpuLoad !== null;
  const sensorState = hwmonStatus.status === "driver_blocked" ? "Часть датчиков заблокирована Windows" :
    hwStale ? "Показания датчиков устарели" :
    hwmonStatus.status === "ready" && hwData?.sidecar_online ? "Аппаратные датчики подключены" :
    hwData ? "Доступны показания Windows" : "Ожидание датчиков";
  const warnings = c.thermalWarnings;
  const timer = c.timerState && c.remainingSeconds > 0;
  return (
    <div className="av-dashboard">
      <header className="av-dash-hero">
        <div className="av-dash-hero-content">
          <p className="av-dash-day">{dayFormat.format(new Date())}</p>
          <h1>Обзор системы</h1>
        </div>
        <div className="av-hero-actions">
          <span className="av-hero-status" role="status" data-state={metricsError ? "error" : metricsReady ? "live" : "pending"}><i />{metricsMessage}</span>
          {timer && <button type="button" className="av-hero-timer" onClick={() => setActiveTab("power")}><Clock3 size={14} />Таймер {formatCountdown(c.remainingSeconds)}</button>}
          {c.isScanning && <button type="button" onClick={openStorage}><HardDrive size={14} /> Сканирование</button>}
          {(c.isScanningCleanup || c.isCleaning) && <button type="button" onClick={() => setActiveTab("cleanup")}><Trash2 size={14} /> Центр очистки</button>}
        </div>
      </header>
      {metricsError && <p className="av-dash-error" role="alert">{metricsError}</p>}
      <div className="av-dash-board">
        <div className="av-dash-core">
          <div className="av-dash-resources" aria-label="Нагрузка оборудования">
            <Resource label="CPU" icon={Cpu} hue="mint" onOpen={openHardware} unit="%"
              value={metricsReady ? percentage.format(metrics.cpu_usage) : null}
              detail={cpu?.name?.trim() || "Процессор"} readings={[
                { label: "Частота", value: hwStale ? null : showClock(cpu?.avg_clock_mhz) },
                { label: "Температура пакета", value: hwStale ? null : formatReading(cpuTemp, "°C") },
              ]}><CpuTrend history={history} /></Resource>
            <Resource label="GPU" icon={Gauge} hue="violet" onOpen={openHardware} unit="%"
              value={gpuLoadReady ? percentage.format(gpuLoad) : null} percent={gpuLoadReady ? gpuLoad : undefined}
              detail={gpu?.name || (hwData ? "Адаптер не обнаружен" : "Видеоадаптер")} readings={[
                { label: "Частота", value: hwStale ? null : showClock(gpuClock) },
                { label: "Температура", value: hwStale ? null : formatReading(gpuTemp, "°C") },
              ]} />
            <Resource label="RAM" icon={MemoryStick} hue="blue" onOpen={openHardware} unit="%"
              value={ramReady ? percentage.format(metrics.ram_percentage) : null} percent={ramReady ? metrics.ram_percentage : undefined}
              detail={ramReady ? `${percentage.format(metrics.ram_total_gb)} ГБ · Оперативная память` : "Оперативная память"} readings={[
                { label: "Занято", value: ramReady ? formatReading(metrics.ram_used_gb, "ГБ") : null },
                { label: "Доступно", value: ramReady ? formatReading(Math.max(0, metrics.ram_total_gb - metrics.ram_used_gb), "ГБ") : null },
              ]} />
          </div>
          <div className="av-dash-system">
            <section className="av-dash-panel av-dash-sensors">
              <header className="av-dash-panel-head"><h2><CircuitBoard size={18} aria-hidden />Датчики</h2>
                <button type="button" className="av-dash-link" onClick={openHardware}>Монитор <ArrowUpRight size={14}/></button>
              </header>
              <p className="av-sensor-state" data-warning={warnings.length > 0 || hwStale || hwmonStatus.status === "driver_blocked"}>{sensorState}</p>
              {warnings.length > 0 && <ul className="av-dash-error">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            </section>
            <section className="av-dash-panel av-dash-storage">
              <header className="av-dash-panel-head"><h2><HardDrive size={18} aria-hidden />Системный диск</h2>
                <button type="button" className="av-dash-link" onClick={openStorage}>Открыть <ArrowUpRight size={14}/></button>
              </header>
              {diskReady ? <><div className="av-storage-size"><strong>{formatReading(metrics.disk_free_gb, "ГБ")}</strong><span>из {formatReading(metrics.disk_total_gb, "ГБ")} свободно</span></div>
                <meter min={0} max={100} value={diskUsedPercentage} aria-label="Заполненность системного диска"
                  data-near-full={diskUsedPercentage >= 90} /></> : <p>Объём диска недоступен</p>}
            </section>
          </div>
          <SystemHistory history={history} />
        </div>
        <div className="av-dash-sidebar">
          <NetworkPanel c={c} />
          <nav className="av-dash-panel av-dash-tools" aria-label="Быстрые переходы">
            <header className="av-dash-panel-head"><h2><FolderOpen size={18} aria-hidden />Быстрые действия</h2></header>
            <div className="av-dash-tool-grid">
              {quickLinks.map(({ tab, label, Icon, hue }) => <button type="button" key={tab} onClick={() => setActiveTab(tab)} data-hue={hue}>
                <Icon size={17} aria-hidden /><span>{label}</span><ArrowUpRight size={13} aria-hidden />
              </button>)}
            </div>
          </nav>
        </div>
      </div>
    </div>
  );
}
