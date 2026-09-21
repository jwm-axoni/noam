import { nextViewMode, type ViewMode } from "./viewMode";

export interface ViewModeShortcutState {
  openNotePath: string | null;
  activeCenterSurfaceKind: "note" | "panel" | null;
  modalOpen: boolean;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
}

function textEntryOwnsShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea")) return true;
  const editable = target.closest('[contenteditable="true"], [contenteditable="plaintext-only"]');
  return editable != null && editable.closest(".cm-editor") == null;
}

/**
 * Own the view-mode shortcut before an editor or WebKit editing command can
 * consume it. The store remains the authority for whether the active note is
 * still backed by an open tab.
 */
export function createViewModeShortcutHandler(
  getState: () => ViewModeShortcutState,
): (event: KeyboardEvent) => void {
  return (event) => {
    if (
      (!event.metaKey && !event.ctrlKey) ||
      event.altKey ||
      event.shiftKey ||
      event.key.toLowerCase() !== "e"
    ) {
      return;
    }

    const state = getState();
    if (
      state.activeCenterSurfaceKind !== "note" ||
      state.modalOpen ||
      textEntryOwnsShortcut(event.target) ||
      !state.openNotePath?.toLowerCase().endsWith(".md")
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    state.setViewMode(nextViewMode(state.viewMode));
  };
}
