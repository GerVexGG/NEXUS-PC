import { useCallback, useEffect, useReducer } from "react";
import { initialNavigation, keyboardNavigation, mouseNavigation, navigate, type Direction, type StorageLocation, type WorkspaceTab } from "../lib/workspaceNavigation";

export function useWorkspaceNavigation() {
  const [navigation, dispatch] = useReducer(navigate, initialNavigation);
  const setActiveTab = useCallback((tab: WorkspaceTab) => dispatch({ tab, inheritStorage: true }), []);
  const goToStorage = useCallback((storage: StorageLocation) => dispatch({ tab: "storage", storage }), []);
  const go = useCallback((direction: Direction) => dispatch({ direction }), []);

  useEffect(() => {
    const modalOpen = () => Boolean(document.querySelector("dialog[open],[role='alertdialog']"));
    const keyboard = (event: KeyboardEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      const editing = Boolean(element?.closest("input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox']"));
      const direction = keyboardNavigation(event, editing);
      if (event.defaultPrevented || !direction || modalOpen()) return;
      event.preventDefault();
      go(direction);
    };
    const mouse = (event: MouseEvent) => {
      const direction = mouseNavigation(event.button);
      if (!direction) return;
      // Suppress browser history for the entire XButton gesture. Navigate once on release.
      event.preventDefault();
      if (event.type === "mouseup" && !modalOpen()) go(direction);
    };
    window.addEventListener("keydown", keyboard);
    const mouseEvents = ["mousedown", "mouseup", "auxclick"] as const;
    for (const name of mouseEvents) window.addEventListener(name, mouse, true);
    return () => {
      window.removeEventListener("keydown", keyboard);
      for (const name of mouseEvents) window.removeEventListener(name, mouse, true);
    };
  }, [go]);

  return {
    activeTab: navigation.entries[navigation.index].tab,
    storageLocation: navigation.storage,
    setActiveTab,
    goToStorage,
    go,
    canGoBack: navigation.index > 0,
    canGoForward: navigation.index + 1 < navigation.entries.length,
  };
}
