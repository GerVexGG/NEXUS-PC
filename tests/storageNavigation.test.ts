import test from "node:test";
import assert from "node:assert/strict";
import { directoryRows, sizeShare, type DirectoryPage, type IndexedEntry } from "../src/lib/storageDirectory.ts";
import { HISTORY_LIMIT, initialNavigation, keyboardNavigation, mouseNavigation, navigate, type NavigationAction } from "../src/lib/workspaceNavigation.ts";

const storage = (volume: string, folder = "", scanId?: number): NavigationAction =>
  ({ tab: "storage", storage: { volume, folder, scanId, view: "analysis" } });
const key = (key: string, altKey = true) => ({ key, altKey, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false });

test("Back and Forward restore modules, disk, folder and view in the same history", () => {
  const chain: NavigationAction[] = [
    storage("C:/"), storage("C:/", "1", 7), storage("C:/", "1.2", 7),
    { tab: "storage", storage: { volume: "C:/", folder: "1.2", scanId: 7, view: "smart" } },
    storage("D:/"), { tab: "processes" },
  ];
  let state = chain.reduce(navigate, initialNavigation);
  for (let index = chain.length - 2; index >= 0; index--) {
    state = navigate(state, { direction: -1 });
    assert.deepEqual(state.entries[state.index], chain[index]);
  }
  state = navigate(state, { direction: -1 });
  assert.equal(state.entries[state.index].tab, "dashboard");
  assert.equal(navigate(state, { direction: -1 }), state);
  for (const destination of chain) {
    state = navigate(state, { direction: 1 });
    assert.deepEqual(state.entries[state.index], destination);
  }
  assert.equal(navigate(state, { direction: 1 }), state);
});

test("keyboard and XButtons map directions, editable controls keep their own shortcuts", () => {
  assert.equal(mouseNavigation(3), -1);
  assert.equal(mouseNavigation(4), 1);
  assert.equal(mouseNavigation(0), null);
  assert.equal(keyboardNavigation(key("ArrowLeft"), false), -1);
  assert.equal(keyboardNavigation(key("ArrowRight"), false), 1);
  assert.equal(keyboardNavigation(key("ArrowRight"), true), null);
  assert.equal(keyboardNavigation(key("ArrowDown"), false), null);
  assert.equal(keyboardNavigation(key("ArrowRight", false), false), null);
  assert.equal(keyboardNavigation({ ...key("ArrowLeft"), repeat: true }, false), null);
});

test("navigation is bounded and a new branch discards Forward history", () => {
  let state = initialNavigation;
  for (let index = 0; index < HISTORY_LIMIT * 2; index++) state = navigate(state, storage("C:/", String(index), 7));
  assert.equal(state.entries.length, HISTORY_LIMIT);
  assert.equal(navigate(state, storage("C:/", String(HISTORY_LIMIT * 2 - 1), 7)), state);
  state = navigate(navigate(state, { direction: -1 }), { tab: "network" });
  assert.equal(navigate(state, { direction: 1 }), state);
});

function entry(id: string, is_directory: boolean): IndexedEntry {
  return { id, path: id, name: id, size_bytes: 99, parent_bytes: 100, file_count: 1,
    folder_count: 0, is_directory, has_entries: is_directory, readable: true };
}
function page(entries: IndexedEntry[], next_offset: number | null = null): DirectoryPage {
  return { path: "", name: "", breadcrumbs: [], entries, next_offset, readable: true, total: entries.length };
}

test("tree expands loaded pages and treats even a malformed cyclic link as finite", () => {
  const pages = new Map([["", page([entry("0", true), entry("/f0", false)], 160)],
    ["0", page([entry("0.0", true), entry("0/f0", false)])], ["0.0", page([entry("0", true)])]]);
  assert.deepEqual(directoryRows("", pages, new Set(["0", "0.0"])).map(row =>
    "entry" in row ? [row.entry.id, row.depth] : ["more", row.offset]),
  [["0", 0], ["0.0", 1], ["0", 2], ["0/f0", 1], ["/f0", 0], ["more", 160]]);
  assert.equal(directoryRows("", pages, new Set()).length, 3);
  assert.deepEqual(directoryRows("absent", pages, new Set()), []);
});

test("parent and volume uses explicit denominators and preserves logical size ratios", () => {
  assert.equal(sizeShare(99, 100), 99);
  assert.equal(sizeShare(50, 10000), 0.5);
  assert.equal(sizeShare(100, 400), 25);
  assert.equal(sizeShare(120, 100), 120);
  assert.equal(sizeShare(0, 0), null);
  assert.equal(sizeShare(0, 100), 0);
});
