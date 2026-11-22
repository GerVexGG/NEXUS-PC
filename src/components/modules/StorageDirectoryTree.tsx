import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, ChevronRight, Copy, FileText, Folder, FolderOpen } from "lucide-react";
import { useWorkspaceState } from "../../hooks/useWorkspaceState";
import { copyTextToClipboard, formatBytes } from "../../lib/studio";
import { directoryRows, sizeShare, type DirectoryPage, type DirectorySort, type IndexedEntry } from "../../lib/storageDirectory";

const ROW = 32;
const columns = [
  ["name", "Название"], ["size", "Размер"], [null, "% родителя"], [null, "% занятого тома"],
  ["files", "Файлы"], ["folders", "Папки"],
] as const;
const numbers = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const percent = (value: number | null) => value === null ? "—" : value > 0 && value < .1 ? "<0,1%" : numbers.format(value) + "%";

interface Props {
  scanId: number;
  folder: string;
  file?: string;
  usedBytes: number | null;
  navigate: (folder: string) => void;
  reveal: (path: string) => Promise<void>;
}

export function StorageDirectoryTree(props: Props) {
  const [order, setOrder] = useWorkspaceState<{ sort: DirectorySort; descending: boolean }>("storage.directoryOrder", { sort: "size", descending: true });
  const jumpOrder = useMemo(() => ({ sort: "size", descending: true } as const), []);
  const [useJumpOrder, setUseJumpOrder] = useState(Boolean(props.file));
  const activeOrder = useJumpOrder ? jumpOrder : order;
  return <DirectoryTree key={activeOrder.sort + activeOrder.descending} {...props} order={activeOrder} sortBy={(sort) => {
    setUseJumpOrder(false);
    setOrder({ sort, descending: activeOrder.sort === sort ? !activeOrder.descending : sort !== "name" });
  }} />;
}

function DirectoryTree({ scanId, folder, file, usedBytes, navigate, reveal, order, sortBy }: Props & {
  order: { sort: DirectorySort; descending: boolean };
  sortBy: (sort: DirectorySort) => void;
}) {
  const key = `storage.tree.${scanId}.${folder}`;
  const [expanded, setExpanded] = useWorkspaceState<Set<string>>(key, new Set());
  const [pages, setPages] = useState<Map<string, DirectoryPage>>(new Map());
  const pending = useRef(new Set<string>());
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(file ?? null);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(400);
  const [scroll, setScroll] = useWorkspaceState(key + ".scroll." + order.sort + order.descending, 0);
  const restoreScroll = useRef(file ? 0 : scroll);
  const revealFile = useRef(Boolean(file));
  const root = pages.get(folder);
  const rows = useMemo(() => directoryRows(folder, pages, expanded), [folder, pages, expanded]);
  const top = Math.min(scroll, Math.max(0, (rows.length + 1) * ROW - height));
  const first = Math.max(0, Math.floor(top / ROW) - 5);
  const past = Math.min(rows.length, Math.ceil((top + height) / ROW) + 5);
  const currentIndex = rows.findIndex(row => selectedId !== null && "entry" in row && row.entry.id === selectedId);
  const selected = rows[currentIndex];
  const entry = selected && "entry" in selected ? selected.entry : null;

  const load = useCallback(async (id: string, offset = 0) => {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    setError("");
    try {
      const page = await invoke<DirectoryPage>("get_storage_directory", { scanId, folder: id, offset, ...order });
      setPages(previous => new Map(previous).set(id, offset && previous.has(id)
        ? { ...page, entries: [...previous.get(id)!.entries, ...page.entries] } : page));
    } catch (cause) {
      setError(String(cause));
    } finally {
      pending.current.delete(id);
    }
  }, [scanId, order]);

  useEffect(() => { void load(folder); }, [folder, load]);
  useEffect(() => {
    for (const id of expanded) void load(id);
  }, [load]); // Restore expanded branches once for this folder and sort.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (revealFile.current && currentIndex >= 0 && ref.current) {
      ref.current.scrollTop = currentIndex * ROW;
      revealFile.current = false;
      return;
    }
    if (!ref.current || !rows.length || restoreScroll.current <= 0) return;
    ref.current.scrollTop = restoreScroll.current;
    if (ref.current.scrollTop >= restoreScroll.current || pending.current.size === 0) restoreScroll.current = 0;
  }, [currentIndex, rows]);

  function toggle(item: IndexedEntry) {
    if (!item.has_entries) return;
    const open = expanded.has(item.id);
    if (!open && !pages.has(item.id)) void load(item.id);
    setExpanded(previous => {
      const next = new Set(previous);
      if (open) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  function select(index: number, step: number) {
    for (let i = index; i >= 0 && i < rows.length; i += step) {
      const row = rows[i];
      if (!("entry" in row)) continue;
      setSelectedId(row.entry.id);
      const node = ref.current;
      if (node) {
        const top = i * ROW;
        if (top < node.scrollTop) node.scrollTop = top;
        else if (top + ROW > node.scrollTop + height - ROW) node.scrollTop = top + ROW * 2 - height;
      }
      return;
    }
  }

  return <section className="nexus-panel avs-directory">
    <div className="avs-directory-path">
      <nav aria-label="Путь каталога">
        {(root?.breadcrumbs ?? []).map(([id, name], index) => <span key={id}>
          {index > 0 && <ChevronRight size={12} aria-hidden />}
          <button type="button" aria-current={id === folder ? "location" : undefined} disabled={id === folder} onClick={() => navigate(id)}>{name}</button>
        </span>)}
      </nav>
      {root && <button type="button" className="nexus-button" onClick={() => void reveal(entry?.path ?? root.path)}><FolderOpen size={14} /> Проводник</button>}
      {root && <button type="button" className="nexus-button" onClick={() => {
        void copyTextToClipboard(entry?.path ?? root.path).then(() => setCopied(true)).catch(cause => setError(String(cause)));
      }}><Copy size={14}/> {copied ? "Скопировано" : "Копировать путь"}</button>}
    </div>
    {error && <p className="nexus-message nexus-message--error" role="alert">{error}</p>}
    <div className="avs-directory-scroll" ref={ref} role="treegrid" tabIndex={0} aria-label="Дерево каталогов и файлов"
      aria-rowcount={rows.length + 1} aria-colcount={6}
      aria-activedescendant={currentIndex >= first && currentIndex < past ? `storage-row-${currentIndex}` : undefined}
      onScroll={event => setScroll(event.currentTarget.scrollTop)}
      onKeyDown={event => {
        if (event.currentTarget !== event.target || event.altKey || event.ctrlKey || event.metaKey) return;
        switch (event.key) {
          case "ArrowDown": select(currentIndex + 1, 1); break;
          case "ArrowUp": select(currentIndex < 0 ? 0 : currentIndex - 1, currentIndex < 0 ? 1 : -1); break;
          case "Home": select(0, 1); break;
          case "End": select(rows.length - 1, -1); break;
          case "ArrowRight": if (entry?.is_directory && !expanded.has(entry.id)) toggle(entry); else select(currentIndex + 1, 1); break;
          case "ArrowLeft": if (entry && expanded.has(entry.id)) toggle(entry); else if (entry && selected && "depth" in selected && selected.depth > 0) {
            for (let index = currentIndex - 1; index >= 0; index--) {
              const candidate = rows[index];
              if ("entry" in candidate && candidate.depth < selected.depth) { select(index, -1); break; }
            }
          } break;
          case "Enter": if (entry?.is_directory) navigate(entry.id); else if (entry) void reveal(entry.path); break;
          default: return;
        }
        event.preventDefault();
      }}>
      <div className="avs-directory-grid avs-directory-columns" role="row" aria-rowindex={1}>
        {columns.map(([key, name]) => <div key={name} role="columnheader" aria-sort={key === order.sort ? order.descending ? "descending" : "ascending" : undefined}
          title={key === null ? name + (name.includes("тома") ? " · логический размер / (ёмкость − доступно)" : " · логический размер / размер непосредственной папки") : undefined}>
          {key ? <button type="button" onClick={() => sortBy(key)}>{name}{key === order.sort && (order.descending ? <ArrowDown size={12}/> : <ArrowUp size={12}/>)}</button> : name}
        </div>)}
      </div>
      {rows.length ? <div className="avs-directory-spacer" style={{ height: rows.length * ROW }} role="presentation">
        <div style={{ transform: `translateY(${first * ROW}px)` }} role="presentation">
          {rows.slice(first, past).map((row, index) => {
            if ("more" in row) return <div key={row.more + "/more"} className="avs-directory-more" role="row">
              <button type="button" role="gridcell" onClick={() => void load(row.more, row.offset)}>Ещё записи</button>
            </div>;
            const { entry: item, depth } = row;
            const share = item.readable ? sizeShare(item.size_bytes, item.parent_bytes) : null;
            return <div key={item.id} id={`storage-row-${first + index}`} role="row" aria-rowindex={first + index + 2}
              aria-level={depth + 1} aria-expanded={item.has_entries ? expanded.has(item.id) : undefined}
              aria-selected={selectedId === item.id} className="avs-directory-grid avs-directory-row"
              onClick={() => { setSelectedId(item.id); setCopied(false); ref.current?.focus({ preventScroll: true }); }}
              onDoubleClick={() => item.is_directory ? navigate(item.id) : void reveal(item.path)}>
              <div role="gridcell" className="avs-directory-name" style={{ paddingLeft: 8 + Math.min(depth, 16) * 16 }}>
                {item.has_entries ? <button type="button" tabIndex={-1} aria-label={expanded.has(item.id) ? "Свернуть папку" : "Раскрыть папку"}
                  onClick={event => { event.stopPropagation(); toggle(item); ref.current?.focus({ preventScroll: true }); }}><ChevronRight size={14} className={expanded.has(item.id) ? "rotate-90" : ""}/></button>
                  : <i aria-hidden />}
                {item.is_directory ? <Folder size={15} aria-hidden /> : <FileText size={14} aria-hidden />}
                <span title={item.path}>{item.name}</span>
              </div>
              <span role="gridcell">{item.readable ? formatBytes(item.size_bytes) : "Недоступно"}</span>
              <span role="gridcell" className="avs-directory-share">
                <i style={{ width: `${Math.min(100, share ?? 0)}%` }} aria-hidden />{percent(share)}
              </span>
              <span role="gridcell">{percent(item.readable ? sizeShare(item.size_bytes, usedBytes) : null)}</span>
              <span role="gridcell">{item.is_directory && item.readable ? numbers.format(item.file_count) : "—"}</span>
              <span role="gridcell">{item.is_directory && item.readable ? numbers.format(item.folder_count) : "—"}</span>
            </div>;
          })}
        </div>
      </div> : <p className="nexus-empty" role="status">{error ? "Индекс недоступен" : !root ? "Загружаем каталог…" : !root.readable ? "Каталог недоступен при сканировании" : "В каталоге нет проиндексированных записей"}</p>}
    </div>
    {root && <div className="avs-directory-footer">
      <span title={entry?.path ?? root.path}>{entry?.path ?? root.path}</span>
      {entry?.is_directory && <button type="button" className="nexus-button" onClick={() => navigate(entry.id)}>Открыть папку</button>}
    </div>}
  </section>;
}
