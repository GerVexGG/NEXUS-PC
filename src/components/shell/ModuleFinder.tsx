import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Search, X } from "lucide-react";
import { pages, type Tab } from "./navigation";

export function ModuleFinder({ dismiss, activate, current }: { dismiss: () => void; activate: (tab: Tab) => void; current: Tab }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const entries = (Object.keys(pages) as Tab[]).filter((tab) =>
    (pages[tab].label + " " + tab).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  function select(tab: Tab) {
    activate(tab);
    dismiss();
  }

  return <dialog ref={dialog} className="av-finder" aria-label="Поиск раздела" onCancel={dismiss}
    onClick={(event) => { if (event.target === dialog.current) dismiss(); }}
    onKeyDown={(event) => {
      const items = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>(".av-finder-list button") ?? []);
      if (!items.length || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? index + 1 : (index < 0 ? items.length - 1 : index - 1);
      items[(next + items.length) % items.length].focus();
    }}>
    <div className="av-finder-content">
      <div className="av-finder-field"><Search size={19} /><input autoFocus aria-label="Название раздела" placeholder="Найти раздел…" value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && entries[0]) select(entries[0]); }} />
        <button type="button" title="Закрыть" onClick={dismiss}><X size={16}/></button>
      </div>
      <div className="av-finder-list">
        {entries.map((tab) => { const { label, icon: Icon } = pages[tab];
          return <button type="button" key={tab} onClick={() => select(tab)}><Icon size={17}/>{label}
            {tab === current ? <Check size={15} aria-label="Текущий раздел"/> : <ArrowUpRight size={14}/>}</button>;
        })}
        {!entries.length && <p role="status">Разделы не найдены</p>}
      </div>
    </div>
  </dialog>;
}

