// Per-folder sort overrides: "sort THIS folder by name, whatever the default".
//
// Device-local and per vault, like the manual order (`lib/ordering`): a sort is
// a reading preference, not vault data, so it never syncs. Stored in
// localStorage under the vault path, as folder path → TreeSort id.
//
// KEYED BY PATH, deliberately. The plan asked for a folder id so a rename could
// not drop the setting, but a local folder has no identity beyond its path:
// `TreeNode.id` IS the vault-relative path (tree.rs), and so is the SQLite
// `folders.id` (index.rs `upsert_folder`). The only real folder id is the
// server's, which a local-only vault never has and a synced one learns late.
// So this does what `itemOrder` does: every rename, move and delete the app
// makes remaps or drops the keys (`remapFolderSorts` / `dropFolderSorts`, wired
// beside `renameInOrder` / `removeFromOrder`). A folder renamed OUTSIDE the app
// loses its override — the same trade `itemOrder` and item colors already make.

import { parseTreeSort, type FolderSorts, type TreeSort } from "./sort";

const STORE_PREFIX = "context.folderSorts:";

export function readFolderSorts(vaultPath: string | undefined): FolderSorts {
  if (!vaultPath) return {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORE_PREFIX + vaultPath) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    // Drop anything that is no longer a sort we offer, rather than trusting it:
    // an id retired in a later build must fall back to the default, not throw.
    const out: FolderSorts = {};
    for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
      const sort = parseTreeSort(v);
      if (sort) out[path] = sort;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeFolderSorts(vaultPath: string, sorts: FolderSorts): void {
  try {
    localStorage.setItem(STORE_PREFIX + vaultPath, JSON.stringify(sorts));
  } catch {
    /* quota/unavailable — a sort override is a convenience only */
  }
}

/** Set (or, with `null`, clear) one folder's override. */
export function setFolderSortAt(
  sorts: FolderSorts,
  folderPath: string,
  sort: TreeSort | null,
): FolderSorts {
  if (sort === null) {
    if (!(folderPath in sorts)) return sorts;
    const out = { ...sorts };
    delete out[folderPath];
    return out;
  }
  return sorts[folderPath] === sort ? sorts : { ...sorts, [folderPath]: sort };
}

/**
 * Follow a rename or move: re-prefix the moved folder's key and every key
 * under it. Returns the same object when nothing matched. Generic over the
 * value, because every path-keyed folder pref (sorts, view modes) follows a
 * rename the same way.
 */
export function remapPathKeys<T>(
  sorts: Record<string, T>,
  from: string,
  to: string,
): Record<string, T> {
  if (from === to) return sorts;
  let changed = false;
  const out: Record<string, T> = {};
  for (const [key, sort] of Object.entries(sorts)) {
    const next =
      key === from ? to : key.startsWith(from + "/") ? to + key.slice(from.length) : key;
    if (next !== key) changed = true;
    out[next] = sort;
  }
  return changed ? out : sorts;
}

/** Forget the keys of a deleted folder and everything under it. */
export function dropPathKeys<T>(sorts: Record<string, T>, path: string): Record<string, T> {
  const gone = (k: string) => k === path || k.startsWith(path + "/");
  if (!Object.keys(sorts).some(gone)) return sorts;
  const out: Record<string, T> = {};
  for (const [key, sort] of Object.entries(sorts)) if (!gone(key)) out[key] = sort;
  return out;
}

/** {@link remapPathKeys} for sort overrides. */
export function remapFolderSorts(sorts: FolderSorts, from: string, to: string): FolderSorts {
  return remapPathKeys(sorts, from, to);
}

/** {@link dropPathKeys} for sort overrides: a deleted folder takes them along. */
export function dropFolderSorts(sorts: FolderSorts, path: string): FolderSorts {
  return dropPathKeys(sorts, path);
}
