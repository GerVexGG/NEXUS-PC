import { useEffect, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import {
  AppWindow,
  ChevronDown,
  ChevronUp,
  Copy,
  Globe,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
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

type SocketFilter = "all" | "established" | "listen";
type SocketSortKey = "process" | "protocol" | "local" | "remote" | "state";

const REFRESH_MS = 2000;

const STATE_RANK: Record<string, number> = {
  ESTABLISHED: 50,
  SYN_SENT: 40,
  SYN_RCVD: 39,
  LISTEN: 30,
  CLOSE_WAIT: 20,
  TIME_WAIT: 19,
  FIN_WAIT1: 18,
  FIN_WAIT2: 17,
  CLOSING: 16,
  LAST_ACK: 15,
  CLOSED: 5,
  "—": 0,
};

function stateBadgeClass(state: string): string {
  switch (state) {
    case "ESTABLISHED":
      return "text-[#38bdf8] bg-sky-500/15 border-sky-400/35";
    case "LISTEN":
      return "text-[#10b981] bg-emerald-500/15 border-emerald-400/35";
    case "TIME_WAIT":
    case "CLOSE_WAIT":
      return "text-[#8793a5] bg-white/[0.04] border-[#222b38]";
    case "SYN_SENT":
      return "text-[#f59e0b] bg-amber-500/15 border-amber-400/35";
    default:
      return "text-[#c5d0de] bg-[#151c27] border-[#222b38]";
  }
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
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SocketSortKey>("state");
  const [sortDesc, setSortDesc] = useState(true);
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
    if (!autoRefresh) return;
    const timer = setInterval(fetchConnections, REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh]);

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

  const query = search.trim().toLowerCase();
  const visible = connections
    .filter((conn) => {
      if (filter === "established" && conn.state !== "ESTABLISHED") return false;
      if (filter === "listen" && conn.state !== "LISTEN") return false;
      if (!query) return true;
      return (
        conn.process_name.toLowerCase().includes(query) ||
        conn.pid.toString().includes(query) ||
        conn.remote_addr.toLowerCase().includes(query) ||
        conn.local_addr.toLowerCase().includes(query) ||
        endpointPort(conn.remote_addr).includes(query) ||
        endpointPort(conn.local_addr).includes(query)
      );
    })
    .sort((a, b) => {
      let diff = 0;
      switch (sortKey) {
        case "process":
          diff = a.process_name.localeCompare(b.process_name, "ru");
          break;
        case "protocol":
          diff = a.protocol.localeCompare(b.protocol);
          break;
        case "local":
          diff = a.local_addr.localeCompare(b.local_addr);
          break;
        case "remote":
          diff = a.remote_addr.localeCompare(b.remote_addr);
          break;
        case "state":
          diff = (STATE_RANK[a.state] ?? 1) - (STATE_RANK[b.state] ?? 1);
          break;
      }
      if (diff === 0) diff = a.pid - b.pid;
      return sortDesc ? -diff : diff;
    });

  const establishedCount = connections.filter((conn) => conn.state === "ESTABLISHED").length;
  const listenCount = connections.filter((conn) => conn.state === "LISTEN").length;

  const toggleSort = (key: SocketSortKey) => {
    if (sortKey === key) {
      setSortDesc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortDesc(key === "state");
    }
  };

  const openMenu = (event: MouseEvent<HTMLDivElement>, conn: NetworkConnection) => {
    event.preventDefault();
    event.stopPropagation();
    const x = Math.min(event.clientX, window.innerWidth - 260);
    const y = Math.min(event.clientY, window.innerHeight - 180);
    setMenu({ x: Math.max(8, x), y: Math.max(8, y), conn });
  };

  const header = (key: SocketSortKey, label: string, alignRight = false) => {
    const active = sortKey === key;
    return (
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className={`flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.14em] cursor-pointer ${
          alignRight ? "justify-end" : "justify-start"
        } ${active ? "text-sky-300" : "text-[#8793a5] hover:text-[#d5dde8]"}`}
      >
        <span>{label}</span>
        {active ? sortDesc ? <ChevronDown size={11} /> : <ChevronUp size={11} /> : <span className="w-[11px]" />}
      </button>
    );
  };

  const filters: { id: SocketFilter; label: string }[] = [
    { id: "all", label: "Все соединения" },
    { id: "established", label: "Активные (ESTABLISHED)" },
    { id: "listen", label: "Слушающие порты (LISTEN)" },
  ];

  return (
    <>
      <motion.div
        key="network"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="space-y-4 max-w-6xl w-full"
      >
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-[#222b38] pb-3.5">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-100">Анализатор сети</h2>
            <p className="mt-0.5 text-sm text-slate-400">
              TCP и UDP сокеты Windows с привязкой к процессу-владельцу
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
            <span className="px-2.5 py-1.5 rounded-lg bg-[#151c27] border border-[#222b38] text-[#8793a5] tabular-nums">
              СОКЕТОВ: <strong className="text-[#e8edf4]">{connections.length}</strong>
            </span>
            <span className="px-2.5 py-1.5 rounded-lg bg-[#151c27] border border-[#222b38] text-[#8793a5] tabular-nums">
              ESTABLISHED: <strong className="text-[#38bdf8]">{establishedCount}</strong>
            </span>
            <span className="px-2.5 py-1.5 rounded-lg bg-[#151c27] border border-[#222b38] text-[#8793a5] tabular-nums">
              LISTEN: <strong className="text-[#10b981]">{listenCount}</strong>
            </span>
            <motion.button
              type="button"
              whileTap={{ scale: 0.95 }}
              onClick={() => setAutoRefresh((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border cursor-pointer ${
                autoRefresh
                  ? "bg-sky-500/15 text-sky-300 border-sky-500/35"
                  : "bg-amber-500/15 text-amber-300 border-amber-500/35"
              }`}
            >
              {autoRefresh ? <Pause size={12} /> : <Play size={12} />}
              <span>{autoRefresh ? "LIVE 2s" : "ПАУЗА"}</span>
            </motion.button>
            <motion.button
              type="button"
              whileTap={{ scale: 0.95 }}
              onClick={fetchConnections}
              className="inline-flex items-center justify-center h-[30px] w-[30px] rounded-lg bg-[#151c27] hover:bg-white/[0.06] text-[#c5d0de] border border-[#222b38] cursor-pointer"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </motion.button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-mono border cursor-pointer transition-colors ${
                filter === item.id
                  ? "bg-sky-500/15 text-sky-300 border-sky-400/40"
                  : "bg-[#151c27] text-[#8793a5] border-[#222b38] hover:text-[#e8edf4]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#8793a5]" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск по процессу, удалённому IP или порту..."
            className="w-full pl-10 pr-24 py-2.5 rounded-xl bg-[#151c27] border border-[#222b38] text-sm font-mono text-[#e8edf4] placeholder-[#8793a5] focus:outline-none focus:border-sky-500/40 transition-all"
          />
          <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[10px] font-mono text-[#8793a5] tabular-nums">
            {visible.length} / {connections.length}
          </span>
        </div>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono flex items-center justify-between gap-3"
            >
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} className="cursor-pointer">
                <X size={13} />
              </button>
            </motion.div>
          )}
          {notice && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="p-3 rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-300 text-xs font-mono truncate"
            >
              {notice}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="relative rounded-xl bg-[#111722] border border-[#222b38] overflow-hidden">
          <div className="grid grid-cols-[minmax(0,1.2fr)_80px_minmax(0,1fr)_minmax(0,1fr)_130px] gap-3 px-4 py-2.5 bg-[#151c27] border-b border-[#222b38]">
            {header("process", "Процесс")}
            {header("protocol", "Протокол")}
            {header("local", "Локальный адрес")}
            {header("remote", "Удалённый узел")}
            {header("state", "Состояние", true)}
          </div>
          <div
            onScroll={() => setMenu(null)}
            className="max-h-[calc(100vh-360px)] min-h-[240px] overflow-y-auto divide-y divide-white/[0.035]"
          >
            {loading && connections.length === 0 ? (
              <div className="p-10 flex items-center justify-center gap-2 text-xs font-mono text-[#8793a5]">
                <Loader2 size={14} className="animate-spin text-sky-400" />
                Чтение таблицы сокетов...
              </div>
            ) : visible.length === 0 ? (
              <div className="p-10 text-center text-xs font-mono text-[#8793a5]">
                Соединения по запросу не найдены
              </div>
            ) : (
              visible.map((conn, index) => (
                <div
                  key={`${conn.protocol}-${conn.local_addr}-${conn.remote_addr}-${conn.pid}-${index}`}
                  onContextMenu={(event) => openMenu(event, conn)}
                  className="grid grid-cols-[minmax(0,1.2fr)_80px_minmax(0,1fr)_minmax(0,1fr)_130px] gap-3 px-4 py-2 items-center text-xs font-mono hover:bg-white/[0.03]"
                >
                  <div className="min-w-0 flex items-center gap-2.5">
                    <div className="h-4 w-4 rounded flex items-center justify-center shrink-0 overflow-hidden text-[#8793a5]">
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
                      <div className="truncate text-[#e8edf4] font-semibold">{conn.process_name}</div>
                      <div className="text-[10px] text-[#8793a5] tabular-nums">PID {conn.pid}</div>
                    </div>
                  </div>
                  <div className={conn.protocol === "TCP" ? "text-sky-300" : "text-violet-300"}>
                    {conn.protocol}
                  </div>
                  <div className="truncate text-[#c5d0de] tabular-nums" title={conn.local_addr}>
                    {conn.local_addr}
                  </div>
                  <div className="truncate text-[#c5d0de] tabular-nums" title={conn.remote_addr}>
                    {conn.remote_addr}
                  </div>
                  <div className="text-right">
                    <span className={`inline-flex px-2 py-0.5 rounded-md border text-[10px] tracking-wide ${stateBadgeClass(conn.state)}`}>
                      {conn.state}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 text-[10px] font-mono text-[#8793a5]">
          <Globe size={12} className="text-sky-400" />
          ПКМ по строке — копирование адреса или переход к процессу
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
            className="fixed z-[100] w-64 rounded-xl backdrop-blur-2xl bg-[#111722]/97 border border-[#222b38] shadow-[0_18px_44px_rgba(0,0,0,0.85)] p-1.5 font-mono text-xs"
          >
            <div className="px-2.5 py-2 mb-1 rounded-lg bg-[#151c27] border border-[#222b38]">
              <div className="text-[#e8edf4] font-bold truncate">{menu.conn.process_name}</div>
              <div className="text-[10px] text-[#8793a5] truncate">
                {menu.conn.protocol} {menu.conn.remote_addr}
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                const host = endpointHost(menu.conn.remote_addr);
                setMenu(null);
                await copyTextToClipboard(host);
                showNotice(`Скопирован IP: ${host}`);
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[#e8edf4] hover:bg-white/[0.06] cursor-pointer"
            >
              <Copy size={14} className="text-sky-300 shrink-0" />
              <span>Копировать удалённый IP</span>
            </button>
            <button
              type="button"
              onClick={async () => {
                const port = endpointPort(menu.conn.remote_addr);
                setMenu(null);
                await copyTextToClipboard(port);
                showNotice(`Скопирован порт: ${port}`);
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[#e8edf4] hover:bg-white/[0.06] cursor-pointer"
            >
              <Copy size={14} className="text-[#8793a5] shrink-0" />
              <span>Копировать порт</span>
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
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-sky-200 hover:bg-sky-500/10 cursor-pointer"
            >
              <AppWindow size={14} className="text-sky-300 shrink-0" />
              <span>Перейти к процессу</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
