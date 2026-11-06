import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Metrics } from "../lib/studio";

export function TrayHud() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [samples, setSamples] = useState<number[]>([]);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const data = await invoke<Metrics>("get_system_metrics");
        if (!alive) return;
        setMetrics(data);
        if (data.net_ping_ms > 0 && data.net_ping_ms < 999) {
          setSamples((prev) => [...prev.slice(-7), data.net_ping_ms]);
        }
      } catch {
        /* метрики появятся на следующем опросе */
      }
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

  const ping = metrics && metrics.net_ping_ms > 0 && metrics.net_ping_ms < 999 ? metrics.net_ping_ms : null;
  const jitter = samples.length >= 2 ? Math.max(...samples) - Math.min(...samples) : null;
  const stable = jitter !== null && jitter <= 10;

  return (
    <div className="flex h-screen w-screen flex-col justify-between rounded-xl border border-[#222b38] bg-[#111722] p-3 text-slate-100">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span className="text-slate-400">Пинг</span>
        <span className={`text-right font-mono font-semibold ${ping === null ? "text-slate-400" : ping <= 80 ? "text-emerald-400" : ping <= 120 ? "text-amber-400" : "text-rose-400"}`}>
          {ping === null ? "—" : `${ping} мс`}
        </span>
        <span className="text-slate-400">Джиттер</span>
        <span className="text-right font-mono font-semibold text-slate-100">{jitter === null ? "—" : `±${jitter} мс`}</span>
        <span className="text-slate-400">Стабильность</span>
        <span className={`text-right ${stable ? "text-emerald-300" : "text-slate-400"}`}>{jitter === null ? "—" : stable ? "Стабильно" : "Пакетный джиттер"}</span>
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
