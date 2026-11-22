import { useWorkspaceState } from "../../hooks/useWorkspaceState";
import { ModuleHeader } from "../ui/ModuleHeader";
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
import { type StartupItem } from "../../lib/studio";
import type { NexusController } from "../../hooks/useNexusController";
import { UtilityConfirmDialog } from "../ui/UtilityConfirmDialog";

export function StartupModule({ c }: { c: NexusController }) {
  const {
    startupSearch,
    setStartupSearch,
    startupFilter: statusFilter,
    setStartupFilter: setStatusFilter,
    startupLoading,
    startupPendingId,
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
  const [phantomsOnly, setPhantomsOnly] = useWorkspaceState("startup.phantomsOnly", false);
  const [order, setOrder] = useWorkspaceState<"default" | "name" | "location">("startup.order", "default");
  const [source, setSource] = useWorkspaceState("startup.source", "");
  const sources = useMemo(() => [...new Set(startupItems.map((item) => item.location))]
    .sort((a, b) => a.localeCompare(b, "ru")), [startupItems]);
  const effectiveSource = sources.includes(source) ? source : "";

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
    const filtered = filteredStartupItems.filter((item) =>
      (!phantomsOnly || item.phantom) && (!effectiveSource || item.location === effectiveSource));
    return order === "default" ? filtered : [...filtered].sort((a, b) =>
      a[order].localeCompare(b[order], "ru", { sensitivity: "base" }) || a.name.localeCompare(b.name, "ru"));
  }, [filteredStartupItems, phantomsOnly, order, effectiveSource]);

  const searchActive = startupSearch.trim().length > 0 || statusFilter !== "all" || phantomsOnly || effectiveSource !== "";
  const canManage = !startupLoading && startupPendingId === null;
  const clearFilters = () => {
    setStartupSearch("");
    setSource("");
    setStatusFilter("all");
    setPhantomsOnly(false);
  };

  return (
    <motion.div
      key="startup"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="avs-module avs-startup w-full space-y-4"
    >
      <ModuleHeader module="startup"
        title="Автозагрузка"
        description="Программы и задачи, запускаемые при входе в Windows"
        actions={
          <button
            type="button"
            onClick={() => void fetchStartupItems()}
            disabled={!canManage}
            className="nexus-button"
          >
            <RefreshCw size={14} className={startupLoading ? "animate-spin" : ""} />
            {startupLoading ? "Обновление…" : "Обновить список"}
          </button>
        }
      />

      <div className="avs-startup-workspace">
      <aside className="nexus-panel avs-startup-index" aria-label="Источники автозагрузки">
        <h2>Источники</h2>
        <button type="button" aria-pressed={!effectiveSource} onClick={() => setSource("")}>Все источники</button>
        {sources.map((location) => (
          <button key={location} type="button" aria-pressed={effectiveSource === location} title={location} onClick={() => setSource(location)}>{location}</button>
        ))}
      </aside>
      <div className="avs-startup-entries">
      <div className="avs-startup-controls">
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
              aria-pressed={statusFilter === id && !phantomsOnly}
              onClick={() => {
                setPhantomsOnly(false);
                setStatusFilter(id);
              }}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === id && !phantomsOnly
                  ? "border-[#00D5E8]/40 bg-[#00D5E8]/12 text-[#00D5E8]"
                  : "border-[#202B38] bg-[#10151D] text-[#8292A3] hover:text-[#E5EDF5]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {(phantomCount > 0 || phantomsOnly) && (
          <button
            type="button"
            aria-pressed={phantomsOnly}
            onClick={() => {
              setStatusFilter("all");
              setPhantomsOnly((value) => !value);
            }}
            className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              phantomsOnly
                ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                : "border-rose-500/25 bg-[#10151D] text-rose-300 hover:bg-rose-500/10"
            }`}
          >
            Без приложения ({phantomCount})
          </button>
        )}

        <select className="avs-sort" aria-label="Сортировка автозагрузки" value={order} onChange={(event) => setOrder(event.target.value as typeof order)}>
          <option value="default">Исходный порядок</option>
          <option value="name">По названию</option>
          <option value="location">По источнику</option>
        </select>
        <div className="relative min-w-0 flex-[1_1_12rem]">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#526170]"
          />
          <input
            type="text"
            value={startupSearch}
            onChange={(e) => setStartupSearch(e.target.value)}
            aria-label="Поиск по названию, пути или источнику"
            placeholder="Поиск по названию, пути или источнику…"
            className="w-full rounded-lg border border-[#202B38] bg-[#10151D] py-2 pl-9 pr-3 text-sm text-[#E5EDF5] outline-none placeholder:text-[#526170] focus:border-[#00D5E8]/50"
          />
        </div>
      </div>

      {startupError && (
        <div role="alert" className="rounded-xl border border-rose-500/35 bg-rose-500/12 px-4 py-2.5 text-sm text-rose-300">
          {startupError}
        </div>
      )}

      {visibleItems.length === 0 ? (
        <div role={startupLoading ? "status" : undefined} className="nexus-empty flex flex-col items-center px-6 py-12 text-center">
          {searchActive ? (
            <SearchX size={28} className="mb-3 text-[#526170]" />
          ) : (
            <ShieldCheck size={28} className="mb-3 text-[#00D5E8]" />
          )}
          <h3 className="text-base font-semibold text-[#E5EDF5]">
            {startupLoading
              ? "Опрос источников автозагрузки…"
              : startupError
              ? "Список автозагрузки недоступен"
              : searchActive
              ? "Совпадений не найдено"
              : "Элементы автозагрузки не обнаружены"}
          </h3>
          <p className="mt-1 max-w-md text-sm text-[#8292A3]">
            {startupLoading || startupError
              ? null
              : searchActive
              ? "Попробуйте изменить фильтр состояния или поисковый запрос."
              : "В проверенных источниках записей нет."}
          </p>
          <button
            type="button"
            onClick={searchActive && !startupError ? clearFilters : () => void fetchStartupItems()}
            disabled={!canManage}
            className="nexus-button mt-4"
          >
            <RefreshCw size={14} className={startupLoading ? "animate-spin" : ""} />
            {searchActive && !startupError ? "Сбросить фильтры" : "Повторить загрузку"}
          </button>
        </div>
      ) : (
        <section aria-label="Записи автозагрузки" aria-busy={startupLoading} className="nexus-panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#202B38] px-4 py-2 text-sm text-[#a0adbb]">
            <span>Записи автозагрузки</span>
            <span className="tabular-nums">{visibleItems.length} из {totalStartupCount} · включено {activeStartupCount}</span>
          </div>
          <div className="hidden grid-cols-12 items-center border-b border-[#202B38] bg-[#0B0E14] px-4 py-2.5 text-xs font-medium text-[#a0adbb] sm:grid">
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
                busy={!canManage}
                pending={startupPendingId === item.id}
                onOpen={() => void handleOpenItemLocation(item)}
                onToggle={() => void handleToggleStartup(item)}
                onRemove={() => setPendingDelete(item)}
              />
            ))}
          </div>
        </section>
      )}

      </div>
      </div>
      {pendingDelete && (
        <UtilityConfirmDialog
          title="Удалить запись автозагрузки?"
          confirmLabel="Удалить запись"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void handleRemoveStartup(pendingDelete);
            setPendingDelete(null);
          }}
        >
          <p><strong className="text-[#E5EDF5]">{pendingDelete.name}</strong> · {pendingDelete.location}</p>
          <p className="break-all font-mono text-xs">{pendingDelete.clean_path || pendingDelete.command || "Путь не указан"}</p>
          <p>Запись будет удалена из источника автозагрузки Windows. Это более постоянное действие, чем отключение.</p>
        </UtilityConfirmDialog>
      )}
    </motion.div>
  );
}

function StartupRow({
  item,
  onOpen,
  onToggle,
  onRemove,
  busy,
  pending,
}: {
  item: StartupItem;
  onOpen: () => void;
  onToggle: () => void;
  onRemove: () => void;
  busy: boolean;
  pending: boolean;
}) {
  const path = item.clean_path || item.command;
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
            <span className="font-mono text-[11px]">{path}</span>
          </div>
        </div>
      </div>

      <div className="min-w-0 text-xs text-[#a0adbb] sm:col-span-2">
        <span className="block truncate" title={item.location}>{item.location}</span>
      </div>

      <div className="flex items-center gap-2 sm:col-span-2">
        {pending ? (
          <span role="status" className="text-xs text-[#a0adbb]">Применение…</span>
        ) : item.phantom ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-rose-300">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
            Нет приложения
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
            aria-label={`Открыть папку: ${item.name}`}
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
            disabled={busy}
            onClick={onRemove}
            className="nexus-button nexus-button--danger"
          >
            <Trash2 size={13} />
            Удалить
          </button>
        ) : (
          <button
            type="button"
            role="switch"
            disabled={!canToggle || busy}
            aria-checked={item.enabled}
            aria-label={`Автозапуск: ${item.name}`}
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
