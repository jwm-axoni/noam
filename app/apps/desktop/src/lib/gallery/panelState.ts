// The gallery panel's one persisted field, `folder`, and the layout edits that
// keep it pointing at the right place.
//
// `folder` is a vault-relative PATH, like every per-folder pref (see
// `lib/tree/folderSorts.ts` for why a local folder has no better identity). So
// it follows in-app renames/moves exactly like they do — `remapGalleryFolders`
// is called from the store's `remapTabs` funnel — and a folder that is deleted
// or renamed outside the app leaves the panel on a path that no longer exists,
// which the panel says out loud instead of silently jumping elsewhere.

import type { LayoutV1 } from "../../layout/types";

/** The folder a gallery panel's state points at ("" = the vault root). */
export function galleryFolder(state: Record<string, unknown> | undefined): string {
  const folder = state?.folder;
  return typeof folder === "string" ? folder.replace(/^\/+|\/+$/g, "") : "";
}

/** The tab strip's label: the folder's own name, "Gallery" at the vault root. */
export function galleryTabLabel(state: Record<string, unknown> | undefined): string {
  const folder = galleryFolder(state);
  return folder ? folder.slice(folder.lastIndexOf("/") + 1) : "Gallery";
}

/** Keep only `folder` when the layout is persisted. */
export function galleryPersistentState(state: Record<string, unknown>): Record<string, unknown> {
  return { folder: galleryFolder(state) };
}

/** Point one gallery panel at `folder`. Same layout object when nothing changes. */
export function withGalleryFolder(layout: LayoutV1, panelId: string, folder: string): LayoutV1 {
  const panel = layout.panels[panelId];
  if (!panel || panel.type !== "gallery") return layout;
  if (panel.state.folder === folder) return layout;
  return {
    ...layout,
    panels: { ...layout.panels, [panelId]: { ...panel, state: { ...panel.state, folder } } },
  };
}

/** Follow an in-app rename/move: re-prefix every gallery pointing at or under `from`. */
export function remapGalleryFolders(layout: LayoutV1, from: string, to: string): LayoutV1 {
  if (from === to) return layout;
  let next = layout;
  for (const panel of Object.values(layout.panels)) {
    if (panel.type !== "gallery") continue;
    const folder = galleryFolder(panel.state);
    if (folder !== from && !folder.startsWith(`${from}/`)) continue;
    next = withGalleryFolder(next, panel.id, to + folder.slice(from.length));
  }
  return next;
}

/** The gallery panel instance, if the layout has one (multiplicity 1). */
export function galleryPanelId(layout: LayoutV1): string | null {
  return Object.values(layout.panels).find((panel) => panel.type === "gallery")?.id ?? null;
}
