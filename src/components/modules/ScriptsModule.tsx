import { ModuleHeader } from "../ui/ModuleHeader";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check,
  Copy,
  FileCode,
  FolderArchive,
  Loader2,
  Play,
  Plus,
  Save,
  Search,
  Shield,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { copyTextToClipboard } from "../../lib/studio";
import { ArchiveCreatorModal } from "../modals/ArchiveCreatorModal";
import { UtilityConfirmDialog } from "../ui/UtilityConfirmDialog";

export type ScriptKind = "powershell" | "cmd" | "vbs" | "text";

export interface UserScript {
  id: string;
  title: string;
  script_type: ScriptKind;
  content: string;
  updated_at: number;
}

const SCRIPT_TYPES: {
  id: ScriptKind;
  label: string;
  badge: string;
  badgeClass: string;
  placeholder: string;
}[] = [
  {
    id: "powershell",
    label: "PowerShell",
    badge: "PS1",
    badgeClass: "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]",
    placeholder: "# Введите команды PowerShell…\nGet-Process | Select-Object -First 10 Name, Id, CPU",
  },
  {
    id: "cmd",
    label: "Batch (CMD)",
    badge: "BAT",
    badgeClass: "border-amber-500/40 bg-amber-500/12 text-amber-300",
    placeholder: "@echo off\nipconfig /all",
  },
  {
    id: "vbs",
    label: "VBScript",
    badge: "VBS",
    badgeClass: "border-indigo-500/40 bg-indigo-500/12 text-indigo-300",
    placeholder: 'WScript.Echo "Готово"',
  },
  {
    id: "text",
    label: "Заметка",
    badge: "TXT",
    badgeClass: "border-[#202B38] bg-[#151C26] text-[#8292A3]",
    placeholder: "Технические заметки, команды или фрагменты конфигурации…",
  },
];

function getTypeMeta(kind: string) {
  return SCRIPT_TYPES.find((t) => t.id === kind) ?? SCRIPT_TYPES[0];
}

function formatUpdatedDate(epochSec: number): string {
  if (!epochSec || epochSec <= 0) return "Только что";
  const d = new Date(epochSec * 1000);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function generateUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `script-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

type LibraryAction =
  | { kind: "select" | "delete"; script: UserScript }
  | { kind: "create" };

interface ScriptRunResult {
  output: string;
  exit_code: number | null;
  timed_out: boolean;
  skipped: boolean;
}

function runStatus(result: ScriptRunResult | null, running: boolean) {
  const neutral = "border-[#46616b] bg-[#14212c] text-[#b9d8df]";
  const warning = "border-rose-400/40 bg-rose-400/10 text-rose-200";
  if (running) return { label: "Выполнение", className: neutral };
  if (result?.skipped) return { label: "Запуск недоступен", className: neutral };
  if (result?.timed_out) return { label: "Таймаут", className: warning };
  if (result?.exit_code === 0) {
    return { label: "Завершено · код 0", className: "border-emerald-400/35 bg-emerald-400/10 text-emerald-200" };
  }
  const label = result?.exit_code == null ? "Ошибка" : `Ошибка · код ${result.exit_code}`;
  return { label, className: warning };
}

export function ScriptsModule() {
  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [scriptType, setScriptType] = useState<ScriptKind>("powershell");
  const [content, setContent] = useState<string>("");
  const [dirty, setDirty] = useState<boolean>(false);

  const [asAdmin, setAsAdmin] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [running, setRunning] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [outputCopied, setOutputCopied] = useState(false);
  const [savedToast, setSavedToast] = useState<boolean>(false);
  const [deleting, setDeleting] = useState(false);

  const [consoleResult, setConsoleResult] = useState<ScriptRunResult | null>(null);
  const [executionTitle, setExecutionTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState<boolean>(false);
  const [confirmation, setConfirmation] = useState<LibraryAction | null>(null);
  const operation = useRef(false);
  const busy = loading || saving || running || deleting;

  const selectScript = useCallback((script: UserScript) => {
    setSelectedId(script.id);
    setTitle(script.title);
    setScriptType((script.script_type as ScriptKind) || "powershell");
    setContent(script.content);
    setDirty(false);
    setSavedToast(false);
    setCopied(false);
    setError(null);
  }, []);

  const loadScripts = useCallback(
    async () => {
      if (operation.current) return;
      operation.current = true;
      setLoading(true);
      setError(null);
      try {
        const list = await invoke<UserScript[]>("get_user_scripts");
        setScripts(list);
        if (list.length > 0) {
          selectScript(list[0]);
        } else {
          const fresh: UserScript = {
            id: generateUuid(),
            title: "Новый скрипт",
            script_type: "powershell",
            content: "",
            updated_at: Math.floor(Date.now() / 1000),
          };
          selectScript(fresh);
          setDirty(true);
        }
      } catch (err) {
        setError(String(err));
      } finally {
        operation.current = false;
        setLoading(false);
      }
    },
    [selectScript]
  );

  useEffect(() => {
    void loadScripts();
  }, [loadScripts]);

  const handleCreateNew = () => {
    const fresh: UserScript = {
      id: generateUuid(),
      title: "Новый скрипт",
      script_type: "powershell",
      content: "",
      updated_at: Math.floor(Date.now() / 1000),
    };
    selectScript(fresh);
    setDirty(true);
  };

  const saveSelectedScript = useCallback(async (): Promise<string | null> => {
    if (!selectedId) return null;
    setSaving(true);
    setError(null);
    const updated: UserScript = {
      id: selectedId,
      title: title.trim() || "Без названия",
      script_type: scriptType,
      content,
      updated_at: Math.floor(Date.now() / 1000),
    };
    try {
      await invoke("save_user_script", { script: updated });
      setDirty(false);
      setSavedToast(true);
      setTitle(updated.title);
      setScripts((prev) => [updated, ...prev.filter((script) => script.id !== updated.id)]);
      return updated.id;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [selectedId, title, scriptType, content]);

  const handleSave = useCallback(async () => {
    if (operation.current || !selectedId) return;
    operation.current = true;
    try {
      await saveSelectedScript();
    } finally {
      operation.current = false;
    }
  }, [selectedId, saveSelectedScript]);

  const handleDelete = async (id: string) => {
    if (operation.current) return;
    operation.current = true;
    setDeleting(true);
    setError(null);
    try {
      await invoke("delete_user_script", { id });
      const nextList = scripts.filter((item) => item.id !== id);
      setScripts(nextList);
      if (selectedId === id) {
        if (nextList.length > 0) {
          selectScript(nextList[0]);
        } else {
          handleCreateNew();
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      operation.current = false;
      setDeleting(false);
    }
  };

  const copy = async (text: string, onCopied: (copied: boolean) => void) => {
    try {
      await copyTextToClipboard(text);
      onCopied(true);
    } catch (err) {
      onCopied(false);
      setError(String(err));
    }
  };

  const handleRun = async () => {
    if (!selectedId || scriptType === "text" || operation.current) return;
    operation.current = true;
    setError(null);
    setRunning(true);
    setConsoleResult(null);
    setOutputCopied(false);
    setExecutionTitle(title.trim() || "Без названия");
    try {
      const targetId = dirty || !scripts.some((s) => s.id === selectedId)
        ? await saveSelectedScript()
        : selectedId;
      if (!targetId) return;
      const result = await invoke<ScriptRunResult>("run_user_script_details", {
        id: targetId,
        asAdmin,
      });
      setConsoleResult(result);
    } catch (err) {
      setConsoleResult({ output: String(err), exit_code: null, timed_out: false, skipped: false });
    } finally {
      operation.current = false;
      setRunning(false);
    }
  };

  const applyLibraryAction = (action: LibraryAction) => {
    if (action.kind === "create") handleCreateNew();
    else if (action.kind === "select") selectScript(action.script);
    else void handleDelete(action.script.id);
  };

  const requestLibraryAction = (action: LibraryAction) => {
    if (busy || operation.current || (action.kind === "select" && action.script.id === selectedId)) return;
    if (dirty || action.kind === "delete") setConfirmation(action);
    else applyLibraryAction(action);
  };

  const markDirty = () => {
    setDirty(true);
    setSavedToast(false);
    setCopied(false);
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void handleSave();
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && !busy) {
      event.preventDefault();
      const target = event.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const next = `${content.slice(0, start)}  ${content.slice(end)}`;
      setContent(next);
      markDirty();
      requestAnimationFrame(() => {
        target.selectionStart = start + 2;
        target.selectionEnd = start + 2;
      });
    }
  };

  const filteredScripts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scripts;
    return scripts.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.script_type.toLowerCase().includes(q) ||
        item.content.toLowerCase().includes(q)
    );
  }, [scripts, search]);

  const currentTypeMeta = getTypeMeta(scriptType);

  return (
    <>
      <motion.div
        key="scripts"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="avs-module avs-scripts w-full space-y-4"
      >
        <ModuleHeader module="scripts"
          title="Скрипты и автоматизация"
          description="Локальная библиотека, редактор и выполнение сценариев PowerShell, Batch и VBScript"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setArchiveOpen(true)}
                className="nexus-button"
              >
                <FolderArchive size={14} className="text-[#00D5E8]" />
                Создать архив
              </button>
              <button
                type="button"
                onClick={() => requestLibraryAction({ kind: "create" })}
                disabled={busy || !selectedId}
                className="nexus-button nexus-button--primary"
              >
                <Plus size={14} />
                Новый скрипт
              </button>
            </div>
          }
        />

      {error && (
        <div role="alert" className="rounded-xl border border-rose-500/35 bg-rose-500/12 px-4 py-2.5 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="avs-script-workbench">
        {/* Левая колонка: Библиотека скриптов */}
        <section aria-label="Библиотека скриптов" className="nexus-panel flex min-w-0 flex-col p-4">
          <h3 className="mb-3 text-sm font-semibold text-[#E5EDF5]">Библиотека <span className="ml-1 tabular-nums text-[#a0adbb]">{scripts.length}</span></h3>
          <div className="relative mb-3">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#526170]"
            />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Поиск по библиотеке…"
              aria-label="Поиск по библиотеке скриптов"
              className="w-full rounded-lg border border-[#202B38] bg-[#0B0E14] py-2 pl-9 pr-3 text-xs text-[#E5EDF5] outline-none placeholder:text-[#526170] focus:border-[#00D5E8]/50"
            />
          </div>

          <div className="max-h-[min(42vh,24rem)] min-h-24 flex-1 divide-y divide-[#242e3b] overflow-y-auto min-[860px]:max-h-[calc(100vh-275px)]">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 font-mono text-xs text-[#8292A3]">
                <Loader2 size={14} className="animate-spin text-[#00D5E8]" />
                Загрузка библиотеки…
              </div>
            ) : filteredScripts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <FileCode size={24} className="mb-2 text-[#526170]" />
                <div className="text-sm text-[#a0adbb]">
                  {search.trim() ? "Нет совпадений" : !selectedId ? "Библиотека недоступна" : "Сохранённых скриптов пока нет"}
                </div>
                {!selectedId && !search.trim() && (
                  <button type="button" className="nexus-button mt-2" onClick={() => void loadScripts()}>Повторить загрузку</button>
                )}
              </div>
            ) : (
              filteredScripts.map((item) => {
                const active = item.id === selectedId;
                const meta = getTypeMeta(item.script_type);
                return (
                  <div
                    key={item.id}
                    className={`group relative flex items-center justify-between gap-1 rounded-md transition-colors ${
                      active
                        ? "bg-[#00D5E8]/10"
                        : "hover:bg-[#151C26]"
                    }`}
                  >
                    {active && (
                      <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-[#00D5E8]" />
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      aria-pressed={active}
                      onClick={() => requestLibraryAction({ kind: "select", script: item })}
                      className="min-w-0 flex-1 cursor-pointer py-2.5 pl-3 text-left disabled:cursor-wait"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${meta.badgeClass}`}
                        >
                          {meta.badge}
                        </span>
                        <span className="truncate text-sm font-medium text-[#E5EDF5]" title={item.title}>
                          {item.title}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-[#a0adbb]">
                        <span>{formatUpdatedDate(item.updated_at)}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      title="Удалить скрипт"
                      aria-label={`Удалить скрипт: ${item.title}`}
                      disabled={busy}
                      onClick={() => requestLibraryAction({ kind: "delete", script: item })}
                      className="mr-1 cursor-pointer rounded p-2 text-[#a0adbb] hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-45"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Правая колонка: Редактор и Консоль */}
        <div className="flex min-w-0 flex-col gap-4">
          <fieldset disabled={busy || !selectedId} aria-label="Редактор сценария" className="nexus-panel flex min-w-0 flex-col gap-3.5 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <label htmlFor="nexus-script-title" className="mb-1 block text-xs font-medium text-[#a0adbb]">
                  Название сценария
                </label>
                <input
                  type="text"
                  id="nexus-script-title"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    markDirty();
                  }}
                  placeholder="Введите название сценария…"
                  className="w-full rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2 text-sm font-medium text-[#E5EDF5] outline-none placeholder:text-[#526170] focus:border-[#00D5E8]/50"
                />
              </div>

              <div>
                <p className="mb-1 block text-xs font-medium text-[#a0adbb]">
                  Интерпретатор
                </p>
                <div role="group" aria-label="Интерпретатор" className="flex flex-wrap gap-1.5">
                  {SCRIPT_TYPES.map((t) => {
                    const active = scriptType === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => {
                          setScriptType(t.id);
                          markDirty();
                        }}
                        className={`cursor-pointer rounded-lg border px-2.5 py-2 font-mono text-xs font-semibold transition-colors ${
                          active
                            ? "border-[#00D5E8]/45 bg-[#00D5E8]/12 text-[#00D5E8]"
                            : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
                        }`}
                      >
                        {t.badge}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-[#a0adbb]">
                <span className="flex items-center gap-1.5">
                  <Terminal size={12} className="text-[#00D5E8]" />
                  {currentTypeMeta.label}
                  {dirty && <span className="text-amber-300">· Изменено</span>}
                  {savedToast && <span className="text-[#00D5E8]">· Сохранено</span>}
                </span>
                <span className="font-mono">{content.length ? content.split("\n").length : 0} стр.</span>
              </div>

              <textarea
                value={content}
                aria-label="Код сценария"
                wrap="off"
                onChange={(event) => {
                  setContent(event.target.value);
                  markDirty();
                }}
                onKeyDown={handleEditorKeyDown}
                spellCheck={false}
                placeholder={currentTypeMeta.placeholder}
                className="h-64 w-full resize-y overflow-auto rounded-lg border border-[#202B38] bg-[#090e14] p-3.5 font-mono text-sm leading-relaxed text-[#E5EDF5] outline-none placeholder:text-[#77879a] focus:border-[#00D5E8]/50 xl:h-80"
              />
              <div className="avs-editor-foot"><span>Tab — отступ · Shift+Tab — выход</span><span>Ctrl+S — сохранить</span></div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#202B38] pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copy(content, setCopied)}
                  className="nexus-button"
                >
                  {copied ? (
                    <Check size={14} className="text-[#00D5E8]" />
                  ) : (
                    <Copy size={14} className="text-[#00D5E8]" />
                  )}
                  {copied ? "Скопировано" : "Скопировать код"}
                </button>

                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSave()}
                  className="nexus-button"
                >
                  {saving ? (
                    <Loader2 size={14} className="animate-spin text-[#00D5E8]" />
                  ) : (
                    <Save size={14} className="text-[#00D5E8]" />
                  )}
                  Сохранить
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={asAdmin}
                  onClick={() => setAsAdmin((v) => !v)}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                    asAdmin
                      ? "border-amber-500/45 bg-amber-500/12 text-amber-300"
                      : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
                  }`}
                >
                  <Shield size={13} className={asAdmin ? "text-amber-300" : "text-[#526170]"} />
                  От имени Администратора
                </button>

                <button
                  type="button"
                  disabled={running || scriptType === "text"}
                  onClick={() => void handleRun()}
                  className="nexus-button nexus-button--primary"
                >
                  {running ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Play size={14} />
                  )}
                  {running ? "Выполнение…" : "Запустить"}
                </button>
              </div>
            </div>
          </fieldset>

        </div>

          {(consoleResult !== null || running) && (() => {
            const status = runStatus(consoleResult, running);
            return (
              <section aria-label="Консоль сценария" className="nexus-panel avs-script-console min-w-0 overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#202B38] px-4 py-2.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                    <h3 className="text-sm font-semibold text-[#E5EDF5]">Консоль</h3>
                    <span className="min-w-0 truncate text-sm text-[#a0adbb]" title={executionTitle}>{executionTitle}</span>
                    <span role="status" className={`rounded border px-2 py-0.5 text-xs font-semibold ${status.className}`}>
                      {status.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={consoleResult === null}
                      onClick={() => consoleResult !== null && void copy(consoleResult.output, setOutputCopied)}
                      className="nexus-button"
                    >
                      {outputCopied ? "Скопировано" : "Копировать вывод"}
                    </button>
                    <button
                      type="button"
                      disabled={running}
                      aria-label="Скрыть консоль"
                      onClick={() => setConsoleResult(null)}
                      className="nexus-button"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
                {consoleResult !== null ? (
                  <pre tabIndex={0} aria-label="Вывод стандартных потоков" className="max-h-[45vh] overflow-auto bg-[#090e14] p-4 font-mono text-sm leading-relaxed whitespace-pre text-[#E5EDF5]">
                    {consoleResult.output || "Скрипт не вернул вывод."}
                  </pre>
                ) : (
                  <p className="px-4 py-3 text-sm text-[#a0adbb]">{saving ? "Сохраняем изменения перед запуском." : "Ожидаем вывод сценария."}</p>
                )}
              </section>
            );
          })()}
      </div>
    </motion.div>

      {confirmation && (
        <UtilityConfirmDialog
          title={confirmation.kind === "delete" ? "Удалить сохранённый скрипт?" : "Отбросить несохранённые изменения?"}
          confirmLabel={confirmation.kind === "delete" ? "Удалить скрипт" : "Отбросить изменения"}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            applyLibraryAction(confirmation);
            setConfirmation(null);
          }}
        >
          {confirmation.kind === "delete" ? (
            <p>Сценарий «{confirmation.script.title}» будет удалён из библиотеки.</p>
          ) : (
            <p>Вернитесь в редактор и сохраните сценарий «{title.trim() || "Без названия"}», чтобы продолжить работу над ним позже.</p>
          )}
        </UtilityConfirmDialog>
      )}
      <AnimatePresence>
        {archiveOpen && (
          <ArchiveCreatorModal open={archiveOpen} onClose={() => setArchiveOpen(false)} />
        )}
      </AnimatePresence>
    </>
  );
}
