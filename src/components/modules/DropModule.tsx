import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { Copy, FolderOpen, Smartphone, Square } from "lucide-react";
import { copyTextToClipboard, formatBytes } from "../../lib/studio";

interface DropSessionInfo {
  is_running: boolean;
  local_ip: string;
  port: number;
  token: string;
  url: string;
  save_dir: string;
  qr_svg: string;
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
};

export function DropModule() {
  const [session, setSession] = useState<DropSessionInfo>(idleSession);
  const [files, setFiles] = useState<DroppedFileItem[]>([]);
  const [texts, setTexts] = useState<DropTextItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [nextSession, nextFiles, nextTexts] = await Promise.all([
        invoke<DropSessionInfo>("get_drop_session"),
        invoke<DroppedFileItem[]>("get_drop_history"),
        invoke<DropTextItem[]>("get_drop_texts"),
      ]);
      setSession(nextSession);
      setFiles(nextFiles);
      setTexts(nextTexts);
    } catch (err) {
      setError(String(err));
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

  return (
    <motion.div
      key="drop"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="space-y-4 max-w-6xl w-full"
    >
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-[#222b38] pb-3.5">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-100">Защищённая передача</h2>
          <p className="mt-0.5 text-sm text-slate-400">
            Файлы, фото и ссылки со смартфона на этот компьютер по Wi-Fi
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`px-2.5 py-1.5 rounded-lg border font-mono text-[11px] tracking-wide ${
              session.is_running
                ? "bg-sky-500/15 text-sky-300 border-sky-500/35"
                : "bg-[#151c27] text-[#8793a5] border-[#222b38]"
            }`}
          >
            {session.is_running ? "СЕССИЯ АКТИВНА" : "ОЖИДАНИЕ ЗАПУСКА"}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void (session.is_running ? stop() : start())}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sky-500/35 bg-sky-500/15 text-sky-300 font-mono text-[11px] cursor-pointer disabled:opacity-50"
          >
            {session.is_running ? <Square size={12} /> : <Smartphone size={12} />}
            {session.is_running ? "Остановить" : "Запустить прием"}
          </button>
          <button
            type="button"
            onClick={() => void invoke("open_drop_folder").catch((err) => setError(String(err)))}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#222b38] bg-[#151c27] text-[#e8edf4] font-mono text-[11px] cursor-pointer"
          >
            <FolderOpen size={12} />
            Открыть папку загрузок
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-mono text-rose-300">
          {error}
        </div>
      )}

      {session.is_running ? (
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
          <div className="rounded-2xl border border-[#222b38] bg-[#111722] p-3">
            <div
              className="aspect-square rounded-xl overflow-hidden border border-[#222b38] bg-[#111722] [&_svg]:h-full [&_svg]:w-full"
              dangerouslySetInnerHTML={{ __html: session.qr_svg }}
            />
          </div>
          <div className="rounded-2xl border border-[#222b38] bg-[#111722] p-4 flex flex-col justify-between gap-4">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[#8793a5] mb-2">
                Подключение в локальной сети
              </div>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <span className="px-2.5 py-1 rounded-lg bg-[#151c27] border border-[#222b38] font-mono text-sm text-[#e8edf4]">
                  {session.local_ip}:{session.port}
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-sky-500/15 border border-sky-500/35 font-mono text-sm text-sky-300 tracking-[0.18em]">
                  {session.token}
                </span>
              </div>
              <p className="text-sm text-[#8793a5] leading-relaxed max-w-xl">
                Наведите камеру смартфона на QR-код для моментальной отправки фото, файлов или ссылок без проводов.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 text-[11px] font-mono text-[#d5dde8]">
                {session.url}
              </code>
              <button
                type="button"
                onClick={() => void copyValue(session.url, "url")}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#222b38] bg-[#151c27] text-[#e8edf4] font-mono text-[11px] cursor-pointer"
              >
                <Copy size={12} />
                {copied === "url" ? "Скопировано" : "Копировать"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-[#222b38] bg-[#111722] px-6 py-10 text-center">
          <Smartphone size={28} className="mx-auto text-sky-400 mb-3" />
          <div className="font-mono text-sm tracking-[0.16em] text-[#e8edf4] mb-1">STANDBY</div>
          <p className="text-xs text-[#8793a5] max-w-md mx-auto mb-4">
            Приём выключен. Запустите сессию, чтобы открыть одноразовый адрес в локальной сети.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void start()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-sky-500/35 bg-sky-500/15 text-sky-300 font-mono text-xs cursor-pointer disabled:opacity-50"
          >
            <Smartphone size={14} />
            Запустить прием
          </button>
        </div>
      )}

      <div className="rounded-2xl border border-[#222b38] bg-[#111722] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#222b38] text-[10px] font-mono uppercase tracking-[0.18em] text-[#8793a5]">
          Принятые файлы
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] font-mono uppercase tracking-wider text-[#8793a5]">
              <tr className="border-b border-[#222b38]">
                <th className="px-4 py-2 font-medium">Имя файла</th>
                <th className="px-4 py-2 font-medium">Размер</th>
                <th className="px-4 py-2 font-medium">Время получения</th>
                <th className="px-4 py-2 font-medium">Действие</th>
              </tr>
            </thead>
            <tbody>
              {files.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-[#8793a5] font-mono">
                    В этой сессии файлов пока нет
                  </td>
                </tr>
              ) : (
                files.map((file) => (
                  <tr key={file.id} className="border-b border-[#222b38]/80 last:border-0">
                    <td className="px-4 py-2.5 text-[#e8edf4]">
                      <div className="truncate max-w-[280px]">{file.filename}</div>
                      <div className={`text-[10px] font-mono ${file.status === "SUCCESS" ? "text-sky-400" : "text-rose-300"}`}>
                        {file.status}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[#8793a5] tabular-nums">{formatBytes(file.size_bytes)}</td>
                    <td className="px-4 py-2.5 font-mono text-[#8793a5]">{file.received_at}</td>
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        disabled={!file.path}
                        onClick={() => void invoke("open_item_location", { path: file.path }).catch((err) => setError(String(err)))}
                        className="px-2.5 py-1 rounded-lg border border-[#222b38] bg-[#151c27] text-[#e8edf4] font-mono text-[10px] cursor-pointer disabled:opacity-40"
                      >
                        Показать в Проводнике
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl border border-[#222b38] bg-[#111722] p-4">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[#8793a5] mb-3">
          Текст и ссылки
        </div>
        {texts.length === 0 ? (
          <p className="text-xs font-mono text-[#8793a5]">Смартфон ещё ничего не отправил</p>
        ) : (
          <div className="space-y-2">
            {texts.map((item) => (
              <div key={item.id} className="flex items-start gap-3 rounded-xl border border-[#222b38] bg-[#151c27] px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-mono text-[#8793a5] mb-1">{item.received_at}</div>
                  <div className="text-sm text-[#e8edf4] break-all">{item.body}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void copyValue(item.body, item.id)}
                  className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#222b38] text-[#e8edf4] font-mono text-[10px] cursor-pointer"
                >
                  <Copy size={11} />
                  {copied === item.id ? "Скопировано" : "Копировать"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}
