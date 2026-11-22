export interface IndexedEntry {
  id: string;
  path: string;
  name: string;
  size_bytes: number;
  parent_bytes: number;
  file_count: number;
  folder_count: number;
  is_directory: boolean;
  has_entries: boolean;
  readable: boolean;
}

export interface DirectoryPage {
  path: string;
  name: string;
  breadcrumbs: [string, string][];
  entries: IndexedEntry[];
  next_offset: number | null;
  total: number;
  readable: boolean;
}

export type DirectorySort = "name" | "size" | "files" | "folders";
export type DirectoryRow = { entry: IndexedEntry; depth: number } | { more: string; offset: number; depth: number };

export function sizeShare(bytes: number, denominator: number | null): number | null {
  return denominator && denominator > 0 ? bytes / denominator * 100 : null;
}

export function directoryRows(root: string, pages: ReadonlyMap<string, DirectoryPage>, expanded: ReadonlySet<string>): DirectoryRow[] {
  const rows: DirectoryRow[] = [];
  const visited = new Set<string>();
  function append(id: string, depth: number) {
    if (visited.has(id)) return;
    visited.add(id);
    const page = pages.get(id);
    if (!page) return;
    for (const entry of page.entries) {
      rows.push({ entry, depth });
      if (entry.is_directory && expanded.has(entry.id)) append(entry.id, depth + 1);
    }
    if (page.next_offset !== null) rows.push({ more: id, offset: page.next_offset, depth });
  }
  append(root, 0);
  return rows;
}
