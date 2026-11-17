import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { Check, Trash2 } from "lucide-react";
import { PageHeader } from "../../lib/studio";
import { NumericInput } from "../ui/NumericInput";
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
  minimize_to_tray: false,
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
  description,
  onChange,
}: {
  checked: boolean;
  label: string;
  description?: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-lg border border-[#202B38] bg-[#0B0E14] px-3.5 py-2.5 text-left transition-colors hover:border-[#00D5E8]/35"
    >
      <div>
        <div className="text-sm font-medium text-[#E5EDF5]">{label}</div>
        {description && <div className="mt-0.5 text-xs text-[#8292A3]">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <span
          className={`font-mono text-[11px] font-medium ${
            checked ? "text-[#00D5E8]" : "text-[#526170]"
          }`}
        >
          {checked ? "Включено" : "Отключено"}
        </span>
        <span
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
            checked ? "border-[#00D5E8]/50 bg-[#00D5E8]/25" : "border-[#202B38] bg-[#10151D]"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
              checked ? "left-4 bg-[#00D5E8] shadow-[0_0_6px_rgba(0,213,232,0.8)]" : "left-0.5 bg-[#526170]"
            }`}
          />
        </span>
      </div>
    </button>
  );
}

function levelClass(level: string): string {
  if (level === "critical") return "border-rose-500/35 bg-rose-500/12 text-rose-300";
  if (level === "warning") return "border-amber-500/35 bg-amber-500/12 text-amber-300";
  return "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]";
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

  const visible = events.filter(
    (event) => filter === "all" || event.level === "warning" || event.level === "critical"
  );

  return (
    <motion.div
      key="settings"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="w-full space-y-4"
    >
      <PageHeader
        title="Настройки и журнал"
        description="Параметры автозапуска, интервалы телеметрии, пороги температурных уведомлений и системный журнал"
      />

      {error && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/12 px-4 py-2.5 text-xs text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <section className="tactical-card tactical-brackets space-y-3 rounded-xl p-5 lg:col-span-6">
          <h3 className="text-sm font-semibold text-[#E5EDF5]">Запуск и поведение окна</h3>
          <Toggle
            checked={draft.autostart}
            label="Запуск вместе с Windows"
            description="Автоматическая регистрация NEXUS при входе в систему"
            onChange={(autostart) => setDraft({ ...draft, autostart })}
          />
          <Toggle
            checked={draft.start_minimized}
            label="Запускать свёрнутым в трей"
            description="Не открывать главное окно при автоматическом старте"
            onChange={(start_minimized) => setDraft({ ...draft, start_minimized })}
          />
          <Toggle
            checked={draft.notifications_enabled}
            label="Системные уведомления"
            description="Предупреждения при превышении температурных порогов"
            onChange={(notifications_enabled) => setDraft({ ...draft, notifications_enabled })}
          />
        </section>

        <section className="tactical-card tactical-brackets flex flex-col justify-between space-y-4 rounded-xl p-5 lg:col-span-6">
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-[#E5EDF5]">
              Аппаратный опрос и температурные пороги
            </h3>
            <div>
              <div className="mb-2 text-xs font-medium text-[#8292A3]">
                Интервал опроса аппаратных датчиков
              </div>
              <div className="grid grid-cols-3 gap-2">
                {POLL_CHIPS.map((chip) => (
                  <button
                    key={chip.value}
                    type="button"
                    onClick={() => setDraft({ ...draft, polling_rate_ms: chip.value })}
                    className={`cursor-pointer rounded-lg border px-3 py-2 font-mono text-xs font-medium transition-colors ${
                      draft.polling_rate_ms === chip.value
                        ? "border-[#00D5E8]/45 bg-[#00D5E8]/12 text-[#00D5E8]"
                        : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
                    }`}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5 text-xs text-[#8292A3]">
                <div className="flex items-center justify-between">
                  <span>Порог CPU</span>
                  <span className="font-mono text-[10px] text-[#526170]">70–100 °C</span>
                </div>
                <NumericInput
                  ariaLabel="Порог температуры CPU"
                  min={70}
                  max={100}
                  step={1}
                  unit="°C"
                  value={draft.alert_cpu_temp}
                  onChange={(_raw, num) => {
                    if (num !== null) setDraft({ ...draft, alert_cpu_temp: num });
                  }}
                />
              </div>
              <div className="space-y-1.5 text-xs text-[#8292A3]">
                <div className="flex items-center justify-between">
                  <span>Порог GPU</span>
                  <span className="font-mono text-[10px] text-[#526170]">65–95 °C</span>
                </div>
                <NumericInput
                  ariaLabel="Порог температуры GPU"
                  min={65}
                  max={95}
                  step={1}
                  unit="°C"
                  value={draft.alert_gpu_temp}
                  onChange={(_raw, num) => {
                    if (num !== null) setDraft({ ...draft, alert_gpu_temp: num });
                  }}
                />
              </div>
              <div className="space-y-1.5 text-xs text-[#8292A3]">
                <div className="flex items-center justify-between">
                  <span>Остаток диска C:</span>
                  <span className="font-mono text-[10px] text-[#526170]">5–50 ГБ</span>
                </div>
                <NumericInput
                  ariaLabel="Минимальный остаток диска C:"
                  min={5}
                  max={50}
                  step={1}
                  unit="ГБ"
                  value={draft.alert_disk_free_gb}
                  onChange={(_raw, num) => {
                    if (num !== null) setDraft({ ...draft, alert_disk_free_gb: num });
                  }}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-[#202B38] pt-3">
            <div className="text-xs text-[#8292A3]">
              {saved ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-[#00D5E8]">
                  <Check size={14} />
                  Конфигурация сохранена
                </span>
              ) : (
                "Изменения вступают в силу сразу после сохранения"
              )}
            </div>
            <button
              type="button"
              disabled={loading || !settingsLoaded}
              onClick={() => void save()}
              className="cyber-btn cursor-pointer px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-[#00D5E8] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Сохранить настройки
            </button>
          </div>
        </section>
      </div>

      <section className="tactical-card tactical-brackets overflow-hidden rounded-xl">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#202B38] px-5 py-3.5">
          <h3 className="text-sm font-semibold text-[#E5EDF5]">Журнал системных событий</h3>
          <div className="flex items-center gap-2">
            {(
              [
                ["all", "Все записи"],
                ["warnings", "Предупреждения"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs font-medium ${
                  filter === id
                    ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                    : "border-[#202B38] bg-[#0B0E14] text-[#8292A3]"
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
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-1 text-xs font-medium text-[#8292A3] hover:border-rose-500/35 hover:text-rose-300"
            >
              <Trash2 size={12} />
              Очистить журнал
            </button>
          </div>
        </div>
        {visible.length === 0 ? (
          <p className="px-5 py-8 text-sm text-[#8292A3]">Записей в журнале событий пока нет</p>
        ) : (
          <div className="divide-y divide-[#202B38]/60">
            {visible.map((event) => (
              <div key={event.id} className="flex items-start justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded border border-[#202B38] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] font-medium text-[#00D5E8]">
                      {event.category}
                    </span>
                    <span
                      className={`rounded border px-2 py-0.5 font-mono text-[10px] font-medium ${levelClass(
                        event.level
                      )}`}
                    >
                      {levelLabel(event.level)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-[#E5EDF5]">{event.message}</p>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-[#526170]">
                  {event.timestamp.replace("T", " ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="tactical-card flex flex-wrap items-center justify-between gap-3 rounded-xl px-5 py-3.5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-[#E5EDF5]">NEXUS System Utility</span>
          <span className="rounded border border-[#00D5E8]/30 bg-[#00D5E8]/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-[#00D5E8]">
            v0.2.2
          </span>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-[#8292A3]">
          <span>Windows x64</span>
          <span>Tauri 2.0 + Rust Core</span>
          <span>Cyber HUD Design System</span>
        </div>
      </section>
    </motion.div>
  );
}
