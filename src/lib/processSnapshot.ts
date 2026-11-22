import type { ProcessItem } from "./studio";
import { getProcessIdentityKey } from "./processTree.ts";

export interface ProcessSnapshot {
  topology: ProcessItem[];
  live: Map<string, ProcessItem>;
  added: Map<string, number>;
  departed: Set<string>;
  orderRevision: number;
}

export const emptyProcessSnapshot: ProcessSnapshot = {
  topology: [], live: new Map(), added: new Map(), departed: new Set(), orderRevision: 0,
};

export function reconcileProcesses(
  previous: ProcessSnapshot, processes: ProcessItem[], orderRevision: number, now: number,
): ProcessSnapshot {
  const live = new Map(processes.map(process => [getProcessIdentityKey(process), process]));
  const pids = new Set(processes.map(process => process.pid));
  const added = new Map<string, number>();
  const departed = new Set<string>();
  let structureChanged = orderRevision !== previous.orderRevision;
  const topology: ProcessItem[] = [];
  for (const old of previous.topology) {
    const key = getProcessIdentityKey(old);
    const current = live.get(key);
    if (current) {
      const hasMainWindow = old.has_main_window || current.has_main_window;
      const changed = old.parent_pid !== current.parent_pid || old.exe_path !== current.exe_path ||
        hasMainWindow !== old.has_main_window;
      structureChanged ||= changed;
      if (orderRevision !== previous.orderRevision) topology.push({ ...current, has_main_window: hasMainWindow });
      else topology.push(changed ? { ...old, parent_pid: current.parent_pid, exe_path: current.exe_path, has_main_window: hasMainWindow } : old);
      const since = previous.added.get(key);
      if (since !== undefined && now - since < 3000) added.set(key, since);
    } else if (!pids.has(old.pid) && previous.live.has(key)) {
      departed.add(key);
      topology.push(old);
    } else {
      structureChanged = true;
    }
  }
  const previousKeys = new Set(previous.topology.map(getProcessIdentityKey));
  for (const [key, current] of live) {
    if (previousKeys.has(key)) continue;
    topology.push(current);
    if (previous.live.size > 0) added.set(key, now);
    structureChanged = true;
  }
  return { topology: structureChanged ? topology : previous.topology, live, added, departed, orderRevision };
}
