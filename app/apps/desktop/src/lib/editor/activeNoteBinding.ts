// The CodeMirror half of the active-note registry (see `activeView.ts`). Only
// the Editor — itself a lazy chunk — imports this, so CodeMirror stays out of
// the eager bundle.

import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { ActiveNote } from "./activeView";
import { applyPresentationPatch, type PresentationPatch } from "../presentation/edit";

/** Wrap a live `EditorView` as the registry's `ActiveNote`. */
export function bindActiveNote(view: EditorView, path: string): ActiveNote {
  return {
    path,
    editorView: view,
    editable: () => !view.state.readOnly,
    insert: (md: string) => {
      if (view.state.readOnly) return false;
      const pos = view.state.selection.main.to;
      const atLineStart =
        pos === 0 || view.state.doc.sliceString(pos - 1, pos) === "\n";
      const insert = `${atLineStart ? "" : "\n"}${md}\n`;
      view.dispatch({
        changes: { from: pos, insert },
        selection: EditorSelection.cursor(pos + insert.length),
        userEvent: "input.drop",
      });
      view.focus();
      return true;
    },
    // 0-based in, 1-based out: `doc.line` counts from 1, the task/board
    // pipeline counts from 0.
    revealLine: (line: number) => {
      const target = view.state.doc.line(
        Math.max(1, Math.min(view.state.doc.lines, line + 1)),
      );
      view.dispatch({
        selection: EditorSelection.cursor(target.from),
        scrollIntoView: true,
      });
      view.focus();
      return true;
    },
    setPresentation: (patch) =>
      applyPresentationPatch(view, patch as PresentationPatch).ok,
  };
}
