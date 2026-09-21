// @vitest-environment jsdom

import { undo } from "@codemirror/commands";
import { Compartment, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { beforeAll, describe, expect, it } from "vitest";
import { createEditorState, editableExtensions } from "./index";
import { applyHighlight } from "./coloredHighlight";

beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
});

function mount(doc: string, readOnly = false, mode: "live" | "source" | "reading" = "live"): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const compartment = new Compartment();
  return new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
      viewMode: { mode, compartment },
      extraExtensions: readOnly ? [editableExtensions(true)] : [],
    } as never),
    parent,
  });
}

function press(view: EditorView, key: string, mods: { alt?: boolean; shift?: boolean } = {}) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: `Key${key.toUpperCase()}`,
      keyCode: key.toUpperCase().charCodeAt(0),
      altKey: !!mods.alt,
      shiftKey: !!mods.shift,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("colored highlight editing", () => {
  it("keeps the default shortcut in portable ==text== syntax", () => {
    const view = mount("pick me");
    view.dispatch({ selection: EditorSelection.range(0, 4) });
    expect(applyHighlight("yellow")(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("==pick== me");
    view.destroy();
  });

  it("adds markers without replacing unrelated line content", () => {
    const view = mount("before target after");
    const touched: Array<[number, number]> = [];
    view.update = ((original) =>
      function (this: EditorView, transactions: Parameters<EditorView["update"]>[0]) {
        for (const transaction of transactions) {
          transaction.changes.iterChanges((from, to) => touched.push([from, to]));
        }
        return original.call(this, transactions);
      })(view.update) as EditorView["update"];
    view.dispatch({ selection: EditorSelection.range(7, 13) });
    applyHighlight("green")(view);
    expect(touched).toEqual([
      [7, 7],
      [13, 13],
    ]);
    expect(view.state.doc.toString()).toBe(
      'before <mark data-noam-color="green">target</mark> after',
    );
    view.destroy();
  });

  it("recolors part of an existing mark without losing nested Markdown", () => {
    const doc = "==one **bold** [link](https://noam.io)==";
    const view = mount(doc);
    const from = doc.indexOf("**bold**");
    view.dispatch({ selection: EditorSelection.range(from, from + "**bold**".length) });
    applyHighlight("green")(view);
    expect(view.state.doc.toString()).toBe(
      '==one ==<mark data-noam-color="green">**bold**</mark>== [link](https://noam.io)==',
    );
    view.destroy();
  });

  it("splits multiline selections into valid per-line marks", () => {
    const view = mount("alpha\nbeta");
    view.dispatch({ selection: EditorSelection.range(0, 10) });
    applyHighlight("purple")(view);
    expect(view.state.doc.toString()).toBe(
      '<mark data-noam-color="purple">alpha</mark>\n<mark data-noam-color="purple">beta</mark>',
    );
    view.destroy();
  });

  it("handles multiple selections in one transaction and one undo", () => {
    const view = mount("red blue");
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(4, 8),
      ]),
    });
    applyHighlight("pink")(view);
    expect(view.state.doc.toString()).toBe(
      '<mark data-noam-color="pink">red</mark> <mark data-noam-color="pink">blue</mark>',
    );
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("red blue");
    view.destroy();
  });

  it("clears known marks without changing their text", () => {
    const doc = '==yellow== and <mark data-noam-color="blue">**blue**</mark>';
    const view = mount(doc);
    view.dispatch({ selection: EditorSelection.range(0, doc.length) });
    applyHighlight(null)(view);
    expect(view.state.doc.toString()).toBe("yellow and **blue**");
    view.destroy();
  });

  it("does not toggle off a partial highlighted selection", () => {
    const doc = "==marked== plain";
    const view = mount(doc);
    view.dispatch({ selection: EditorSelection.range(0, doc.length) });
    applyHighlight("yellow")(view);
    expect(view.state.doc.toString()).toContain("==marked==");
    expect(view.state.doc.toString()).toContain("plain==");
    view.destroy();
  });

  it("keeps the selected text selected for repeated recoloring", () => {
    const view = mount("change this twice");
    view.dispatch({ selection: EditorSelection.range(7, 11) });
    applyHighlight("green")(view);
    applyHighlight("blue")(view);
    expect(view.state.doc.toString()).toBe(
      'change <mark data-noam-color="blue">this</mark> twice',
    );
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "this",
    );
    view.destroy();
  });

  it("merges disconnected peer edits inside and outside the selected span", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const textA = docA.getText("content");
    textA.insert(0, "left target right");
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = docB.getText("content");
    const baseA = Y.encodeStateVector(docA);
    const baseB = Y.encodeStateVector(docB);
    const awarenessA = new Awareness(docA);
    const awarenessB = new Awareness(docB);
    const parentA = document.createElement("div");
    const parentB = document.createElement("div");
    document.body.append(parentA, parentB);
    const options = { getTitles: () => [], onNavigate: () => {}, collab: true } as const;
    const viewA = new EditorView({
      state: createEditorState({
        ...options,
        doc: textA.toString(),
        extraExtensions: [yCollab(textA, awarenessA, { undoManager: new Y.UndoManager(textA) })],
      } as never),
      parent: parentA,
    });
    const viewB = new EditorView({
      state: createEditorState({
        ...options,
        doc: textB.toString(),
        extraExtensions: [yCollab(textB, awarenessB, { undoManager: new Y.UndoManager(textB) })],
      } as never),
      parent: parentB,
    });

    viewA.dispatch({ selection: EditorSelection.range(5, 11) });
    applyHighlight("green")(viewA);
    // Client B is still disconnected. It edits inside the future highlight and
    // elsewhere on the same line before either side receives the other's ops.
    viewB.dispatch({
      changes: [
        { from: 0, insert: "LEFT " },
        { from: 8, insert: "remote-" },
        { from: textB.length, insert: "!" },
      ],
    });
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, baseA));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, baseB));

    const expected = 'LEFT left <mark data-noam-color="green">tarremote-get</mark> right!';
    expect(viewA.state.doc.toString()).toBe(expected);
    expect(viewB.state.doc.toString()).toBe(expected);
    expect(textA.toString()).toBe(expected);
    expect(textB.toString()).toBe(expected);
    viewA.destroy();
    viewB.destroy();
    awarenessA.destroy();
    awarenessB.destroy();
    docA.destroy();
    docB.destroy();
  });

  it("refuses writes in read-only state", () => {
    const view = mount("leave this", true);
    view.dispatch({ selection: EditorSelection.range(0, 5) });
    expect(applyHighlight("green")(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("leave this");
    view.destroy();
  });

  it("does not format frontmatter or fenced code", () => {
    const doc = "---\ntitle: Test\n---\n\n```ts\nconst value = 1\n```\n\nplain";
    const view = mount(doc);
    view.dispatch({ selection: EditorSelection.range(0, doc.length) });
    applyHighlight("blue")(view);
    expect(view.state.doc.toString()).toBe(
      '---\ntitle: Test\n---\n\n```ts\nconst value = 1\n```\n\n<mark data-noam-color="blue">plain</mark>',
    );
    view.destroy();
  });

  it("skips inline code and honors the opening fence length", () => {
    const doc = "`inline` plain\n````\ninside\n```\nstill inside\n````\noutside";
    const view = mount(doc);
    view.dispatch({ selection: EditorSelection.range(0, doc.length) });
    applyHighlight("blue")(view);
    expect(view.state.doc.toString()).toBe(
      '`inline` <mark data-noam-color="blue">plain</mark>\n````\ninside\n```\nstill inside\n````\n<mark data-noam-color="blue">outside</mark>',
    );
    view.destroy();
  });

  it("preserves heading, list, task, and blockquote syntax", () => {
    const doc = "# Heading\n- List\n- [ ] Task\n> Quote\n> - Nested";
    const view = mount(doc);
    view.dispatch({ selection: EditorSelection.range(0, doc.length) });
    applyHighlight("pink")(view);
    expect(view.state.doc.toString()).toBe(
      '# <mark data-noam-color="pink">Heading</mark>\n' +
        '- <mark data-noam-color="pink">List</mark>\n' +
        '- [ ] <mark data-noam-color="pink">Task</mark>\n' +
        '> <mark data-noam-color="pink">Quote</mark>\n' +
        '> - <mark data-noam-color="pink">Nested</mark>',
    );
    view.destroy();
  });

  it("does not recognize arbitrary mark attributes as a Noam color", () => {
    const doc = '<mark style="background: red" data-noam-color="green">unsafe style</mark>';
    const view = mount(doc, false, "reading");
    expect(view.contentDOM.querySelector(".cm-highlight-green")).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });
});

describe("colored highlight presentation", () => {
  const doc = 'before <mark data-noam-color="green">*nested* [link](Target)</mark> after';

  it("shows source tags and colors their content in Source", () => {
    const view = mount(doc, false, "source");
    // The behavior under test is DOM output, not parser source inspection.
    expect(view.contentDOM.textContent).toContain("data-noam-color");
    expect(view.contentDOM.querySelector(".cm-highlight-green")?.textContent).toContain("nested");
    view.destroy();
  });

  it("hides fixed syntax in Reading and keeps nested content", () => {
    const view = mount(doc, false, "reading");
    expect(view.contentDOM.textContent).not.toContain("data-noam-color");
    expect(view.contentDOM.textContent).toContain("nested");
    view.destroy();
  });

  it("renders the explicit yellow HTML form", () => {
    const yellow = '<mark data-noam-color="yellow">sunlight</mark>';
    const view = mount(yellow, false, "reading");
    expect(view.contentDOM.textContent).toBe("sunlight");
    expect(view.contentDOM.querySelector(".cm-highlight-yellow")?.textContent).toBe("sunlight");
    view.destroy();
  });

  it("does not decorate colored syntax inside frontmatter or code", () => {
    const mark = '<mark data-noam-color="green">hidden</mark>';
    const source = `---\nvalue: '${mark}'\n---\n\`${mark}\`\n\n\`\`\`\n${mark}\n\`\`\`\n\n${mark}`;
    const view = mount(source, false, "reading");
    expect(view.contentDOM.querySelectorAll(".cm-highlight-green")).toHaveLength(1);
    view.destroy();
  });

  it("shows an accessible palette for an editable selection", () => {
    const view = mount("select me");
    let box = { left: 0, right: 20, top: 2, bottom: 22 };
    view.coordsAtPos = (() => box) as typeof view.coordsAtPos;
    view.focus();
    view.dispatch({ selection: EditorSelection.range(0, 6) });
    const toolbar = document.body.querySelector<HTMLElement>(".cm-highlight-toolbar");
    Object.defineProperty(toolbar, "getBoundingClientRect", {
      value: () => ({ width: 300, height: 40 }),
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    press(view, "H", { alt: true, shift: true });
    expect(toolbar?.hidden).toBe(false);
    expect(toolbar?.getAttribute("aria-label")).toBe("Highlight selection");
    expect(toolbar?.querySelectorAll("button")).toHaveLength(6);
    expect(document.activeElement).toBe(toolbar?.querySelector("button"));
    expect(toolbar?.dataset.placement).toBe("below");
    expect(toolbar?.style.left).toBe("158px");

    box = { left: 390, right: 400, top: 240, bottom: 260 };
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(toolbar?.dataset.placement).toBe("above");
    expect(toolbar?.style.left).toBe("242px");

    toolbar?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(toolbar?.hidden).toBe(true);
    expect(view.hasFocus).toBe(true);
    view.destroy();
  });

  it("keeps the toolbar plugin alive when a focused selection changes", async () => {
    const view = mount("ordinary paragraph");
    view.focus();

    view.dispatch({ selection: EditorSelection.range(0, 18) });
    view.coordsAtPos = (() => ({ left: 40, right: 60, top: 80, bottom: 100 })) as typeof view.coordsAtPos;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const toolbar = document.body.querySelector<HTMLElement>(".cm-highlight-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.hidden).toBe(false);

    view.dispatch({
      changes: {
        from: view.state.doc.length,
        insert: '\n<mark data-noam-color="green">green</mark>',
      },
    });
    expect(view.contentDOM.textContent).not.toContain("data-noam-color");
    expect(view.contentDOM.querySelector(".cm-highlight-green")?.textContent).toBe("green");
    view.destroy();
  });
});
