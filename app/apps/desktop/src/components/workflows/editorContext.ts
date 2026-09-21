// The editor snapshot a run starts from: which note is open, and what is
// selected in it.
//
// `import type` only — this module is reachable from eager code and a value
// import of `@codemirror/view` here would drag CodeMirror into the startup
// chunk (the same reason `activeView.ts` types `editorView` as `unknown`).

import type { EditorView } from "@codemirror/view";
import { getActiveNote } from "../../lib/editor/activeView";
import type { EditorContext } from "../../lib/workflows";

/** `{{title}}`, `{{path}}`, `{{folder}}` and `{{selection}}` come from here. */
export function currentEditorContext(): EditorContext {
  const active = getActiveNote();
  if (!active) return {};
  const view = (active.editorView as EditorView | null) ?? null;
  const range = view?.state.selection.main;
  if (!view || !range || range.empty) return { currentPath: active.path };
  return { currentPath: active.path, selection: view.state.sliceDoc(range.from, range.to) };
}
