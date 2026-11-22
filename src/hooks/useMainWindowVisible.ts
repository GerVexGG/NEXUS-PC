import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

// WebView2's document.visibilityState can stay "visible" when Tauri hides its HWND.
export function useMainWindowVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let generation = 0;
    let disposed = false;
    async function sync() {
      const request = ++generation;
      const [shown, minimized] = await Promise.all([win.isVisible(), win.isMinimized()]);
      if (!disposed && request === generation) setVisible(shown && !minimized);
    }
    const refresh = () => { void sync().catch(console.error); };
    const listeners = [
      win.listen("aurora-window-visibility", refresh),
      win.onFocusChanged(refresh),
      win.onResized(refresh),
    ];
    void Promise.all(listeners).then(() => { if (!disposed) refresh(); }).catch(console.error);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", refresh);
      for (const listener of listeners) void listener.then((stop) => stop()).catch(console.error);
    };
  }, []);
  return visible;
}
