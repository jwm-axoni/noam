// Opening and retargeting the folder gallery from the sidebar and the panel.

import { useLayoutStore } from "../../layout/store";
import { CENTER_NOTE_GROUP_ID } from "../../layout/types";
import { galleryPanelId, remapGalleryFolders, withGalleryFolder } from "./panelState";

/**
 * Show `folder` as a gallery: reveal the existing gallery tab (wherever it
 * docks) and retarget it, or open one as a center tab beside the notes.
 * Returns false when the layout refused the panel.
 */
export function openGallery(folder: string): boolean {
  useLayoutStore.getState().dispatch({
    type: "open-panel",
    panelType: "gallery",
    zone: "center",
    groupId: CENTER_NOTE_GROUP_ID,
  });
  const { layout, replace } = useLayoutStore.getState();
  const id = galleryPanelId(layout);
  if (!id) return false;
  const next = withGalleryFolder(layout, id, folder);
  if (next !== layout) replace(next);
  return true;
}

/** Retarget the gallery in place (subfolder cards, breadcrumbs). */
export function retargetGallery(panelId: string, folder: string): void {
  const { layout, replace } = useLayoutStore.getState();
  const next = withGalleryFolder(layout, panelId, folder);
  if (next !== layout) replace(next);
}

/** The store's rename funnel: every gallery follows its folder's new path. */
export function followGalleryRename(from: string, to: string): void {
  const { layout, replace } = useLayoutStore.getState();
  const next = remapGalleryFolders(layout, from, to);
  if (next !== layout) replace(next);
}
