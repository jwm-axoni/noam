// Who answers ⌘F: the in-note find bubble or the vault Search panel.
//
//   Mod+F        focus inside a note editor (`.cm-editor`) → the note's bubble
//   Mod+F        anywhere else                            → vault Search panel
//   Mod+Shift+F  anywhere                                 → vault Search panel
//
// Pure, so the rule is testable without mounting `App.tsx`. "Mod" is ⌘ or
// Ctrl but not both, and Alt is never part of it (Mod+Alt+F is the bubble's
// replace key on macOS).

import { EditorView } from "@codemirror/view";
import { openFind } from "./find";

export type FindShortcutRoute = "note" | "vault";

type KeyLike = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

/** The editor root `target` sits in, or null. */
export function editorRootOf(target: EventTarget | null): HTMLElement | null {
  const el =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return el?.closest<HTMLElement>(".cm-editor") ?? null;
}

export function routeFindShortcut(
  event: KeyLike,
  target: EventTarget | null,
): FindShortcutRoute | null {
  if (event.metaKey === event.ctrlKey || event.altKey) return null;
  if (event.key.toLowerCase() !== "f") return null;
  if (event.shiftKey) return "vault";
  return editorRootOf(target) ? "note" : "vault";
}

/**
 * The "note" route when CodeMirror did NOT take the key itself: focus is in
 * the editor but outside its content — the inline title, the Properties
 * panel. Opens that editor's bubble; false when there is no view to open.
 */
export function openNoteFindFrom(target: EventTarget | null): boolean {
  const root = editorRootOf(target);
  const view = root ? EditorView.findFromDOM(root) : null;
  return view ? openFind(view) : false;
}
