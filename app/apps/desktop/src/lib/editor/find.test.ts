// @vitest-environment jsdom
// The floating find/replace bubble against a real EditorView built by
// `createEditorState` (solo) and with the yCollab binding (collab).

import { undoDepth } from "@codemirror/commands";
import { getSearchQuery, SearchQuery, searchPanelOpen } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import {
  countMatches,
  findKeymap,
  matchCountLabel,
  openFind,
  openFindCommand,
  openReplaceCommand,
  replaceOpenField,
} from "./find";
import { createEditorState, editableExtensions, readOnlyGuardedKeymap } from "./index";

beforeAll(() => {
  // jsdom has no layout engine; CodeMirror's measure pass (a rAF after every
  // dispatch) calls these. Same stubs as commands.test.ts.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
});

afterEach(() => {
  document.body.replaceChildren();
});

function mount(
  doc: string,
  extra: Partial<Parameters<typeof createEditorState>[0]> = {},
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
      viewMode: undefined,
      ...extra,
    }),
    parent,
  });
}

function mountCollab(doc: string) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, doc);
  // captureTimeout 0: two transactions can never merge into one undo item,
  // so "one undo step" really means "one transaction".
  const undoManager = new Y.UndoManager(ytext, { captureTimeout: 0 });
  const view = mount(doc, {
    collab: true,
    extraExtensions: [
      yCollab(ytext, null, { undoManager }),
      keymap.of(readOnlyGuardedKeymap(yUndoManagerKeymap)),
    ],
  });
  return { view, ytext, undoManager };
}

const bubble = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-find")!;
const input = (view: EditorView, name: "search" | "replace") =>
  bubble(view).querySelector<HTMLInputElement>(`input[name=${name}]`)!;
const btn = (view: EditorView, name: string) =>
  bubble(view).querySelector<HTMLButtonElement>(`button[name=${name}]`)!;
const countText = (view: EditorView) =>
  bubble(view).querySelector(".cm-find-count")!.textContent;

function type(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(target: Element, init: KeyboardEventInit) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

const sel = (view: EditorView) => {
  const { from, to } = view.state.selection.main;
  return [from, to];
};

describe("countMatches / matchCountLabel", () => {
  const state = EditorState.create({ doc: "cat Cat cat concat" });
  const q = (spec: ConstructorParameters<typeof SearchQuery>[0]) => new SearchQuery(spec);

  it("counts matches and places the selection among them", () => {
    const query = q({ search: "cat" });
    const at = state.update({ selection: EditorSelection.single(8, 11) }).state;
    const count = countMatches(at, query);
    expect(count).toEqual({ current: 3, total: 4, capped: false });
    expect(matchCountLabel(query, count)).toBe("3 of 4");
  });

  it("says how many when the selection is not on a match", () => {
    const query = q({ search: "cat" });
    expect(matchCountLabel(query, countMatches(state, query))).toBe("4 results");
  });

  it("says No results, and nothing for an empty query", () => {
    const none = q({ search: "dog" });
    expect(matchCountLabel(none, countMatches(state, none))).toBe("No results");
    const empty = q({ search: "" });
    expect(matchCountLabel(empty, countMatches(state, empty))).toBe("");
  });

  it("stops counting at the limit", () => {
    const query = q({ search: "a" });
    const big = EditorState.create({ doc: "a".repeat(50) });
    const count = countMatches(big, query, 10);
    expect(count).toMatchObject({ total: 10, capped: true });
    expect(matchCountLabel(query, count)).toBe("10+ results");
  });
});

describe("find bubble", () => {
  it("replaces the bottom panel with a top panel, prefilled from a one-line selection", () => {
    const view = mount("alpha beta\nbeta gamma beta");
    view.dispatch({ selection: EditorSelection.single(6, 10) });
    openFind(view);

    expect(searchPanelOpen(view.state)).toBe(true);
    expect(view.dom.querySelector(".cm-panels-top .cm-find")).not.toBeNull();
    expect(view.dom.querySelector(".cm-panels-bottom")).toBeNull();
    expect(input(view, "search").value).toBe("beta");
    expect(document.activeElement).toBe(input(view, "search"));
    expect(countText(view)).toBe("1 of 3");
  });

  it("does not prefill from a multi-line selection", () => {
    const view = mount("alpha beta\nbeta gamma");
    view.dispatch({ selection: EditorSelection.single(6, 15) });
    openFind(view);
    expect(input(view, "search").value).toBe("");
    expect(countText(view)).toBe("");
  });

  it("Mod-f in the editor opens it", () => {
    const view = mount("one two");
    const e = key(view.contentDOM, { key: "f", ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(document.activeElement).toBe(input(view, "search"));
  });

  it("finds as you type, and counts live", () => {
    const view = mount("foo bar foo baz foo");
    openFind(view);
    type(input(view, "search"), "foo");
    expect(sel(view)).toEqual([0, 3]);
    expect(countText(view)).toBe("1 of 3");
    type(input(view, "search"), "nope");
    expect(countText(view)).toBe("No results");
  });

  it("Enter goes to the next match, Shift+Enter to the previous (wrapping)", () => {
    const view = mount("foo bar foo baz foo");
    openFind(view);
    type(input(view, "search"), "foo");
    key(input(view, "search"), { key: "Enter" });
    expect(sel(view)).toEqual([8, 11]);
    expect(countText(view)).toBe("2 of 3");
    key(input(view, "search"), { key: "Enter" });
    expect(countText(view)).toBe("3 of 3");
    key(input(view, "search"), { key: "Enter" });
    expect(countText(view)).toBe("1 of 3");
    key(input(view, "search"), { key: "Enter", shiftKey: true });
    expect(sel(view)).toEqual([16, 19]);
    btn(view, "prev").click();
    expect(countText(view)).toBe("2 of 3");
    btn(view, "next").click();
    expect(countText(view)).toBe("3 of 3");
  });

  it("toggles change the query and the count", () => {
    const view = mount("Word word wordy WORD");
    openFind(view);
    type(input(view, "search"), "word");
    expect(countText(view)).toBe("1 of 4");

    btn(view, "caseSensitive").click();
    expect(getSearchQuery(view.state).caseSensitive).toBe(true);
    expect(btn(view, "caseSensitive").getAttribute("aria-pressed")).toBe("true");
    expect(countText(view)).toMatch(/of 2$/);

    btn(view, "caseSensitive").click();
    btn(view, "wholeWord").click();
    expect(getSearchQuery(view.state).wholeWord).toBe(true);
    expect(btn(view, "wholeWord").getAttribute("aria-pressed")).toBe("true");
    expect(countText(view)).toMatch(/of 3$/);

    btn(view, "wholeWord").click();
    btn(view, "regexp").click();
    type(input(view, "search"), "w.rd\\b");
    expect(getSearchQuery(view.state).regexp).toBe(true);
    expect(countText(view)).toMatch(/of 3$/);

    type(input(view, "search"), "w(");
    expect(countText(view)).toBe("No results");
    expect(input(view, "search").hasAttribute("aria-invalid")).toBe(true);
  });

  it("Esc closes and returns focus to the editor on the current match", () => {
    const view = mount("foo bar foo");
    openFind(view);
    type(input(view, "search"), "foo");
    key(input(view, "search"), { key: "Enter" });
    const e = key(input(view, "search"), { key: "Escape" });
    expect(e.defaultPrevented).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(view.dom.querySelector(".cm-find")).toBeNull();
    expect(view.hasFocus).toBe(true);
    expect(sel(view)).toEqual([8, 11]);
  });

  it("the close button closes too", () => {
    const view = mount("foo");
    openFind(view);
    btn(view, "close").click();
    expect(searchPanelOpen(view.state)).toBe(false);
  });
});

describe("replace", () => {
  it("is collapsed by default and expands with the toggle or the replace command", () => {
    const view = mount("foo");
    openFind(view);
    const row = bubble(view).querySelector<HTMLElement>(".cm-find-replace-row")!;
    expect(row.hidden).toBe(true);
    btn(view, "expand").click();
    expect(row.hidden).toBe(false);
    expect(btn(view, "expand").getAttribute("aria-expanded")).toBe("true");
    btn(view, "expand").click();
    expect(row.hidden).toBe(true);

    openFind(view, { replace: true });
    expect(view.state.field(replaceOpenField)).toBe(true);
    expect(row.hidden).toBe(false);
  });

  it("Ctrl-h (Windows/Linux) opens with replace expanded", () => {
    const view = mount("foo");
    key(view.contentDOM, { key: "h", ctrlKey: true });
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(view.state.field(replaceOpenField)).toBe(true);
  });

  it("Enter in the replace input replaces the current match and moves on", () => {
    const view = mount("foo bar foo");
    openFind(view, { replace: true });
    type(input(view, "search"), "foo");
    type(input(view, "replace"), "qux");
    key(input(view, "replace"), { key: "Enter" });
    expect(view.state.doc.toString()).toBe("qux bar foo");
    expect(sel(view)).toEqual([8, 11]);
    btn(view, "replace").click();
    expect(view.state.doc.toString()).toBe("qux bar qux");
  });

  it("Replace All is one undo step with CM6 history (solo)", () => {
    const doc = "a foo b foo c foo";
    const view = mount(doc);
    openFind(view, { replace: true });
    type(input(view, "search"), "foo");
    type(input(view, "replace"), "bar");
    const before = undoDepth(view.state);
    btn(view, "replaceAll").click();
    expect(view.state.doc.toString()).toBe("a bar b bar c bar");
    expect(undoDepth(view.state)).toBe(before + 1);
    // The editor's own undo key (CM6 history's Mod-z in solo mode).
    key(view.contentDOM, { key: "z", ctrlKey: true });
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("Replace All is one undo step with the Yjs UndoManager (collab)", () => {
    const doc = "a foo b foo c foo";
    const { view, ytext, undoManager } = mountCollab(doc);
    openFind(view, { replace: true });
    type(input(view, "search"), "foo");
    type(input(view, "replace"), "bar");
    expect(undoManager.undoStack.length).toBe(0);
    btn(view, "replaceAll").click();
    expect(ytext.toString()).toBe("a bar b bar c bar");
    expect(undoManager.undoStack.length).toBe(1);
    // The editor's own undo key (the Yjs UndoManager's Mod-z in collab mode).
    key(view.contentDOM, { key: "z", ctrlKey: true });
    expect(ytext.toString()).toBe(doc);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("read-only editors hide and disable the replace controls", () => {
    const view = mount("foo foo", { extraExtensions: [editableExtensions(true)] });
    openFind(view, { replace: true });
    const row = bubble(view).querySelector<HTMLElement>(".cm-find-replace-row")!;
    expect(row.hidden).toBe(true);
    expect(btn(view, "expand").hidden).toBe(true);
    expect(btn(view, "replaceAll").disabled).toBe(true);
    type(input(view, "search"), "foo");
    btn(view, "replaceAll").click();
    expect(view.state.doc.toString()).toBe("foo foo");
    expect(countText(view)).toBe("1 of 2");
  });
});

describe("findKeymap", () => {
  it("binds replace to Mod-Alt-f on macOS and Ctrl-h elsewhere, never Mod-h", () => {
    const replace = findKeymap.find((b) => b.run === openReplaceCommand)!;
    expect(replace.key).toBe("Ctrl-h");
    expect(replace.mac).toBe("Mod-Alt-f");
    for (const b of findKeymap) {
      expect([b.key, b.mac]).not.toContain("Mod-h");
    }
  });

  it("owns Mod-f (searchKeymap's copy is dropped)", () => {
    const modF = findKeymap.filter((b) => b.key === "Mod-f");
    expect(modF).toHaveLength(1);
    expect(modF[0].run).toBe(openFindCommand);
  });
});
