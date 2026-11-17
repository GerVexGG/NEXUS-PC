import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  AppWindow,
  FolderOpen,
  RefreshCw,
  Search,
  SearchX,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { PageHeader, getLocationBadgeStyles, type StartupItem } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";

function sourceBadge(location: string): string {
  const value = location.toLowerCase();
  if (value.includes("store") || value.includes("приложен")) return "Microsoft Store";
  if (value.includes("планировщик") || value.includes("cim")) return "Планировщик";
  if (value.includes("общая")) return "Общая папка";
  if (value.includes("hkcu")) return "HKCU Run";
  if (value.includes("hklm")) return "HKLM Run";
  if (value.includes("папк")) return "Autorun";
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
    startupFilter: statusFilter,
    setStartupFilter: setStatusFilter,
    startupLoading,
    startupError,
    fetchStartupItems,
    handleToggleStartup,
    handleRemoveStartup,
    handleOpenItemLocation,
    totalStartupCount,
    activeStartupCount,
    filteredStartupItems,
    startupItems,
  } = c;
  const [phantomsOnly, setPhantomsOnly] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<StartupItem | null>(null);
  const phantomCount = useMemo(
    () => startupItems.filter((item) => item.phantom).length,
    [startupItems]
  );
  const enabledNonPhantomCount = useMemo(
    () => startupItems.filter((item) => item.enabled && !item.phantom).length,
    [startupItems]
  );
  const disabledNonPhantomCount = useMemo(
    () => startupItems.filter((item) => !item.enabled && !item.phantom).length,
    [startupItems]
  );

  const visibleItems = useMemo(() => {
    if (!phantomsOnly) return filteredStartupItems;
    return filteredStartupItems.filter((item) => item.phantom);
  }, [filteredStartupItems, phantomsOnly]);

  const searchActive = startupSearch.trim().length > 0 || statusFilter !== "all" || phantomsOnly;

  return (
    <motion.div
      key="startup"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="w-full space-y-4"
    >
      <PageHeader
        title="Автозагрузка"
        description="Управление программами, службами и ключами реестра, запускаемыми вместе с Windows"
        badge={
          <span className="rounded-md border border-[#202B38] bg-[#151C26] px-2.5 py-0.5 font-mono text-xs text-[#8292A3]">
            Активно: <span className="font-semibold text-[#00D5E8]">{activeStartupCount}</span> из {totalStartupCount}
          </span>
        }
        actions={
          <button
            type="button"
            onClick={() => void fetchStartupItems()}
            disabled={startupLoading}
            className="cyber-btn inline-flex cursor-pointer items-center gap-2 px-3.5 py-2 text-xs font-medium text-[#00D5E8] disabled:opacity-60"
          >
            <RefreshCw size={14} className={startupLoading ? "animate-spin" : ""} />
            Обновить список
          </button>
        }
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["all", `Все (${totalStartupCount})`],
              ["on", `Включено (${enabledNonPhantomCount})`],
              ["off", `Отключено (${disabledNonPhantomCount})`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setStatusFilter(id)}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === id
                  ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                  : "border-[#202B38] bg-[#10151D] text-[#8292A3] hover:text-[#E5EDF5]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {phantomCount > 0 && (
          <button
            type="button"
            onClick={() => setPhantomsOnly((value) => !value)}
            className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              phantomsOnly
                ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                : "border-rose-500/25 bg-[#10151D] text-rose-300 hover:bg-rose-500/10"
            }`}
          >
            Осиротевшие ключи реестра: {phantomCount}
          </button>
        )}

        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#526170]"
          />
          <input
            type="text"
            value={startupSearch}
            onChange={(e) => setStartupSearch(e.target.value)}
            placeholder="Поиск по названию, пути или издателю…"
            className="w-full rounded-lg border border-[#202B38] bg-[#10151D] py-2 pl-9 pr-3 text-sm text-[#E5EDF5] outline-none placeholder:text-[#526170] focus:border-[#00D5E8]/50"
          />
        </div>
      </div>

      {startupError && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/12 px-4 py-2.5 text-xs text-rose-300">
          {startupError}
        </div>
      )}

      {visibleItems.length === 0 ? (
        <div className="tactical-card flex flex-col items-center rounded-xl px-6 py-16 text-center">
          {searchActive ? (
            <SearchX size={28} className="mb-3 text-[#526170]" />
          ) : (
            <ShieldCheck size={28} className="mb-3 text-[#00D5E8]" />
          )}
          <h3 className="text-base font-semibold text-[#E5EDF5]">
            {startupLoading
              ? "Опрос источников автозагрузки…"
              : searchActive
              ? "Совпадений не найдено"
              : "Элементы автозагрузки не обнаружены"}
          </h3>
          <p className="mt-1 max-w-md text-sm text-[#8292A3]">
            {searchActive
              ? "Попробуйте изменить фильтр состояния или поисковый запрос."
              : totalStartupCount === 0
              ? "Ветви реестра Run и папки автозапуска сейчас чисты."
              : "Подходящих записей в выбранной категории нет."}
          </p>
          <button
            type="button"
            onClick={() => void fetchStartupItems()}
            disabled={startupLoading}
            className="cyber-btn mt-4 inline-flex cursor-pointer items-center gap-2 px-3.5 py-2 text-xs font-medium text-[#00D5E8] disabled:opacity-60"
          >
            <RefreshCw size={14} className={startupLoading ? "animate-spin" : ""} />
            Повторить сканирование
          </button>
        </div>
      ) : (
        <div className="tactical-card tactical-brackets overflow-hidden rounded-xl">
          <div className="hidden grid-cols-12 items-center border-b border-[#202B38] bg-[#0B0E14] px-4 py-2.5 text-xs font-medium text-[#8292A3] sm:grid">
            <div className="col-span-6">Приложение и исполняемый путь</div>
            <div className="col-span-2">Источник</div>
            <div className="col-span-2">Состояние</div>
            <div className="col-span-2 text-right">Управление</div>
          </div>
          <div className="divide-y divide-[#202B38]/60">
            {visibleItems.map((item) => (
              <StartupRow
                key={item.id}
                item={item}
                onOpen={() => void handleOpenItemLocation(item)}
                onToggle={() => void handleToggleStartup(item)}
                onRemove={() => setPendingDelete(item)}
              />
            ))}
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-xl border border-[#202B38] bg-[#10151D] p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-[#E5EDF5]">
              Удаление записи автозагрузки
            </h3>
            <p className="mt-2 text-sm text-[#8292A3]">
              Удалить запись <span className="font-semibold text-[#E5EDF5]">{pendingDelete.name}</span> из источника{" "}
              <span className="font-mono text-xs text-[#00D5E8]">{sourceBadge(pendingDelete.location)}</span>?
            </p>
            <div className="mt-2 rounded-lg border border-[#202B38] bg-[#0B0E14] p-2.5 font-mono text-xs text-[#8292A3] break-all">
              {pendingDelete.clean_path || pendingDelete.command || "Путь не указан"}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="cursor-pointer rounded-lg border border-[#202B38] bg-[#151C26] px-3.5 py-2 text-xs font-medium text-[#8292A3] hover:text-[#E5EDF5]"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  const item = pendingDelete;
                  setPendingDelete(null);
                  void handleRemoveStartup(item);
                }}
                className="cyber-btn-danger cursor-pointer px-3.5 py-2 text-xs font-semibold text-rose-300"
              >
                Удалить запись
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function StartupRow({
  item,
  onOpen,
  onToggle,
  onRemove,
}: {
  item: StartupItem;
  onOpen: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const path = item.clean_path || item.command;
  const hint = folderHint(path);
  const badgeText = sourceBadge(item.location);
  const badgeStyle = getLocationBadgeStyles(badgeText);
  const canToggle =
    !item.phantom &&
    (item.id.startsWith("reg|") ||
      item.id.startsWith("dir|") ||
      item.id.startsWith("folder|") ||
      item.id.startsWith("msix|"));

  return (
    <div className="flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-[#151C26]/50 sm:grid sm:grid-cols-12 sm:items-center">
      <div className="flex min-w-0 items-center gap-3 sm:col-span-6">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
            item.file_exists
              ? "border-[#202B38] bg-[#0B0E14] text-[#00D5E8]"
              : "border-rose-500/35 bg-rose-500/12 text-rose-300"
          }`}
        >
          {item.file_exists ? <AppWindow size={16} /> : <AlertTriangle size={16} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-sm font-medium text-[#E5EDF5]">{item.name}</div>
            {item.phantom ? (
              <span className="shrink-0 rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] text-rose-300">
                Осиротевший ключ
              </span>
            ) : (
              !item.file_exists && (
                <span className="shrink-0 rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] text-rose-300">
                  Файл отсутствует
                </span>
              )
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-[#8292A3]" title={path}>
            {hint && <span className="text-[#E5EDF5]/80">{hint} · </span>}
            <span className="font-mono text-[11px]">{path}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center sm:col-span-2">
        <span className={`inline-flex rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium ${badgeStyle}`}>
          {badgeText}
        </span>
      </div>

      <div className="flex items-center gap-2 sm:col-span-2">
        {item.phantom || !item.file_exists ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-rose-300">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
            Недействителен
          </span>
        ) : item.enabled ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-[#00D5E8]/30 bg-[#00D5E8]/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-[#00D5E8]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#00D5E8]" />
            Включено
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-[#202B38] bg-[#151C26] px-2 py-0.5 font-mono text-[11px] font-medium text-[#8292A3]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#526170]" />
            Отключено
          </span>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 sm:col-span-2">
        {!item.phantom && item.file_exists && (
          <button
            type="button"
            onClick={onOpen}
            title="Показать файл в проводнике Windows"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#202B38] bg-[#0B0E14] px-2.5 py-1.5 text-xs font-medium text-[#8292A3] transition-colors hover:border-[#00D5E8]/40 hover:text-[#E5EDF5]"
          >
            <FolderOpen size={13} />
            <span className="hidden xl:inline">Папка</span>
          </button>
        )}

        {item.phantom || !item.file_exists ? (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/12 px-2.5 py-1.5 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/20"
          >
            <Trash2 size={13} />
            Удалить
          </button>
        ) : (
          <button
            type="button"
            role="switch"
            disabled={!canToggle}
            aria-checked={item.enabled}
            title={
              canToggle
                ? item.enabled
                  ? "Отключить автозапуск"
                  : "Включить автозапуск"
                : "Запись управляется системной политикой"
            }
            onClick={onToggle}
            className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              item.enabled
                ? "border-[#00D5E8]/50 bg-[#00D5E8]/25"
                : "border-[#202B38] bg-[#0B0E14]"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
                item.enabled ? "left-4 bg-[#00D5E8] shadow-[0_0_6px_rgba(0,213,232,0.8)]" : "left-0.5 bg-[#526170]"
              }`}
            />
          </button>
        )}
      </div>
    </div>
  );
}
