import test from "node:test";
import assert from "node:assert/strict";
import { buildProcessTree, compareProcessItems, getProcessIdentityKey, matchesProcessQuery, processAncestorKeys, toProcessTargetIdentity } from "../src/lib/processTree.ts";
import type { ProcessItem } from "../src/lib/studio.tsx";
import { emptyProcessSnapshot, reconcileProcesses } from "../src/lib/processSnapshot.ts";

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

test("polling updates live metrics without replacing ranked rows or open branches", () => {
  const root = makeProc({ pid: 35, name: "explorer.exe", start_time: 100, cpu_usage: 2 });
  const app = makeProc({ pid: 36, name: "app.exe", start_time: 101, parent_pid: root.pid });
  const other = makeProc({ pid: 40, name: "other.exe", start_time: 205, cpu_usage: 7 });
  const first = reconcileProcesses(emptyProcessSnapshot, [root, app, other], 1, 1000);
  const expanded = new Set([root.pid]);
  const rows = (snapshot: typeof first) => buildProcessTree(snapshot.topology, "cpu", true, "", expanded, undefined, "ppid").rows;
  assert.deepEqual(rows(first).map(row => [row.process.pid, row.depth]), [[40, 0], [35, 0], [36, 1]]);
  const second = reconcileProcesses(first, [
    { ...root, cpu_usage: 95, memory_mb: 300 }, app, { ...other, cpu_usage: 0 },
  ], 1, 2000);
  assert.equal(second.topology, first.topology);
  assert.equal(second.live.get(getProcessIdentityKey(root))?.cpu_usage, 95);
  assert.equal(second.live.get(getProcessIdentityKey(root))?.memory_mb, 300);
  assert.deepEqual(rows(second).map(row => row.process.pid), [40, 35, 36]);
  const resorted = reconcileProcesses(second, [...second.live.values()], 2, 2500);
  assert.deepEqual(rows(resorted).map(row => row.process.pid), [35, 36, 40]);
});

test("departed selections expire, reused PIDs receive a new key and cannot adopt older children", () => {
  const original = makeProc({ pid: 88, name: "original.exe", start_time: 100 });
  const child = makeProc({ pid: 89, name: "child.exe", parent_pid: 88, start_time: 101 });
  const first = reconcileProcesses(emptyProcessSnapshot, [original, child], 1, 1000);
  const key = getProcessIdentityKey(original);
  const exit = reconcileProcesses(first, [child], 1, 2000);
  assert.equal(exit.live.has(key), false);
  assert.equal(exit.departed.has(key), true);
  assert.equal(exit.topology, first.topology);
  const replacement = { ...original, start_time: 102 };
  const next = reconcileProcesses(exit, [replacement, child], 1, 3000);
  assert.equal(next.topology.some(row => getProcessIdentityKey(row) === key), false);
  assert.equal(next.added.has(getProcessIdentityKey(replacement)), true);
  const tree = buildProcessTree(next.topology, "pid", false, "", new Set([88]), undefined, "ppid");
  assert.deepEqual(tree.rows.map(row => [row.process.pid, row.depth]), [[88, 0], [89, 0]]);
  const reconnected = reconcileProcesses(next, [replacement, { ...child, parent_pid: null }], 1, 4000);
  assert.notEqual(reconnected.topology, next.topology);
  assert.equal(reconnected.live.get(getProcessIdentityKey(child))?.parent_pid, null);
});

test("apps launched from explorer.exe (chrome, Antigravity) promote to top-level roots while preserving real subtrees", () => {
  const explorer = makeProc({ pid: 6704, name: "explorer.exe", parent_pid: 500, start_time: 100, cpu_usage: 0.4, memory_mb: 90 });
  const explorerSub = makeProc({ pid: 6705, name: "explorer.exe", parent_pid: 6704, start_time: 150, cpu_usage: 0.1, memory_mb: 45 });
  // chrome.exe и Antigravity.exe стартовали из оболочки explorer.exe (PPID=6704),
  // но в дереве процессов (как в System Informer) должны быть самостоятельными корнями:
  const chrome = makeProc({ pid: 102, name: "chrome.exe", parent_pid: 6704, start_time: 300, has_main_window: true, cpu_usage: 3.0, memory_mb: 350 });
  const chromeGpu = makeProc({ pid: 201, name: "chrome.exe", parent_pid: 102, start_time: 301, cpu_usage: 4.5, memory_mb: 500 });
  const chromeTab1 = makeProc({ pid: 202, name: "chrome.exe", parent_pid: 102, start_time: 302, cpu_usage: 1.5, memory_mb: 400 });
  const chromeSub = makeProc({ pid: 301, name: "crashpad_handler.exe", parent_pid: 201, start_time: 304, cpu_usage: 0.0, memory_mb: 12 });

  const antigravity = makeProc({ pid: 103, name: "Antigravity.exe", parent_pid: 6704, start_time: 400, has_main_window: true, cpu_usage: 2.0, memory_mb: 300 });
  const agWorker1 = makeProc({ pid: 204, name: "Antigravity.exe", parent_pid: 103, start_time: 401, cpu_usage: 1.0, memory_mb: 200 });
  const agNode = makeProc({ pid: 205, name: "node.exe", parent_pid: 204, start_time: 402, cpu_usage: 2.0, memory_mb: 150 });

  const all = [explorer, explorerSub, chrome, chromeGpu, chromeTab1, chromeSub, antigravity, agWorker1, agNode];

  const collapsed = buildProcessTree(all, "memory", true, "", new Set(), undefined, "applications");
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

test("confirmed targets use real PPIDs even when the application appears as a separate root", () => {
  const explorer = makeProc({ pid: 6704, name: "explorer.exe", parent_pid: 500, start_time: 100 });
  const explorerSub = makeProc({ pid: 6705, name: "explorer.exe", parent_pid: 6704, start_time: 150 });
  const chrome = makeProc({ pid: 25936, name: "chrome.exe", parent_pid: 6704, start_time: 300 });
  const chromeTab = makeProc({ pid: 25937, name: "chrome.exe", parent_pid: 25936, start_time: 301 });
  const crashpad = makeProc({ pid: 25938, name: "crashpad_handler.exe", parent_pid: 25937, start_time: 302 });

  const tree = buildProcessTree([explorer, explorerSub, chrome, chromeTab, crashpad], "pid", false, "", new Set());
  const explorerTargets = tree.statsByPid.get(6704)!.subtreeTargets.map((t) => t.pid);
  assert.deepEqual(explorerTargets, [6705, 25938, 25937, 25936, 6704]);

  const chromeTargets = tree.statsByPid.get(25936)!.subtreeTargets.map((t) => t.pid);
  assert.deepEqual(chromeTargets, [25938, 25937, 25936]);

  const keyOld = getProcessIdentityKey(chromeTab);
  const keyReused = getProcessIdentityKey(makeProc({ pid: 25937, name: "notepad.exe", start_time: 9999 }));
  assert.notEqual(keyOld, keyReused, "Identity key must distinguish reused PIDs");
});

test("search filtering preserves ancestor chain for matching descendants and sets matchedSelf", () => {
  const launcher = makeProc({ pid: 100, name: "steam.exe", start_time: 100 });
  const helper = makeProc({ pid: 101, name: "steamwebhelper.exe", parent_pid: 100, start_time: 110 });
  const unrelated = makeProc({ pid: 200, name: "notepad.exe", start_time: 120 });

  const filtered = buildProcessTree([launcher, helper, unrelated], "pid", false, "webhelper", new Set());
  assert.equal(filtered.rootCount, 1);
  assert.equal(filtered.matchedCount, 1);
  assert.deepEqual(
    filtered.rows.map((r) => ({ pid: r.process.pid, matchedSelf: r.matchedSelf, depth: r.depth })),
    [
      { pid: 100, matchedSelf: false, depth: 0 },
      { pid: 101, matchedSelf: true, depth: 1 },
    ]
  );

  const identWithEmptyPath = toProcessTargetIdentity({
    pid: 101,
    start_time: 110,
    name: "steamwebhelper.exe",
    exe_path: "",
  });
  assert.deepEqual(identWithEmptyPath, {
    pid: 101,
    start_time: 110,
    name: "steamwebhelper.exe",
    exe_path: undefined,
  });
});

test("filters affect visible rows without shortening a branch approved for termination", () => {
  const root = makeProc({ pid: 13, name: "root.exe" });
  const visible = makeProc({ pid: 23, name: "match.exe", parent_pid: 13 });
  const hidden = makeProc({ pid: 123, name: "worker.exe", parent_pid: 13 });
  for (const filtered of [
    buildProcessTree([root, visible, hidden], "pid", false, "match", new Set()),
    buildProcessTree([root, visible, hidden], "pid", false, "", new Set(), (process) => process.pid === 23),
  ]) {
    assert.deepEqual(filtered.rows.map(({ process }) => process.pid), [13, 23]);
    assert.deepEqual(filtered.statsByPid.get(13)?.subtreeTargets.map(({ pid }) => pid), [23, 123, 13]);
    assert.equal(filtered.statsByPid.get(13)?.totalDescendants, 2);
  }
});

test("runtime sort does not elevate a process with a missing start timestamp", () => {
  const unknown = makeProc({ pid: 10, name: "unknown.exe", start_time: 0, run_time_sec: 1_795_000_000 });
  const observed = makeProc({ pid: 20, name: "observed.exe", run_time_sec: 30 });
  assert.ok(compareProcessItems(unknown, observed, "runtime", true) > 0);
});

test("Application projection keeps Windows helpers attached and does not alter real selection identities", () => {
  const shell = makeProc({ pid: 41, name: "explorer.exe", start_time: 10 });
  const app = makeProc({ pid: 42, name: "app.exe", parent_pid: 41, start_time: 11, has_main_window: true });
  const child = makeProc({ pid: 43, name: "app-worker.exe", parent_pid: 42, start_time: 12 });
  const helper = makeProc({ pid: 44, name: "dllhost.exe", parent_pid: 41, start_time: 15 });
  const all = [shell, app, child, helper];
  const opened = new Set([41, 42]);
  const show = (mode: "applications" | "ppid") => buildProcessTree(all, "pid", false, "", opened, undefined, mode)
    .rows.map(({ process, depth }) => [getProcessIdentityKey(process), depth]);
  assert.deepEqual(show("applications"), [[getProcessIdentityKey(shell), 0], [getProcessIdentityKey(helper), 1],
    [getProcessIdentityKey(app), 0], [getProcessIdentityKey(child), 1]]);
  assert.deepEqual(show("ppid"), [[getProcessIdentityKey(shell), 0], [getProcessIdentityKey(app), 1],
    [getProcessIdentityKey(child), 2], [getProcessIdentityKey(helper), 1]]);
  assert.deepEqual(processAncestorKeys(all, child), [getProcessIdentityKey(app), getProcessIdentityKey(shell)]);
  assert.deepEqual(processAncestorKeys([shell, { ...app, start_time: 99 }, child], child), []);
});

test("metadata search preserves parent context and treats inaccessible metadata as missing", () => {
  const parent = makeProc({ pid: 51, name: "parent.exe" });
  const child = makeProc({ pid: 52, name: "a.exe", parent_pid: parent.pid, description: null });
  assert.equal(matchesProcessQuery(child, "office"), false);
  assert.equal(matchesProcessQuery({ ...child, description: "Office Viewer" }, "office"), true);
  const lookup = (process: ProcessItem) => process.pid === child.pid ? "Office Viewer" : null;
  const mode = buildProcessTree([parent, child], "path", false, "office", new Set(), p => p.pid === child.pid, "ppid", lookup);
  assert.deepEqual(mode.rows.map(row => [row.process.pid, row.depth, row.matchedSelf]), [[51, 0, false], [52, 1, true]]);
});
