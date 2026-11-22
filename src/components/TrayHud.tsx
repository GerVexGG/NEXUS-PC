import { useEffect, useState } from "react";
import { ArrowUpRight, Power, TriangleAlert } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Metrics } from "../lib/studio";
import "../AuroraShell.css";

interface RouteProbe {
  label: string;
  ping_ms: number;
  rtt_range_ms: number | null;
  method?: string;
}

export function TrayHud() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [routes, setRoutes] = useState<RouteProbe[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const hud = getCurrentWindow();
    let alive = true;
    let pending = false;
    let acquiredFocus = false;
    const pull = async () => {
      if (pending) return;
      pending = true;
      try {
        if (!(await hud.isVisible()) || !alive) return;
        await Promise.allSettled([
          invoke<Metrics>("get_system_metrics").then(
            (sample) => { if (alive) setMetrics(sample); },
            () => { if (alive) setMetrics(null); },
          ),
          invoke<RouteProbe[]>("probe_game_routes").then(
            (sample) => { if (alive) setRoutes(sample); },
            () => { if (alive) setRoutes([]); },
          ),
        ]);
      } catch (err) {
        if (alive) setError(String(err));
      } finally {
        pending = false;
      }
    };

    const unlisten = hud.onFocusChanged(({ payload }) => {
      if (!alive) return;
      if (payload) {
        acquiredFocus = true;
        void pull();
      } else if (acquiredFocus) {
        acquiredFocus = false;
        void hud.hide().catch((err) => setError(String(err)));
      }
    });
    void pull();
    const timer = window.setInterval(() => void pull(), 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      void unlisten.then((stop) => stop()).catch(console.error);
    };
  }, []);

  async function openMain() {
    setError("");
    try {
      try {
        await invoke("restore_from_tray");
      } catch {
        const main = await WebviewWindow.getByLabel("main");
        if (!main) throw new Error("Главное окно недоступно");
        await main.show();
        if (await main.isMinimized()) await main.unminimize();
        await main.setFocus();
        await getCurrentWindow().hide();
      }
    } catch (err) {
      setError(String(err));
    }
  }

  const route = routes?.find((entry) => entry.label.includes("Москва") && entry.ping_ms > 0 && entry.ping_ms < 999);
  const latency = route ? route.ping_ms + " мс" : "—";
  const quality = route ? "Есть ответ" : routes ? "Нет ответа" : "Опрос…";
  const samples = [
    { label: route?.method ? "Задержка · " + route.method : "Задержка", value: latency },
    { label: "Диапазон RTT", value: route?.rtt_range_ms != null ? route.rtt_range_ms + " мс" : "Н/Д" },
    { label: "Процессор", value: metrics && Number.isFinite(metrics.cpu_usage) ? metrics.cpu_usage.toFixed(0) + "%" : "—" },
    { label: "Память", value: metrics && metrics.ram_total_gb > 0 ? metrics.ram_percentage.toFixed(0) + "%" : "—" },
  ];

  return (
    <div className="nexus-shell av-tray flex h-screen w-screen flex-col justify-between p-2.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <strong className="av-tray-brand"><img src="/aurora.svg" width="22" height="22" alt=""/> AURORA</strong>
        <span className="text-[11px] text-[var(--nexus-muted)]">{quality}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border border-[var(--nexus-line)] bg-[var(--nexus-surface)] px-2.5 py-1.5">
        {samples.map((sample) => <div key={sample.label} className="min-w-0">
          <dt className="truncate text-[11px] text-[var(--nexus-muted)]">{sample.label}</dt>
          <dd className="font-mono text-xs font-semibold tabular-nums">{sample.value}</dd>
        </div>)}
      </dl>
      {error && <div role="alert" title={error} className="flex items-center gap-1 text-[11px] text-rose-200"><TriangleAlert size={12} /><span className="truncate">{error}</span></div>}
      <div className="flex gap-1.5">
        <button type="button" onClick={() => void openMain()} className="nexus-button nexus-button--primary flex-1"><ArrowUpRight size={14} /> Открыть AURORA</button>
        <button type="button" onClick={() => void invoke("app_exit").catch((err) => setError(String(err)))} className="nexus-button nexus-button--danger" title="Завершить AURORA"><Power size={13} /> Выход</button>
      </div>
    </div>
  );
}
