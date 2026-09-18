import { type EditorState, Facet } from "@codemirror/state";

/** The three ways a Markdown note can be presented in the one live editor. */
export type ViewMode = "live" | "source" | "reading";

/**
 * The active presentation mode. Editors that do not install an explicit value
 * keep the app's long-standing Live Preview behaviour.
 */
export const viewMode = Facet.define<ViewMode, ViewMode>({
  combine: (values) => values[0] ?? "live",
});

/** True when the note is being rendered for reading rather than editing. */
export function isReading(state: EditorState): boolean {
  return state.facet(viewMode) === "reading";
}

/** Shared ordering for the segmented control and the ⌘E cycle. */
export const VIEW_MODE_ORDER: readonly ViewMode[] = ["live", "source", "reading"];

export function nextViewMode(mode: ViewMode): ViewMode {
  const index = VIEW_MODE_ORDER.indexOf(mode);
  return VIEW_MODE_ORDER[(index + 1) % VIEW_MODE_ORDER.length] ?? "live";
}
