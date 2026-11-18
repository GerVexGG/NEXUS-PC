import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
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
import { PageHeader, copyTextToClipboard } from "../../lib/studio";
import { ArchiveCreatorModal } from "../modals/ArchiveCreatorModal";

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
    placeholder: 'WScript.Echo "NEXUS VBScript Engine Ready"',
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
  const [savedToast, setSavedToast] = useState<boolean>(false);

  const [consoleOutput, setConsoleOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState<boolean>(false);

  const selectScript = useCallback((script: UserScript) => {
    setSelectedId(script.id);
    setTitle(script.title);
    setScriptType((script.script_type as ScriptKind) || "powershell");
    setContent(script.content);
    setDirty(false);
    setError(null);
  }, []);

  const loadScripts = useCallback(
    async (preferId?: string) => {
      setLoading(true);
      try {
        const list = await invoke<UserScript[]>("get_user_scripts");
        setScripts(list);
        if (list.length > 0) {
          const target = (preferId && list.find((s) => s.id === preferId)) || list[0];
          selectScript(target);
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
    setScripts((prev) => [fresh, ...prev]);
    selectScript(fresh);
    setDirty(true);
    setConsoleOutput(null);
  };

  const handleSave = useCallback(async (): Promise<string | null> => {
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
      const refreshed = await invoke<UserScript[]>("get_user_scripts");
      setScripts(refreshed);
      setDirty(false);
      setSavedToast(true);
      window.setTimeout(() => setSavedToast(false), 1800);
      return updated.id;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [selectedId, title, scriptType, content]);

  const handleDelete = async (id: string) => {
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
    }
  };

  const handleCopyContent = async () => {
    await copyTextToClipboard(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const handleRun = async () => {
    if (!selectedId) return;
    setError(null);
    let targetId: string | null = selectedId;
    if (dirty || !scripts.some((s) => s.id === selectedId)) {
      targetId = await handleSave();
      if (!targetId) return;
    }
    setRunning(true);
    setConsoleOutput("Исполнение сценария…");
    try {
      const result = await invoke<string>("run_user_script", {
        id: targetId,
        asAdmin,
      });
      setConsoleOutput(result);
    } catch (err) {
      setConsoleOutput(`[ОШИБКА]\n${String(err)}`);
    } finally {
      setRunning(false);
    }
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void handleSave();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const target = event.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const next = `${content.slice(0, start)}  ${content.slice(end)}`;
      setContent(next);
      setDirty(true);
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
        className="w-full space-y-4"
      >
        <PageHeader
          title="Скрипты и автоматизация"
          description="Локальная библиотека, редактор и выполнение сценариев PowerShell, Batch и VBScript"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setArchiveOpen(true)}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[#202B38] bg-[#10151D] px-3.5 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-[#E5EDF5] transition-colors hover:border-[#00D5E8]/45 hover:text-[#00D5E8]"
              >
                <FolderArchive size={14} className="text-[#00D5E8]" />
                Создать архив
              </button>
              <button
                type="button"
                onClick={handleCreateNew}
                className="cyber-btn inline-flex cursor-pointer items-center gap-2 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-[#00D5E8]"
              >
                <Plus size={14} />
                Новый скрипт
              </button>
            </div>
          }
        />

      {error && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/12 px-4 py-2.5 text-xs text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Левая колонка: Библиотека скриптов */}
        <div className="tactical-card tactical-brackets flex flex-col rounded-xl p-4 lg:col-span-4">
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
              className="w-full rounded-lg border border-[#202B38] bg-[#0B0E14] py-2 pl-9 pr-3 text-xs text-[#E5EDF5] outline-none placeholder:text-[#526170] focus:border-[#00D5E8]/50"
            />
          </div>

          <div className="max-h-[calc(100vh-280px)] min-h-[340px] flex-1 space-y-2 overflow-y-auto pr-1">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 font-mono text-xs text-[#8292A3]">
                <Loader2 size={14} className="animate-spin text-[#00D5E8]" />
                Загрузка библиотеки…
              </div>
            ) : filteredScripts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <FileCode size={24} className="mb-2 text-[#526170]" />
                <div className="text-xs text-[#8292A3]">Скрипты не найдены</div>
              </div>
            ) : (
              filteredScripts.map((item) => {
                const active = item.id === selectedId;
                const meta = getTypeMeta(item.script_type);
                return (
                  <div
                    key={item.id}
                    onClick={() => selectScript(item)}
                    className={`group relative flex cursor-pointer items-start justify-between gap-2 rounded-lg border p-3 transition-all ${
                      active
                        ? "border-[#00D5E8]/45 bg-[#00D5E8]/10"
                        : "border-[#202B38] bg-[#0B0E14] hover:border-[#202B38] hover:bg-[#151C26]"
                    }`}
                  >
                    {active && (
                      <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-[#00D5E8]" />
                    )}
                    <div className="min-w-0 flex-1 pl-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${meta.badgeClass}`}
                        >
                          {meta.badge}
                        </span>
                        <span className="truncate text-sm font-medium text-[#E5EDF5]">
                          {item.title}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-[#526170]">
                        <span>Изменён: {formatUpdatedDate(item.updated_at)}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      title="Удалить скрипт"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDelete(item.id);
                      }}
                      className="cursor-pointer rounded p-1 text-[#526170] opacity-0 transition-opacity hover:bg-rose-500/15 hover:text-rose-300 group-hover:opacity-100"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Правая колонка: Редактор и Консоль */}
        <div className="flex flex-col gap-4 lg:col-span-8">
          <div className="tactical-card tactical-brackets flex flex-col gap-3.5 rounded-xl p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <label className="mb-1 block text-xs font-medium text-[#8292A3]">
                  Название сценария
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setDirty(true);
                  }}
                  placeholder="Введите название сценария…"
                  className="w-full rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2 text-sm font-medium text-[#E5EDF5] outline-none placeholder:text-[#526170] focus:border-[#00D5E8]/50"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[#8292A3]">
                  Интерпретатор
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {SCRIPT_TYPES.map((t) => {
                    const active = scriptType === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setScriptType(t.id);
                          setDirty(true);
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
              <div className="mb-1.5 flex items-center justify-between font-mono text-[11px] text-[#8292A3]">
                <span className="flex items-center gap-1.5">
                  <Terminal size={12} className="text-[#00D5E8]" />
                  {currentTypeMeta.label}
                  {dirty && <span className="text-amber-300">· Изменено</span>}
                  {savedToast && <span className="text-[#00D5E8]">· Сохранено</span>}
                </span>
                <span className="text-[#526170]">Tab — отступ · Ctrl+S — сохранить</span>
              </div>

              <textarea
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  setDirty(true);
                }}
                onKeyDown={handleEditorKeyDown}
                spellCheck={false}
                placeholder={currentTypeMeta.placeholder}
                className="h-64 w-full resize-y rounded-xl border border-[#202B38] bg-[#07080B] p-3.5 font-mono text-sm leading-relaxed text-[#E5EDF5] outline-none placeholder:text-[#526170] focus:border-[#00D5E8]/50 xl:h-80"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#202B38] pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyContent()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2 text-xs font-medium text-[#E5EDF5] transition-colors hover:border-[#00D5E8]/40"
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
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2 text-xs font-medium text-[#E5EDF5] transition-colors hover:border-[#00D5E8]/40 disabled:opacity-60"
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
                  className="cyber-btn inline-flex cursor-pointer items-center gap-2 px-5 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-[#00D5E8] disabled:opacity-45"
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
          </div>

          {consoleOutput !== null && (() => {
            const isTimeout = consoleOutput.includes("[TIMEOUT]");
            const exitMatch = consoleOutput.match(/Код выхода:\s*(-?\d+)/) ?? consoleOutput.match(/\[EXIT CODE\s+(-?\d+)\]/);
            const exitCode = exitMatch ? Number(exitMatch[1]) : null;
            const isError =
              isTimeout ||
              consoleOutput.startsWith("[ОШИБКА]") ||
              consoleOutput.includes("[ОШИБКА ·") ||
              (exitCode !== null && exitCode !== 0);
            const statusLabel = running
              ? "ВЫПОЛНЕНИЕ…"
              : isTimeout
              ? "ТАЙМАУТ (60с)"
              : isError
              ? exitCode !== null
                ? `ОШИБКА · КОД ${exitCode}`
                : "ОШИБКА"
              : exitCode === 0
              ? "ЗАВЕРШЕНО · КОД 0"
              : consoleOutput.includes("[INFO]")
              ? "ИНФО"
              : "ВЫПОЛНЕНО";
            const statusBadgeClass = running
              ? "border-[#00D5E8]/35 bg-[#00D5E8]/10 text-[#00D5E8]"
              : isTimeout || isError
              ? "border-rose-500/35 bg-rose-500/12 text-rose-300"
              : "border-emerald-500/35 bg-emerald-500/12 text-emerald-300";
            return (
              <div className="tactical-card tactical-brackets overflow-hidden rounded-xl">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#202B38] bg-[#0B0E14] px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="font-mono text-xs font-semibold text-[#00D5E8]">
                      ВЫВОД ТЕРМИНАЛА (STDOUT / STDERR)
                    </span>
                    <span className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${statusBadgeClass}`}>
                      {statusLabel}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void copyTextToClipboard(consoleOutput)}
                      className="cursor-pointer rounded border border-[#202B38] bg-[#10151D] px-2 py-0.5 font-mono text-[10px] text-[#8292A3] hover:border-[#00D5E8]/40 hover:text-[#00D5E8]"
                    >
                      Копировать вывод
                    </button>
                    <button
                      type="button"
                      onClick={() => setConsoleOutput(null)}
                      className="cursor-pointer rounded p-1 text-[#8292A3] hover:text-[#E5EDF5]"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
                <pre className="max-h-60 overflow-auto bg-[#07080B] p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[#E5EDF5]">
                  {consoleOutput}
                </pre>
              </div>
            );
          })()}
        </div>
      </div>
    </motion.div>

      <AnimatePresence>
        {archiveOpen && (
          <ArchiveCreatorModal open={archiveOpen} onClose={() => setArchiveOpen(false)} />
        )}
      </AnimatePresence>
    </>
  );
}
