// @vitest-environment jsdom
//
// The Insert/Format menu items, run against a REAL `EditorView` with the real
// extension stack (as `commands.test.ts` does for the keys), so a menu item and
// its keyboard twin are proven to produce the same document.

import { beforeAll, describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditorState, editableExtensions } from "./index";
import { runEditorMenuCommand } from "./menuCommands";

beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
});

function mount(doc: string, from?: number, to?: number): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
    } as never),
    parent,
  });
  if (from != null) {
    view.dispatch({ selection: to != null ? EditorSelection.range(from, to) : EditorSelection.cursor(from) });
  }
  return view;
}

const text = (view: EditorView) => view.state.doc.toString();
const selected = (view: EditorView) =>
  view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);

describe("Insert", () => {
  it("wraps the selection as an internal link, caret inside when empty", () => {
    const view = mount("see Note here", 4, 8);
    expect(runEditorMenuCommand(view, "insert.internal-link")).toBe(true);
    expect(text(view)).toBe("see [[Note]] here");
    const empty = mount("", 0);
    runEditorMenuCommand(empty, "insert.internal-link");
    expect(text(empty)).toBe("[[]]");
    expect(empty.state.selection.main.head).toBe(2);
  });

  it("inserts a callout after the current line with its title selected", () => {
    const view = mount("intro", 5);
    runEditorMenuCommand(view, "insert.callout");
    expect(text(view)).toBe("intro\n> [!note] Title\n> ");
    expect(selected(view)).toBe("Title");
  });

  it("inserts a code block in place of an empty line, caret between the fences", () => {
    const view = mount("a\n\nb", 2);
    runEditorMenuCommand(view, "insert.code-block");
    expect(text(view)).toBe("a\n```\n\n```\nb");
    expect(view.state.selection.main.head).toBe(6);
  });

  it("inserts a table with the first header cell selected", () => {
    const view = mount("", 0);
    runEditorMenuCommand(view, "insert.table");
    expect(text(view)).toBe("| Column | Column |\n| --- | --- |\n|  |  |");
    expect(selected(view)).toBe("Column");
  });

  it("toggles bullets on every selected line, keeping indentation", () => {
    const view = mount("one\n  two\nthree", 0, 13);
    runEditorMenuCommand(view, "insert.bullet-list");
    expect(text(view)).toBe("- one\n  - two\n- three");
    view.dispatch({ selection: EditorSelection.range(0, text(view).length) });
    runEditorMenuCommand(view, "insert.bullet-list");
    expect(text(view)).toBe("one\n  two\nthree");
  });

  it("numbers lines in order and switches a bullet list to numbered", () => {
    const view = mount("- a\n- b\nc", 0, 9);
    runEditorMenuCommand(view, "insert.numbered-list");
    expect(text(view)).toBe("1. a\n2. b\n3. c");
    view.dispatch({ selection: EditorSelection.range(0, text(view).length) });
    runEditorMenuCommand(view, "insert.numbered-list");
    expect(text(view)).toBe("a\nb\nc");
  });

  it("leaves a task line to the task toggle, not the bullet toggle", () => {
    const view = mount("- [ ] todo", 3);
    expect(runEditorMenuCommand(view, "insert.bullet-list")).toBe(false);
    expect(text(view)).toBe("- [ ] todo");
    const task = mount("plain", 2);
    runEditorMenuCommand(task, "insert.task-list");
    expect(text(task)).toBe("- [ ] plain");
  });
});

describe("Format", () => {
  it("sets and clears heading levels", () => {
    const view = mount("Title", 2);
    runEditorMenuCommand(view, "format.heading-2");
    expect(text(view)).toBe("## Title");
    runEditorMenuCommand(view, "format.heading-3");
    expect(text(view)).toBe("### Title");
    runEditorMenuCommand(view, "format.body");
    expect(text(view)).toBe("Title");
    expect(runEditorMenuCommand(view, "format.body")).toBe(false);
  });

  it("toggles inline markers exactly like the keyboard shortcuts", () => {
    const view = mount("word", 0, 4);
    runEditorMenuCommand(view, "format.bold");
    expect(text(view)).toBe("**word**");
    runEditorMenuCommand(view, "format.bold");
    expect(text(view)).toBe("word");
    runEditorMenuCommand(view, "format.code");
    expect(text(view)).toBe("`word`");
  });

  it("Comment uses the language's comment tokens (what ⌘/ already does)", () => {
    const view = mount("aside", 2);
    runEditorMenuCommand(view, "format.comment");
    expect(text(view)).toBe("<!-- aside -->");
  });

  it("refuses to edit a read-only view", () => {
    const view = new EditorView({
      state: createEditorState({
        doc: "locked",
        getTitles: () => [],
        onNavigate: () => {},
        extraExtensions: [editableExtensions(true)],
      } as never),
      parent: document.createElement("div"),
    });
    view.dispatch({ selection: EditorSelection.range(0, 6) });
    expect(runEditorMenuCommand(view, "format.bold")).toBe(false);
    expect(runEditorMenuCommand(view, "insert.bullet-list")).toBe(false);
    expect(text(view)).toBe("locked");
  });
});
