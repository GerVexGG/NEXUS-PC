import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { Archive, Copy, FileText, FolderOpen, Image, Smartphone, Square } from "lucide-react";
import { copyTextToClipboard, formatBytes } from "../../lib/studio";

interface DropTransfer {
  filename: string;
  received_bytes: number;
  total_bytes: number;
  speed_bps: number;
}

interface DropSessionInfo {
  is_running: boolean;
  local_ip: string;
  port: number;
  token: string;
  url: string;
  save_dir: string;
  qr_svg: string;
  transfer?: DropTransfer | null;
}

interface DroppedFileItem {
  id: string;
  filename: string;
  size_bytes: number;
  received_at: string;
  status: string;
  path: string;
}

interface DropTextItem {
  id: string;
  body: string;
  received_at: string;
}

const idleSession: DropSessionInfo = {
  is_running: false,
  local_ip: "",
  port: 0,
  token: "",
  url: "",
  save_dir: "",
  qr_svg: "",
  transfer: null,
};

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp"].includes(ext)) return Image;
  if (["zip", "rar", "7z", "tar", "gz", "bz2"].includes(ext)) return Archive;
  return FileText;
}

function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0 MB/s";
  const mb = bps / (1024 * 1024);
  if (mb >= 0.1) return `${mb.toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}

export function DropModule() {
  const [session, setSession] = useState<DropSessionInfo>(idleSession);
  const [files, setFiles] = useState<DroppedFileItem[]>([]);
  const [texts, setTexts] = useState<DropTextItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const nextSession = await invoke<DropSessionInfo>("get_drop_session");
      const nextFiles = await invoke<DroppedFileItem[]>("get_drop_history");
      const nextTexts = await invoke<DropTextItem[]>("get_drop_texts");
      setSession(nextSession);
      setFiles(nextFiles);
      setTexts(nextTexts);
    } catch (err) {
      setError(String(err));
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await invoke<DropSessionInfo>("start_drop_session");
      setSession(next);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError("");
    try {
      await invoke("stop_drop_session");
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyValue = async (value: string, key: string) => {
    await copyTextToClipboard(value);
    setCopied(key);
    window.setTimeout(() => setCopied(""), 1400);
  };

  const transfer = session.transfer;
  const progress =
    transfer && transfer.total_bytes > 0
      ? Math.min(100, Math.max(0, (transfer.received_bytes / transfer.total_bytes) * 100))
      : 0;

  return (
    <motion.div
      key="drop"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="w-full max-w-6xl space-y-4"
    >
      <div className="flex flex-col justify-between gap-4 border-b border-[#222b38] pb-3.5 lg:flex-row lg:items-end">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-100">NEXUS Drop</h2>
          <p className="mt-0.5 text-sm text-slate-400">Локальная передача файлов без интернета и проводов</p>
        </div>
        {session.is_running ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Сервер активен
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void stop()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#222b38] bg-[#111722] px-3 py-1.5 text-xs text-slate-300 hover:text-slate-100 disabled:opacity-50"
            >
              <Square size={12} />
              Остановить
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void start()}
            className="inline-flex items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/20 px-3 py-2 text-xs font-medium text-sky-300 hover:bg-sky-500/30 disabled:opacity-50"
          >
            <Smartphone size={14} />
            Запустить сервер
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card-cyber-hover rounded-xl border border-[#222b38] bg-[#111722] p-4">
          <h3 className="text-sm font-semibold text-slate-100">Точка подключения</h3>
          <div className="mt-3 w-fit rounded-lg bg-white p-2.5">
            {session.is_running && session.qr_svg ? (
              <div
                className="h-44 w-44 [&_svg]:h-full [&_svg]:w-full"
                dangerouslySetInnerHTML={{ __html: session.qr_svg }}
              />
            ) : (
              <div className="flex h-44 w-44 items-center justify-center text-slate-400">
                <Smartphone size={28} />
              </div>
            )}
          </div>
          {session.is_running && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 font-mono text-xs text-slate-200">
                  {session.url || `http://${session.local_ip}:${session.port}`}
                </code>
                <button
                  type="button"
                  onClick={() => void copyValue(session.url, "url")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#222b38] bg-[#151c27] px-2.5 py-2 text-xs text-slate-200"
                >
                  <Copy size={12} />
                  {copied === "url" ? "Скопировано" : "Копировать"}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">PIN</span>
                <span className="font-mono text-sm tracking-[0.18em] text-sky-300">{session.token}</span>
                <button
                  type="button"
                  onClick={() => void copyValue(session.token, "token")}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#222b38] px-2 py-1 text-[11px] text-slate-300"
                >
                  <Copy size={11} />
                  {copied === "token" ? "Скопировано" : "Копировать"}
                </button>
              </div>
            </div>
          )}
          <ol className="mt-4 space-y-1 text-sm text-slate-400">
            <li>1. Подключите телефон к тому же Wi-Fi.</li>
            <li>2. Отсканируйте код камерой.</li>
          </ol>
        </div>

        <div className="card-cyber-hover flex min-h-[320px] flex-col rounded-xl border border-[#222b38] bg-[#111722]">
          <div className="flex items-center justify-between gap-2 border-b border-[#222b38] px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-100">История приёма</h3>
            <button
              type="button"
              onClick={() => void invoke("open_drop_folder").catch((err) => setError(String(err)))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#222b38] bg-[#151c27] px-2.5 py-1.5 text-xs text-slate-200"
            >
              <FolderOpen size={12} />
              Открыть папку загрузок
            </button>
          </div>
          {transfer && (
            <div className="border-b border-[#222b38] px-4 py-3">
              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-slate-300">
                <span className="truncate">{transfer.filename || "Входящий файл"}</span>
                <span className="shrink-0 font-mono text-cyan-400">{formatSpeed(transfer.speed_bps)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[#151c27]">
                <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
          {files.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center text-sm text-slate-400">
              <Smartphone size={22} />
              Ожидание отправки со смартфона
            </div>
          ) : (
            <div className="divide-y divide-[#222b38]/50">
              {files.map((file) => {
                const Icon = fileIcon(file.filename);
                return (
                  <div key={file.id} className="flex items-center gap-3 px-4 py-3">
                    <Icon size={16} className="shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-slate-100">{file.filename}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                        <span className="font-mono text-cyan-400">{formatBytes(file.size_bytes)}</span>
                        <span>{file.received_at}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!file.path}
                      onClick={() =>
                        void invoke("open_item_location", { path: file.path }).catch((err) => setError(String(err)))
                      }
                      className="shrink-0 rounded-lg border border-[#222b38] bg-[#151c27] px-2.5 py-1.5 text-[11px] text-slate-200 disabled:opacity-40"
                    >
                      Показать в проводнике
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {texts.length > 0 && (
            <div className="border-t border-[#222b38] px-4 py-3">
              <div className="mb-2 text-xs text-slate-400">Текст и ссылки</div>
              <div className="space-y-2">
                {texts.map((item) => (
                  <div key={item.id} className="flex items-start gap-2 rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[10px] text-slate-500">{item.received_at}</div>
                      <div className="text-sm break-all text-slate-100">{item.body}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyValue(item.body, item.id)}
                      className="shrink-0 text-[11px] text-slate-300"
                    >
                      {copied === item.id ? "Скопировано" : "Копировать"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
