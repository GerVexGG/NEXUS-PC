import test from "node:test";
import assert from "node:assert/strict";
import { buildProcessTree, getProcessIdentityKey } from "../src/lib/processTree.ts";
import type { ProcessItem } from "../src/lib/studio.tsx";

function makeProc(
  overrides: Partial<ProcessItem> & Pick<ProcessItem, "pid" | "name">
): ProcessItem {
  return {
    parent_pid: null,
    exe_path: `C:\\Windows\\${overrides.name}`,
    cpu_usage: 0,
    memory_mb: 10,
    disk_read_bytes_sec: 0,
    disk_write_bytes_sec: 0,
    run_time_sec: 100,
    start_time: 1000,
    thread_count: 4,
    handle_count: 120,
    status: "Активен",
    icon_base64: null,
    ...overrides,
  };
}

test("apps launched from explorer.exe (chrome, Antigravity) promote to top-level roots while preserving real subtrees", () => {
  const explorer = makeProc({ pid: 6704, name: "explorer.exe", parent_pid: 500, start_time: 100, cpu_usage: 0.4, memory_mb: 90 });
  const explorerSub = makeProc({ pid: 6705, name: "explorer.exe", parent_pid: 6704, start_time: 150, cpu_usage: 0.1, memory_mb: 45 });
  // chrome.exe и Antigravity.exe стартовали из оболочки explorer.exe (PPID=6704),
  // но в дереве процессов (как в System Informer) должны быть самостоятельными корнями:
  const chrome = makeProc({ pid: 102, name: "chrome.exe", parent_pid: 6704, start_time: 300, cpu_usage: 3.0, memory_mb: 350 });
  const chromeGpu = makeProc({ pid: 201, name: "chrome.exe", parent_pid: 102, start_time: 301, cpu_usage: 4.5, memory_mb: 500 });
  const chromeTab1 = makeProc({ pid: 202, name: "chrome.exe", parent_pid: 102, start_time: 302, cpu_usage: 1.5, memory_mb: 400 });
  const chromeSub = makeProc({ pid: 301, name: "crashpad_handler.exe", parent_pid: 201, start_time: 304, cpu_usage: 0.0, memory_mb: 12 });

  const antigravity = makeProc({ pid: 103, name: "Antigravity.exe", parent_pid: 6704, start_time: 400, cpu_usage: 2.0, memory_mb: 300 });
  const agWorker1 = makeProc({ pid: 204, name: "Antigravity.exe", parent_pid: 103, start_time: 401, cpu_usage: 1.0, memory_mb: 200 });
  const agNode = makeProc({ pid: 205, name: "node.exe", parent_pid: 204, start_time: 402, cpu_usage: 2.0, memory_mb: 150 });

  const all = [explorer, explorerSub, chrome, chromeGpu, chromeTab1, chromeSub, antigravity, agWorker1, agNode];

  const collapsed = buildProcessTree(all, "memory", true, "", new Set());
  assert.equal(collapsed.rootCount, 3, "explorer.exe, chrome.exe, and Antigravity.exe should be 3 separate root processes");
  assert.deepEqual(
    collapsed.rows.map((r) => r.process.name),
    ["chrome.exe", "Antigravity.exe", "explorer.exe"]
  );

  const explorerStats = collapsed.statsByPid.get(6704)!;
  assert.equal(explorerStats.directChildCount, 1);
  assert.equal(explorerStats.totalDescendants, 1);

  const chromeStats = collapsed.statsByPid.get(102)!;
  assert.equal(chromeStats.directChildCount, 2, "chrome.exe has 2 direct children (GPU + Tab1)");
  assert.equal(chromeStats.totalDescendants, 3, "chrome.exe has 2 direct + 1 crashpad grandchild = 3 total");
  assert.ok(Math.abs(chromeStats.subtreeMemoryMb - 1262) < 1e-4);

  const agStats = collapsed.statsByPid.get(103)!;
  assert.equal(agStats.directChildCount, 1);
  assert.equal(agStats.totalDescendants, 2);
});

test("multi-level nesting preserves expanded state and computes depth, ancestorHasNext, and isLastChild", () => {
  const root = makeProc({ pid: 10, name: "root.exe", cpu_usage: 1, memory_mb: 50 });
  const childA = makeProc({ pid: 20, name: "childA.exe", parent_pid: 10, cpu_usage: 5, memory_mb: 100 });
  const childB = makeProc({ pid: 21, name: "childB.exe", parent_pid: 10, cpu_usage: 2, memory_mb: 80 });
  const grandA = makeProc({ pid: 30, name: "grandA.exe", parent_pid: 20, cpu_usage: 4, memory_mb: 60 });

  const expanded = new Set([10, 20]);
  const res = buildProcessTree([root, childA, childB, grandA], "cpu", true, "", expanded);

  assert.deepEqual(
    res.rows.map((r) => ({ pid: r.process.pid, depth: r.depth, isLast: r.isLastChild, guides: r.ancestorHasNext })),
    [
      { pid: 10, depth: 0, isLast: true, guides: [] },
      { pid: 20, depth: 1, isLast: false, guides: [false] },
      { pid: 30, depth: 2, isLast: true, guides: [false, true] },
      { pid: 21, depth: 1, isLast: true, guides: [false] },
    ]
  );

  // Own-metric sorting on roots: higher own CPU root appears above lower own CPU root even if smaller subtree
  const heavySelf = makeProc({ pid: 50, name: "heavySelf.exe", cpu_usage: 40, memory_mb: 200 });
  const heavyBranch = makeProc({ pid: 60, name: "shell.exe", cpu_usage: 0.5, memory_mb: 50 });
  const heavyKid = makeProc({ pid: 61, name: "worker.exe", parent_pid: 60, cpu_usage: 60, memory_mb: 900 });
  const sorted = buildProcessTree([heavySelf, heavyBranch, heavyKid], "cpu", true, "", new Set());
  assert.deepEqual(
    sorted.rows.map((r) => r.process.pid),
    [50, 60],
    "Sorting roots by own CPU should place heavySelf (40%) ahead of collapsed shell (0.5%)"
  );
});

test("rejects reused PIDs when apparent parent started strictly later than child", () => {
  const newProcessWithReusedPid = makeProc({ pid: 500, name: "new_host.exe", start_time: 2000, cpu_usage: 1 });
  const olderOrphanChild = makeProc({ pid: 800, name: "orphan.exe", parent_pid: 500, start_time: 1000, cpu_usage: 2 });
  // Also test strict 1-second boundary (no +2s slop)
  const boundaryParent = makeProc({ pid: 501, name: "parent2.exe", start_time: 101, cpu_usage: 1 });
  const boundaryChild = makeProc({ pid: 801, name: "child2.exe", parent_pid: 501, start_time: 100, cpu_usage: 2 });

  const tree = buildProcessTree(
    [newProcessWithReusedPid, olderOrphanChild, boundaryParent, boundaryChild],
    "pid",
    false,
    "",
    new Set()
  );

  assert.equal(tree.rootCount, 4, "All 4 processes should become independent roots");
  assert.equal(tree.statsByPid.get(500)?.directChildCount, 0);
  assert.equal(tree.statsByPid.get(501)?.directChildCount, 0);
});

test("handles parent termination and child termination cleanly across snapshots", () => {
  const parent = makeProc({ pid: 100, name: "launcher.exe", cpu_usage: 1, memory_mb: 20 });
  const child1 = makeProc({ pid: 101, name: "app1.exe", parent_pid: 100, cpu_usage: 4, memory_mb: 100 });
  const child2 = makeProc({ pid: 102, name: "app2.exe", parent_pid: 100, cpu_usage: 6, memory_mb: 200 });

  const expanded = new Set([100]);
  const initial = buildProcessTree([parent, child1, child2], "cpu", true, "", expanded);
  assert.equal(initial.statsByPid.get(100)?.directChildCount, 2);
  assert.equal(initial.statsByPid.get(100)?.totalDescendants, 2);
  assert.equal(initial.statsByPid.get(100)?.subtreeMemoryMb, 320);

  // Child 2 terminates -> subtree metrics shrink immediately
  const afterChildExit = buildProcessTree([parent, child1], "cpu", true, "", expanded);
  assert.equal(afterChildExit.statsByPid.get(100)?.directChildCount, 1);
  assert.equal(afterChildExit.statsByPid.get(100)?.totalDescendants, 1);
  assert.equal(afterChildExit.statsByPid.get(100)?.subtreeMemoryMb, 120);

  // Parent terminates while child1 survives -> child1 promotes cleanly to root
  const afterParentExit = buildProcessTree([child1], "cpu", true, "", expanded);
  assert.equal(afterParentExit.rootCount, 1);
  assert.equal(afterParentExit.rows[0].process.pid, 101);
  assert.equal(afterParentExit.rows[0].depth, 0);
});

test("breaks cycles cleanly without infinite recursion or double counting CPU/RAM", () => {
  const a = makeProc({ pid: 701, name: "cycleA.exe", parent_pid: 702, start_time: 1000, cpu_usage: 12.5, memory_mb: 120 });
  const b = makeProc({ pid: 702, name: "cycleB.exe", parent_pid: 701, start_time: 1000, cpu_usage: 7.5, memory_mb: 80 });

  const res = buildProcessTree([a, b], "pid", false, "", new Set([701, 702]));
  assert.equal(res.rows.length, 2, "Both cyclic processes remain visible once");
  assert.equal(res.statsByPid.get(702)?.directChildCount, 1);
  assert.equal(res.statsByPid.get(702)?.totalDescendants, 1);
  assert.equal(res.statsByPid.get(702)?.subtreeCpu, 20.0);
  assert.equal(res.statsByPid.get(702)?.subtreeMemoryMb, 200);
});

test("subtreeTargets matches displayed NEXUS branch in leaves-first order and excludes shell-promoted apps", () => {
  const explorer = makeProc({ pid: 6704, name: "explorer.exe", parent_pid: 500, start_time: 100 });
  const explorerSub = makeProc({ pid: 6705, name: "explorer.exe", parent_pid: 6704, start_time: 150 });
  const chrome = makeProc({ pid: 25936, name: "chrome.exe", parent_pid: 6704, start_time: 300 });
  const chromeTab = makeProc({ pid: 25937, name: "chrome.exe", parent_pid: 25936, start_time: 301 });
  const crashpad = makeProc({ pid: 25938, name: "crashpad_handler.exe", parent_pid: 25937, start_time: 302 });

  const tree = buildProcessTree([explorer, explorerSub, chrome, chromeTab, crashpad], "pid", false, "", new Set());
  const explorerTargets = tree.statsByPid.get(6704)!.subtreeTargets.map((t) => t.pid);
  assert.deepEqual(explorerTargets, [6705, 6704]);

  const chromeTargets = tree.statsByPid.get(25936)!.subtreeTargets.map((t) => t.pid);
  assert.deepEqual(chromeTargets, [25938, 25937, 25936]);

  const keyOld = getProcessIdentityKey(chromeTab);
  const keyReused = getProcessIdentityKey(makeProc({ pid: 25937, name: "notepad.exe", start_time: 9999 }));
  assert.notEqual(keyOld, keyReused, "Identity key must distinguish reused PIDs");
});
