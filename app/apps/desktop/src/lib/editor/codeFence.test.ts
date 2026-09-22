// @vitest-environment jsdom
//
// The code-fence copy button, and the curated language list behind fences.

import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { codeLanguages } from "./codeLanguages";
import { createEditorState } from "./index";
import { setFocused } from "./reveal";

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: createEditorState({ doc, getTitles: () => [], onNavigate: () => {} } as never),
    parent,
  });
}

/** The rendered text of each line, minus the flair widget's own text. */
function lines(view: EditorView): string[] {
  return Array.from(view.contentDOM.querySelectorAll(".cm-line")).map((l) => {
    const copy = l.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".cm-fence-flair").forEach((f) => f.remove());
    return copy.textContent ?? "";
  });
}

const YAML_DOC = [
  "intro",
  "```yaml",
  "type: person | organization | tool",
  "tags: [lowercase-kebab-case]",
  "```",
  "outro",
].join("\n");

describe("code fence flair and fence reveal", () => {
  it("puts one copy button on a fenced block", () => {
    const view = mount("```js\nconst a = 1;\n```");
    const buttons = view.contentDOM.querySelectorAll(".cm-fence-copy");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("Copy");
    view.destroy();
  });

  it("hides both fence lines while the editor is blurred, keeping them as padding", () => {
    const view = mount(YAML_DOC);
    expect(lines(view)).toEqual([
      "intro",
      "",
      "type: person | organization | tool",
      "tags: [lowercase-kebab-case]",
      "",
      "outro",
    ]);
    // The document itself is untouched: decorations only.
    expect(view.state.doc.toString()).toBe(YAML_DOC);
    view.destroy();
  });

  it("hides the fences while the caret is outside the block", () => {
    const view = mount(YAML_DOC);
    for (const anchor of [0, YAML_DOC.indexOf("outro")]) {
      view.dispatch({ effects: setFocused.of(true), selection: { anchor } });
      expect(lines(view)[1]).toBe("");
      expect(lines(view)[4]).toBe("");
    }
    view.destroy();
  });

  it("reveals both fences when the caret enters any line of the block", () => {
    const view = mount(YAML_DOC);
    const inBody = YAML_DOC.indexOf("tags:");
    view.dispatch({ effects: setFocused.of(true), selection: { anchor: inBody } });
    expect(lines(view)[1]).toBe("```yaml");
    expect(lines(view)[4]).toBe("```");
    view.destroy();
  });

  it("leaves the last line of an unclosed fence alone", () => {
    const view = mount("```js\nconst a = 1;");
    expect(lines(view)).toEqual(["", "const a = 1;"]);
    view.destroy();
  });

  it("hides only the fence, not the quote marker before it", () => {
    const view = mount("> ```js\n> x\n> ```");
    // Blurred: each `>` folds by its own rule and keeps its trailing space;
    // the fence hide starts at the backticks, so the two never overlap.
    expect(lines(view)).toEqual([" ", " x", " "]);
    view.destroy();
  });

  it("labels the fence with its language, before the copy button", () => {
    const view = mount(YAML_DOC);
    const flair = view.contentDOM.querySelector(".cm-fence-flair")!;
    const label = flair.querySelector(".cm-fence-lang");
    expect(label?.textContent).toBe("yaml");
    expect(flair.firstElementChild).toBe(label);
    expect(flair.querySelector(".cm-fence-copy")).not.toBeNull();
    view.destroy();
  });

  it("labels only the first word of an info string", () => {
    const view = mount('```ts title="a.ts"\nconst a = 1;\n```');
    expect(view.contentDOM.querySelector(".cm-fence-lang")?.textContent).toBe("ts");
    view.destroy();
  });

  it("shows no label on a fence without an info string", () => {
    const view = mount("```\nplain\n```");
    expect(view.contentDOM.querySelector(".cm-fence-lang")).toBeNull();
    expect(view.contentDOM.querySelector(".cm-fence-copy")).not.toBeNull();
    view.destroy();
  });

  it("skips an html fence, which live preview renders instead", () => {
    const view = mount("```html\n<h1>Hi</h1>\n```");
    expect(view.contentDOM.querySelector(".cm-fence-copy")).toBeNull();
    view.destroy();
  });

  it("gives an empty fence a label but nothing to copy", () => {
    const view = mount("```js\n```");
    expect(view.contentDOM.querySelector(".cm-fence-copy")).toBeNull();
    expect(view.contentDOM.querySelector(".cm-fence-lang")?.textContent).toBe("js");
    view.destroy();
  });

  it("copies the code, not the fences", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (t: string) => (copied.push(t), Promise.resolve()) },
    });
    const view = mount("```js\nconst a = 1;\n```");
    const button = view.contentDOM.querySelector(".cm-fence-copy") as HTMLButtonElement;
    // `cancelable`, or `preventDefault()` is a no-op and CodeMirror's own
    // mousedown handler runs — which is precisely what the widget prevents in
    // the app (`eventBelongsToEditor` bails on a defaultPrevented event).
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    // `copyText` tries the native Tauri clipboard first and falls through to
    // the web API here, so wait for the dynamic import to settle. A fixed
    // 50 ms lost under full-suite load; poll with a generous ceiling instead.
    for (let i = 0; i < 100 && copied.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // The code, without the fence lines.
    expect(copied).toEqual(["const a = 1;"]);
    expect(button.textContent).toBe("Copied");
    view.destroy();
  });
});

describe("curated code languages", () => {
  it("covers the fences people actually paste, without @codemirror/language-data", () => {
    const names = codeLanguages.map((l) => l.name);
    for (const lang of ["javascript", "typescript", "python", "rust", "json", "yaml", "sql", "shell"]) {
      expect(names).toContain(lang);
    }
  });

  it("resolves the common aliases", () => {
    const find = (alias: string) =>
      codeLanguages.find((l) => l.name === alias || l.alias.includes(alias))?.name;
    expect(find("ts")).toBe("typescript");
    expect(find("bash")).toBe("shell");
    expect(find("py")).toBe("python");
    expect(find("yml")).toBe("yaml");
  });

  it("loads a grammar lazily, so none of them is on the startup path", async () => {
    // A language no other test in this file mounts, so the assertion really is
    // "nothing loaded it until asked".
    const go = codeLanguages.find((l) => l.name === "go")!;
    expect(go.support).toBeUndefined();
    await go.load();
    expect(go.support).toBeDefined();
  });
});
