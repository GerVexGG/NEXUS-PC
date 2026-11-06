import { useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  AppWindow,
  FolderOpen,
  RefreshCw,
  Search,
  SearchX,
  ShieldCheck,
} from "lucide-react";
import type { StartupItem } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

type StartupFilter = "all" | "on" | "off";

function sourceBadge(location: string): string {
  const value = location.toLowerCase();
  if (value.includes("hkcu")) return "HKCU Run";
  if (value.includes("hklm")) return "HKLM Run";
  if (value.includes("папк")) return "Папка Автозапуск";
  return location;
}

function folderHint(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  const skip = new Set([
    "program files",
    "program files (x86)",
    "windows",
    "users",
    "appdata",
    "local",
    "roaming",
    "programdata",
  ]);
  const named = parts.filter((part) => !/^[a-z]:$/i.test(part) && !skip.has(part.toLowerCase()));
  if (named.length >= 2) return named[named.length - 2];
  return named[0] ?? "";
}

export function StartupModule({ c }: { c: NexusController }) {
  const {
    startupSearch,
    setStartupSearch,
    startupLoading,
    startupError,
    fetchStartupItems,
    handleToggleStartup,
    handleOpenItemLocation,
    totalStartupCount,
    filteredStartupItems,
  } = c;
  const [statusFilter, setStatusFilter] = useState<StartupFilter>("all");

  const visibleItems = filteredStartupItems.filter((item) => {
    if (statusFilter === "on") return item.enabled;
    if (statusFilter === "off") return !item.enabled;
    return true;
  });
  const searchActive = startupSearch.trim().length > 0 || statusFilter !== "all";

  return (
    <motion.div
      key="startup"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="w-full max-w-6xl space-y-4"
    >
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-2xl font-semibold text-slate-100">Автозагрузка программ</h2>
          <p className="mt-1 text-sm text-slate-400">Управление приложениями при старте Windows</p>
        </div>
        <button
          type="button"
          onClick={() => void fetchStartupItems()}
          disabled={startupLoading}
          className="inline-flex items-center gap-2 self-start rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-[#1a2332] disabled:opacity-60"
        >
          <RefreshCw size={14} className={startupLoading ? "animate-spin" : ""} />
          Обновить список
        </button>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["all", "Все"],
              ["on", "Включенные"],
              ["off", "Отключенные"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setStatusFilter(id)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                statusFilter === id
                  ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                  : "border-[#222b38] bg-[#111722] text-slate-400 hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={startupSearch}
            onChange={(e) => setStartupSearch(e.target.value)}
            placeholder="Поиск по имени"
            className="w-full rounded-lg border border-[#222b38] bg-[#111722] py-2 pl-9 pr-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-slate-500"
          />
        </div>
      </div>

      {startupError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {startupError}
        </div>
      )}

      {visibleItems.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-[#222b38] bg-[#111722] px-6 py-16 text-center">
          {searchActive ? (
            <SearchX size={28} className="mb-3 text-slate-500" />
          ) : (
            <ShieldCheck size={28} className="mb-3 text-slate-500" />
          )}
          <h3 className="text-base font-semibold text-slate-100">
            {startupLoading
              ? "Читаем список автозагрузки"
              : searchActive
                ? "Ничего не найдено"
                : "Записей автозапуска не обнаружено"}
          </h3>
          <p className="mt-1 max-w-md text-sm text-slate-400">
            {searchActive
              ? "Измените фильтр или строку поиска."
              : totalStartupCount === 0
                ? "Реестр и папка автозапуска сейчас пусты."
                : "Подходящих записей нет."}
          </p>
          <button
            type="button"
            onClick={() => void fetchStartupItems()}
            disabled={startupLoading}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[#222b38] bg-[#151c27] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-[#1a2332] disabled:opacity-60"
          >
            <RefreshCw size={14} className={startupLoading ? "animate-spin" : ""} />
            Повторить сканирование
          </button>
        </div>
      ) : (
        <div className="divide-y divide-[#222b38]/50 overflow-hidden rounded-xl border border-[#222b38] bg-[#111722]">
          {visibleItems.map((item) => (
            <StartupRow
              key={item.id}
              item={item}
              onOpen={() => void handleOpenItemLocation(item)}
              onToggle={() => void handleToggleStartup(item)}
            />
          ))}
        </div>
      )}
    </motion.div>
  );
}

function StartupRow({
  item,
  onOpen,
  onToggle,
}: {
  item: StartupItem;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const path = item.clean_path || item.command;
  const hint = folderHint(path);

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
          item.file_exists
            ? "border-[#222b38] bg-[#151c27] text-slate-300"
            : "border-rose-500/30 bg-rose-500/10 text-rose-300"
        }`}
      >
        {item.file_exists ? <AppWindow size={16} /> : <AlertTriangle size={16} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-100">{item.name}</div>
        <div className="truncate text-xs text-slate-400">
          {hint && <span>{hint} · </span>}
          <span className="font-mono">{path}</span>
        </div>
      </div>
      <span className="hidden shrink-0 rounded-md border border-[#222b38] px-2 py-1 text-xs text-slate-400 sm:inline">
        {sourceBadge(item.location)}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#222b38] bg-[#151c27] px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-[#1a2332]"
      >
        <FolderOpen size={13} />
        Открыть папку
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={item.enabled}
        onClick={onToggle}
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
          item.enabled ? "border-sky-500/40 bg-sky-500/30" : "border-[#222b38] bg-[#151c27]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
            item.enabled ? "left-4 bg-sky-300" : "left-0.5 bg-slate-500"
          }`}
        />
      </button>
    </div>
  );
}
