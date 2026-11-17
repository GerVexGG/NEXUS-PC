import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Archive,
  Copy,
  FileText,
  FolderOpen,
  Image,
  Loader2,
  QrCode,
  ShieldCheck,
  Smartphone,
  Square,
  Wifi,
} from "lucide-react";
import { PageHeader, copyTextToClipboard, formatBytes } from "../../lib/studio";

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
  if (!Number.isFinite(bps) || bps <= 0) return "0 МБ/с";
  const mb = bps / (1024 * 1024);
  if (mb >= 0.1) return `${mb.toFixed(1)} МБ/с`;
  return `${(bps / 1024).toFixed(0)} КБ/с`;
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
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="w-full space-y-4"
    >
      <PageHeader
        title="NEXUS Drop"
        description="Локальный обмен файлами и буфером обмена между смартфоном и ПК по сети Wi-Fi без облачных сервисов"
        badge={
          session.is_running ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-[#00D5E8]/35 bg-[#00D5E8]/12 px-2.5 py-0.5 font-mono text-xs font-semibold text-[#00D5E8]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#00D5E8] shadow-[0_0_6px_rgba(0,213,232,0.85)]" />
              СЕРВЕР АКТИВЕН · :{session.port}
            </span>
          ) : busy ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/35 bg-amber-500/12 px-2.5 py-0.5 font-mono text-xs font-semibold text-amber-300">
              <Loader2 size={12} className="animate-spin" />
              ЗАПУСК СЕРВЕРА…
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-[#202B38] bg-[#151C26] px-2.5 py-0.5 font-mono text-xs text-[#8292A3]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#526170]" />
              СЕРВЕР ОСТАНОВЛЕН
            </span>
          )
        }
        actions={
          session.is_running ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void stop()}
              className="cyber-btn-danger inline-flex cursor-pointer items-center gap-2 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-rose-300 disabled:opacity-50"
            >
              <Square size={12} className="fill-current" />
              Остановить сервер
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void start()}
              className="cyber-btn inline-flex cursor-pointer items-center gap-2 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-[#00D5E8] disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Wifi size={14} />}
              {busy ? "Инициализация…" : "Запустить сервер"}
            </button>
          )
        }
      />

      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-rose-500/35 bg-rose-500/12 px-4 py-3 text-xs text-rose-300">
          <AlertTriangle size={16} className="shrink-0 text-rose-400" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Левая колонка: Терминал подключения */}
        <div className="tactical-card tactical-brackets flex flex-col justify-between rounded-xl p-5 lg:col-span-6">
          <div>
            <div className="flex items-center justify-between border-b border-[#202B38] pb-3">
              <div>
                <h3 className="text-sm font-semibold text-[#E5EDF5]">Точка подключения</h3>
                <p className="text-xs text-[#8292A3]">
                  {session.is_running
                    ? "Отсканируйте QR-код камерой смартфона или откройте адрес в браузере"
                    : "Запустите локальный узел для генерации одноразового токена и QR-кода"}
                </p>
              </div>
              <span className="rounded border border-[#202B38] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] text-[#00D5E8]">
                LAN // HTTP
              </span>
            </div>

            {session.is_running && session.qr_svg ? (
              <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
                <div className="shrink-0 rounded-xl border border-[#00D5E8]/40 bg-[#0B0E14] p-2.5 shadow-[0_0_20px_rgba(0,213,232,0.12)]">
                  <div
                    className="h-44 w-44 rounded-lg bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: session.qr_svg }}
                  />
                </div>

                <div className="min-w-0 flex-1 space-y-3 w-full">
                  <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] p-3">
                    <div className="text-[11px] text-[#8292A3]">Локальный адрес узла</div>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate font-mono text-xs text-[#00D5E8]">
                        {session.url || `http://${session.local_ip}:${session.port}`}
                      </code>
                      <button
                        type="button"
                        onClick={() => void copyValue(session.url, "url")}
                        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-[#202B38] bg-[#151C26] px-2 py-1 text-[11px] text-[#E5EDF5] hover:border-[#00D5E8]/40"
                      >
                        <Copy size={11} />
                        {copied === "url" ? "Скопировано" : "Копия"}
                      </button>
                    </div>
                  </div>

                  <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[11px] text-[#8292A3]">Код доступа (PIN-токен)</div>
                        <div className="mt-0.5 font-mono text-lg font-bold tracking-[0.22em] text-[#E5EDF5]">
                          {session.token}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void copyValue(session.token, "token")}
                        className="inline-flex cursor-pointer items-center gap-1 rounded border border-[#202B38] bg-[#151C26] px-2.5 py-1.5 text-[11px] text-[#E5EDF5] hover:border-[#00D5E8]/40"
                      >
                        <Copy size={11} />
                        {copied === "token" ? "Скопировано" : "Копировать"}
                      </button>
                    </div>
                  </div>

                  {session.save_dir && (
                    <div className="truncate font-mono text-[11px] text-[#526170]" title={session.save_dir}>
                      Каталог приёма: <span className="text-[#8292A3]">{session.save_dir}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* Полноценное техническое состояние, когда сервер выключен (без пустых белых блоков) */
              <div className="mt-4 rounded-xl border border-[#202B38] bg-[#0B0E14] p-5">
                <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
                  <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-[#202B38] bg-[#10151D] text-[#00D5E8]">
                    {busy ? <Loader2 size={28} className="animate-spin" /> : <QrCode size={30} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                      <span className="text-sm font-semibold text-[#E5EDF5]">
                        {busy ? "Запуск локального приёмника…" : "Локальный сервер ожидает запуска"}
                      </span>
                      <span className="rounded border border-[#202B38] bg-[#151C26] px-2 py-0.5 font-mono text-[10px] text-[#8292A3]">
                        OFFLINE
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-[#8292A3]">
                      При запуске NEXUS Drop поднимает изолированный HTTP-узел в вашей домашней сети Wi-Fi и генерирует одноразовый QR-код для мгновенной отправки фотографий, архивов и текста со смартфона.
                    </p>
                    <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void start()}
                        className="cyber-btn inline-flex cursor-pointer items-center gap-2 px-4 py-2 font-mono text-xs font-semibold text-[#00D5E8] disabled:opacity-50"
                      >
                        <Wifi size={14} />
                        Активировать точку приёма
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Нижние карточки протокола работы */}
          <div className="mt-4 grid grid-cols-3 gap-2.5 pt-2">
            <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] p-2.5">
              <div className="font-mono text-[10px] text-[#00D5E8]">ШАГ 01</div>
              <div className="mt-0.5 text-xs font-medium text-[#E5EDF5]">Одна сеть Wi-Fi</div>
              <div className="mt-0.5 text-[11px] text-[#8292A3]">Смартфон и ПК в одной LAN</div>
            </div>
            <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] p-2.5">
              <div className="font-mono text-[10px] text-[#00D5E8]">ШАГ 02</div>
              <div className="mt-0.5 text-xs font-medium text-[#E5EDF5]">Камера / QR</div>
              <div className="mt-0.5 text-[11px] text-[#8292A3]">Авторизация по PIN-токену</div>
            </div>
            <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] p-2.5">
              <div className="font-mono text-[10px] text-[#00D5E8]">ШАГ 03</div>
              <div className="mt-0.5 text-xs font-medium text-[#E5EDF5]">Прямой приём</div>
              <div className="mt-0.5 text-[11px] text-[#8292A3]">Без сжатия и ограничений</div>
            </div>
          </div>
        </div>

        {/* Правая колонка: Журнал принятых файлов и текста */}
        <div className="tactical-card tactical-brackets flex min-h-[360px] flex-col rounded-xl lg:col-span-6">
          <div className="flex items-center justify-between gap-2 border-b border-[#202B38] px-5 py-3.5">
            <div className="flex items-center gap-2">
              <ShieldCheck size={15} className="text-[#00D5E8]" />
              <h3 className="text-sm font-semibold text-[#E5EDF5]">Журнал принятых данных</h3>
              <span className="rounded border border-[#202B38] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] text-[#8292A3]">
                {files.length} файл.
              </span>
            </div>
            <button
              type="button"
              onClick={() => void invoke("open_drop_folder").catch((err) => setError(String(err)))}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-1.5 text-xs font-medium text-[#E5EDF5] transition-colors hover:border-[#00D5E8]/40"
            >
              <FolderOpen size={13} className="text-[#00D5E8]" />
              Папка приёма
            </button>
          </div>

          {transfer && (
            <div className="border-b border-[#202B38] bg-[#0B0E14] px-5 py-3">
              <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-medium text-[#E5EDF5]">
                  Приём: {transfer.filename || "Входящий поток"}
                </span>
                <span className="shrink-0 font-mono font-semibold text-[#00D5E8]">
                  {formatSpeed(transfer.speed_bps)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[#151C26]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#00D5E8] to-[#36AFC0] transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {files.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#202B38] bg-[#0B0E14] text-[#526170]">
                <Smartphone size={20} />
              </div>
              <div className="text-sm font-medium text-[#E5EDF5]">Список принятых файлов пуст</div>
              <p className="max-w-xs text-xs text-[#8292A3]">
                Отправленные со смартфона файлы и заметки автоматически появятся в этом списке.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[#202B38]/60 overflow-y-auto">
              {files.map((file) => {
                const Icon = fileIcon(file.filename);
                return (
                  <div
                    key={file.id}
                    className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-[#151C26]/50"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#202B38] bg-[#0B0E14] text-[#00D5E8]">
                      <Icon size={15} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-[#E5EDF5]">{file.filename}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[#8292A3]">
                        <span className="font-mono font-semibold text-[#00D5E8]">
                          {formatBytes(file.size_bytes)}
                        </span>
                        <span>·</span>
                        <span className="font-mono">{file.received_at}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!file.path}
                      onClick={() =>
                        void invoke("open_item_location", { path: file.path }).catch((err) =>
                          setError(String(err))
                        )
                      }
                      className="shrink-0 cursor-pointer rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-1.5 text-xs font-medium text-[#8292A3] transition-colors hover:border-[#00D5E8]/40 hover:text-[#E5EDF5] disabled:opacity-40"
                    >
                      В проводнике
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {texts.length > 0 && (
            <div className="border-t border-[#202B38] bg-[#0B0E14]/60 px-5 py-3.5">
              <div className="mb-2 text-xs font-medium text-[#8292A3]">Принятые текстовые заметки и ссылки</div>
              <div className="space-y-2">
                {texts.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-2 rounded-lg border border-[#202B38] bg-[#10151D] px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[10px] text-[#526170]">{item.received_at}</div>
                      <div className="mt-0.5 text-xs break-all text-[#E5EDF5]">{item.body}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyValue(item.body, item.id)}
                      className="shrink-0 cursor-pointer rounded border border-[#202B38] bg-[#151C26] px-2 py-1 text-[11px] text-[#00D5E8]"
                    >
                      {copied === item.id ? "Скопировано" : "Копия"}
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
