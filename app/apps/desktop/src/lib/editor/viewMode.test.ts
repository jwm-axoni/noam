// @vitest-environment jsdom

import { closeCompletion, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { foldEffect, foldable, foldedRanges } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import {
  createEditorState,
  presentationExtensions,
  readOnlyGuardedKeymap,
} from "./index";
import {
  activeLineChecker,
  isFocused,
  selectionTouches,
  setFocused,
} from "./reveal";
import { toggleTaskAtCursor } from "./tasks";
import { isReading, nextViewMode, viewMode, type ViewMode } from "./viewMode";

const presentationOptions = {
  getTitles: () => [],
  onNavigate: () => {},
  resolveAsset: (src: string) => src,
};

function mount(
  doc: string,
  mode: ViewMode,
  extra: Partial<Parameters<typeof createEditorState>[0]> = {},
): { view: EditorView; compartment: Compartment } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const compartment = new Compartment();
  const view = new EditorView({
    state: createEditorState({
      doc,
      ...presentationOptions,
      ...extra,
      viewMode: { mode, compartment },
    }),
    parent,
  });
  return { view, compartment };
}

const shown = (view: EditorView) =>
  Array.from(view.contentDOM.querySelectorAll(".cm-line"))
    .map((line) => line.textContent ?? "")
    .join("\n");

const switchTo = (view: EditorView, compartment: Compartment, mode: ViewMode) => {
  if (mode === "reading") closeCompletion(view);
  view.dispatch({
    effects: compartment.reconfigure(presentationExtensions(mode, presentationOptions)),
  });
};

const foldedCount = (state: EditorState) => {
  let count = 0;
  foldedRanges(state).between(0, state.doc.length, () => {
    count++;
  });
  return count;
};

describe("view mode facet and reveal", () => {
  it("defaults to Live Preview", () => {
    const state = EditorState.create();
    expect(state.facet(viewMode)).toBe("live");
    expect(isReading(state)).toBe(false);
  });

  it("cycles Live to Source to Reading and back", () => {
    expect(nextViewMode("live")).toBe("source");
    expect(nextViewMode("source")).toBe("reading");
    expect(nextViewMode("reading")).toBe("live");
  });

  it("Reading hides reveal even when focused on the token and line", () => {
    const doc = "# **Heading**\n\n- [ ] task";
    const { view } = mount(doc, "reading");
    const at = doc.indexOf("Heading") + 2;
    view.dispatch({ effects: setFocused.of(true), selection: { anchor: at } });

    expect(isReading(view.state)).toBe(true);
    expect(selectionTouches(view.state)(at, at)).toBe(false);
    expect(activeLineChecker(view.state)(0, doc.indexOf("\n"))).toBe(false);
    expect(shown(view)).not.toContain("**Heading**");
    expect(shown(view)).toContain("Heading");
    expect(view.dom.classList.contains("cm-reading")).toBe(true);
    view.destroy();
  });

  it("Reading keeps the Properties panel mounted when the caret maps into YAML", () => {
    const doc = "---\nstatus: draft\n---\nBody";
    const { view } = mount(doc, "reading", {
      header: {
        vaultId: "vault-a",
        path: "Note.md",
        mode: "visible",
        renameTo: async () => null,
        noteExists: async () => false,
      },
    });
    view.dispatch({
      effects: setFocused.of(true),
      selection: { anchor: doc.indexOf("draft") },
    });

    expect(view.dom.querySelector(".cm-note-properties")).not.toBeNull();
    expect(view.dom.querySelector(".cm-frontmatter")).toBeNull();
    view.destroy();
  });
});

describe("Source presentation", () => {
  it("hides no Markdown marks and mounts no presentation widgets", () => {
    const doc = [
      "---",
      "kind: test",
      "---",
      "# **Heading**",
      "- [ ] task",
      "[[Note]] and [link](https://example.com)",
      "```js",
      "const n = 1;",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n");
    const { view } = mount(doc, "source");

    expect(view.dom.classList.contains("cm-source")).toBe(true);
    expect(shown(view)).toBe(doc);
    expect(
      view.dom.querySelector(
        ".cm-bullet, .cm-task-checkbox, .cm-md-html, .cm-md-table, .cm-foldChevron, .cm-fence-copy",
      ),
    ).toBeNull();
    view.destroy();
  });

  it("keeps frontmatter as dimmed source and never mounts the Properties panel", () => {
    const doc = "---\nstatus: draft\n---\nBody";
    const { view } = mount(doc, "source", {
      header: {
        vaultId: "vault-a",
        path: "Note.md",
        mode: "visible",
        renameTo: async () => null,
        noteExists: async () => false,
      },
    });

    expect(view.dom.querySelector(".cm-note-properties")).toBeNull();
    expect(view.dom.querySelector(".cm-frontmatter")).not.toBeNull();
    expect(shown(view)).toContain("---\nstatus: draft\n---");
    view.destroy();
  });
});

describe("Reading edit refusal and live reconfiguration", () => {
  it("refuses task checkbox changes in Reading mode", () => {
    const doc = "- [ ] task";
    const { view } = mount(doc, "reading");
    const checkbox = view.dom.querySelector<HTMLInputElement>(".cm-task-checkbox");
    expect(checkbox).not.toBeNull();
    expect(view.state.readOnly).toBe(true);

    // The widget's own mousedown listener is the contract under test. Keep the
    // synthetic event at the target: jsdom has no Range#getClientRects for
    // CodeMirror's separate contentDOM mouse-position handler.
    checkbox!.dispatchEvent(new MouseEvent("mousedown"));
    expect(toggleTaskAtCursor(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it("switches presentation compartments without replacing the view or document", () => {
    const doc = "**bold**\n\n- item";
    const { view, compartment } = mount(doc, "live");
    const originalView = view;
    view.dispatch({ effects: setFocused.of(true) });

    view.dispatch({
      effects: compartment.reconfigure(
        presentationExtensions("source", presentationOptions),
      ),
    });
    expect(view).toBe(originalView);
    expect(view.state.doc.toString()).toBe(doc);
    expect(shown(view)).toBe(doc);
    expect(isFocused(view.state)).toBe(true);

    view.dispatch({
      effects: compartment.reconfigure(
        presentationExtensions("reading", presentationOptions),
      ),
    });
    expect(view).toBe(originalView);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.readOnly).toBe(true);
    view.destroy();
  });

  it("preserves the view, selection and undo history through every ordered mode pair", () => {
    const modes: ViewMode[] = ["live", "source", "reading"];
    for (const from of modes) {
      for (const to of modes) {
        if (from === to) continue;
        const { view, compartment } = mount("alpha", "live");
        view.dispatch({ changes: { from: 5, insert: "!" }, selection: { anchor: 3 } });
        switchTo(view, compartment, from);
        const original = view;

        switchTo(view, compartment, to);
        switchTo(view, compartment, from);

        expect(view).toBe(original);
        expect(view.state.selection.main.head, `${from} -> ${to}`).toBe(3);
        expect(view.state.doc.toString()).toBe("alpha!");
        switchTo(view, compartment, "live");
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe("alpha");
        view.destroy();
      }
    }
  });

  it("guards Yjs keyboard and native-history undo while Reading but accepts remote edits", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "hello");
    const undoManager = new Y.UndoManager(ytext);
    const { view, compartment } = mount("hello", "live", {
      collab: true,
      extraExtensions: [
        yCollab(ytext, null, { undoManager }),
        keymap.of(readOnlyGuardedKeymap(yUndoManagerKeymap)),
      ],
    });
    view.dispatch({ changes: { from: 5, insert: "!" } });
    expect(ytext.toString()).toBe("hello!");
    switchTo(view, compartment, "reading");

    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    view.contentDOM.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "historyUndo",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.state.doc.toString()).toBe("hello!");
    expect(ytext.toString()).toBe("hello!");

    ydoc.transact(() => ytext.insert(ytext.length, " remote"), "remote");
    expect(view.state.doc.toString()).toBe("hello! remote");
    expect(ytext.toString()).toBe("hello! remote");
    view.destroy();
    ydoc.destroy();
  });

  it("invalidates retained checkbox and callout decorations in both directions", () => {
    const doc = "- [ ] task\n> [!note] Title\n> body";
    const { view, compartment } = mount(doc, "live");
    view.dispatch({ effects: setFocused.of(true), selection: { anchor: 2 } });
    expect(view.dom.querySelector(".cm-task-checkbox")).toBeNull();

    switchTo(view, compartment, "reading");
    expect(view.dom.querySelector(".cm-task-checkbox")).not.toBeNull();
    switchTo(view, compartment, "live");
    expect(view.dom.querySelector(".cm-task-checkbox")).toBeNull();

    view.dispatch({ selection: { anchor: doc.indexOf("Title") } });
    expect(view.dom.querySelector(".cm-callout-icon")).toBeNull();
    switchTo(view, compartment, "reading");
    expect(view.dom.querySelector(".cm-callout-icon")).not.toBeNull();
    switchTo(view, compartment, "live");
    expect(view.dom.querySelector(".cm-callout-icon")).toBeNull();
    view.destroy();
  });

  it("closes completion on entering Reading and cannot start it there", async () => {
    const { view, compartment } = mount("/", "live");
    expect(startCompletion(view)).toBe(true);
    await Promise.resolve();
    switchTo(view, compartment, "reading");
    expect(completionStatus(view.state)).toBeNull();
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        code: "Space",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
    expect(completionStatus(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe("/");
    view.destroy();
  });

  it("shows literal Source without leaking folds and restores them on return", () => {
    const doc = "# Heading\nbody\n\n# Next\ntail";
    const { view, compartment } = mount(doc, "live");
    const first = view.state.doc.line(1);
    const range = foldable(view.state, first.from, first.to);
    expect(range).not.toBeNull();
    view.dispatch({ effects: foldEffect.of(range!) });
    expect(foldedCount(view.state)).toBe(1);

    switchTo(view, compartment, "source");
    expect(foldedCount(view.state)).toBe(0);
    expect(shown(view)).toBe(doc);
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "[",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(foldedCount(view.state)).toBe(0);

    switchTo(view, compartment, "live");
    expect(foldedCount(view.state)).toBe(1);
    view.destroy();
  });

  it("discards an open table draft and blocks a retained menu action on entry", async () => {
    const doc = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const { view, compartment } = mount(doc, "live");
    const cell = view.dom.querySelector<HTMLElement>(".cm-md-table th")!;
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const input = view.dom.querySelector<HTMLInputElement>(".cm-md-cell-input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "changed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const other = view.dom.querySelectorAll<HTMLElement>(".cm-md-table th")[1]!;
    other.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const deleteColumn = Array.from(document.querySelectorAll<HTMLElement>(".cm-md-table-menu li"))
      .find((item) => item.textContent === "Delete column")!;

    switchTo(view, compartment, "reading");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    deleteColumn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.dom.querySelector(".cm-md-cell-input")).toBeNull();
    expect(document.querySelector(".cm-md-table-menu")).toBeNull();
    view.destroy();
  });
});
