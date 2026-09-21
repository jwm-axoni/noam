// @vitest-environment jsdom
//
// The Properties panel through a real EditorView and a real React root.
//
// Two assertions here are the feature's gate:
//   1. the panel's host node survives an edit (`updateDOM` returns true) — if
//      it ever returns false, a teammate's keystroke destroys the field under
//      your cursor and collaboration is unusable;
//   2. an unparseable block gets a banner and NO replace decoration, so the
//      YAML stays visible and is never rewritten.
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it } from "vitest";
import { addPropertyToNote } from "../../components/properties/PropertiesPanel";
import { propertiesMode, type PropertiesMode } from "./frontmatter";
import { getHeaderFocus } from "./headerFocus";
import { createEditorState } from "./index";

/** The Compartment Editor.tsx owns, exposed so a test can reconfigure it. */
const modeCompartments = new WeakMap<EditorView, Compartment>();

function mount(
  doc: string,
  mode: PropertiesMode = "visible",
  readOnly = false,
  identity = { vaultId: "vault-a", docId: "doc-1", path: "Notes/My Note.md" },
) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const modeCompartment = new Compartment();
  const view = new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
      header: {
        ...identity,
        mode,
        modeCompartment,
        renameTo: async () => null,
        noteExists: async () => false,
      },
      extraExtensions: readOnly
        ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
        : [],
    } as never),
    parent,
  });
  modeCompartments.set(view, modeCompartment);
  // Park the caret in the body: a caret inside the region yields to source.
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  return view;
}

const panel = (view: EditorView) => view.dom.querySelector(".cm-note-properties");
const names = (view: EditorView) =>
  [...view.dom.querySelectorAll<HTMLInputElement>(".prop-name")].map((i) => i.value);
const lineTexts = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll(".cm-line")].map((l) => l.textContent);

const DOC = [
  "---",
  "status: draft",
  "tags: [youtube, ai]",
  "done: false",
  "---",
  "",
  "Body text.",
].join("\n");

beforeEach(() => localStorage.clear());

describe("the Properties panel", () => {
  it("restores the collapsed panel after direct and ancestor moves without leaking to another vault", () => {
    const view = mount(DOC);
    view.dom.querySelector<HTMLButtonElement>(".prop-panel-header")!.click();
    view.destroy();

    for (const path of ["Notes/Renamed.md", "Moved/Renamed.md"]) {
      const restored = mount(DOC, "visible", false, { vaultId: "vault-a", docId: "doc-1", path });
      expect(restored.dom.querySelector(".prop-panel-header")?.getAttribute("aria-expanded")).toBe("false");
      expect(names(restored)).toEqual([]);
      restored.destroy();
    }
    const other = mount(DOC, "visible", false, { vaultId: "vault-b", docId: "doc-1", path: "Moved/Renamed.md" });
    expect(other.dom.querySelector(".prop-panel-header")?.getAttribute("aria-expanded")).toBe("true");
    other.destroy();
  });

  it("renders one row per key, with the right control", () => {
    const view = mount(DOC);
    expect(panel(view)).not.toBeNull();
    expect(names(view)).toEqual(["status", "tags", "done"]);
    expect(view.dom.querySelectorAll(".prop-chip")).toHaveLength(2);
    expect(view.dom.querySelector<HTMLInputElement>(".prop-checkbox")?.checked).toBe(false);
    // The YAML lines are replaced, not merely hidden by CSS.
    expect(lineTexts(view)).not.toContain("status: draft");
    view.destroy();
  });

  it("collapses to a count header, expands again, and remembers the note", () => {
    const view = mount(DOC);
    const header = view.dom.querySelector<HTMLButtonElement>(".prop-panel-header")!;
    expect(header.textContent).toContain("Properties · 3");
    expect(header.getAttribute("aria-expanded")).toBe("true");

    header.click();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(names(view)).toEqual([]);
    header.focus();

    const host = panel(view);
    view.dispatch({ changes: { from: DOC.lastIndexOf("---"), insert: "priority: high\n" } });
    expect(panel(view)).toBe(host);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.textContent).toContain("Properties · 4");
    expect(document.activeElement).toBe(header);
    view.destroy();

    const restored = mount(DOC);
    expect(
      restored.dom.querySelector(".prop-panel-header")?.getAttribute("aria-expanded"),
    ).toBe("false");
    restored.dom.querySelector<HTMLButtonElement>(".prop-panel-header")!.click();
    expect(names(restored)).toEqual(["status", "tags", "done"]);
    restored.destroy();
  });

  it("expands before property focus handoffs and add-property", () => {
    const view = mount(DOC);
    view.dom.querySelector<HTMLButtonElement>(".prop-panel-header")!.click();

    expect(getHeaderFocus(view).focusFirstProperty?.()).toBe(true);
    expect(view.dom.querySelector(".prop-panel-header")?.getAttribute("aria-expanded"))
      .toBe("true");
    expect(document.activeElement).toBe(
      view.dom.querySelectorAll<HTMLInputElement>(".prop-input")[0],
    );

    view.dom.querySelector<HTMLButtonElement>(".prop-panel-header")!.click();
    expect(addPropertyToNote(view)).toBe(true);
    expect(view.dom.querySelector(".prop-panel-header")?.getAttribute("aria-expanded"))
      .toBe("true");
    expect(names(view)).toContain("property");
    view.destroy();
  });

  it("yields to raw source while the caret is inside the region", () => {
    const view = mount(DOC);
    view.dispatch({ selection: { anchor: DOC.indexOf("status") } });
    expect(panel(view)).toBeNull();
    expect(lineTexts(view)).toContain("status: draft");
    // …and comes back when the caret leaves.
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(panel(view)).not.toBeNull();
    view.destroy();
  });

  it("shows a banner over YAML it refuses to rewrite, with the text intact", () => {
    const bad = "---\nmeta:\n  author: me\n---\n\nBody.";
    const view = mount(bad);
    expect(panel(view)).toBeNull();
    expect(view.dom.querySelector(".cm-fm-banner")).not.toBeNull();
    expect(lineTexts(view)).toContain("  author: me");
    expect(view.contentDOM.querySelectorAll(".cm-fm-invalid").length).toBe(4);
    // Nothing was written: the document is byte-identical.
    expect(view.state.doc.toString()).toBe(bad);
    view.destroy();
  });

  it("hidden mode shows neither the panel nor the source", () => {
    const view = mount(DOC, "hidden");
    expect(panel(view)).toBeNull();
    expect(lineTexts(view)).not.toContain("status: draft");
    expect(lineTexts(view)).not.toContain("---");
    view.destroy();
  });

  it("source mode keeps Stage 1's dimmed block", () => {
    const view = mount(DOC, "source");
    expect(panel(view)).toBeNull();
    expect(view.contentDOM.querySelector(".cm-frontmatter")).not.toBeNull();
    expect(lineTexts(view)).toContain("status: draft");
    view.destroy();
  });

  it("follows a display-mode change without rebuilding the view", () => {
    const view = mount(DOC, "visible");
    expect(panel(view)).not.toBeNull();
    // Exactly what Settings -> Appearance dispatches.
    view.dispatch({
      effects: modeCompartments
        .get(view)!
        .reconfigure(propertiesMode.of("source")),
    });
    expect(panel(view)).toBeNull();
    expect(lineTexts(view)).toContain("status: draft");
    view.destroy();
  });

  it("renders read-only without the add/remove affordances", () => {
    const view = mount(DOC, "visible", true);
    expect(panel(view)).not.toBeNull();
    expect(view.dom.querySelector(".prop-add")).toBeNull();
    expect(view.dom.querySelector(".prop-remove")).toBeNull();
    expect(
      [...view.dom.querySelectorAll<HTMLInputElement>(".prop-panel input")].every(
        (input) => input.disabled,
      ),
    ).toBe(true);
    view.destroy();
  });

  it("does not let read-only property keyboard handlers delete YAML", () => {
    const view = mount(DOC, "visible", true);
    const before = view.state.doc.toString();
    const name = view.dom.querySelector<HTMLInputElement>(".prop-name")!;
    name.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    const chip = view.dom.querySelector<HTMLInputElement>(".prop-chip-input")!;
    chip.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.state.doc.toString()).toBe(before);
    expect(view.state.doc.toString()).toContain("tags: [youtube, ai]");
    view.destroy();
  });

  it("renders a frontmatter-only note (the block is the whole document)", () => {
    const view = mount("---\nstatus: draft\n---");
    expect(names(view)).toEqual(["status"]);
    view.destroy();
  });

  // ---- The remount regression (see the module note) -------------------------

  it("keeps the SAME host node through a body edit and a property edit", () => {
    const view = mount(DOC);
    const host = panel(view);
    expect(host).not.toBeNull();

    view.dispatch({ changes: { from: view.state.doc.length, insert: " More." } });
    expect(panel(view)).toBe(host);

    // A different property changing — what a teammate's edit looks like.
    const at = view.state.doc.toString().indexOf("draft");
    view.dispatch({ changes: { from: at, to: at + 5, insert: "final" } });
    expect(panel(view)).toBe(host);
    expect(
      view.dom.querySelectorAll<HTMLInputElement>(".prop-input")[0]?.value,
    ).toBe("final");
    view.destroy();
  });

  it("changes only the edited bytes when a value is committed", () => {
    const src = [
      "---",
      "# a comment",
      "title: 'Old name'",
      "tags: [a, b]",
      "done: false",
      "---",
      "",
      "Body.",
    ].join("\n");
    const view = mount(src);
    // A real click, not a synthesized `change`: React routes a checkbox's
    // onChange off the click event.
    view.dom.querySelector<HTMLInputElement>(".prop-checkbox")!.click();
    expect(view.state.doc.toString()).toBe(src.replace("done: false", "done: true"));
    view.destroy();
  });
});
