import type { ProcessItem, ProcessSortKey, ProcessTargetIdentity } from "./studio";

export type ProcessTreeMode = "applications" | "ppid";

export function toProcessTargetIdentity(
  proc: Pick<ProcessItem, "pid" | "start_time" | "name" | "exe_path">
): ProcessTargetIdentity {
  return {
    pid: proc.pid,
    start_time: proc.start_time,
    name: proc.name,
    exe_path: proc.exe_path || undefined,
  };
}

export function getProcessIdentityKey(
  proc: Pick<ProcessItem, "pid" | "start_time" | "name">
): string {
  return `${proc.pid}:${proc.start_time}:${proc.name.toLowerCase()}`;
}

export function processAncestorKeys(processes: readonly ProcessItem[], selected: ProcessItem | null): string[] {
  if (!selected) return [];
  const byPid = new Map(processes.map(process => [process.pid, process]));
  const keys: string[] = [];
  const seen = new Set([selected.pid]);
  let child = selected;
  while (child.parent_pid) {
    const parent = byPid.get(child.parent_pid);
    if (!parent || seen.has(parent.pid) ||
      (parent.start_time > 0 && child.start_time > 0 && parent.start_time > child.start_time)) break;
    seen.add(parent.pid);
    keys.push(getProcessIdentityKey(parent));
    child = parent;
  }
  return keys;
}

export interface ProcessTreeNode {
  process: ProcessItem;
  children: ProcessTreeNode[];
  directChildCount: number;
  childCount: number;
  totalDescendants: number;
  subtreeCpu: number;
  subtreeMemoryMb: number;
  matchedSelf: boolean;
  visible: boolean;
}

export interface FlattenedProcessRow {
  process: ProcessItem;
  depth: number;
  hasChildren: boolean;
  directChildCount: number;
  childCount: number;
  totalDescendants: number;
  subtreeCpu: number;
  subtreeMemoryMb: number;
  isExpanded: boolean;
  matchedSelf: boolean;
  /** True for ancestor columns whose parent still has siblings below them, used to render tree guides */
  ancestorHasNext: boolean[];
  isLastChild: boolean;
}

export interface ProcessNodeStats {
  directChildCount: number;
  totalDescendants: number;
  subtreeCpu: number;
  subtreeMemoryMb: number;
  subtreeTargets: ProcessTargetIdentity[];
}

export function matchesProcessQuery(process: ProcessItem, query: string): boolean {
  return (
    process.name.toLowerCase().includes(query) ||
    String(process.pid).includes(query) ||
    process.exe_path.toLowerCase().includes(query) ||
    (process.description?.toLowerCase().includes(query) ?? false)
  );
}

function compareProcessValues(a: ProcessItem, b: ProcessItem, key: ProcessSortKey): number {
  switch (key) {
    case "name": return a.name.localeCompare(b.name, "ru");
    case "pid": return a.pid - b.pid;
    case "cpu": return a.cpu_usage - b.cpu_usage;
    case "memory": return a.memory_mb - b.memory_mb;
    case "disk": return a.disk_read_bytes_sec + a.disk_write_bytes_sec -
      (b.disk_read_bytes_sec + b.disk_write_bytes_sec);
    case "runtime": return (a.start_time > 0 ? a.run_time_sec : 0) - (b.start_time > 0 ? b.run_time_sec : 0);
    case "threads": return a.thread_count - b.thread_count;
    case "handles": return a.handle_count - b.handle_count;
    case "owner": return (a.owner ?? "").localeCompare(b.owner ?? "", "ru");
    case "description": return (a.description ?? "").localeCompare(b.description ?? "", "ru");
    case "path": return a.exe_path.localeCompare(b.exe_path, "ru");
    case "status": return a.status.localeCompare(b.status, "ru");
  }
}

function compareIoPresence(a: ProcessItem, b: ProcessItem, key: ProcessSortKey): number {
  return key === "disk" ? Number(b.disk_status === "ready") - Number(a.disk_status === "ready") : 0;
}

export function compareProcessItems(
  a: ProcessItem, b: ProcessItem, key: ProcessSortKey, sortDesc: boolean,
): number {
  const presence = compareIoPresence(a, b, key);
  if (presence) return presence;
  const cmp = compareProcessValues(a, b, key) || a.pid - b.pid;
  return sortDesc ? -cmp : cmp;
}

function compareNodes(a: ProcessTreeNode, b: ProcessTreeNode, key: ProcessSortKey, sortDesc: boolean): number {
  const presence = compareIoPresence(a.process, b.process, key);
  if (presence) return presence;
  let cmp = compareProcessValues(a.process, b.process, key);
  if (!cmp && key === "cpu") cmp = a.subtreeCpu - b.subtreeCpu;
  if (!cmp && key === "memory") cmp = a.subtreeMemoryMb - b.subtreeMemoryMb;
  cmp ||= a.process.pid - b.process.pid;
  return sortDesc ? -cmp : cmp;
}

export function buildProcessTree(
  processes: ProcessItem[],
  sortKey: ProcessSortKey,
  sortDesc: boolean,
  searchQuery: string,
  expandedPids: Set<number>,
  filterProcess?: (process: ProcessItem) => boolean,
  mode: ProcessTreeMode = "ppid",
  descriptionFor?: (process: ProcessItem) => string | null | undefined,
): {
  rows: FlattenedProcessRow[];
  rootCount: number;
  matchedCount: number;
  parentPids: number[];
  statsByPid: Map<number, ProcessNodeStats>;
} {
  const byPid = new Map<number, ProcessItem>();
  for (const proc of processes) {
    const existing = byPid.get(proc.pid);
    if (!existing || proc.start_time >= existing.start_time) {
      byPid.set(proc.pid, proc);
    }
  }
  const uniqueProcesses = Array.from(byPid.values()).sort((a, b) => a.pid - b.pid);

  const parentOf = new Map<number, number>();
  const childrenMap = new Map<number, ProcessItem[]>();
  const roots: ProcessItem[] = [];

  for (const proc of uniqueProcesses) {
    const ppid = proc.parent_pid;
    let validParent = false;
    if (ppid !== null && ppid !== 0 && ppid !== proc.pid) {
      const parent = byPid.get(ppid);
      if (parent) {
        // Строгая проверка времени создания: родитель не может стартовать позже дочернего процесса
        const timeValid =
          parent.start_time === 0 ||
          proc.start_time === 0 ||
          parent.start_time <= proc.start_time;
        if (timeValid) {
          // Проверка на цикл в принятой цепочке предков
          let createsCycle = false;
          let cursor: number | undefined = ppid;
          let steps = 0;
          while (cursor !== undefined && steps <= uniqueProcesses.length) {
            if (cursor === proc.pid) {
              createsCycle = true;
              break;
            }
            cursor = parentOf.get(cursor);
            steps += 1;
          }
          if (!createsCycle) {
            parentOf.set(proc.pid, ppid);
            const name = proc.name.toLowerCase();
            const shellChild = parent.name.toLowerCase() === "explorer.exe" && name !== "explorer.exe";
            // Windows-owned background helpers stay under the shell. User images
            // can be independent even while their main window is still starting.
            const userImage = Boolean(proc.exe_path && !/^[a-z]:[\\/]windows[\\/]/i.test(proc.exe_path));
            const promoted = mode === "applications" && shellChild && (proc.has_main_window || userImage);
            if (!promoted) {
              validParent = true;
              const bucket = childrenMap.get(ppid);
              if (bucket) bucket.push(proc);
              else childrenMap.set(ppid, [proc]);
            }
          }
        }
      }
    }
    if (!validParent) {
      roots.push(proc);
    }
  }

  const query = searchQuery.trim().toLowerCase();
  const filtering = query.length > 0 || filterProcess !== undefined;
  let matchedCount = 0;
  const parentPids: number[] = [];
  const statsByPid = new Map<number, ProcessNodeStats>();

  const matchesProcess = (p: ProcessItem): boolean => {
    if (!filtering) return false;
    const hit = (!query || matchesProcessQuery(p, query) ||
      (descriptionFor?.(p)?.toLowerCase().includes(query) ?? false)) && (!filterProcess || filterProcess(p));
    if (hit) matchedCount += 1;
    return hit;
  };

  // Защита от возможных циклов + рекурсивная сортировка и фильтрация с сохранением цепочки предков
  const visited = new Set<number>();

  const buildNode = (proc: ProcessItem): ProcessTreeNode | null => {
    if (visited.has(proc.pid)) return null;
    visited.add(proc.pid);

    const rawChildren = childrenMap.get(proc.pid) ?? [];

    const childNodes: ProcessTreeNode[] = [];
    for (const child of rawChildren) {
      const node = buildNode(child);
      if (node) childNodes.push(node);
    }
    childNodes.sort((a, b) => compareNodes(a, b, sortKey, sortDesc));

    const matchedSelf = matchesProcess(proc);
    if (childNodes.length > 0) {
      parentPids.push(proc.pid);
    }

    const directChildCount = childNodes.length;
    let subtreeCpu = proc.cpu_usage;
    let subtreeMemoryMb = proc.memory_mb;
    let totalDescendants = 0;
    for (const child of childNodes) {
      subtreeCpu += child.subtreeCpu;
      subtreeMemoryMb += child.subtreeMemoryMb;
      totalDescendants += 1 + child.totalDescendants;
    }
    let targets: ProcessTargetIdentity[] | undefined;
    statsByPid.set(proc.pid, {
      directChildCount,
      totalDescendants,
      subtreeCpu,
      subtreeMemoryMb,
      get subtreeTargets() {
        if (targets) return targets;
        const result: ProcessTargetIdentity[] = [];
        function append(process: ProcessItem, children: ProcessTreeNode[]) {
          for (const child of children) append(child.process, child.children);
          result.push(toProcessTargetIdentity(process));
        }
        append(proc, childNodes);
        return targets = result;
      },
    });

    return {
      process: proc,
      children: childNodes,
      directChildCount,
      childCount: directChildCount,
      totalDescendants,
      subtreeCpu,
      subtreeMemoryMb,
      matchedSelf,
      visible: !filtering || matchedSelf || childNodes.some((child) => child.visible),
    };
  };

  const rootNodes: ProcessTreeNode[] = [];
  for (const root of roots) {
    const node = buildNode(root);
    if (node) rootNodes.push(node);
  }

  // На случай изолированных непосещённых узлов добираем их в корни
  for (const proc of uniqueProcesses) {
    if (!visited.has(proc.pid)) {
      const node = buildNode(proc);
      if (node) rootNodes.push(node);
    }
  }
  rootNodes.sort((a, b) => compareNodes(a, b, sortKey, sortDesc));

  const rows: FlattenedProcessRow[] = [];

  const flatten = (
    nodes: ProcessTreeNode[],
    depth: number,
    ancestorHasNext: boolean[]
  ) => {
    const visibleNodes = nodes.filter((node) => node.visible);
    visibleNodes.forEach((node, index) => {
      const isLast = index === visibleNodes.length - 1;
      const hasChildren = node.children.some((child) => child.visible);
      const isExpanded = hasChildren && (filtering || expandedPids.has(node.process.pid));

      rows.push({
        process: node.process,
        depth,
        hasChildren,
        directChildCount: node.directChildCount,
        childCount: node.directChildCount,
        totalDescendants: node.totalDescendants,
        subtreeCpu: node.subtreeCpu,
        subtreeMemoryMb: node.subtreeMemoryMb,
        isExpanded,
        matchedSelf: node.matchedSelf,
        ancestorHasNext,
        isLastChild: isLast,
      });

      if (isExpanded) {
        flatten(node.children, depth + 1, [...ancestorHasNext, !isLast]);
      }
    });
  };

  flatten(rootNodes, 0, []);

  return {
    rows,
    rootCount: rootNodes.filter((node) => node.visible).length,
    matchedCount,
    parentPids,
    statsByPid,
  };
}
