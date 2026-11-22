export type WorkspaceTab = "dashboard" | "startup" | "storage" | "hardware" | "cleanup" |
  "power" | "processes" | "network" | "drop" | "scripts" | "settings";

export interface StorageLocation {
  volume: string;
  folder: string;
  scanId?: number;
  file?: string;
  view: "analysis" | "smart";
}

export type Destination = { tab: Exclude<WorkspaceTab, "storage"> } | { tab: "storage"; storage: StorageLocation };
export type Direction = -1 | 1;
export type NavigationAction = Destination | { tab: WorkspaceTab; inheritStorage: true } | { direction: Direction };

export const HISTORY_LIMIT = 80;
const emptyStorage: StorageLocation = { volume: "", folder: "", view: "analysis" };
export const initialNavigation = {
  entries: [{ tab: "dashboard" }] as Destination[],
  index: 0,
  storage: emptyStorage,
};

export function navigate(state: typeof initialNavigation, action: NavigationAction): typeof initialNavigation {
  if ("direction" in action) {
    const index = state.index + action.direction;
    const destination = state.entries[index];
    if (!destination) return state;
    return { ...state, index, storage: destination.tab === "storage" ? destination.storage : state.storage };
  }
  const destination: Destination = action.tab !== "storage" ? { tab: action.tab }
    : { tab: "storage", storage: "inheritStorage" in action ? state.storage : action.storage };
  const previous = state.entries[state.index];
  if (previous.tab === destination.tab && previous.tab !== "storage") return state;
  if (previous.tab === "storage" && destination.tab === "storage" &&
    previous.storage.volume === destination.storage.volume && previous.storage.folder === destination.storage.folder &&
    previous.storage.scanId === destination.storage.scanId && previous.storage.view === destination.storage.view) {
    if (previous.storage.file === destination.storage.file) return state;
    const entries = state.entries.map((entry, index) => index === state.index ? destination : entry);
    return { ...state, entries, storage: destination.storage };
  }
  const entries = [...state.entries.slice(0, state.index + 1), destination].slice(-HISTORY_LIMIT);
  return { entries, index: entries.length - 1, storage: destination.tab === "storage" ? destination.storage : state.storage };
}

export function mouseNavigation(button: number): Direction | null {
  return button === 3 ? -1 : button === 4 ? 1 : null;
}

export function keyboardNavigation(event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat">, editing: boolean): Direction | null {
  if (editing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return null;
  return event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : null;
}
