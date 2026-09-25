// The CodeMirror half of the native menu: Insert and Format items, run against
// the live editor. Loaded lazily by `menu/menuActions.ts` (the menu handler is
// eager; CodeMirror must stay out of the startup chunk — see `activeView.ts`).
//
// Where a keyboard shortcut already exists the menu item runs THE SAME command
// (`toggleInline`, `setHeading`, `insertLink`, `toggleTaskAtCursor`, and
// `toggleComment` — which is what ⌘/ already does through `defaultKeymap`, so
// the menu says `<!-- -->` rather than inventing a second comment syntax).

import { toggleComment } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import type { MenuActionId } from "../../menu/menuSpec";
import { clearHeading, insertLink, setHeading, toggleInline } from "./formatting";
import { toggleTaskAtCursor } from "./tasks";

export type EditorMenuCommandId = Extract<MenuActionId, `insert.${string}` | `format.${string}`>;

/** `open`…`close` around each selection; an empty selection lands the caret between them. */
function wrapWith(open: string, close: string): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const tr = view.state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: open },
        { from: range.to, insert: close },
      ],
      range: range.empty
        ? EditorSelection.cursor(range.from + open.length)
        : EditorSelection.range(range.from + open.length, range.to + open.length),
    }));
    view.dispatch(tr, { scrollIntoView: true, userEvent: "input.format" });
    return true;
  };
}

/**
 * Insert a block template on its own line after the caret's line (or in place
 * of an empty one), then park the caret `caret` characters in — or select
 * [caret, selTo) so the placeholder is replaced by typing.
 */
function insertBlock(text: string, caret: number, selTo?: number): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const { state } = view;
    const line = state.doc.lineAt(state.selection.main.to);
    const prefix = line.length === 0 ? "" : "\n";
    const from = line.length === 0 ? line.from : line.to;
    const base = from + prefix.length;
    view.dispatch({
      changes: { from, insert: prefix + text },
      selection:
        selTo != null
          ? EditorSelection.range(base + caret, base + selTo)
          : EditorSelection.cursor(base + caret),
      scrollIntoView: true,
      userEvent: "input.format",
    });
    return true;
  };
}

const BULLET_RE = /^(\s*)[-*+][ \t]+(?!\[[ xX]\][ \t])/;
const ORDERED_RE = /^(\s*)\d+[.)][ \t]+/;
const TASK_RE = /^\s*[-*+][ \t]+\[[ xX]\][ \t]/;

/**
 * Toggle a list marker on every selected line: lines already in that list
 * kind drop the marker, lines in the other kind switch, plain lines join.
 * Tasks (`- [ ]`) are left to `toggleTaskAtCursor`.
 */
function toggleList(kind: "bullet" | "ordered"): Command {
  const own = kind === "bullet" ? BULLET_RE : ORDERED_RE;
  const other = kind === "bullet" ? ORDERED_RE : BULLET_RE;
  return (view) => {
    if (view.state.readOnly) return false;
    const { state } = view;
    const seen = new Set<number>();
    const changes: { from: number; to: number; insert: string }[] = [];
    let n = 1;
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let i = first; i <= last; i++) {
        if (seen.has(i)) continue;
        seen.add(i);
        const line = state.doc.line(i);
        // A task is already a bullet; its box belongs to `toggleTaskAtCursor`.
        if (kind === "bullet" && TASK_RE.test(line.text)) continue;
        const mine = own.exec(line.text);
        if (mine) {
          changes.push({ from: line.from + mine[1].length, to: line.from + mine[0].length, insert: "" });
          continue;
        }
        const marker = kind === "bullet" ? "- " : `${n++}. `;
        const theirs = other.exec(line.text);
        const indent = theirs ? theirs[1].length : (/^\s*/.exec(line.text)?.[0].length ?? 0);
        changes.push({
          from: line.from + indent,
          to: line.from + (theirs ? theirs[0].length : indent),
          insert: marker,
        });
      }
    }
    if (!changes.length) return false;
    view.dispatch({ changes, userEvent: "input.format" });
    return true;
  };
}

const COMMANDS: Record<EditorMenuCommandId, Command> = {
  "insert.internal-link": wrapWith("[[", "]]"),
  "insert.markdown-link": insertLink,
  "insert.callout": insertBlock("> [!note] Title\n> ", 10, 15),
  "insert.code-block": insertBlock("```\n\n```", 4),
  "insert.table": insertBlock("| Column | Column |\n| --- | --- |\n|  |  |", 2, 8),
  "insert.bullet-list": toggleList("bullet"),
  "insert.numbered-list": toggleList("ordered"),
  "insert.task-list": toggleTaskAtCursor,
  // The attachment picker is I/O, handled in `menuActions.ts`; nothing to do here.
  "insert.attachment": () => false,
  "format.heading-1": setHeading(1),
  "format.heading-2": setHeading(2),
  "format.heading-3": setHeading(3),
  "format.heading-4": setHeading(4),
  "format.heading-5": setHeading(5),
  "format.heading-6": setHeading(6),
  "format.body": clearHeading,
  "format.bold": toggleInline("**"),
  "format.italic": toggleInline("*"),
  "format.code": toggleInline("`"),
  "format.highlight": toggleInline("=="),
  "format.strikethrough": toggleInline("~~"),
  "format.comment": toggleComment,
};

/** Run one Insert/Format menu item against `view`; false when nothing changed. */
export function runEditorMenuCommand(view: EditorView, id: EditorMenuCommandId): boolean {
  const ran = COMMANDS[id](view);
  if (ran) view.focus();
  return ran;
}
