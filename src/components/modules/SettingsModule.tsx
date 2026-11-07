import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { Check, Trash2 } from "lucide-react";
import type { NexusController } from "../../hooks/useNexusController";

interface NexusSettings {
  autostart: boolean;
  minimize_to_tray: boolean;
  start_minimized: boolean;
  polling_rate_ms: number;
  alert_cpu_temp: number;
  alert_gpu_temp: number;
  alert_disk_free_gb: number;
  notifications_enabled: boolean;
}

interface NexusEvent {
  id: string;
  timestamp: string;
  category: string;
  message: string;
  level: string;
}

const defaultSettings: NexusSettings = {
  autostart: false,
  minimize_to_tray: true,
  start_minimized: false,
  polling_rate_ms: 2000,
  alert_cpu_temp: 85,
  alert_gpu_temp: 83,
  alert_disk_free_gb: 20,
  notifications_enabled: true,
};

const POLL_CHIPS = [
  { label: "1 сек", value: 1000 },
  { label: "2 сек", value: 2000 },
  { label: "5 сек", value: 5000 },
];

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2.5 text-left"
    >
      <span className="text-sm text-slate-200">{label}</span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${checked ? "border-sky-500/40 bg-sky-500/30" : "border-[#222b38] bg-[#0e1118]"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-slate-100 transition-transform ${checked ? "translate-x-5" : "translate-x-1"}`} />
      </span>
    </button>
  );
}

function levelClass(level: string): string {
  if (level === "critical") return "border-rose-500/30 bg-rose-500/10 text-rose-300";
  if (level === "warning") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  return "border-sky-500/30 bg-sky-500/10 text-sky-300";
}

function levelLabel(level: string): string {
  if (level === "critical") return "Критично";
  if (level === "warning") return "Предупреждение";
  return "Инфо";
}

export function SettingsModule({ c }: { c?: NexusController }) {
  const [draft, setDraft] = useState<NexusSettings>(defaultSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [events, setEvents] = useState<NexusEvent[]>([]);
  const [filter, setFilter] = useState<"all" | "warnings">("all");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [settingsRes, logRes] = await Promise.allSettled([
      invoke<NexusSettings>("get_settings"),
      invoke<NexusEvent[]>("get_event_log"),
    ]);

    if (settingsRes.status === "fulfilled") {
      setDraft(settingsRes.value);
      setSettingsLoaded(true);
      setError("");
      c?.setAlertThresholds({
        cpu: settingsRes.value.alert_cpu_temp,
        gpu: settingsRes.value.alert_gpu_temp,
      });
    } else {
      setSettingsLoaded(false);
      setError(`Ошибка чтения конфигурации: ${String(settingsRes.reason)}`);
    }

    if (logRes.status === "fulfilled") {
      setEvents(logRes.value);
    }

    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!settingsLoaded) {
      setError("Ошибка чтения конфигурации: сохранение заблокировано для защиты настроек");
      return;
    }
    if (draft.alert_cpu_temp < 70 || draft.alert_cpu_temp > 100) {
      setError("Порог CPU должен быть от 70 до 100 °C");
      return;
    }
    if (draft.alert_gpu_temp < 65 || draft.alert_gpu_temp > 95) {
      setError("Порог GPU должен быть от 65 до 95 °C");
      return;
    }
    if (draft.alert_disk_free_gb < 5 || draft.alert_disk_free_gb > 50) {
      setError("Остаток диска должен быть от 5 до 50 ГБ");
      return;
    }
    setError("");
    try {
      await invoke("save_settings", { settings: draft });
      c?.setAlertThresholds({
        cpu: draft.alert_cpu_temp,
        gpu: draft.alert_gpu_temp,
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2200);
    } catch (err) {
      setError(String(err));
    }
  };

  const visible = events.filter((event) => filter === "all" || event.level === "warning" || event.level === "critical");

  return (
    <motion.div
      key="settings"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="w-full max-w-5xl space-y-4"
    >
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-100">Настройки и журнал</h2>
        <p className="mt-0.5 text-sm text-slate-400">Локальные параметры запуска, пороги уведомлений и журнал событий</p>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>
      )}

      <section className="space-y-3 rounded-xl border border-[#222b38] bg-[#111722] p-4">
        <h3 className="text-sm font-semibold text-slate-100">Запуск и поведение</h3>
        <Toggle checked={draft.autostart} label="Запуск вместе с Windows" onChange={(autostart) => setDraft({ ...draft, autostart })} />
        <Toggle
          checked={draft.minimize_to_tray}
          label="Сворачивать в трей при закрытии окна"
          onChange={(minimize_to_tray) => setDraft({ ...draft, minimize_to_tray })}
        />
        <Toggle
          checked={draft.start_minimized}
          label="Запускать свёрнутым в трей"
          onChange={(start_minimized) => setDraft({ ...draft, start_minimized })}
        />
      </section>

      <section className="space-y-4 rounded-xl border border-[#222b38] bg-[#111722] p-4">
        <h3 className="text-sm font-semibold text-slate-100">Аппаратный опрос и уведомления</h3>
        <div>
          <div className="mb-2 text-xs text-slate-400">Интервал опроса датчиков</div>
          <div className="flex flex-wrap gap-2">
            {POLL_CHIPS.map((chip) => (
              <button
                key={chip.value}
                type="button"
                onClick={() => setDraft({ ...draft, polling_rate_ms: chip.value })}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  draft.polling_rate_ms === chip.value
                    ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                    : "border-[#222b38] bg-[#151c27] text-slate-300"
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>
        <Toggle
          checked={draft.notifications_enabled}
          label="Включить системные уведомления"
          onChange={(notifications_enabled) => setDraft({ ...draft, notifications_enabled })}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-slate-400">
            Порог перегрева CPU (°C)
            <input
              type="number"
              min={70}
              max={100}
              value={draft.alert_cpu_temp}
              onChange={(event) => setDraft({ ...draft, alert_cpu_temp: Number(event.target.value) })}
              className="w-full rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-slate-500"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-400">
            Порог перегрева GPU (°C)
            <input
              type="number"
              min={65}
              max={95}
              value={draft.alert_gpu_temp}
              onChange={(event) => setDraft({ ...draft, alert_gpu_temp: Number(event.target.value) })}
              className="w-full rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-slate-500"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-400">
            Порог остатка диска C: (ГБ)
            <input
              type="number"
              min={5}
              max={50}
              value={draft.alert_disk_free_gb}
              onChange={(event) => setDraft({ ...draft, alert_disk_free_gb: Number(event.target.value) })}
              className="w-full rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-slate-500"
            />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={loading || !settingsLoaded}
            onClick={() => void save()}
            className="rounded-lg border border-sky-500/30 bg-sky-500/20 px-4 py-2 text-xs font-medium text-sky-300 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Сохранить настройки
          </button>
          {saved && (
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
              <Check size={13} />
              Настройки применены
            </span>
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-[#222b38] bg-[#111722]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222b38] px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-100">Журнал событий системы</h3>
          <div className="flex items-center gap-2">
            {([
              ["all", "Все"],
              ["warnings", "Предупреждения"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={`rounded-lg border px-2.5 py-1 text-[11px] ${
                  filter === id ? "border-sky-500/30 bg-sky-500/10 text-sky-300" : "border-[#222b38] bg-[#151c27] text-slate-400"
                }`}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                void invoke("clear_event_log")
                  .then(() => setEvents([]))
                  .catch((err) => setError(String(err)));
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#222b38] bg-[#151c27] px-2.5 py-1 text-[11px] text-slate-300 hover:text-rose-300"
            >
              <Trash2 size={12} />
              Очистить журнал
            </button>
          </div>
        </div>
        {visible.length === 0 ? (
          <p className="px-4 py-8 text-sm text-slate-400">Событий пока нет</p>
        ) : (
          <div className="divide-y divide-[#222b38]/50">
            {visible.map((event) => (
              <div key={event.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 text-[11px] text-cyan-300">
                      {event.category}
                    </span>
                    <span className={`rounded-md border px-1.5 py-0.5 text-[11px] ${levelClass(event.level)}`}>
                      {levelLabel(event.level)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-100">{event.message}</p>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-slate-500">{event.timestamp.replace("T", " ")}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[#222b38] bg-[#111722] px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-100">О программе</h3>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-slate-400">
          <span>v0.2.0</span>
          <span>x64</span>
          <span>Tauri 2 / Rust</span>
        </div>
      </section>
    </motion.div>
  );
}
