import { useWorkspaceState } from "../../hooks/useWorkspaceState";
import { ModuleHeader } from "../ui/ModuleHeader";
import { saveAuroraAppearance, type AuroraEffects } from "../../lib/auroraAppearance";
import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { Check, Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { NumericInput } from "../ui/NumericInput";
import { UtilityConfirmDialog } from "../ui/UtilityConfirmDialog";
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

const POLLING_INTERVALS = [1000, 2000, 5000];
const THRESHOLDS = [
  { key: "alert_cpu_temp", label: "Температура CPU", min: 70, max: 100, unit: "°C" },
  { key: "alert_gpu_temp", label: "Температура GPU", min: 65, max: 95, unit: "°C" },
  { key: "alert_disk_free_gb", label: "Свободное место на C:", min: 5, max: 50, unit: "ГБ" },
] as const;

function Toggle({
  checked, label, description, onChange, disabled, statusText,
}: {
  checked: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  statusText?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-[#E5EDF5]/4 disabled:opacity-60"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[#E5EDF5]">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-[#a0adbb]">{description}</span>
      </span>
      <span aria-hidden="true" className="flex shrink-0 items-center gap-2.5">
        <span className={`hidden text-xs sm:inline ${checked ? "text-[#9ce2e8]" : "text-[#a0adbb]"}`}>
          {statusText ?? (checked ? "Включено" : "Отключено")}
        </span>
        <span className="aurora-toggle" data-checked={checked}>
          <span />
        </span>
      </span>
    </button>
  );
}

function eventLevel(level: string): { label: string; tone: string } {
  if (level === "critical") return { label: "Критично", tone: "text-rose-200" };
  if (level === "warning") return { label: "Предупреждение", tone: "text-amber-200" };
  return { label: "Инфо", tone: "text-[#9ce2e8]" };
}

export function SettingsModule({ c }: { c?: NexusController }) {
  type Startup = "enabled" | "disabled" | "blocked" | "outdated" | "unsupported";
  const [draftChanges, setDraftChanges] = useWorkspaceState<Partial<NexusSettings>>("settings.draft", {});
  const [savedSettings, setSavedSettings] = useState<NexusSettings | null>(null);
  const draft = savedSettings && { ...savedSettings, ...draftChanges };
  const [events, setEvents] = useState<NexusEvent[]>([]);
  const [page, setPage] = useWorkspaceState<"appearance" | "windows" | "telemetry" | "journal" | "about">("settings.page", "appearance");
  const [filter, setFilter] = useWorkspaceState<"all" | "warnings">("settings.filter", "all");
  const [settingsError, setSettingsError] = useState("");
  const [logError, setLogError] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [logLoading, setLogLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [version, setVersion] = useState("");
  const [effects, setEffects] = useState<AuroraEffects>(() => {
    const current = document.documentElement.dataset.auroraEffects;
    return current === "full" || current === "reduced" ? current : "balanced";
  });
  const [appearanceError, setAppearanceError] = useState("");
  const [autostart, setAutostart] = useState<Startup | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState("");
  const autostartOperation = useRef(false);
  const configOperation = useRef(false);
  const logOperation = useRef(false);
  const setAlertThresholds = c?.setAlertThresholds;
  const setPollingRateMs = c?.setPollingRateMs;

  const syncAutostart = useCallback(async (enabled?: boolean) => {
    if (autostartOperation.current) return;
    autostartOperation.current = true;
    setAutostartBusy(true);
    setAutostartError("");
    try {
      const state = enabled === undefined
        ? await invoke<Startup>("get_windows_autostart")
        : await invoke<Startup>("set_windows_autostart", { enabled });
      setAutostart(state);
      if (enabled !== undefined && state !== (enabled ? "enabled" : "disabled")) {
        setAutostartError("Windows не подтвердила запрошенное состояние автозапуска.");
      }
    } catch (err) {
      setAutostartError(String(err));
      setAutostart(await invoke<Startup>("get_windows_autostart").catch(() => null));
    } finally {
      setAutostartBusy(false);
      autostartOperation.current = false;
    }
  }, []);

  const applyRuntime = useCallback((settings: NexusSettings) => {
    setAlertThresholds?.({ cpu: settings.alert_cpu_temp, gpu: settings.alert_gpu_temp, disk: settings.alert_disk_free_gb });
    setPollingRateMs?.(settings.polling_rate_ms);
  }, [setAlertThresholds, setPollingRateMs]);

  const loadSettings = useCallback(async () => {
    if (configOperation.current) return;
    configOperation.current = true;
    setLoading(true);
    setSettingsError("");
    try {
      const settings = await invoke<NexusSettings>("get_settings");
      setSavedSettings(settings);
      applyRuntime(settings);
    } catch (error) {
      setSettingsError(`Ошибка чтения настроек: ${String(error)}`);
    } finally {
      configOperation.current = false;
      setLoading(false);
    }
  }, [applyRuntime]);

  const loadLog = useCallback(async () => {
    if (logOperation.current) return;
    logOperation.current = true;
    setLogLoading(true);
    setLogError("");
    try {
      setEvents(await invoke<NexusEvent[]>("get_event_log"));
    } catch (error) {
      setLogError(`Ошибка чтения журнала: ${String(error)}`);
    } finally {
      logOperation.current = false;
      setLogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadLog();
    void getVersion().then(setVersion).catch(() => {
      // Version is optional when running the frontend without Tauri.
    });
  }, [loadSettings, loadLog]);

  useEffect(() => {
    const refresh = () => void syncAutostart();
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [syncAutostart]);

  const updateDraft = (patch: Partial<NexusSettings>) => {
    if (configOperation.current) return;
    setSaved(false);
    setDraftChanges(previous => ({ ...previous, ...patch }));
  };

  const changed = Boolean(draft && savedSettings && (Object.keys(draft) as (keyof NexusSettings)[]).some(
    (key) => draft[key] !== savedSettings[key]
  ));

  const saveSettings = async () => {
    if (!draft || !changed || configOperation.current) return;
    for (const { key, label, min, max, unit } of THRESHOLDS) {
      if (!Number.isInteger(draft[key]) || draft[key] < min || draft[key] > max) {
        setSettingsError(`${label} — допустимый диапазон ${min}–${max} ${unit}`);
        return;
      }
    }
    configOperation.current = true;
    setSaving(true);
    setSettingsError("");
    try {
      await invoke("save_settings", { settings: draft });
      setSavedSettings(draft);
      setDraftChanges({});
      applyRuntime(draft);
      setSaved(true);
    } catch (error) {
      setSettingsError(`Ошибка сохранения настроек: ${String(error)}`);
      try {
        applyRuntime(await invoke<NexusSettings>("get_settings"));
      } catch {
        // Keep the original save error visible and preserve the draft for retry.
      }
    } finally {
      configOperation.current = false;
      setSaving(false);
    }
  };

  const clearLog = async () => {
    if (logOperation.current) return;
    logOperation.current = true;
    setConfirmClear(false);
    setLogLoading(true);
    setLogError("");
    try {
      await invoke("clear_event_log");
      setEvents([]);
    } catch (error) {
      setLogError(`Ошибка очистки журнала: ${String(error)}`);
    } finally {
      logOperation.current = false;
      setLogLoading(false);
    }
  };

  const visibleEvents = events.filter(
    (event) => filter === "all" || event.level === "warning" || event.level === "critical"
  );

  const windowsAutostartControl = <>
    <Toggle
      checked={autostart === "enabled"}
      disabled={autostartBusy || autostart === null || autostart === "unsupported"}
      label="Запускать AURORA вместе с Windows"
      statusText={autostartBusy ? "Проверка…" : autostart === "outdated" ? "Старая запись" : autostart === null || autostart === "unsupported" ? "Нет данных" : undefined}
      description={autostartBusy ? "Проверяем состояние Windows…" : autostart === "blocked"
        ? "Отключено в настройках автозагрузки Windows."
        : autostart === "outdated" ? "При включении Windows запишет путь к этой AURORA и заменит запись автозапуска прежней версии, если она есть."
        : autostart === "unsupported" ? "Доступно только в Windows."
        : autostart === null ? "Состояние записи автозапуска неизвестно."
        : "Применяется сразу. Запускает AURORA при входе в Windows."}
      onChange={(enabled) => void syncAutostart(enabled)}
    />
    {autostartError && <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-rose-200">
      <span>{autostartError}</span>
      <button type="button" className="nexus-button" onClick={() => void syncAutostart()}>Проверить снова</button>
    </div>}
  </>;

  return (
    <div className="avs-module avs-settings w-full space-y-4">
      <ModuleHeader module="settings" title="Настройки и журнал" description="Оформление, интеграция с Windows и системные предупреждения" />

      <div className="avs-settings-workspace">
        <nav className="nexus-panel avs-settings-index" aria-label="Группы настроек">
          {([
            ["appearance", "Оформление"], ["windows", "Запуск с Windows"],
            ["telemetry", "Телеметрия"], ["journal", "Журнал событий"], ["about", "О программе"],
          ] as const).map(([id, label]) => <button type="button" key={id} aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>{label}</button>)}
        </nav>
        <div className="avs-settings-content">
      <section hidden={page !== "appearance"} className="nexus-panel p-4" aria-labelledby="settings-effects-title">
        <h3 id="settings-effects-title" className="mb-2.5 text-sm font-semibold">Визуальные эффекты</h3>
        <div className="avs-appearance-grid" role="group" aria-label="Интенсивность оформления">
          {([
            ["full", "Сияние", "Усиленная подсветка"],
            ["balanced", "Баланс", "Мягкое освещение"],
            ["reduced", "Минимум", "Простые поверхности"],
          ] as const).map(([mode, label, detail]) => (
            <button type="button" key={mode} aria-pressed={effects === mode} onClick={() => {
              try {
                saveAuroraAppearance(mode);
                setEffects(mode);
                setAppearanceError("");
              } catch {
                setAppearanceError("Не удалось сохранить оформление в профиле приложения.");
              }
            }}>
              <b>{label}</b><small>{detail}</small>
            </button>
          ))}
        </div>
        {appearanceError && <p role="alert" className="mt-2 text-xs text-rose-200">{appearanceError}</p>}
      </section>

      {settingsError && (
        <p role="alert" className="rounded-lg border border-rose-400/35 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{settingsError}</p>
      )}

      {draft ? (
        <form hidden={page !== "windows" && page !== "telemetry" && !changed} onSubmit={(event) => { event.preventDefault(); void saveSettings(); }}>
          <fieldset disabled={saving || loading} className="min-w-0 space-y-3" aria-label="Настройки AURORA">
              <section hidden={page !== "windows"} aria-labelledby="settings-startup-title" className="nexus-panel min-w-0 divide-y divide-[#242e3b]">
                <h3 id="settings-startup-title" className="px-4 py-3 text-sm font-semibold text-[#E5EDF5]">Запуск с Windows</h3>
                {windowsAutostartControl}
                <Toggle
                  checked={draft.start_minimized}
                  label="При автозапуске скрывать окно в трей"
                  description="При входе в Windows AURORA останется в трее. При ручном запуске откроется главное окно."
                  onChange={(start_minimized) => updateDraft({ start_minimized })}
                />
              </section>

              <section hidden={page !== "telemetry"} aria-labelledby="settings-telemetry-title" className="nexus-panel min-w-0 p-4">
                <h3 id="settings-telemetry-title" className="text-sm font-semibold text-[#E5EDF5]">Телеметрия</h3>
                <p className="mt-2 text-sm text-[#a0adbb]">Интервал опроса системных метрик и аппаратных датчиков.</p>
                <div role="group" aria-label="Интервал опроса" className="mt-3 flex flex-wrap gap-2">
                  {POLLING_INTERVALS.map((interval) => (
                    <button key={interval} type="button" aria-pressed={draft.polling_rate_ms === interval} onClick={() => updateDraft({ polling_rate_ms: interval })} className="nexus-button font-mono tabular-nums">
                      {interval / 1000} с
                    </button>
                  ))}
                </div>
              </section>


            <section hidden={page !== "telemetry"} aria-labelledby="settings-warnings-title" className="nexus-panel min-w-0 divide-y divide-[#242e3b]">
              <h3 id="settings-warnings-title" className="px-4 py-3 text-sm font-semibold text-[#E5EDF5]">Пороговые предупреждения</h3>
              <Toggle
                checked={draft.notifications_enabled}
                label="Записывать предупреждения в журнал"
                description="Записи о перегреве CPU и GPU и о нехватке места на системном диске."
                onChange={(notifications_enabled) => updateDraft({ notifications_enabled })}
              />
              <div className="grid gap-3 p-4 sm:grid-cols-3">
                {THRESHOLDS.map(({ key, label, min, max, unit }) => (
                  <div key={key} className="min-w-0 space-y-1.5">
                    <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-[#a0adbb]">
                      <span>{label}</span>
                      <span className="font-mono tabular-nums">{min}–{max} {unit}</span>
                    </p>
                    <NumericInput
                      ariaLabel={label}
                      min={min}
                      max={max}
                      value={draft[key]}
                      unit={unit}
                      onChange={(_raw, numeric) => { if (numeric !== null) updateDraft({ [key]: numeric }); }}
                    />
                  </div>
                ))}
              </div>
            </section>

            <div hidden={page !== "windows" && page !== "telemetry" && !changed} className="avs-settings-save">
              <span role="status" className="flex items-center gap-1.5 text-sm text-[#a0adbb]">
                {saved && <Check size={15} className="text-emerald-300" />}
                {saving ? "Сохранение настроек…" : saved ? "Настройки сохранены" : changed ? "Есть несохранённые изменения" : null}
              </span>
              <button type="submit" className="nexus-button nexus-button--primary" disabled={!changed || saving}>
                <Save size={15} /> Сохранить настройки
              </button>
            </div>
          </fieldset>
        </form>
      ) : (page === "windows" || page === "telemetry") && (
        <>
        {!loading && page === "windows" && <section className="nexus-panel" aria-label="Запуск с Windows">{windowsAutostartControl}</section>}
        <section className="nexus-empty flex flex-wrap items-center gap-3 p-4" role={loading ? "status" : undefined}>
          {loading ? <Loader2 size={16} className="animate-spin text-[#9ce2e8]" /> : null}
          <p className="text-sm text-[#a0adbb]">{loading ? "Загружаем настройки…" : "Настройки недоступны. Сохранение заблокировано."}</p>
          {!loading && <button type="button" onClick={() => void loadSettings()} className="nexus-button">Повторить</button>}
        </section>
        </>
      )}

      <section hidden={page !== "journal"} aria-labelledby="settings-journal-title" className="nexus-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#242e3b] px-4 py-3">
          <h3 id="settings-journal-title" className="text-sm font-semibold text-[#E5EDF5]">Журнал событий</h3>
          <div className="flex flex-wrap items-center gap-2">
            {([["all", "Все записи"], ["warnings", "Предупреждения"]] as const).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className="nexus-button">{label}</button>
            ))}
            <button type="button" disabled={logLoading} onClick={() => void loadLog()} className="nexus-button" aria-label="Обновить журнал" title="Обновить журнал">
              <RefreshCw size={14} className={logLoading ? "animate-spin" : undefined} />
            </button>
            <button type="button" disabled={logLoading || events.length === 0} onClick={() => setConfirmClear(true)} className="nexus-button">
              <Trash2 size={14} /> Очистить журнал
            </button>
          </div>
        </div>
        {logError && <p role="alert" className="px-4 py-3 text-sm text-rose-200">{logError}</p>}
        {visibleEvents.length === 0 ? (
          <p role={logLoading ? "status" : undefined} className="px-4 py-6 text-sm text-[#a0adbb]">
            {logLoading ? "Загружаем журнал…" : logError ? "Журнал недоступен" : filter === "warnings" ? "Предупреждений в журнале нет" : "Записей в журнале пока нет"}
          </p>
        ) : (
          <div className="divide-y divide-[#242e3b]">
            {visibleEvents.map((event) => {
              const level = eventLevel(event.level);
              return (
                <div key={event.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={`font-medium ${level.tone}`}>{level.label}</span>
                      <span className="text-[#a0adbb]">{event.category}</span>
                    </div>
                    <p className="mt-1 text-sm break-words text-[#E5EDF5]">{event.message}</p>
                  </div>
                  <time dateTime={event.timestamp} className="font-mono text-xs tabular-nums text-[#a0adbb]">{event.timestamp.replace("T", " ")}</time>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section hidden={page !== "about"} className="avs-about nexus-panel" aria-label="О программе">
        <img src="/aurora.svg" alt="" />
        <div><b>AURORA</b><small>Системные инструменты Windows{version ? ` · v${version}` : ""}</small></div>
      </section>

        </div>
      </div>
      {confirmClear && (
        <UtilityConfirmDialog title="Очистить журнал событий?" confirmLabel="Удалить записи" onCancel={() => setConfirmClear(false)} onConfirm={() => void clearLog()}>
          <p>Все сохранённые события будут удалены, включая записи, скрытые текущим фильтром.</p>
        </UtilityConfirmDialog>
      )}
    </div>
  );
}
