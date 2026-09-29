// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { searchPanelOpen } from "@codemirror/search";
import { afterEach, describe, expect, it } from "vitest";
import { findReplace } from "./find";
import { openNoteFindFrom, routeFindShortcut } from "./findShortcut";

afterEach(() => {
  document.body.replaceChildren();
});

function editorWithInput() {
  const editor = document.createElement("div");
  editor.className = "cm-editor";
  const content = document.createElement("div");
  content.className = "cm-content";
  const text = document.createTextNode("hello");
  content.append(text);
  editor.append(content);
  const sidebar = document.createElement("input");
  document.body.append(editor, sidebar);
  return { content, text, sidebar };
}

const k = (init: Partial<KeyboardEvent>) => ({
  key: "f",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe("routeFindShortcut", () => {
  it("Mod+F inside the note editor goes to the note's bubble", () => {
    const { content, text } = editorWithInput();
    expect(routeFindShortcut(k({ metaKey: true }), content)).toBe("note");
    expect(routeFindShortcut(k({ ctrlKey: true }), content)).toBe("note");
    expect(routeFindShortcut(k({ metaKey: true }), text)).toBe("note");
  });

  it("Mod+F anywhere else goes to the vault search", () => {
    const { sidebar } = editorWithInput();
    expect(routeFindShortcut(k({ metaKey: true }), sidebar)).toBe("vault");
    expect(routeFindShortcut(k({ ctrlKey: true }), document.body)).toBe("vault");
    expect(routeFindShortcut(k({ ctrlKey: true }), null)).toBe("vault");
  });

  it("Mod+Shift+F always goes to the vault search", () => {
    const { content, sidebar } = editorWithInput();
    expect(routeFindShortcut(k({ metaKey: true, shiftKey: true, key: "F" }), content)).toBe("vault");
    expect(routeFindShortcut(k({ ctrlKey: true, shiftKey: true, key: "F" }), sidebar)).toBe("vault");
  });

  it("ignores everything else", () => {
    const { content } = editorWithInput();
    expect(routeFindShortcut(k({}), content)).toBeNull();
    expect(routeFindShortcut(k({ metaKey: true, ctrlKey: true }), content)).toBeNull();
    // Mod+Alt+F is the bubble's replace key on macOS.
    expect(routeFindShortcut(k({ metaKey: true, altKey: true }), content)).toBeNull();
    expect(routeFindShortcut(k({ metaKey: true, key: "g" }), content)).toBeNull();
  });
});

describe("openNoteFindFrom", () => {
  it("opens the bubble of the editor the target sits in", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: "x", extensions: [findReplace()] }),
      parent,
    });
    const widgetInput = document.createElement("input");
    view.dom.append(widgetInput);
    expect(openNoteFindFrom(widgetInput)).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(openNoteFindFrom(document.body)).toBe(false);
  });
});
