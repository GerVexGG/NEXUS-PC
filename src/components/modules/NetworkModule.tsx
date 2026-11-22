import { appendRtt, formatJitter, JITTER_HELP, summarizeRtt, type RttSample } from "../../lib/latencyHistory";
import { useWorkspaceState } from "../../hooks/useWorkspaceState";
import { ModuleHeader } from "../ui/ModuleHeader";
import type { NetworkSpeedSample } from "../../lib/networkHistory";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AppWindow,
  ArrowDown,
  ArrowUp,
  Cable,
  Copy,
  Globe,
  Loader2,
  Network,
  RefreshCw,
  RotateCcw,
  Router,
  Search,
  Wifi,
  X,
} from "lucide-react";
import {
  copyTextToClipboard,
  formatBytes,
  formatLinkSpeed,
  formatThroughputRate,
  type NetworkAdapterInfo,
  type NetworkHealthProbe,
  type NetworkOptimizerStatus,
} from "../../lib/studio";
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
const SOCKET_ROW_HEIGHT = 49;
const SOCKET_OVERSCAN = 4;

function isListening(state: string): boolean {
  return state === "LISTEN" || state === "LISTENING";
}

function stateBadge(state: string): { label: string; className: string } {
  if (state === "ESTABLISHED") {
    return {
      label: "ESTABLISHED",
      className: "border-[#00D5E8]/35 bg-[#00D5E8]/12 text-[#00D5E8]",
    };
  }
  if (isListening(state)) {
    return {
      label: "LISTENING",
      className: "border-[#36AFC0]/35 bg-[#36AFC0]/12 text-[#36AFC0]",
    };
  }
  if (state === "TIME_WAIT" || state === "CLOSE_WAIT") {
    return {
      label: state,
      className: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    };
  }
  return {
    label: state || "UDP / STATELESS",
    className: "border-[#202B38] bg-[#151C26] text-[#8292A3]",
  };
}

function endpointHost(value: string): string {
  if (value === "*:*") return "*";
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

function EndpointCell({ addr }: { addr: string }) {
  const host = endpointHost(addr);
  const port = endpointPort(addr);
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs" title={addr}>
      <span className="truncate text-[#E5EDF5]">{host}</span>
      {port && (
        <span className="shrink-0 rounded border border-[#202B38] bg-[#0B0E14] px-1.5 py-0.5 text-[10px] text-[#00D5E8]">
          :{port}
        </span>
      )}
    </div>
  );
}

function useSocketConnections(active: boolean) {
  const [connections, setConnections] = useState<NetworkConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [received, setReceived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  const fetchConnections = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const list = await invoke<NetworkConnection[]>("get_network_connections");
      setConnections(list);
      setReceived(true);
      setError(null);
    } catch (err) {
      console.error("Ошибка чтения таблицы сокетов:", err);
      setError(String(err));
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void fetchConnections();
    const timer = setInterval(() => void fetchConnections(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, fetchConnections]);

  return { connections, received, loading, error, setError, fetchConnections };
}

export function NetworkModule({ c }: { c: NexusController }) {
  const [search, setSearch] = useWorkspaceState("network.search", "");
  const [filter, setFilter] = useWorkspaceState<SocketFilter>("network.filter", "all");
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; conn: NetworkConnection } | null>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const menuOrigin = useRef<HTMLElement | null>(null);
  const [view, setView] = useWorkspaceState<"overview" | "sockets" | "diagnostics" | "optimizer">("network.view", "overview");
  const [toolsVisited, setToolsVisited] = useState(view === "diagnostics" || view === "optimizer");
  const { connections, received, loading, error, setError, fetchConnections } = useSocketConnections(view === "sockets" && c.windowVisible);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeMenuAndRestoreFocus = useCallback(() => {
    closeMenu();
    menuOrigin.current?.focus({ preventScroll: true });
  }, [closeMenu]);

  useLayoutEffect(() => {
    if (menu) menuElement.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
    };
  }, [menu, closeMenu]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice((current) => (current === message ? null : current)), 2200);
  }, []);

  const copyEndpoint = useCallback(async (value: string, field: string) => {
    try {
      await copyTextToClipboard(value);
      showNotice(`Скопирован ${field}: ${value}`);
    } catch (err) {
      setError(String(err));
    }
  }, [setError, showNotice]);

  const copyRemoteIp = useCallback((conn: NetworkConnection) => (
    copyEndpoint(endpointHost(conn.remote_addr), "IP-адрес")
  ), [copyEndpoint]);

  const query = search.trim().toLowerCase();
  const visible = useMemo(() => {
    if (filter === "all" && !query) return connections;
    return connections.filter((conn) => {
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
  }, [connections, filter, query]);

  const { establishedCount, listenCount, udpCount } = useMemo(() => {
    let establishedCount = 0;
    let listenCount = 0;
    let udpCount = 0;
    for (const conn of connections) {
      if (conn.state === "ESTABLISHED") establishedCount++;
      if (isListening(conn.state)) listenCount++;
      if (conn.protocol.toUpperCase() === "UDP") udpCount++;
    }
    return { establishedCount, listenCount, udpCount };
  }, [connections]);

  const openMenu = useCallback((event: MouseEvent<HTMLDivElement>, conn: NetworkConnection) => {
    event.preventDefault();
    event.stopPropagation();
    const row = event.currentTarget.getBoundingClientRect();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    menuOrigin.current = event.currentTarget.querySelector("button");
    const x = Math.min(keyboard ? row.left : event.clientX, window.innerWidth - 264);
    const y = Math.min(keyboard ? row.bottom : event.clientY, window.innerHeight - 184);
    setMenu({ x: Math.max(8, x), y: Math.max(8, y), conn });
  }, []);

  const filters: { id: SocketFilter; label: string }[] = [
    { id: "all", label: `Все (${received ? connections.length : "—"})` },
    { id: "established", label: `ESTABLISHED (${received ? establishedCount : "—"})` },
    { id: "listen", label: `LISTENING (${received ? listenCount : "—"})` },
    { id: "udp", label: `UDP (${received ? udpCount : "—"})` },
  ];

  return (
    <>
      <motion.div
        key="network"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="avs-module avs-network w-full space-y-4"
      >
        <ModuleHeader module="network"
          title="Сетевой анализатор"
          description="Трафик адаптеров, активные соединения и диагностика Windows"
        />
        <div className="avs-workspace-tabs" role="group" aria-label="Представление сети">
          {([
            ["overview", "Обзор сети"],
            ["sockets", "Расширенные подключения"],
            ["diagnostics", "Диагностика и DNS"],
            ["optimizer", "Оптимизатор"],
          ] as const).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={view === id} onClick={() => {
              closeMenu();
              if (id === "diagnostics" || id === "optimizer") setToolsVisited(true);
              setView(id);
            }}>{label}</button>
          ))}
          {view === "sockets" && (
            <button type="button" onClick={() => void fetchConnections()} className="ml-auto" disabled={loading}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Обновить
            </button>
          )}
        </div>

        <div hidden={view !== "overview"}>
          <NetworkOverview c={c} active={view === "overview" && c.windowVisible} />
        </div>
        {toolsVisited && <NetworkToolkit view={view} active={c.windowVisible} />}
        {view === "sockets" && (
          <div className="space-y-4">
            {/* Сетевая телеметрия */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <div className="tactical-card rounded-xl px-4 py-3">
                <div className="text-xs text-[#8292A3]">Входящий поток (RX)</div>
                <div className="mt-1 font-mono text-xl font-bold text-[#00D5E8]">
                  {c.metricsReady ? `↓ ${c.rxParts.value} ${c.rxParts.unit}` : "—"}
                </div>
              </div>
              <div className="tactical-card rounded-xl px-4 py-3">
                <div className="text-xs text-[#8292A3]">Исходящий поток (TX)</div>
                <div className="mt-1 font-mono text-xl font-bold text-[#E5EDF5]">
                  {c.metricsReady ? `↑ ${c.txParts.value} ${c.txParts.unit}` : "—"}
                </div>
              </div>
              <div className="tactical-card rounded-xl px-4 py-3">
                <div className="text-xs text-[#8292A3]">Всего сокетов</div>
                <div className="mt-1 font-mono text-xl font-bold text-[#E5EDF5]">
                  {received ? connections.length : "—"}
                </div>
              </div>
              <div className="tactical-card rounded-xl px-4 py-3">
                <div className="text-xs text-[#8292A3]">Установлено (TCP)</div>
                <div className="mt-1 font-mono text-xl font-bold text-[#00D5E8]">
                  {received ? establishedCount : "—"}
                </div>
              </div>
              <div className="tactical-card col-span-2 rounded-xl px-4 py-3 lg:col-span-1">
                <div className="text-xs text-[#8292A3]">Ожидание (LISTEN)</div>
                <div className="mt-1 font-mono text-xl font-bold text-[#36AFC0]">
                  {received ? listenCount : "—"}
                </div>
              </div>
            </div>

            {/* Панель поиска и фильтрации */}
            <div className="avs-band">
              <div className="flex flex-wrap gap-2">
                {filters.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setFilter(item.id)}
                    aria-pressed={filter === item.id}
                    className={`cursor-pointer rounded-lg border px-3 py-1.5 font-mono text-xs font-medium transition-colors ${
                      filter === item.id
                        ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                        : "border-[#202B38] bg-[#10151D] text-[#8292A3] hover:text-[#E5EDF5]"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="relative min-w-0 flex-[1_1_13rem]">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#526170]"
                />
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Поиск по процессу, PID, IP-адресу или порту…"
                  aria-label="Поиск подключений"
                  className="w-full rounded-lg border border-[#202B38] bg-[#10151D] py-2 pr-16 pl-9 text-sm text-[#E5EDF5] outline-none placeholder:text-[#526170] focus:border-[#00D5E8]/50"
                />
                <span className="absolute top-1/2 right-3 -translate-y-1/2 font-mono text-[11px] text-[#526170]">
                  {visible.length}/{connections.length}
                </span>
              </div>
            </div>

            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="flex items-center justify-between gap-3 rounded-xl border border-rose-500/35 bg-rose-500/12 px-4 py-2.5 text-xs text-rose-300"
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
                  className="rounded-xl border border-[#00D5E8]/35 bg-[#00D5E8]/12 px-4 py-2.5 text-xs text-[#00D5E8]"
                >
                  {notice}
                </motion.div>
              )}
            </AnimatePresence>

            <div className="tactical-card tactical-brackets overflow-x-auto rounded-xl">
              <div className="min-w-[580px]">
                <div className="grid grid-cols-[minmax(130px,1.35fr)_62px_minmax(90px,1fr)_minmax(90px,1fr)_114px_44px] gap-2.5 border-b border-[#202B38] bg-[#0B0E14] px-4 py-2.5 text-xs font-medium text-[#8292A3] lg:grid-cols-[minmax(0,1.4fr)_84px_minmax(0,1fr)_minmax(0,1fr)_136px_64px] lg:gap-3">
                  <span>Процесс и PID</span>
                  <span>Протокол</span>
                  <span>Локальный узел :порт</span>
                  <span>Удалённый узел :порт</span>
                  <span>Состояние</span>
                  <span className="text-right">IP</span>
                </div>
                <SocketTable
                  connections={visible}
                  loading={loading && connections.length === 0}
                  onCopy={copyRemoteIp}
                  onMenu={openMenu}
                  onScroll={closeMenu}
                />
              </div>
            </div>
          </div>
        )}
      </motion.div>

      {createPortal(<AnimatePresence>
        {menu && (
          <motion.div
            ref={menuElement}
            aria-label="Действия с подключением"
            role="menu"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 520, damping: 34 }}
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault();
                closeMenuAndRestoreFocus();
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const items = Array.from(event.currentTarget.querySelectorAll("button"));
                const current = items.indexOf(document.activeElement as HTMLButtonElement);
                items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
              }
            }}
            className="nexus-panel fixed z-[100] w-64 p-1.5 text-xs shadow-2xl"
          >
            <div className="mb-1 rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-2">
              <div className="truncate font-semibold text-[#E5EDF5]">{menu.conn.process_name}</div>
              <div className="truncate font-mono text-[10px] text-[#8292A3]">
                {menu.conn.protocol} {menu.conn.remote_addr}
              </div>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void copyRemoteIp(menu.conn);
                closeMenuAndRestoreFocus();
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[#E5EDF5] hover:bg-[#151C26]"
            >
              <Copy size={14} className="shrink-0 text-[#00D5E8]" />
              Копировать удалённый IP
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void copyEndpoint(endpointPort(menu.conn.remote_addr), "порт");
                closeMenuAndRestoreFocus();
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[#E5EDF5] hover:bg-[#151C26]"
            >
              <Copy size={14} className="shrink-0 text-[#8292A3]" />
              Копировать порт
            </button>
            <div className="my-1 h-px bg-[#202B38]" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                c.openProcessFromNetwork(menu.conn.pid);
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[#00D5E8] hover:bg-[#00D5E8]/10"
            >
              <AppWindow size={14} className="shrink-0 text-[#00D5E8]" />
              Перейти к процессу в диспетчере
            </button>
          </motion.div>
        )}
      </AnimatePresence>, document.body)}
    </>
  );
}


interface SocketTableProps {
  connections: NetworkConnection[];
  loading: boolean;
  onCopy: (conn: NetworkConnection) => Promise<void>;
  onMenu: (event: MouseEvent<HTMLDivElement>, conn: NetworkConnection) => void;
  onScroll: () => void;
}

const SocketTable = memo(function SocketTable({
  connections, loading, onCopy, onMenu, onScroll,
}: SocketTableProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const rowKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return connections.map((conn) => {
      const base = `${conn.protocol}:${conn.pid}|${conn.local_addr}|${conn.remote_addr}`;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      return `${base}|${occurrence}`;
    });
  }, [connections]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setHeight(element.clientHeight);
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const totalHeight = connections.length * SOCKET_ROW_HEIGHT;
  const top = Math.min(scrollTop, Math.max(0, totalHeight - height));
  const start = Math.max(0, Math.floor(top / SOCKET_ROW_HEIGHT) - SOCKET_OVERSCAN);
  const end = Math.min(connections.length, Math.ceil((top + height) / SOCKET_ROW_HEIGHT) + SOCKET_OVERSCAN);

  return (
    <div
      ref={viewport}
      tabIndex={0}
      aria-label="Список сетевых подключений"
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
        onScroll();
      }}
      className="max-h-[calc(100vh-380px)] min-h-[240px] overflow-y-auto"
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 p-12 text-xs text-[#8292A3]">
          <Loader2 size={15} className="animate-spin text-[#00D5E8]" />
          Опрос сетевого стека Windows…
        </div>
      ) : connections.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-12 text-sm text-[#8292A3]">
          <Search size={18} className="text-[#526170]" />
          Активные сокеты по заданному фильтру не найдены
        </div>
      ) : (
        <div style={{ paddingTop: start * SOCKET_ROW_HEIGHT, paddingBottom: (connections.length - end) * SOCKET_ROW_HEIGHT }}>
          {connections.slice(start, end).map((conn, offset) => {
            const badge = stateBadge(conn.state);
            const isTcp = conn.protocol.toUpperCase() === "TCP";
            return (
              <div
                key={rowKeys[start + offset]}
                onContextMenu={(event) => onMenu(event, conn)}
                style={{ height: SOCKET_ROW_HEIGHT }}
                className={`grid grid-cols-[minmax(130px,1.35fr)_62px_minmax(90px,1fr)_minmax(90px,1fr)_114px_44px] items-center gap-2.5 px-4 py-2.5 text-xs transition-colors hover:bg-[#151C26]/65 lg:grid-cols-[minmax(0,1.4fr)_84px_minmax(0,1fr)_minmax(0,1fr)_136px_64px] lg:gap-3 ${start + offset < connections.length - 1 ? "border-b border-[#202B38]/60" : ""}`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-[#202B38] bg-[#0B0E14] text-[#8292A3]">
                    {conn.icon_base64 ? (
                      <img
                        src={`data:image/png;base64,${conn.icon_base64}`}
                        alt=""
                        draggable={false}
                        className="h-4 w-4 object-contain"
                      />
                    ) : (
                      <AppWindow size={13} />
                    )}
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-semibold text-[#E5EDF5]">
                      {conn.process_name}
                    </span>
                    <span className="shrink-0 rounded border border-[#202B38] bg-[#0B0E14] px-1.5 py-0.5 font-mono text-[10px] text-[#8292A3]">
                      PID {conn.pid}
                    </span>
                  </div>
                </div>

                <div>
                  <span
                    className={`inline-flex rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                      isTcp
                        ? "border-[#00D5E8]/30 bg-[#00D5E8]/10 text-[#00D5E8]"
                        : "border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
                    }`}
                  >
                    {conn.protocol.toUpperCase()}
                  </span>
                </div>

                <EndpointCell addr={conn.local_addr} />
                <EndpointCell addr={conn.remote_addr} />

                <div>
                  <span
                    className={`inline-flex rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    title="Копировать удалённый IP-адрес"
                    onClick={() => void onCopy(conn)}
                    className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-[#202B38] bg-[#0B0E14] text-[#8292A3] transition-colors hover:border-[#00D5E8]/40 hover:text-[#00D5E8]"
                  >
                    <Copy size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

function buildSmoothArea(coords: { x: number; y: number }[], baseline: number): { line: string; area: string } {
  if (coords.length === 0) return { line: "", area: "" };
  const fmt = (n: number) => n.toFixed(2);
  let line = `M ${fmt(coords[0].x)} ${fmt(coords[0].y)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const midX = fmt((p1.x + p2.x) / 2);
    line += ` C ${midX} ${fmt(p1.y)} ${midX} ${fmt(p2.y)} ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  const firstX = fmt(coords[0].x);
  const lastX = fmt(coords[coords.length - 1].x);
  return {
    line,
    area: `${line} L ${lastX} ${fmt(baseline)} L ${firstX} ${fmt(baseline)} Z`,
  };
}

function niceSpeedCeiling(maxBytesSec: number, unitMode: "mbps" | "mbs"): number {
  const minFloor = unitMode === "mbps" ? 6_250 : 8 * 1024; // 50 Кбит/с или 8 КБ/с минимум динамической шкалы
  const peak = Math.max(minFloor, maxBytesSec * 1.18);
  const scaleFactor = unitMode === "mbps" ? 8 / 1_000_000 : 1 / (1024 * 1024);
  const scaled = peak * scaleFactor;
  const steps =
    unitMode === "mbps"
      ? [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500]
      : [0.0078125, 0.015625, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
  const chosen = steps.find((s) => s >= scaled) ?? Math.ceil(scaled / 500) * 500;
  return chosen / scaleFactor;
}

function LiveNetworkSpeedChart({
  history,
  currentRx,
  currentTx,
  unitMode,
  onUnitChange,
}: {
  history: NetworkSpeedSample[];
  currentRx: number;
  currentTx: number;
  unitMode: "mbps" | "mbs";
  onUnitChange: (mode: "mbps" | "mbs") => void;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const width = 640;
  const height = 196;

  const peakRx = history.reduce((m, p) => Math.max(m, p.rxBps), currentRx);
  const peakTx = history.reduce((m, p) => Math.max(m, p.txBps), currentTx);
  const ceilingBytes = niceSpeedCeiling(Math.max(peakRx, peakTx), unitMode);

  const rxNow = formatThroughputRate(currentRx, unitMode);
  const txNow = formatThroughputRate(currentTx, unitMode);
  const rxPeakFmt = formatThroughputRate(peakRx, unitMode);
  const txPeakFmt = formatThroughputRate(peakTx, unitMode);

  const first = history[0]?.at ?? 0;
  const last = history[history.length - 1]?.at ?? first;
  const fraction = (at: number) => last === first ? 1 : (at - first) / (last - first);

  const mapPoints = (key: "rxBps" | "txBps") =>
    history.map((pt) => {
      const x = fraction(pt.at) * width;
      const ratio = Math.min(1, Math.max(0, pt[key] / ceilingBytes));
      const y = height - ratio * (height - 16) - 8;
      return { x, y };
    });

  const rxCoords = mapPoints("rxBps");
  const txCoords = mapPoints("txBps");
  const rxPaths = buildSmoothArea(rxCoords, height);
  const txPaths = buildSmoothArea(txCoords, height);
  const rxLast = rxCoords[rxCoords.length - 1];
  const txLast = txCoords[txCoords.length - 1];

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || history.length === 0) return;
    const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const target = first + relX * (last - first);
    setHoverIdx(history.reduce((nearest, p, index) =>
      Math.abs(p.at - target) < Math.abs(history[nearest].at - target) ? index : nearest, 0));
  };

  const hovered = hoverIdx !== null ? history[hoverIdx] : null;
  const hoverX = hovered ? fraction(hovered.at) * 100 : 0;
  const hoveredRx = hovered ? formatThroughputRate(hovered.rxBps, unitMode) : null;
  const hoveredTx = hovered ? formatThroughputRate(hovered.txBps, unitMode) : null;

  const midLabel = formatThroughputRate(ceilingBytes * 0.5, unitMode);
  const topLabel = formatThroughputRate(ceilingBytes, unitMode);

  return (
    <section className="avs-network-plot tactical-card rounded-xl p-4 sm:p-5" aria-label="График пропускной способности">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-[#8292A3]">
              <ArrowDown size={13} className="text-[#00D5E8]" />
              <span>Приём</span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-mono text-2xl font-bold tracking-tight text-[#00D5E8] sm:text-3xl">
                {rxNow.value}
              </span>
              <span className="font-mono text-xs font-medium text-[#8292A3]">{rxNow.unit}</span>
              <span className="font-mono text-[11px] text-[#526170]">
                пик {rxPeakFmt.value} {rxPeakFmt.unit}
              </span>
            </div>
          </div>

          <div className="h-10 w-px bg-[#202B38]" />

          <div>
            <div className="flex items-center gap-1.5 text-xs text-[#8292A3]">
              <ArrowUp size={13} className="text-indigo-400" />
              <span>Отдача</span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-mono text-2xl font-bold tracking-tight text-indigo-300 sm:text-3xl">
                {txNow.value}
              </span>
              <span className="font-mono text-xs font-medium text-[#8292A3]">{txNow.unit}</span>
              <span className="font-mono text-[11px] text-[#526170]">
                пик {txPeakFmt.value} {txPeakFmt.unit}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 text-xs text-[#8292A3]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#00D5E8] shadow-[0_0_6px_rgba(0,213,232,0.85)]" />
              RX
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-indigo-400 shadow-[0_0_6px_rgba(129,140,248,0.85)]" />
              TX
            </span>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-[#202B38] bg-[#0B0E14] p-0.5">
            {(
              [
                ["mbps", "Мбит/с"],
                ["mbs", "МБ/с"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => onUnitChange(id)}
                aria-pressed={unitMode === id}
                className={`cursor-pointer rounded-md px-2.5 py-1 font-mono text-[11px] font-medium transition-colors ${
                  unitMode === id
                    ? "bg-[#151C26] text-[#00D5E8]"
                    : "text-[#8292A3] hover:text-[#E5EDF5]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex gap-3">
          <div className="hidden h-48 w-20 shrink-0 flex-col justify-between py-1 text-right font-mono text-[10px] text-[#526170] sm:flex">
            <span>
              {topLabel.value} {topLabel.unit}
            </span>
            <span>
              {midLabel.value} {midLabel.unit}
            </span>
            <span>0</span>
          </div>

          <div
            data-graph
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoverIdx(null)}
            className="relative h-48 min-w-0 flex-1 cursor-crosshair overflow-hidden rounded-lg border border-[#202B38] bg-[#0B0E14]"
          >
            {history.length > 1 && <input
              type="range" min={0} max={history.length - 1} step={1}
              className="avs-chart-scrubber"
              aria-label="Замер скорости адаптера"
              aria-valuetext={hovered && hoveredRx && hoveredTx
                ? `${hovered.ts}. Приём ${hoveredRx.value} ${hoveredRx.unit}. Отдача ${hoveredTx.value} ${hoveredTx.unit}.`
                : history[history.length - 1].ts}
              value={hovered && hoverIdx !== null ? hoverIdx : history.length - 1}
              onChange={(event) => setHoverIdx(event.currentTarget.valueAsNumber)}
              onFocus={() => setHoverIdx(history.length - 1)} onBlur={() => setHoverIdx(null)}
            />}
            <svg
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              className="h-full w-full"
            >
              <defs>
                <linearGradient id="netRxGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00D5E8" stopOpacity="0.24" />
                  <stop offset="100%" stopColor="#00D5E8" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="netTxGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#818CF8" stopOpacity="0.18" />
                  <stop offset="100%" stopColor="#818CF8" stopOpacity="0" />
                </linearGradient>
              </defs>

              {[0.25, 0.5, 0.75].map((ratio) => (
                <line
                  key={ratio}
                  x1={0}
                  y1={height * ratio}
                  x2={width}
                  y2={height * ratio}
                  stroke="#202B38"
                  strokeOpacity="0.7"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
              ))}

              <path d={txPaths.area} fill="url(#netTxGrad)" />
              <path
                d={txPaths.line}
                fill="none"
                stroke="#818CF8"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />

              <path d={rxPaths.area} fill="url(#netRxGrad)" />
              <path
                d={rxPaths.line}
                fill="none"
                stroke="#00D5E8"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>

            {history.length === 0 && <p>Ожидание первого измерения</p>}
            {txLast && (
              <div
                className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-400 shadow-[0_0_6px_rgba(129,140,248,0.85)]"
                style={{ left: `${(txLast.x / width) * 100}%`, top: `${(txLast.y / height) * 100}%` }}
              />
            )}
            {rxLast && (
              <div
                className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${(rxLast.x / width) * 100}%`, top: `${(rxLast.y / height) * 100}%` }}
              >
                <span className="block h-2.5 w-2.5 rounded-full bg-[#00D5E8] shadow-[0_0_8px_rgba(0,213,232,0.9)]" />
              </div>
            )}

            {hovered && hoveredRx && hoveredTx && (
              <>
                <div
                  className="pointer-events-none absolute inset-y-0 w-px bg-[#00D5E8]/35"
                  style={{ left: `${hoverX}%` }}
                />
                <div
                  className="pointer-events-none absolute top-2 z-20 -translate-x-1/2 rounded-md border border-[#202B38] bg-[#10151D]/95 px-2.5 py-1 font-mono text-[11px] shadow-lg"
                  style={{ left: `${Math.min(82, Math.max(18, hoverX))}%` }}
                >
                  <span className="text-[#8292A3]">{hovered.ts}</span>{" "}
                  <span className="text-[#00D5E8]">
                    ↓ {hoveredRx.value} {hoveredRx.unit}
                  </span>{" "}
                  <span className="text-indigo-300">
                    ↑ {hoveredTx.value} {hoveredTx.unit}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap justify-between gap-2 px-0.5 font-mono text-[11px] text-[#526170] sm:pl-[92px]">
          <span>{history[0]?.ts ?? "—"}</span>
          <span>Трафик адаптера</span>
          <span>{history[history.length - 1]?.ts ?? "—"}</span>
        </div>
      </div>
    </section>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#202B38]/60 py-2 last:border-0">
      <span className="shrink-0 text-xs text-[#8292A3]">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-xs text-[#E5EDF5] ${mono ? "font-mono" : "font-medium"}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function NetworkOverview({ c, active }: { c: NexusController; active: boolean }) {
  const { netSnapshot, netSnapshotError, selectedAdapterId, setSelectedAdapterId, netSpeedHistory, refreshNetworkTelemetry } = c;
  const [unitMode, setUnitMode] = useWorkspaceState<"mbps" | "mbs">("network.unitMode", "mbps");
  const [latestProbe, setLatestProbe] = useState<NetworkHealthProbe | null>(null);
  const [rttHistory, setRttHistory] = useState<RttSample[]>([]);
  const [probing, setProbing] = useState(false);
  const [probeFailure, setProbeFailure] = useState<string | null>(null);
  const probeScope = useRef<{ pending: boolean } | null>(null);

  const visibleAdapters: NetworkAdapterInfo[] = useMemo(() => {
    const all = netSnapshot?.adapters ?? [];
    const primaryList = all.filter((a) => !a.is_system_tunnel);
    return primaryList.length > 0 ? primaryList : all;
  }, [netSnapshot]);

  const activeAdapter: NetworkAdapterInfo | undefined = useMemo(() => {
    const all = netSnapshot?.adapters ?? [];
    return (
      all.find((a) => a.id === selectedAdapterId) ??
      all.find((a) => a.id === netSnapshot?.active_adapter_id) ??
      visibleAdapters[0]
    );
  }, [netSnapshot, selectedAdapterId, visibleAdapters]);

  const activeGateway = activeAdapter?.gateways[0] ?? null;

  useEffect(() => {
    setLatestProbe(null);
    setRttHistory([]);
    setProbeFailure(null);
  }, [activeAdapter?.id, activeGateway]);

  const runHealthProbe = useCallback(async () => {
    const scope = probeScope.current;
    if (!scope || scope.pending) return;
    scope.pending = true;
    setProbing(true);
    try {
      const sample = await invoke<NetworkHealthProbe>("probe_network_health", {
        gatewayIp: activeGateway,
        externalHost: "1.1.1.1",
      });
      if (probeScope.current === scope) {
        setLatestProbe(sample);
        setRttHistory(previous => appendRtt(previous, {
          host: sample.external_host,
          timestamp_ms: sample.timestamp_ms,
          method: sample.external_method,
          route: sample.external_route ?? null,
          rtt_ms: sample.external_ping_ms,
        }));
        setProbeFailure(null);
      }
    } catch (err) {
      if (probeScope.current === scope) {
        setLatestProbe(null);
        setRttHistory([]);
        setProbeFailure(String(err));
      }
    } finally {
      scope.pending = false;
      if (probeScope.current === scope) setProbing(false);
    }
  }, [activeGateway]);

  useEffect(() => {
    if (!active) return;
    probeScope.current = { pending: false };
    void runHealthProbe();
    const timer = window.setInterval(() => {
      void runHealthProbe();
    }, 2500);
    return () => {
      probeScope.current = null;
      window.clearInterval(timer);
    };
  }, [active, activeAdapter?.id, runHealthProbe]);

  const { avgMs: avgPing, jitterMs, successes, lossPct: packetLossPct } = summarizeRtt(rttHistory);

  const errorsTotal = activeAdapter ? activeAdapter.rx_errors + activeAdapter.tx_errors : 0;
  const droppedTotal = activeAdapter ? activeAdapter.rx_dropped + activeAdapter.tx_dropped : 0;

  return (
    <div className="space-y-4">
      {netSnapshotError && <p role="alert" className="nexus-message nexus-message--error">
        {netSnapshot ? "Не удалось обновить адаптеры. Показан последний замер." : "Не удалось прочитать сетевые адаптеры."} {netSnapshotError}
      </p>}
      <div className="tactical-card flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#8292A3]">
            <Network size={14} className="text-[#00D5E8]" />
            Адаптер:
          </span>
          {visibleAdapters.length === 0 ? (
            <span className="text-xs text-[var(--nexus-muted)]">{netSnapshotError ? "Список недоступен" : netSnapshot ? "Интерфейсы не обнаружены" : "Опрос интерфейсов Windows…"}</span>
          ) : (
            visibleAdapters.map((adapter) => {
              const selected = activeAdapter?.id === adapter.id;
              const IconComp = adapter.adapter_kind === "wifi" ? Wifi : Cable;
              return (
                <button
                  key={adapter.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSelectedAdapterId(adapter.id)}
                  className={`inline-flex max-w-[260px] cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                    selected
                      ? "border-[#00D5E8]/45 bg-[#00D5E8]/12 text-[#00D5E8]"
                      : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
                  }`}
                >
                  <IconComp size={12} className="shrink-0" />
                  <span className="truncate font-medium">{adapter.name}</span>
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      adapter.is_connected ? "bg-emerald-400" : "bg-[#526170]"
                    }`}
                  />
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!activeAdapter}
            onClick={() => void refreshNetworkTelemetry(true)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-1.5 text-xs font-medium text-[#8292A3] transition-colors hover:border-[#00D5E8]/35 hover:text-[#E5EDF5]"
          >
            <RotateCcw size={12} />
            Сброс сессии
          </button>
        </div>
      </div>

      {activeAdapter && <LiveNetworkSpeedChart
        history={netSpeedHistory}
        currentRx={activeAdapter.rx_bytes_per_sec}
        currentTx={activeAdapter.tx_bytes_per_sec}
        unitMode={unitMode}
        onUnitChange={setUnitMode}
      />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <section className="tactical-card tactical-brackets rounded-xl p-4 lg:col-span-6">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#202B38] pb-3">
            <div className="flex items-center gap-2">
              <Router size={15} className="text-[#00D5E8]" />
              <h3 className="text-sm font-semibold text-[#E5EDF5]">Состояние подключения</h3>
            </div>
            {activeAdapter && (
              <div className="flex items-center gap-1.5">
                <span
                  className={`rounded border px-2 py-0.5 font-mono text-[10px] font-medium ${
                    activeAdapter.is_physical
                      ? "border-[#00D5E8]/35 bg-[#00D5E8]/10 text-[#00D5E8]"
                      : "border-indigo-500/35 bg-indigo-500/10 text-indigo-300"
                  }`}
                >
                  {activeAdapter.is_physical ? "Физический" : "Виртуальный"}
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                    activeAdapter.is_connected
                      ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
                      : "border-[#202B38] bg-[#151C26] text-[#8292A3]"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      activeAdapter.is_connected ? "bg-emerald-400" : "bg-[#526170]"
                    }`}
                  />
                  {activeAdapter.status_label}
                </span>
              </div>
            )}
          </div>

          {!activeAdapter ? (
            <div className="py-10 text-center text-sm text-[#8292A3]">
              Сетевой интерфейс не выбран
            </div>
          ) : (
            <div className="mt-2">
              <InfoRow label="Адаптер" value={activeAdapter.name} />
              <InfoRow label="Контроллер" value={activeAdapter.description} />
              <InfoRow label="Производитель" value={activeAdapter.manufacturer} />
              <InfoRow label="Тип сети" value={activeAdapter.adapter_type_label} />
              <InfoRow
                label="Скорость соединения"
                value={formatLinkSpeed(activeAdapter.link_speed_bps)}
                mono
              />
              <InfoRow
                label="IPv4-адрес"
                value={activeAdapter.ipv4_addresses.join(", ") || "Не назначен"}
                mono
              />
              <InfoRow
                label="IPv6-адрес"
                value={activeAdapter.ipv6_addresses[0] || "Не назначен"}
                mono
              />
              <InfoRow
                label="Шлюз по умолчанию"
                value={activeAdapter.gateways.join(", ") || "Не настроен"}
                mono
              />
              <InfoRow
                label="DNS-серверы"
                value={activeAdapter.dns_servers.join(", ") || "Авто / Не заданы"}
                mono
              />
              <InfoRow
                label="MAC-адрес"
                value={activeAdapter.mac_address || "Н/Д"}
                mono
              />
            </div>
          )}
        </section>

        <div className="space-y-4 lg:col-span-6">
          <section className="tactical-card tactical-brackets rounded-xl p-4">
            <div className="flex items-center justify-between border-b border-[#202B38] pb-3">
              <div className="flex items-center gap-2">
                <Activity size={15} className="text-[#00D5E8]" />
                <h3 className="text-sm font-semibold text-[#E5EDF5]">Статистика трафика</h3>
              </div>
              <span className="font-mono text-[10px] text-[#526170]">Счётчики адаптера</span>
            </div>

            {activeAdapter ? <div className="mt-3 grid grid-cols-2 gap-2.5">
              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2.5">
                <div className="text-[11px] text-[#8292A3]">Получено за сессию</div>
                <div className="mt-1 font-mono text-base font-bold text-[#00D5E8]">
                  {formatBytes(activeAdapter.session_rx_bytes)}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-[#526170]">
                  Всего ОС: {formatBytes(activeAdapter.total_rx_bytes)}
                </div>
              </div>
              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2.5">
                <div className="text-[11px] text-[#8292A3]">Отправлено за сессию</div>
                <div className="mt-1 font-mono text-base font-bold text-indigo-300">
                  {formatBytes(activeAdapter.session_tx_bytes)}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-[#526170]">
                  Всего ОС: {formatBytes(activeAdapter.total_tx_bytes)}
                </div>
              </div>
              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2.5">
                <div className="text-[11px] text-[#8292A3]">Пакеты (RX / TX)</div>
                <div className="mt-1 font-mono text-sm font-semibold text-[#E5EDF5]">
                  {activeAdapter.rx_packets.toLocaleString("ru-RU")} /{" "}
                  {activeAdapter.tx_packets.toLocaleString("ru-RU")}
                </div>
              </div>
              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2.5">
                <div className="text-[11px] text-[#8292A3]">Ошибки / Потери (Drop)</div>
                <div
                  className={`mt-1 font-mono text-sm font-semibold ${
                    errorsTotal > 0 || droppedTotal > 0 ? "text-amber-300" : "text-emerald-300"
                  }`}
                >
                  {errorsTotal.toLocaleString("ru-RU")} / {droppedTotal.toLocaleString("ru-RU")}
                </div>
              </div>
            </div> : <p className="py-5 text-sm text-[var(--nexus-muted)]">Нет показаний адаптера</p>}
          </section>

          <section className="tactical-card tactical-brackets rounded-xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#202B38] pb-3">
              <div className="flex items-center gap-2">
                <Globe size={15} className="text-[#00D5E8]" />
                <h3 className="text-sm font-semibold text-[#E5EDF5]">Сетевая диагностика</h3>
              </div>
              <button
                type="button"
                disabled={probing}
                onClick={() => void runHealthProbe()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-1 font-mono text-[11px] font-medium text-[#00D5E8] hover:border-[#00D5E8]/40 disabled:opacity-60"
              >
                <RefreshCw size={11} className={probing ? "animate-spin" : ""} />
                Проверить
              </button>
            </div>

            {probeFailure && <p role="alert" className="nexus-message nexus-message--error mt-3">Не удалось проверить канал. {probeFailure}</p>}
            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                <div className="text-[11px] text-[#8292A3]">Доступность шлюза</div>
                <div
                  className={`mt-0.5 font-mono text-sm font-bold ${
                    !activeGateway
                      ? "text-[#526170]"
                      : latestProbe?.gateway_reachable
                      ? "text-emerald-300"
                      : "text-rose-400"
                  }`}
                >
                  {!activeGateway
                    ? "Нет шлюза"
                    : latestProbe?.gateway_reachable
                    ? latestProbe.gateway_ping_ms === 0
                      ? "<1 мс · ОК"
                      : `${latestProbe.gateway_ping_ms} мс · ОК`
                    : latestProbe
                    ? "Недоступен"
                    : probeFailure ? "Нет замера" : "Замер…"}
                </div>
              </div>

              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                <div className="text-[11px] text-[#8292A3]">Внешний канал (1.1.1.1)</div>
                <div
                  className={`mt-0.5 font-mono text-sm font-bold ${
                    latestProbe == null
                      ? "text-[#526170]"
                      : latestProbe.external_reachable
                      ? "text-[#00D5E8]"
                      : "text-rose-400"
                  }`}
                >
                  {latestProbe == null
                    ? (probeFailure ? "Нет замера" : "Замер…")
                    : latestProbe.external_reachable
                    ? `${latestProbe.external_ping_ms === 0 ? "<1" : latestProbe.external_ping_ms ?? "—"} мс (${latestProbe.external_method})`
                    : "Нет ответа"}
                </div>
              </div>

              <div className="col-span-2 rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2 sm:col-span-1">
                <div className="text-[11px] text-[#8292A3]">Средний Ping</div>
                <div className="mt-0.5 font-mono text-sm font-bold text-[#E5EDF5]">
                  {avgPing !== null ? `${avgPing.toFixed(1)} мс` : "—"}
                </div>
              </div>

              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                <div className="text-[11px] text-[#8292A3]" title={JITTER_HELP}>Джиттер (Jitter)</div>
                <div className="mt-0.5 font-mono text-sm font-semibold text-[#E5EDF5]">
                  {formatJitter(jitterMs)}
                </div>
              </div>

              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                <div className="text-[11px] text-[#8292A3]" title="Доля проб без ответа. ICMP и резервная TCP-проба могут использоваться в одной попытке.">Пробы без ответа</div>
                <div
                  className={`mt-0.5 font-mono text-sm font-semibold ${
                    packetLossPct == null
                      ? "text-[#526170]"
                      : packetLossPct === 0
                      ? "text-emerald-300"
                      : packetLossPct < 5
                      ? "text-amber-300"
                      : "text-rose-400"
                  }`}
                >
                  {packetLossPct !== null ? `${packetLossPct.toFixed(1)}%` : "—"}
                </div>
              </div>

              <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3 py-2">
                <div className="text-[11px] text-[#8292A3]">Серия замеров</div>
                <div className="mt-0.5 font-mono text-sm font-semibold text-[#8292A3]">
                  {successes}/{rttHistory.length} ОК
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

    </div>
  );
}

const PROBE_TARGETS = [
  { label: "СНГ / Москва", host: "162.159.135.234" },
  { label: "Европа / Cloudflare", host: "1.0.0.1" },
  { label: "Магистраль DNS 1.1.1.1", host: "1.1.1.1" },
];

interface StabilityReport {
  sent: number;
  received: number;
  loss_percent: number;
  min_ms: number | null;
  avg_ms: number | null;
  max_ms: number | null;
  jitter_ms: number | null;
}

const formatRtt = (value: number | null, digits = 0) =>
  value === null ? "Н/Д" : `${value.toFixed(digits)} мс`;

interface DnsBenchRow {
  name: string;
  server: string;
  ms: number | null;
  method?: string;
}

function NetworkToolkit({ view, active }: { view: "overview" | "sockets" | "diagnostics" | "optimizer"; active: boolean }) {
  const [host, setHost] = useState(PROBE_TARGETS[0].host);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [report, setReport] = useState<StabilityReport | null>(null);
  const [probeError, setProbeError] = useState("");
  const [dnsRows, setDnsRows] = useState<DnsBenchRow[]>([]);
  const [dnsBusy, setDnsBusy] = useState(false);
  const [dnsError, setDnsError] = useState("");
  const [optStatus, setOptStatus] = useState<NetworkOptimizerStatus | null>(null);
  const [optBusy, setOptBusy] = useState<"packet" | "ethernet" | null>(null);
  const [optNotice, setOptNotice] = useState<string | null>(null);
  const [optError, setOptError] = useState<string | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const requestedInitialStatus = useRef(false);

  const loadOptimizerStatus = useCallback(async () => {
    try {
      const next = await invoke<NetworkOptimizerStatus>("get_network_optimizer_status");
      setOptStatus(next);
    } catch (error) {
      setOptStatus(null);
      setOptError(String(error));
    }
  }, []);

  useEffect(() => {
    if (view === "optimizer" && active && !requestedInitialStatus.current) {
      requestedInitialStatus.current = true;
      void loadOptimizerStatus();
    }
  }, [active, view, loadOptimizerStatus]);

  useEffect(() => () => {
      if (progressTimerRef.current) {
        clearInterval(progressTimerRef.current);
      }
  }, []);

  const handleTogglePacketPriority = async () => {
    if (!optStatus || optBusy) return;
    const nextEnabled = !optStatus.packet_priority_enabled;
    setOptBusy("packet");
    setOptError(null);
    setOptNotice(null);
    try {
      const msg = await invoke<string>("set_packet_priority", { enabled: nextEnabled });
      setOptNotice(msg);
    } catch (err) {
      setOptError(String(err));
    } finally {
      await loadOptimizerStatus();
      setOptBusy(null);
    }
  };

  const handleToggleEthernetTuned = async () => {
    if (!optStatus || optBusy) return;
    const nextEnabled = !optStatus.ethernet_tuned;
    setOptBusy("ethernet");
    setOptError(null);
    setOptNotice(null);
    try {
      const msg = await invoke<string>("set_ethernet_tuned", { enabled: nextEnabled });
      setOptNotice(msg);
    } catch (err) {
      setOptError(String(err));
    } finally {
      await loadOptimizerStatus();
      setOptBusy(null);
    }
  };

  const fastest = dnsRows.reduce<number | null>((best, row) => {
    if (row.ms == null) return best;
    return best == null ? row.ms : Math.min(best, row.ms);
  }, null);

  const lossClass = !report
    ? "text-[#8292A3]"
    : report.loss_percent === 0
    ? "text-[#00D5E8]"
    : report.loss_percent < 5
    ? "text-amber-300"
    : "text-rose-300";

  return (
    <div hidden={view !== "optimizer" && view !== "diagnostics"}>
      <section hidden={view !== "optimizer"} className="nexus-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#202B38] pb-3">
          <div>
            <h3 className="text-sm font-semibold text-[#E5EDF5]">
              Оптимизация сетевого стека и адаптера (Network Optimizer)
            </h3>
            <p className="mt-0.5 text-xs text-[#8292A3]">
              Перед изменением системных параметров сохраняет исходные значения реестра и драйвера по GUID адаптера для точного отката
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadOptimizerStatus()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-1 text-xs text-[#8292A3] hover:text-[#E5EDF5]"
          >
            <RefreshCw size={11} />
            Обновить статус
          </button>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[#202B38] bg-[#0B0E14] p-3.5">
            <div className="min-w-0">
              <div className="text-sm font-medium text-[#E5EDF5]">Приоритет сетевых пакетов (MMCSS)</div>
              <div className="mt-0.5 text-xs text-[#8292A3]">
                {optStatus?.packet_priority_has_backup
                  ? "Исходные значения NetworkThrottlingIndex и SystemResponsiveness сохранены в резервной копии"
                  : "При включении сохранит текущие значения Windows перед изменением"}
              </div>
            </div>
            <button
              type="button"
              disabled={!optStatus || optBusy !== null}
              onClick={() => void handleTogglePacketPriority()}
              className={`shrink-0 cursor-pointer rounded-lg border px-3 py-1.5 font-mono text-xs font-semibold transition-colors disabled:opacity-50 ${
                optStatus?.packet_priority_enabled
                  ? "border-[#00D5E8]/45 bg-[#00D5E8]/15 text-[#00D5E8]"
                  : "border-[#202B38] bg-[#151C26] text-[#E5EDF5] hover:border-[#00D5E8]/35"
              }`}
            >
              {optBusy === "packet"
                ? "ПРИМЕНЕНИЕ…"
                : optStatus?.packet_priority_enabled
                ? "ВКЛЮЧЕНО · ОТКАТИТЬ"
                : "ВКЛЮЧИТЬ"}
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-[#202B38] bg-[#0B0E14] p-3.5">
            <div className="min-w-0">
              <div className="text-sm font-medium text-[#E5EDF5]">Тюнинг Ethernet (EEE / Interrupts)</div>
              <div className="mt-0.5 text-xs text-[#8292A3]">
                {optStatus?.ethernet_has_backup
                  ? `Сохранена резервная копия драйвера для адаптеров: ${optStatus.backed_up_adapters_count}`
                  : "Отключает энергосбережение EEE и снижает задержки с транзакционным откатом"}
              </div>
            </div>
            <button
              type="button"
              disabled={!optStatus || optBusy !== null}
              onClick={() => void handleToggleEthernetTuned()}
              className={`shrink-0 cursor-pointer rounded-lg border px-3 py-1.5 font-mono text-xs font-semibold transition-colors disabled:opacity-50 ${
                optStatus?.ethernet_tuned
                  ? "border-[#00D5E8]/45 bg-[#00D5E8]/15 text-[#00D5E8]"
                  : "border-[#202B38] bg-[#151C26] text-[#E5EDF5] hover:border-[#00D5E8]/35"
              }`}
            >
              {optBusy === "ethernet"
                ? "ПРИМЕНЕНИЕ…"
                : optStatus?.ethernet_tuned
                ? "ОПТИМИЗИРОВАНО · ВОССТАНОВИТЬ"
                : "ОПТИМИЗИРОВАТЬ"}
            </button>
          </div>
        </div>

        {optNotice && (
          <div className="mt-3 rounded-lg border border-[#00D5E8]/35 bg-[#00D5E8]/10 px-3 py-2 text-xs text-[#00D5E8]">
            {optNotice}
          </div>
        )}
        {optError && (
          <div className="mt-3 rounded-lg border border-rose-500/35 bg-rose-500/12 px-3 py-2 text-xs text-rose-300">
            {optError}
          </div>
        )}
      </section>

      <div hidden={view !== "diagnostics"} className="avs-network-tools">
      <section className="nexus-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[#E5EDF5]">
              Тест стабильности маршрута (Ping & Jitter Probe)
            </h3>
            <p className="mt-0.5 text-xs text-[#8292A3]">
              Серия из 30 замеров для оценки джиттера и процента потерь пакетов
            </p>
          </div>
          <button
            type="button"
            disabled={running}
            onClick={() => {
              setRunning(true);
              setProgress(0);
              setProbeError("");
              setReport(null);
              if (progressTimerRef.current) {
                clearInterval(progressTimerRef.current);
              }
              progressTimerRef.current = window.setInterval(() => {
                void invoke<number>("get_stability_progress").then(setProgress).catch(() => undefined);
              }, 250);
              void invoke<StabilityReport>("run_stability_probe", { host })
                .then((next) => {
                  setReport(next);
                  setProgress(next.sent);
                })
                .catch((err) => setProbeError(String(err)))
                .finally(() => {
                  if (progressTimerRef.current) {
                    clearInterval(progressTimerRef.current);
                    progressTimerRef.current = null;
                  }
                  setRunning(false);
                });
            }}
            className="cyber-btn cursor-pointer px-4 py-2 font-mono text-xs font-semibold text-[#00D5E8] disabled:opacity-50"
          >
            {running ? "ВЫПОЛНЯЕТСЯ ТЕСТ…" : "ЗАПУСТИТЬ ТЕСТ СТАБИЛЬНОСТИ"}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {PROBE_TARGETS.map((target) => (
            <button
              key={target.host}
              type="button"
              onClick={() => setHost(target.host)}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium ${
                host === target.host
                  ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                  : "border-[#202B38] bg-[#0B0E14] text-[#8292A3] hover:text-[#E5EDF5]"
              }`}
            >
              {target.label} <span className="ml-1 font-mono text-[11px] opacity-75">({target.host})</span>
            </button>
          ))}
        </div>

        {(running || progress > 0) && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between font-mono text-[11px] text-[#8292A3]">
              <span>Отправлено пакетов</span>
              <span className="text-[#00D5E8]">{Math.min(progress, 30)} / 30</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[#0B0E14]">
              <div
                className="h-full bg-gradient-to-r from-[#00D5E8] to-[#36AFC0]"
                style={{ width: `${Math.min(100, (progress / 30) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {probeError && <p className="mt-2 text-xs text-rose-300">{probeError}</p>}

        {report && (
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3.5 py-2.5">
              <div className="text-[11px] text-[#8292A3]">Минимальный пинг</div>
              <div className="mt-0.5 font-mono text-base font-bold text-[#E5EDF5]">{formatRtt(report.min_ms)}</div>
            </div>
            <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3.5 py-2.5">
              <div className="text-[11px] text-[#8292A3]">Средний пинг</div>
              <div className="mt-0.5 font-mono text-base font-bold text-[#00D5E8]">
                {formatRtt(report.avg_ms, 1)}
              </div>
            </div>
            <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3.5 py-2.5">
              <div className="text-[11px] text-[#8292A3]">Максимальный пинг</div>
              <div className="mt-0.5 font-mono text-base font-bold text-[#E5EDF5]">{formatRtt(report.max_ms)}</div>
            </div>
            <div className="rounded-lg border border-[#202B38] bg-[#0B0E14] px-3.5 py-2.5">
              <div className="text-[11px] text-[#8292A3]">Потери и джиттер</div>
              <div className={`mt-0.5 font-mono text-sm font-bold ${lossClass}`}>
                Потери: {report.loss_percent.toFixed(1)}%
              </div>
              <div className="font-mono text-[11px] text-[#8292A3]">
                Станд. отклонение RTT: {formatRtt(report.jitter_ms, 1)}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="nexus-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#202B38] px-5 py-3.5">
          <div>
            <h3 className="text-sm font-semibold text-[#E5EDF5]">Сравнение резолверов DNS</h3>
            <p className="text-xs text-[#8292A3]">Замер времени отклика публичных и провайдерских серверов</p>
          </div>
          <button
            type="button"
            disabled={dnsBusy}
            onClick={() => {
              setDnsBusy(true);
              setDnsError("");
              void invoke<DnsBenchRow[]>("benchmark_dns")
                .then(setDnsRows)
                .catch((err) => setDnsError(String(err)))
                .finally(() => setDnsBusy(false));
            }}
            className="cyber-btn cursor-pointer px-4 py-2 font-mono text-xs font-semibold text-[#00D5E8] disabled:opacity-50"
          >
            {dnsBusy ? "ИЗМЕРЕНИЕ…" : "ТЕСТИРОВАТЬ СКОРОСТЬ DNS"}
          </button>
        </div>
        {dnsError && <p className="px-5 py-2 text-xs text-rose-300">{dnsError}</p>}
        <table className="w-full text-left text-xs">
          <thead className="border-b border-[#202B38] bg-[#0B0E14] text-[#8292A3]">
            <tr>
              <th className="px-5 py-2.5 font-medium">Провайдер DNS</th>
              <th className="px-5 py-2.5 font-medium">Узел</th>
              <th className="px-5 py-2.5 font-medium">Метод</th>
              <th className="px-5 py-2.5 font-medium">Время отклика</th>
            </tr>
          </thead>
          <tbody>
            {(dnsRows.length > 0
              ? dnsRows
              : [
                  { name: "Cloudflare DNS", server: "1.1.1.1", ms: null, method: "UDP DNS" },
                  { name: "Google Public DNS", server: "8.8.8.8", ms: null, method: "UDP DNS" },
                  { name: "Quad9 Security DNS", server: "9.9.9.9", ms: null, method: "UDP DNS" },
                  { name: "Текущий провайдер", server: "Системный", ms: null, method: "UDP DNS" },
                ]
            ).map((row) => (
              <tr key={row.name} className="border-b border-[#202B38]/60 last:border-0">
                <td className="px-5 py-3 text-[#E5EDF5]">
                  <span className="font-medium">{row.name}</span>
                  {fastest != null && row.ms === fastest && (
                    <span className="ml-2 rounded border border-[#00D5E8]/35 bg-[#00D5E8]/12 px-2 py-0.5 font-mono text-[10px] font-semibold text-[#00D5E8]">
                      Оптимальный
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 font-mono text-[#8292A3]">{row.server}</td>
                <td className="px-5 py-3">
                  <span className="rounded border border-[#202B38] bg-[#0B0E14] px-2 py-0.5 font-mono text-[10px] text-[#8292A3]">
                    {row.method || "UDP DNS"}
                  </span>
                </td>
                <td className="px-5 py-3 font-mono font-semibold text-[#E5EDF5]">
                  {row.ms == null
                    ? <span className="text-[#8292A3]">{dnsRows.length ? "Нет результатов" : "Не проверено"}</span>
                    : `${row.ms} мс`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      </div>
    </div>
  );
}
