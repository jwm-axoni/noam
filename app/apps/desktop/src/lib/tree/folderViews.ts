// Per-folder view mode: does clicking this folder also open it as a gallery?
//
// The same shape and rules as `folderSorts.ts`, deliberately: device-local and
// per vault (a way of looking at a folder, not vault data, so it never syncs),
// stored in localStorage under the vault path, and KEYED BY PATH — a local
// folder has no identity beyond its path (see `folderSorts.ts` for the long
// version). Every in-app rename/move remaps the keys and every in-app delete
// drops them, through the same store funnels (`remapTabs` / `pruneTabs`) and the
// same helpers. A folder renamed OUTSIDE the app goes back to list mode.
//
// Only `gallery` is ever stored: `list` is the default, so choosing it clears
// the entry, and an install that has never seen this key reads as all-list.

import { dropPathKeys, remapPathKeys } from "./folderSorts";

export type FolderViewMode = "list" | "gallery";

/** folder path → its non-default view mode. */
export type FolderViews = Record<string, "gallery">;

const STORE_PREFIX = "noam.folderViews:";

export function readFolderViews(vaultPath: string | undefined): FolderViews {
  if (!vaultPath) return {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORE_PREFIX + vaultPath) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: FolderViews = {};
    for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === "gallery") out[path] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeFolderViews(vaultPath: string, views: FolderViews): void {
  try {
    localStorage.setItem(STORE_PREFIX + vaultPath, JSON.stringify(views));
  } catch {
    /* quota/unavailable — a view mode is a convenience only */
  }
}

export function folderViewOf(views: FolderViews, folderPath: string): FolderViewMode {
  return views[folderPath] ?? "list";
}

/** Set one folder's mode; `list` clears the entry. Same object when unchanged. */
export function setFolderViewAt(
  views: FolderViews,
  folderPath: string,
  mode: FolderViewMode,
): FolderViews {
  if (mode === "list") {
    if (!(folderPath in views)) return views;
    const out = { ...views };
    delete out[folderPath];
    return out;
  }
  return views[folderPath] === "gallery" ? views : { ...views, [folderPath]: "gallery" };
}

/** Follow an in-app rename/move of a folder (and everything under it). */
export function remapFolderViews(views: FolderViews, from: string, to: string): FolderViews {
  return remapPathKeys(views, from, to);
}

/** Forget a deleted folder's mode and its subfolders'. */
export function dropFolderViews(views: FolderViews, path: string): FolderViews {
  return dropPathKeys(views, path);
}
