// The sidebar's BASE arrangement — what the tree looks like before the user's
// own drag-and-drop arrangement is layered on top of it.
//
// Two layers, and the order between them is the whole design:
//
//   sortTree()  →  the base order, from a preference (name or modified, either
//                  direction; a global default plus per-folder overrides)
//   applyOrder() →  the user's manual per-folder arrangement, pinned on top
//
// Because `applyOrder` ranks the items a folder has been arranged with and
// leaves every *unranked* item in the order it received, sorting first means
// changing the sort can never disturb an arrangement someone made by hand: a
// folder they dragged into place keeps its position, while the folders and
// files they never touched — including everything inside that folder — follow
// the sort. That is the property to preserve if this is ever refactored.
//
// Pure and dependency-free (the TreeNode import is type-only) so it tests in a
// plain Node environment.

import type { TreeNode } from "../ipc";

/** A time a sort can order files by. 0 or absent means "unknown". */
type TimeKey = (n: TreeNode) => number | undefined;

const modifiedKey: TimeKey = (n) => n.modified;

/**
 * Every sort the sidebar offers, in menu order. `by` is `"name"` or the time
 * key files sort on; `dir` is 1 ascending (A–Z, oldest first), -1 descending.
 * Adding a mode — Created, once a reliable created date reaches `TreeNode` — is
 * one row here plus its key function.
 *
 * The ids are persisted (the global default in prefs, per-folder overrides in
 * `folderSorts`), so never rename one: `"recent"` and `"name"` predate the rest
 * and are exactly what an existing install has saved.
 */
export const TREE_SORTS = [
  { id: "name", label: "Name, A–Z", hint: "Alphabetical", by: "name", dir: 1 },
  { id: "name-desc", label: "Name, Z–A", hint: "Reverse alphabetical", by: "name", dir: -1 },
  { id: "recent", label: "Modified, newest first", hint: "Newest notes first", by: modifiedKey, dir: -1 },
  { id: "modified-asc", label: "Modified, oldest first", hint: "Oldest notes first", by: modifiedKey, dir: 1 },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
  by: "name" | TimeKey;
  dir: 1 | -1;
}>;

/** How the sidebar arranges anything the user hasn't arranged themselves. */
export type TreeSort = (typeof TREE_SORTS)[number]["id"];

type SortSpec = (typeof TREE_SORTS)[number];

const SPEC_BY_ID = new Map<string, SortSpec>(TREE_SORTS.map((s) => [s.id, s]));

/** A fresh install's default — see `readTreeSort` for why. */
export const DEFAULT_TREE_SORT: TreeSort = "recent";

/** A persisted value, if it is still a sort we know; `null` otherwise. */
export function parseTreeSort(v: unknown): TreeSort | null {
  return typeof v === "string" && SPEC_BY_ID.has(v) ? (v as TreeSort) : null;
}

export function treeSortLabel(sort: TreeSort): string {
  return SPEC_BY_ID.get(sort)?.label ?? sort;
}

/** Does this mode read a live key (an mtime)? Those are the modes a sync wave
 *  can reshuffle, so the sidebar pins their keys while it is being used. */
export function isTimeSort(sort: TreeSort): boolean {
  const spec = SPEC_BY_ID.get(sort);
  return !!spec && spec.by !== "name";
}

/**
 * Per-folder overrides: folder path → the sort for THAT folder's direct
 * children. Not inherited — a subfolder without its own entry uses the global
 * default. Keyed by path, not id; `folderSorts.ts` says why and keeps the keys
 * in step with renames, moves and deletes.
 */
export type FolderSorts = Record<string, TreeSort>;

/** Sidebar rows are titles, so compare them the way a reader would: "note 10"
 *  after "note 9", case- and accent-insensitively. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Name order, made total: names the collator calls equal ("a.md" / "A.md")
 *  fall back to the raw path, so the result never depends on input order. */
function byName(a: TreeNode, b: TreeNode): number {
  return collator.compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function known(t: number | undefined): t is number {
  return t !== undefined && t > 0;
}

function fileComparator(spec: SortSpec): (a: TreeNode, b: TreeNode) => number {
  const { by, dir } = spec;
  if (by === "name") return (a, b) => dir * byName(a, b);
  return (a, b) => {
    const ta = by(a);
    const tb = by(b);
    // An unknown time is not "oldest": it goes last in BOTH directions, so
    // flipping to oldest-first never floods the top with undated rows.
    if (known(ta) !== known(tb)) return known(ta) ? -1 : 1;
    if (known(ta) && known(tb) && ta !== tb) return dir * (ta - tb);
    return byName(a, b);
  };
}

function folderComparator(spec: SortSpec): (a: TreeNode, b: TreeNode) => number {
  // Folders follow a NAME sort's direction but never a time sort — see sortTree.
  return spec.by === "name" ? (a, b) => spec.dir * byName(a, b) : byName;
}

/**
 * Sort a tree level (and, recursively, everything under it).
 *
 * Folders always come first. In the name modes they follow the chosen
 * direction; in the time modes they stay A–Z. A folder's mtime moves whenever
 * anything inside it does, so sorting folders by recency would shuffle the
 * sidebar's skeleton every time a note is saved — the part of the tree a user
 * navigates by muscle memory. Recency is a property of the notes, so that is
 * where a time mode applies. (This is also what "default to recent for the
 * files, mostly not the folders" asks for.)
 *
 * `overrides` swaps the mode for ONE folder's direct children (keyed by that
 * folder's path; the root would be `""`). Every other level — that folder's
 * own subfolders included — uses `mode` unless it has an entry of its own.
 *
 * Ties and missing mtimes (0/absent) fall back to name order, so the result is
 * total and stable rather than dependent on what `read_dir` happened to yield.
 */
export function sortTree(
  nodes: TreeNode[],
  mode: TreeSort,
  overrides: FolderSorts = {},
  parentPath = "",
): TreeNode[] {
  const spec =
    SPEC_BY_ID.get(overrides[parentPath] ?? mode) ?? SPEC_BY_ID.get(DEFAULT_TREE_SORT)!;
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];
  for (const n of nodes) (n.isDir ? dirs : files).push(n);

  dirs.sort(folderComparator(spec));
  files.sort(fileComparator(spec));

  return [...dirs, ...files].map((n) =>
    n.children ? { ...n, children: sortTree(n.children, mode, overrides, n.path) } : n,
  );
}

/**
 * Freeze the recency sort key of every file node we have already placed.
 *
 * The time modes sort files by their `.md` file's mtime, and a sync run
 * rewrites files: a bulk wave in a 1,560-note vault moved 1,372 mtimes inside
 * three minutes (measured 2026-09-04). Every one of those writes re-sorted the
 * folder it was in, and arborist positions rows absolutely — so the row under
 * the pointer became a *different* row several times a second. That is the
 * sidebar "blinking on hover" and the clicks that "land on the wrong thing /
 * feel blocked" while something syncs: the highlight follows the cursor, but
 * the content beneath it keeps being replaced.
 *
 * So while the sidebar is being used (or while a wave is in flight), sort by the
 * mtime each row was FIRST seen with. `pins` is the caller's memory of that,
 * keyed by path: a path already in it keeps its remembered key, a new path
 * records its current one (so a note created mid-wave still appears at the top,
 * where it belongs). Clearing `pins` thaws it, and the next sort is the true one.
 *
 * Folders are untouched — no mode sorts them by time.
 */
export function pinModified(nodes: TreeNode[], pins: Map<string, number>): TreeNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    if (n.isDir) {
      if (!n.children) return n;
      const kids = pinModified(n.children, pins);
      if (kids === n.children) return n;
      changed = true;
      return { ...n, children: kids };
    }
    const live = n.modified ?? 0;
    const pinned = pins.get(n.path);
    if (pinned === undefined) {
      pins.set(n.path, live);
      return n;
    }
    if (pinned === live) return n;
    changed = true;
    return { ...n, modified: pinned };
  });
  // Identity is load-bearing: an unchanged level returns the SAME array, so a
  // refresh that moved nothing cannot invalidate a memo downstream.
  return changed ? out : nodes;
}
