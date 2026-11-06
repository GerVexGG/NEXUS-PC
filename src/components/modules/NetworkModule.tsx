import { useEffect, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import { AppWindow, Copy, Loader2, RefreshCw, Search, X } from "lucide-react";
import { copyTextToClipboard } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

interface NetworkConnection {
  protocol: string;
  local_addr: string;
  remote_addr: string;
  state: string;
  pid: number;
  process_name: string;
  icon_base64: string | null;
}

type SocketFilter = "all" | "established" | "listen" | "udp";

const REFRESH_MS = 2000;

function isListening(state: string): boolean {
  return state === "LISTEN" || state === "LISTENING";
}

function stateBadge(state: string): { label: string; className: string } {
  if (state === "ESTABLISHED") {
    return {
      label: "ESTABLISHED",
      className: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
    };
  }
  if (isListening(state)) {
    return {
      label: "LISTENING",
      className: "border-sky-500/20 bg-sky-500/10 text-sky-400",
    };
  }
  return {
    label: state || "—",
    className: "border-[#222b38] bg-[#151c27] text-slate-400",
  };
}

function endpointHost(value: string): string {
  if (value === "*:*") return value;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : value;
  }
  const colon = value.lastIndexOf(":");
  return colon > 0 ? value.slice(0, colon) : value;
}

function endpointPort(value: string): string {
  if (value === "*:*") return "*";
  const colon = value.lastIndexOf(":");
  return colon >= 0 ? value.slice(colon + 1) : value;
}

export function NetworkModule({ c }: { c: NexusController }) {
  const [connections, setConnections] = useState<NetworkConnection[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SocketFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; conn: NetworkConnection } | null>(null);

  const fetchConnections = async () => {
    try {
      const list = await invoke<NetworkConnection[]>("get_network_connections");
      setConnections(list);
      setError(null);
    } catch (err) {
      console.error("Ошибка чтения таблицы сокетов:", err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConnections();
    const timer = setInterval(fetchConnections, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const showNotice = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice((current) => (current === message ? null : current)), 2200);
  };

  const copyRemoteIp = async (conn: NetworkConnection) => {
    const host = endpointHost(conn.remote_addr);
    await copyTextToClipboard(host);
    showNotice(`Скопирован IP: ${host}`);
  };

  const query = search.trim().toLowerCase();
  const visible = connections.filter((conn) => {
    if (filter === "established" && conn.state !== "ESTABLISHED") return false;
    if (filter === "listen" && !isListening(conn.state)) return false;
    if (filter === "udp" && conn.protocol.toUpperCase() !== "UDP") return false;
    if (!query) return true;
    return (
      conn.process_name.toLowerCase().includes(query) ||
      conn.pid.toString().includes(query) ||
      conn.remote_addr.toLowerCase().includes(query) ||
      conn.local_addr.toLowerCase().includes(query) ||
      endpointHost(conn.remote_addr).toLowerCase().includes(query)
    );
  });

  const establishedCount = connections.filter((conn) => conn.state === "ESTABLISHED").length;
  const listenCount = connections.filter((conn) => isListening(conn.state)).length;

  const openMenu = (event: MouseEvent<HTMLDivElement>, conn: NetworkConnection) => {
    event.preventDefault();
    event.stopPropagation();
    const x = Math.min(event.clientX, window.innerWidth - 260);
    const y = Math.min(event.clientY, window.innerHeight - 180);
    setMenu({ x: Math.max(8, x), y: Math.max(8, y), conn });
  };

  const filters: { id: SocketFilter; label: string }[] = [
    { id: "all", label: "Все" },
    { id: "established", label: "Установленные (ESTABLISHED)" },
    { id: "listen", label: "Слушающие (LISTENING)" },
    { id: "udp", label: "UDP" },
  ];

  const kpis = [
    { label: "Активные соединения", value: connections.length, tone: "text-slate-100" },
    { label: "TCP сокеты", value: establishedCount, tone: "text-emerald-400" },
    { label: "Прослушивание", value: listenCount, tone: "text-sky-400" },
  ];

  return (
    <>
      <motion.div
        key="network"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="w-full max-w-6xl space-y-4"
      >
        <div className="flex flex-col justify-between gap-4 border-b border-[#222b38] pb-3.5 lg:flex-row lg:items-end">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-100">Сетевой монитор</h2>
            <p className="mt-0.5 text-sm text-slate-400">Активные сетевые сокеты и соединения процессов</p>
          </div>
          <button
            type="button"
            onClick={() => void fetchConnections()}
            className="inline-flex items-center gap-2 rounded-lg border border-[#222b38] bg-[#111722] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-[#151c27]"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            Обновить
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {kpis.map((item) => (
            <div key={item.label} className="rounded-xl border border-[#222b38] bg-[#111722] px-4 py-3">
              <div className="text-xs text-slate-400">{item.label}</div>
              <div className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${item.tone}`}>{item.value}</div>
            </div>
          ))}
        </div>

        <div className="space-y-3 rounded-xl border border-[#222b38] bg-[#111722] p-3">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Поиск по процессу или IP-адресу"
              className="w-full rounded-lg border border-[#222b38] bg-[#151c27] py-2 pr-16 pl-9 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-slate-500"
            />
            <span className="absolute top-1/2 right-3 -translate-y-1/2 font-mono text-[10px] text-slate-500">
              {visible.length}/{connections.length}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === item.id
                    ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                    : "border-[#222b38] bg-[#151c27] text-slate-400 hover:text-slate-200"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="flex items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
            >
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)}>
                <X size={13} />
              </button>
            </motion.div>
          )}
          {notice && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-300"
            >
              {notice}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="overflow-hidden rounded-xl border border-[#222b38] bg-[#111722]">
          <div className="grid grid-cols-[minmax(0,1.3fr)_88px_minmax(0,1fr)_minmax(0,1fr)_130px_72px] gap-3 border-b border-[#222b38] bg-[#151c27] px-4 py-2.5 text-[11px] font-medium text-slate-400">
            <span>Процесс (PID)</span>
            <span>Протокол</span>
            <span>Локальный адрес</span>
            <span>Удалённый адрес</span>
            <span>Состояние</span>
            <span>Действие</span>
          </div>
          <div
            onScroll={() => setMenu(null)}
            className="max-h-[calc(100vh-460px)] min-h-[240px] divide-y divide-[#222b38] overflow-y-auto"
          >
            {loading && connections.length === 0 ? (
              <div className="flex items-center justify-center gap-2 p-10 text-xs text-slate-400">
                <Loader2 size={14} className="animate-spin text-sky-400" />
                Чтение таблицы сокетов...
              </div>
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-10 text-sm text-slate-400">
                <Search size={18} />
                Соединения не найдены
              </div>
            ) : (
              visible.map((conn, index) => {
                const badge = stateBadge(conn.state);
                return (
                  <div
                    key={`${conn.protocol}-${conn.local_addr}-${conn.remote_addr}-${conn.pid}-${index}`}
                    onContextMenu={(event) => openMenu(event, conn)}
                    className="grid grid-cols-[minmax(0,1.3fr)_88px_minmax(0,1fr)_minmax(0,1fr)_130px_72px] items-center gap-3 px-4 py-2.5 text-xs hover:bg-[#151c27]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden text-slate-500">
                        {conn.icon_base64 ? (
                          <img
                            src={`data:image/png;base64,${conn.icon_base64}`}
                            alt=""
                            draggable={false}
                            className="h-4 w-4 object-contain"
                          />
                        ) : (
                          <AppWindow size={12} />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-slate-100">{conn.process_name}</div>
                        <div className="font-mono text-[10px] text-slate-500">PID {conn.pid}</div>
                      </div>
                    </div>
                    <div className={`font-mono ${conn.protocol.toUpperCase() === "TCP" ? "text-sky-300" : "text-violet-300"}`}>
                      {conn.protocol}
                    </div>
                    <div className="truncate font-mono text-slate-300" title={conn.local_addr}>
                      {conn.local_addr}
                    </div>
                    <div className="truncate font-mono text-slate-300" title={conn.remote_addr}>
                      {conn.remote_addr}
                    </div>
                    <div>
                      <span className={`inline-flex rounded-md border px-2 py-0.5 font-mono text-[10px] ${badge.className}`}>
                        {badge.label}
                      </span>
                    </div>
                    <button
                      type="button"
                      title="Копировать удалённый IP"
                      onClick={() => void copyRemoteIp(conn)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-[#222b38] text-slate-400 hover:bg-[#151c27] hover:text-slate-100"
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {menu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 520, damping: 34 }}
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
            className="fixed z-[100] w-64 rounded-xl border border-[#222b38] bg-[#111722] p-1.5 text-xs shadow-[0_18px_44px_rgba(0,0,0,0.85)]"
          >
            <div className="mb-1 rounded-lg border border-[#222b38] bg-[#151c27] px-2.5 py-2">
              <div className="truncate font-semibold text-slate-100">{menu.conn.process_name}</div>
              <div className="truncate font-mono text-[10px] text-slate-500">
                {menu.conn.protocol} {menu.conn.remote_addr}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                void copyRemoteIp(menu.conn);
                setMenu(null);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-200 hover:bg-[#151c27]"
            >
              <Copy size={14} className="shrink-0 text-sky-300" />
              Копировать удалённый IP
            </button>
            <button
              type="button"
              onClick={async () => {
                const port = endpointPort(menu.conn.remote_addr);
                setMenu(null);
                await copyTextToClipboard(port);
                showNotice(`Скопирован порт: ${port}`);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-200 hover:bg-[#151c27]"
            >
              <Copy size={14} className="shrink-0 text-slate-400" />
              Копировать порт
            </button>
            <div className="my-1 h-px bg-[#222b38]" />
            <button
              type="button"
              onClick={() => {
                const pid = menu.conn.pid;
                setMenu(null);
                c.setProcessSearch(String(pid));
                c.setSelectedPid(pid);
                c.setActiveTab("processes");
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sky-200 hover:bg-sky-500/10"
            >
              <AppWindow size={14} className="shrink-0 text-sky-300" />
              Перейти к процессу
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
