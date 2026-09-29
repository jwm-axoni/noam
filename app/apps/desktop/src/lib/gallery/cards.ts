// Pure helpers behind the folder gallery panel (plan Part 3): card order, date
// labels and keyboard movement. Dependency-free apart from type imports and the
// sidebar's own sort, so they test in plain Node.

import type { FolderCard, TreeNode } from "../ipc";
import { applyOrder, type ItemOrder } from "../ordering";
import { sortTree, type FolderSorts, type TreeSort } from "../tree/sort";

/**
 * Order one folder's cards exactly the way the sidebar orders that folder:
 * `sortTree` with the folder's effective sort (its override, else the global
 * default), then the user's manual arrangement on top. Cards go through the
 * sidebar's own functions as `TreeNode`s rather than through a second sort, so
 * the two views can never disagree about what comes first.
 */
export function orderCards(
  cards: FolderCard[],
  folder: string,
  treeSort: TreeSort,
  folderSorts: FolderSorts,
  itemOrder: ItemOrder = {},
  /** Path → created ms, for the Created sorts (the store's `createdTimes`). */
  created?: ReadonlyMap<string, number> | null,
): FolderCard[] {
  const byPath = new Map(cards.map((card) => [card.path, card] as const));
  const nodes: TreeNode[] = cards.map((card) => ({
    id: card.path,
    // The sidebar sorts on the file NAME (extension included) — so do we.
    name: card.path.slice(card.path.lastIndexOf("/") + 1),
    path: card.path,
    isDir: card.kind === "folder",
    modified: card.kind === "note" ? card.modified : 0,
  }));
  // `sortTree` reads the override at `parentPath`; only this one level exists.
  const sorted = applyOrder(
    sortTree(nodes, treeSort, folderSorts, { created: created ?? undefined }, folder),
    folder,
    itemOrder,
  );
  return sorted.flatMap((node) => {
    const card = byPath.get(node.path);
    return card ? [card] : [];
  });
}

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["week", 7 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/** "3 days ago", "yesterday", "just now"; "" for an unknown (0) time. */
export function relativeDate(ms: number, now: number = Date.now(), locale = "en"): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return "just now";
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (abs >= size) return format.format(Math.trunc(diff / size), unit);
  }
  return "just now";
}

/** The full date for a tooltip; "" for an unknown (0) time. */
export function fullDate(ms: number, locale?: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toLocaleString(locale, { dateStyle: "full", timeStyle: "short" });
}

/**
 * Arrow-key movement across a wrapped grid of `count` cards, `columns` wide.
 * Returns the index to focus, or `null` for keys that are not ours (the caller
 * must then NOT preventDefault). Movement clamps at the edges; it never wraps
 * from the last column to the next row's first, which in a grid reads as a jump.
 */
export function nextCardIndex(
  key: string,
  index: number,
  count: number,
  columns: number,
): number | null {
  if (count <= 0) return null;
  const cols = Math.max(1, Math.floor(columns));
  const clamp = (i: number) => Math.min(count - 1, Math.max(0, i));
  switch (key) {
    case "ArrowRight":
      return clamp(index + 1);
    case "ArrowLeft":
      return clamp(index - 1);
    case "ArrowDown":
      return index + cols < count ? index + cols : index;
    case "ArrowUp":
      return index - cols >= 0 ? index - cols : index;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Breadcrumb segments for a vault-relative folder path ("" = the vault root). */
export function breadcrumbs(folder: string): Array<{ name: string; path: string }> {
  const parts = folder.split("/").filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
}
