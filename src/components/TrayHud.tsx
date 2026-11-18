import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Metrics } from "../lib/studio";

interface RouteProbe {
  label: string;
  host: string;
  ping_ms: number;
  jitter_ms: number;
  method?: string;
}

export function TrayHud() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [routes, setRoutes] = useState<RouteProbe[]>([]);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      const [metricsResult, routesResult] = await Promise.allSettled([
        invoke<Metrics>("get_system_metrics"),
        invoke<RouteProbe[]>("probe_game_routes"),
      ]);
      if (!alive) return;
      if (metricsResult.status === "fulfilled") setMetrics(metricsResult.value);
      if (routesResult.status === "fulfilled") setRoutes(routesResult.value);
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        void getCurrentWindow().hide();
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const gameRoute = routes.find((route) => route.label.includes("Москва") && route.ping_ms > 0);
  const ping = gameRoute && gameRoute.ping_ms > 0 && gameRoute.ping_ms < 999 ? gameRoute.ping_ms : null;
  const jitter = gameRoute ? gameRoute.jitter_ms : null;
  const stable = jitter !== null && jitter <= 7;

  return (
    <div className="hud-bg flex h-screen w-screen flex-col justify-between border border-[#202B38] bg-[#07080B] p-3 text-[#E5EDF5]">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span className="font-mono text-[11px] text-[#8292A3]">
          PING{gameRoute?.method ? ` (${gameRoute.method})` : ""}
        </span>
        <span
          className={`text-right font-mono font-semibold ${
            ping === null
              ? "text-[#8292A3]"
              : ping <= 80
              ? "text-[#00D5E8]"
              : ping <= 120
              ? "text-amber-400"
              : "text-rose-400"
          }`}
        >
          {ping === null ? "—" : `${ping} мс`}
        </span>
        <span className="font-mono text-[11px] text-[#8292A3]">JITTER</span>
        <span className="text-right font-mono font-semibold text-[#E5EDF5]">
          {jitter === null ? "—" : `±${jitter} мс`}
        </span>
        <span className="font-mono text-[11px] text-[#8292A3]">КАНАЛ</span>
        <span
          className={`text-right font-mono text-[11px] ${
            jitter === null ? "text-[#8292A3]" : stable ? "text-[#00D5E8]" : "text-amber-300"
          }`}
        >
          {jitter === null ? "ОПРОС" : stable ? "СТАБИЛЬНО" : "ДЖИТТЕР"}
        </span>
        <span className="font-mono text-[11px] text-[#8292A3]">CPU</span>
        <span className="text-right font-mono font-semibold text-[#00D5E8]">
          {metrics ? `${metrics.cpu_usage.toFixed(0)}%` : "—"}
        </span>
        <span className="font-mono text-[11px] text-[#8292A3]">RAM</span>
        <span className="text-right font-mono font-semibold text-[#36AFC0]">
          {metrics ? `${metrics.ram_percentage.toFixed(0)}%` : "—"}
        </span>
      </div>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={() => {
            void (async () => {
              try {
                await invoke("restore_from_tray");
              } catch {
                const main = await WebviewWindow.getByLabel("main");
                await main?.show();
                if (await main?.isMinimized()) {
                  await main?.unminimize();
                }
                await main?.setFocus();
                await getCurrentWindow().hide();
              }
            })();
          }}
          className="cyber-btn flex-1 px-2 py-1.5 font-mono text-[11px] font-semibold text-[#00D5E8]"
        >
          ОТКРЫТЬ NEXUS
        </button>
        <button
          type="button"
          onClick={() => void invoke("app_exit")}
          className="cyber-btn-danger px-2.5 py-1.5 font-mono text-[11px] font-semibold text-rose-300"
        >
          ВЫХОД
        </button>
      </div>
    </div>
  );
}
