// Triple-click line selection, trimmed to the line's content.
//
// CodeMirror's default triple-click selects a whole line *including* its
// trailing newline, so the `drawSelection()` layer paints the highlight running
// to column 0 of the next line — a stray block that bleeds one line down
// (most visible on tall heading lines). We intercept the third click and select
// `line.from`→`line.to`, which stops just before the line break.

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const tripleClickLine = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.detail < 3) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    view.dispatch({
      selection: EditorSelection.range(line.from, line.to),
      userEvent: "select",
    });
    event.preventDefault();
    return true;
  },
});
