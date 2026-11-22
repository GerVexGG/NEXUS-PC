import { useWorkspaceState } from "../../hooks/useWorkspaceState";
import { ModuleHeader } from "../ui/ModuleHeader";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Archive, Check, ChevronDown, Copy, FileText, FolderOpen, Image, Inbox, LaptopMinimal, Loader2, LockKeyholeOpen, Smartphone, Square, Wifi } from "lucide-react";
import { copyTextToClipboard, formatBytes } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

interface DropSessionInfo {
  is_running: boolean;
  local_ip: string;
  port: number;
  token: string;
  url: string;
  save_dir: string;
  qr_svg: string;
  transfer?: { filename: string; received_bytes: number; total_bytes: number; speed_bps: number } | null;
  session_files_count?: number;
  session_total_bytes?: number;
  max_file_bytes?: number;
  max_session_bytes?: number;
  max_session_files?: number;
  limit_reached_reason?: string | null;
}

interface DroppedFile {
  id: string;
  filename: string;
  size_bytes: number;
  received_at: string;
  path: string;
}

interface DroppedText {
  id: string;
  body: string;
  received_at: string;
}

type ServerAction = "start" | "stop";

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp"].includes(ext)) return Image;
  if (["zip", "rar", "7z", "tar", "gz", "bz2"].includes(ext)) return Archive;
  return FileText;
}

function TransportSecurity() {
  return (
    <details className="nexus-drop-security text-xs" onKeyDown={(event) => {
      if (event.key === "Escape" && event.currentTarget.open) {
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }
    }}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-amber-300/25 bg-amber-300/5 px-2.5 py-1.5 font-medium text-amber-200 [&::-webkit-details-marker]:hidden">
        <LockKeyholeOpen size={13} /> Без TLS <ChevronDown size={12} />
      </summary>
      <div className="nexus-drop-security__details">
        <strong>Открытый HTTP в локальной сети</strong>
        <p className="mt-1.5 leading-relaxed text-[var(--nexus-muted)]">
          Код доступа ограничивает подключение к сеансу. Файлы и текст передаются без шифрования. Используйте AURORA Drop в доверенной сети.
        </p>
      </div>
    </details>
  );
}

function CopyButton({ copied, label, onClick }: { copied: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="nexus-button shrink-0" title={label} aria-label={label}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function DropModule({ c }: { c: NexusController }) {
  const [session, setSession] = useState<DropSessionInfo | null>(null);
  const [files, setFiles] = useState<DroppedFile[]>([]);
  const [texts, setTexts] = useState<DroppedText[]>([]);
  const [view, setView] = useWorkspaceState<"files" | "texts">("drop.view", "files");
  const [action, setAction] = useState<ServerAction | null>(null);
  const [actionError, setActionError] = useState("");
  const [pollError, setPollError] = useState("");
  const [copied, setCopied] = useState("");
  const inFlight = useRef<Promise<void> | null>(null);
  const actionPending = useRef(false);
  const copyTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const pending = Promise.allSettled([
      invoke<DropSessionInfo>("get_drop_session"),
      invoke<DroppedFile[]>("get_drop_history"),
      invoke<DroppedText[]>("get_drop_texts"),
    ]).then(([current, history, notes]) => {
      if (current.status === "fulfilled") setSession(current.value);
      if (history.status === "fulfilled") setFiles(history.value);
      if (notes.status === "fulfilled") setTexts(notes.value);
      setPollError([current, history, notes].flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []).join(" · "));
    }).finally(() => {
      inFlight.current = null;
    });
    inFlight.current = pending;
    return pending;
  }, []);

  useEffect(() => {
    if (!c.windowVisible) return;
    const poll = () => {
      if (!actionPending.current) void refresh();
    };
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => window.clearInterval(timer);
  }, [refresh, c.windowVisible]);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  async function changeServer(next: ServerAction) {
    if (actionPending.current) return;
    actionPending.current = true;
    setAction(next);
    setActionError("");
    setCopied("");
    try {
      await inFlight.current;
      if (next === "start") {
        setSession(await invoke<DropSessionInfo>("start_drop_session"));
      } else {
        await invoke("stop_drop_session");
        setSession((last) => last && { ...last, is_running: false, token: "", url: "", qr_svg: "", transfer: null });
      }
      await refresh();
    } catch (err) {
      setActionError(String(err));
    } finally {
      actionPending.current = false;
      setAction(null);
    }
  }

  async function copy(value: string, key: string) {
    setActionError("");
    try {
      await copyTextToClipboard(value);
      setCopied(key);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(""), 1400);
    } catch (err) {
      setActionError(String(err));
    }
  }

  function openLocation(path?: string) {
    setActionError("");
    const result = path ? invoke("open_item_location", { path }) : invoke("open_drop_folder");
    void result.catch((err) => setActionError(String(err)));
  }

  const online = session?.is_running === true;
  const status = action === "start" ? "Запуск…" : action === "stop" ? "Остановка…" :
    online ? "Приём включён" : session ? "Приём выключен" : pollError ? "Статус недоступен" : "Проверка статуса…";
  const transfer = session?.transfer;
  const address = session?.url.split("#", 1)[0] || (session?.local_ip ? "http://" + session.local_ip + ":" + session.port : "");
  const errors = [...new Set([actionError, pollError].filter(Boolean))];
  const count = view === "files" ? files.length : texts.length;

  return (
    <div className="avs-module avs-drop space-y-4">
      <ModuleHeader module="drop" title="AURORA Drop" description="Принимайте файлы и текст со смартфона в той же локальной сети." />
      {errors.length > 0 && <div role="alert" className="nexus-message nexus-message--error"><AlertTriangle size={16} /> <div className="break-words">{errors.join(" · ")}</div></div>}
      <div className="nexus-drop-layout">
        <section className="nexus-panel avs-drop-receiver min-w-0" data-online={online}>
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--nexus-line)] px-4 py-3.5">
            <div>
              <h3 className="text-sm font-semibold">Точка подключения</h3>
              <p className="mt-1 flex items-center gap-2 text-xs text-[var(--nexus-muted)]" role="status">
                {action ? <Loader2 size={12} className="animate-spin" /> : <span className={online ? "nexus-dot nexus-dot--active" : "nexus-dot"} />}
                {status}{online && session.port > 0 ? " · порт " + session.port : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="nexus-eyebrow">LAN // HTTP</span>
              <TransportSecurity />
            </div>
          </header>
          {online ? (
            <div className="space-y-4 p-4">
              <div className="nexus-drop-pairing">
                {session.qr_svg && <div role="img" aria-label="QR-код адреса с кодом доступа" className="nexus-drop-qr" dangerouslySetInnerHTML={{ __html: session.qr_svg }} />}
                <div className="min-w-0 space-y-3">
                  <p className="text-sm leading-relaxed text-[var(--nexus-muted)]">
                    {session.qr_svg ? "Отсканируйте QR-код смартфоном или скопируйте ссылку для браузера." : "Скопируйте ссылку и откройте её в браузере смартфона."}
                  </p>
                  {address && <div>
                    <div className="mb-1 text-xs text-[var(--nexus-muted)]">Локальный адрес</div>
                    <div className="nexus-drop-value">
                      <code className="min-w-0 flex-1 select-text break-all text-xs text-[var(--nexus-accent)]">{address}</code>
                      {session.url && <CopyButton copied={copied === "url"} label="Копировать ссылку с кодом доступа" onClick={() => void copy(session.url, "url")} />}
                    </div>
                  </div>}
                  {session.token && <div>
                    <div className="mb-1 text-xs text-[var(--nexus-muted)]">Код доступа сеанса</div>
                    <div className="nexus-drop-value">
                      <code className="min-w-0 flex-1 select-text break-all text-xs">{session.token}</code>
                      <CopyButton copied={copied === "token"} label="Копировать код доступа" onClick={() => void copy(session.token, "token")} />
                    </div>
                  </div>}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--nexus-line)] pt-3">
                <button type="button" className="nexus-button nexus-button--danger" disabled={action !== null} onClick={() => void changeServer("stop")}>
                  {action === "stop" ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} />} Остановить приём
                </button>
                {!!session.max_file_bytes && !!session.max_session_bytes && <span className="text-xs text-[var(--nexus-muted)]">{formatBytes(session.max_file_bytes)} на файл · {formatBytes(session.max_session_bytes)} за сеанс</span>}
              </div>
              {session.limit_reached_reason && <div role="status" className="nexus-message nexus-message--warning"><AlertTriangle size={16} /> {session.limit_reached_reason}</div>}
            </div>
          ) : (
            <div className="avs-drop-station">
              <div className="avs-drop-devices" aria-hidden="true"><LaptopMinimal size={43} strokeWidth={1.35} /><i /><Smartphone size={30} strokeWidth={1.5} /></div>
              <h4>Подключите смартфон</h4>
              <p className="max-w-sm text-sm leading-relaxed text-[var(--nexus-muted)]">Включите приём, чтобы получить ссылку и QR-код для отправки со смартфона.</p>
                <button className="nexus-button nexus-button--primary" type="button" disabled={!session || action !== null} onClick={() => void changeServer("start")}>
                  {action === "start" ? <Loader2 size={15} className="animate-spin" /> : <Wifi size={15} />} Включить приём
                </button>
            </div>
          )}
        </section>

        <section className="nexus-panel avs-drop-history min-w-0">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--nexus-line)] px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold">Журнал приёма</h3>
              {online && typeof session.session_files_count === "number" && typeof session.max_session_files === "number" && <p className="mt-1 text-xs tabular-nums text-[var(--nexus-muted)]">
                За сеанс {session.session_files_count} из {session.max_session_files} файлов
                {typeof session.session_total_bytes === "number" ? " · " + formatBytes(session.session_total_bytes) : ""}
              </p>}
            </div>
            <button type="button" className="nexus-button" onClick={() => openLocation()}><FolderOpen size={14} /> Папка приёма</button>
          </header>
          {transfer && <div className="space-y-2 border-b border-[var(--nexus-line)] px-4 py-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate" title={transfer.filename}>Приём · {transfer.filename || "Файл"}</span>
              <span className="shrink-0 font-mono text-[var(--nexus-accent)]">{formatBytes(transfer.speed_bps)}/с</span>
            </div>
            {transfer.total_bytes > 0 && <progress className="nexus-progress" aria-label="Получено байт" value={Math.min(transfer.received_bytes, transfer.total_bytes)} max={transfer.total_bytes} />}
          </div>}
          <div role="group" aria-label="Тип принятых данных" className="avs-workspace-tabs mx-3 mt-3">
            <button type="button" aria-pressed={view === "files"} onClick={() => setView("files")}>Файлы <span>{files.length}</span></button>
            <button type="button" aria-pressed={view === "texts"} onClick={() => setView("texts")}>Текст <span>{texts.length}</span></button>
          </div>
          <div className="nexus-drop-log">
            {!session || !count ? (
              <div className="nexus-empty">
                <Inbox size={22} />
                <strong>{!session ? pollError ? "Журнал недоступен" : "Получаем журнал…" : view === "files" ? "Файлов пока нет" : "Текстовых заметок пока нет"}</strong>
                {session && <span>{online ? "Отправьте данные со страницы AURORA Drop на смартфоне." : "Включите приём, чтобы подключить смартфон."}</span>}
              </div>
            ) : view === "files" ? (
              <ul className="divide-y divide-[var(--nexus-line)]">
                {files.map((file) => {
                  const Icon = fileIcon(file.filename);
                  return <li key={file.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Icon size={17} className="shrink-0 text-[var(--nexus-accent)]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium" title={file.filename}>{file.filename}</div>
                      <div className="mt-0.5 text-xs tabular-nums text-[var(--nexus-muted)]">{formatBytes(file.size_bytes)} · {file.received_at}</div>
                    </div>
                    <button className="nexus-button shrink-0" type="button" title="Показать файл в Проводнике" aria-label={"Показать в Проводнике " + file.filename} disabled={!file.path} onClick={() => openLocation(file.path)}><FolderOpen size={14} /></button>
                  </li>;
                })}
              </ul>
            ) : (
              <ul className="divide-y divide-[var(--nexus-line)]">
                {texts.map((item) => <li key={item.id} className="flex items-start gap-3 px-4 py-2.5">
                  <FileText size={16} className="mt-1 shrink-0 text-[var(--nexus-accent)]" />
                  <div className="min-w-0 flex-1">
                    <div className="select-text whitespace-pre-wrap [overflow-wrap:anywhere] text-sm">{item.body}</div>
                    <div className="mt-1 text-xs tabular-nums text-[var(--nexus-muted)]">{item.received_at}</div>
                  </div>
                  <CopyButton copied={copied === item.id} label="Копировать текст" onClick={() => void copy(item.body, item.id)} />
                </li>)}
              </ul>
            )}
          </div>
          {session?.save_dir && <div className="truncate border-t border-[var(--nexus-line)] px-4 py-2.5 text-xs text-[var(--nexus-muted)]" title={session.save_dir}>{session.save_dir}</div>}
        </section>
      </div>
      <div className="sr-only" role="status">{copied ? "Скопировано" : ""}</div>
    </div>
  );
}
