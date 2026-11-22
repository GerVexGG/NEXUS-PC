import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, ArrowRight, ChevronRight, Copy, Minus, PanelsTopLeft, Search, Shield, ShieldCheck, Square, X } from "lucide-react";

interface TitleBarProps {
  group: string;
  label: string;
  isElevatedAdmin: boolean;
  adminError: string | null;
  onRestartAsAdmin: () => void;
  onToggleMaximize: () => void;
  onMinimize: () => void;
  onHideToTray: () => void;
  onFindModule: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigate: (direction: -1 | 1) => void;
}

export function TitleBar({ group, label, isElevatedAdmin, adminError, onRestartAsAdmin, onToggleMaximize, onMinimize, onHideToTray, onFindModule, canGoBack, canGoForward, onNavigate }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    async function sync() {
      const value = await win.isMaximized();
      if (alive) setMaximized(value);
    }
    void sync().catch(console.error);
    const unsubscribe = win.onResized(() => { void sync().catch(console.error); });
    return () => { alive = false; void unsubscribe.then((stop) => stop()).catch(console.error); };
  }, []);
  const sizeLabel = maximized ? "Восстановить окно" : "Развернуть окно";

  return <header data-tauri-drag-region className="av-chrome">
    <div className="av-history-controls" role="group" aria-label="История переходов">
      <button type="button" aria-label="Назад" title="Назад (Alt+←)" disabled={!canGoBack} onClick={() => onNavigate(-1)}><ArrowLeft size={15}/></button>
      <button type="button" aria-label="Вперёд" title="Вперёд (Alt+→)" disabled={!canGoForward} onClick={() => onNavigate(1)}><ArrowRight size={15}/></button>
    </div>
    <div className="av-breadcrumb" data-tauri-drag-region>
      <PanelsTopLeft size={14} /><span>{group}</span><ChevronRight size={12}/><b>{label}</b>
    </div>
    {adminError && <span role="alert" title={adminError} className="av-chrome-error">{adminError}</span>}
    <button type="button" className="av-search" onClick={onFindModule} title="Найти раздел (Ctrl+K)" aria-label="Найти раздел" aria-keyshortcuts="Control+k">
      <Search size={14}/><kbd>Ctrl K</kbd>
    </button>
    {isElevatedAdmin
      ? <span className="av-privilege"><ShieldCheck size={14}/> Администратор</span>
      : <button type="button" className="av-privilege" onClick={onRestartAsAdmin} title="Перезапустить AURORA с правами администратора"><Shield size={14}/> Запуск от администратора</button>}
    <div className="av-caption">
      <button type="button" onClick={onMinimize} title="Свернуть" aria-label="Свернуть"><Minus size={14}/></button>
      <button type="button" onClick={onToggleMaximize} title={sizeLabel} aria-label={sizeLabel}>{maximized ? <Copy size={12}/> : <Square size={12}/>}</button>
      <button type="button" onClick={onHideToTray} title="Скрыть в трей" aria-label="Скрыть в трей"><X size={15}/></button>
    </div>
  </header>;
}
