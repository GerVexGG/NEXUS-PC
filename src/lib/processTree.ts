import type { ProcessItem, ProcessSortKey } from "./studio";

export interface ProcessTreeNode {
  process: ProcessItem;
  children: ProcessTreeNode[];
  directChildCount: number;
  childCount: number;
  totalDescendants: number;
  subtreeCpu: number;
  subtreeMemoryMb: number;
  matchedSelf: boolean;
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
}

function compareNodes(
  a: ProcessTreeNode,
  b: ProcessTreeNode,
  sortKey: ProcessSortKey,
  sortDesc: boolean
): number {
  let cmp = 0;
  if (sortKey === "name") {
    cmp = a.process.name.localeCompare(b.process.name);
  } else if (sortKey === "cpu") {
    cmp = a.process.cpu_usage - b.process.cpu_usage;
    if (cmp === 0) cmp = a.subtreeCpu - b.subtreeCpu;
  } else if (sortKey === "memory") {
    cmp = a.process.memory_mb - b.process.memory_mb;
    if (cmp === 0) cmp = a.subtreeMemoryMb - b.subtreeMemoryMb;
  } else if (sortKey === "disk") {
    cmp =
      a.process.disk_read_bytes_sec +
      a.process.disk_write_bytes_sec -
      (b.process.disk_read_bytes_sec + b.process.disk_write_bytes_sec);
  } else if (sortKey === "runtime") {
    cmp = a.process.run_time_sec - b.process.run_time_sec;
  } else if (sortKey === "threads") {
    cmp = (a.process.thread_count ?? 0) - (b.process.thread_count ?? 0);
  } else if (sortKey === "handles") {
    cmp = (a.process.handle_count ?? 0) - (b.process.handle_count ?? 0);
  } else {
    cmp = a.process.pid - b.process.pid;
  }
  if (cmp === 0) {
    cmp = a.process.pid - b.process.pid;
  }
  return sortDesc ? -cmp : cmp;
}

export function buildProcessTree(
  processes: ProcessItem[],
  sortKey: ProcessSortKey,
  sortDesc: boolean,
  searchQuery: string,
  expandedPids: Set<number>
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
  const uniqueProcesses = Array.from(byPid.values());

  const childrenMap = new Map<number, ProcessItem[]>();
  const parentOf = new Map<number, number>();
  const roots: ProcessItem[] = [];

  for (const proc of uniqueProcesses) {
    const ppid = proc.parent_pid;
    let validParent = false;
    if (ppid !== null && ppid !== 0 && ppid !== proc.pid) {
      const parent = byPid.get(ppid);
      if (parent) {
        // Строгая проверка времени создания: родитель не может стартовать позже дочернего процесса
        const launchedViaShell =
          parent.name.toLowerCase() === "explorer.exe" &&
          proc.name.toLowerCase() !== "explorer.exe";
        const timeValid =
          parent.start_time === 0 ||
          proc.start_time === 0 ||
          parent.start_time <= proc.start_time;
        if (!launchedViaShell && timeValid) {
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
            validParent = true;
            parentOf.set(proc.pid, ppid);
            const bucket = childrenMap.get(ppid);
            if (bucket) bucket.push(proc);
            else childrenMap.set(ppid, [proc]);
          }
        }
      }
    }
    if (!validParent) {
      roots.push(proc);
    }
  }

  const query = searchQuery.trim().toLowerCase();
  const hasQuery = query.length > 0;
  let matchedCount = 0;
  const parentPids: number[] = [];
  const statsByPid = new Map<number, ProcessNodeStats>();

  const matchesProcess = (p: ProcessItem): boolean => {
    if (!hasQuery) return false;
    const hit =
      p.name.toLowerCase().includes(query) ||
      String(p.pid).includes(query) ||
      Boolean(p.exe_path && p.exe_path.toLowerCase().includes(query));
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
    if (hasQuery && !matchedSelf && childNodes.length === 0) {
      return null;
    }

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

    statsByPid.set(proc.pid, {
      directChildCount,
      totalDescendants,
      subtreeCpu,
      subtreeMemoryMb,
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
    nodes.forEach((node, index) => {
      const isLast = index === nodes.length - 1;
      const hasChildren = node.children.length > 0;
      const isExpanded = hasChildren && (hasQuery || expandedPids.has(node.process.pid));

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
    rootCount: rootNodes.length,
    matchedCount,
    parentPids,
    statsByPid,
  };
}
