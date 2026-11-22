import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MotionConfig } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useNexusController } from "./hooks/useNexusController";
import { WorkspaceSession } from "./hooks/useWorkspaceState";
import { TitleBar } from "./components/TitleBar";
import { ModuleFinder } from "./components/shell/ModuleFinder";
import { Sidebar } from "./components/shell/Sidebar";
import { groupFor, pages, type Tab } from "./components/shell/navigation";
import "./AuroraShell.css";

export default function App() {
  const c = useNexusController();
  const { activeTab } = c;
  const main = useRef<HTMLElement>(null);
  const positions = useRef<Partial<Record<Tab, number>>>({});
  const [session] = useState(() => new Map<string, unknown>());
  const [visitedScripts, setVisitedScripts] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const openFinder = useCallback(() => setFinderOpen(true), []);

  useEffect(() => {
    void invoke("main_window_ready").catch(console.error);
  }, []);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (!event.ctrlKey || event.altKey || event.code !== "KeyK" || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      openFinder();
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openFinder]);

  useLayoutEffect(() => {
    if (main.current) main.current.scrollTop = positions.current[activeTab] ?? 0;
    if (activeTab === "scripts") setVisitedScripts(true);
  }, [activeTab]);

  const ActivePage = pages[activeTab].component;
  const ScriptsPage = pages.scripts.component;
  return (
    <MotionConfig reducedMotion="user">
      <WorkspaceSession.Provider value={session}>
        <div className="nexus-shell av-shell" data-visible={c.windowVisible} data-view={activeTab}>
          <Sidebar
            activeTab={activeTab} setActiveTab={c.setActiveTab} handleWindowClose={c.handleWindowClose}
            thermalWarnings={c.thermalWarnings} suspendedPids={c.suspendedPids} brokenStartupCount={c.brokenStartupCount}
            isScanning={c.isScanning} isScanningCleanup={c.isScanningCleanup} isCleaning={c.isCleaning}
            timerState={c.timerState} remainingSeconds={c.remainingSeconds}
          />
          <div className="av-workspace">
            <TitleBar group={groupFor(activeTab)} label={pages[activeTab].label}
              isElevatedAdmin={c.isElevatedAdmin} adminError={c.adminError}
              onRestartAsAdmin={c.handleRestartAsAdmin} onToggleMaximize={c.handleWindowToggleMaximize}
              onMinimize={c.handleWindowMinimize} onFindModule={openFinder}
              canGoBack={c.canGoBack} canGoForward={c.canGoForward} onNavigate={c.go}
              onHideToTray={() => {
                void invoke("hide_to_tray").catch(() => getCurrentWindow().hide()).catch(console.error);
              }}
            />
            <main ref={main} aria-label={pages[activeTab].label} className="nexus-main av-main"
              onScroll={(event) => { positions.current[activeTab] = event.currentTarget.scrollTop; }}>
              {activeTab !== "scripts" && <div key={activeTab} className="nexus-view av-page">
                <ActivePage c={c} />
              </div>}
              {(visitedScripts || activeTab === "scripts") && <div key="scripts" hidden={activeTab !== "scripts"} className="nexus-view av-page">
                <ScriptsPage c={c} />
              </div>}
            </main>
          </div>
          {finderOpen && <ModuleFinder current={activeTab} activate={c.setActiveTab} dismiss={() => setFinderOpen(false)} />}
        </div>
      </WorkspaceSession.Provider>
    </MotionConfig>
  );
}
