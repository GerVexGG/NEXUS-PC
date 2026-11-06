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
    <div className="flex h-screen w-screen flex-col justify-between rounded-xl border border-[#222b38] bg-[#111722] p-3 text-slate-100">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span className="text-slate-400">Пинг</span>
        <span className={`text-right font-mono font-semibold ${ping === null ? "text-slate-400" : ping <= 80 ? "text-emerald-400" : ping <= 120 ? "text-amber-400" : "text-rose-400"}`}>
          {ping === null ? "—" : `${ping} ms`}
        </span>
        <span className="text-slate-400">Джиттер</span>
        <span className="text-right font-mono font-semibold text-slate-100">{jitter === null ? "—" : `±${jitter} ms`}</span>
        <span className="text-slate-400">Стабильность</span>
        <span className={`text-right ${jitter === null ? "text-slate-400" : stable ? "text-emerald-300" : "text-amber-300"}`}>
          {jitter === null ? "Сбор данных" : stable ? "Стабильно" : "Пакетный джиттер"}
        </span>
        <span className="text-slate-400">CPU</span>
        <span className="text-right font-mono">{metrics ? `${metrics.cpu_usage.toFixed(0)}%` : "—"}</span>
        <span className="text-slate-400">RAM</span>
        <span className="text-right font-mono">{metrics ? `${metrics.ram_percentage.toFixed(0)}%` : "—"}</span>
      </div>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={() => {
            void (async () => {
              const main = await WebviewWindow.getByLabel("main");
              await main?.show();
              await main?.unminimize();
              await main?.setFocus();
              await getCurrentWindow().hide();
            })();
          }}
          className="flex-1 rounded-lg border border-[#222b38] bg-[#151c27] px-2 py-1.5 text-[11px] text-slate-200 hover:bg-[#1a2332]"
        >
          Развернуть NEXUS PC
        </button>
        <button
          type="button"
          onClick={() => void invoke("app_exit")}
          className="rounded-lg border border-rose-500/30 bg-rose-500/15 px-2 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/25"
        >
          Выход
        </button>
      </div>
    </div>
  );
}
