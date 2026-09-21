// @vitest-environment jsdom
//
// The slash menu, driven through a REAL `EditorView`: the block options it has
// always had, plus the vault's workflows arriving through the injected source.
// The workflow half is asserted by actually accepting the completion — that is
// the only way to know the `/query` really goes away and the run flow really
// gets the selection.

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  setSlashWorkflowSource,
  slashCompletions,
  slashWorkflows,
  type SlashRunContext,
  type SlashWorkflowItem,
} from "./slash";

beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
});

afterEach(() => setSlashWorkflowSource(null));

const ITEMS: SlashWorkflowItem[] = [
  { id: "meeting-note", name: "Meeting note (example)", description: "From a template", runnable: true },
  { id: "hidden-one", name: "Hidden", slash: false, runnable: true },
  { id: "broken-one", name: "Broken", runnable: false },
  { id: "jrnl", name: "Journal entry (example)", runnable: true },
];

function source(over: Partial<{
  list: () => readonly SlashWorkflowItem[];
  run: (id: string, ctx: SlashRunContext) => void;
  currentPath: () => string | null;
}> = {}) {
  const run = vi.fn();
  const full = {
    list: () => ITEMS,
    run,
    currentPath: () => "Notes/Today.md",
    ...over,
  };
  setSlashWorkflowSource(full);
  return { run: full.run as ReturnType<typeof vi.fn> };
}

function view(doc: string, cursor: number): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  return new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor) }),
    parent: host,
  });
}

/** Run the completion source at the caret, the way autocomplete does. */
function complete(v: EditorView, explicit = true): CompletionResult | null {
  const context = {
    state: v.state,
    pos: v.state.selection.main.head,
    explicit,
    matchBefore(expr: RegExp) {
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const text = line.text.slice(0, v.state.selection.main.head - line.from);
      const match = new RegExp(`(?:${expr.source})$`).exec(text);
      if (!match) return null;
      return {
        from: v.state.selection.main.head - match[0].length,
        to: v.state.selection.main.head,
        text: match[0],
      };
    },
  } as unknown as CompletionContext;
  return slashCompletions(context);
}

const labels = (result: CompletionResult | null) => (result?.options ?? []).map((o) => o.label);

describe("slashWorkflows", () => {
  it("offers only runnable workflows that did not opt out", () => {
    source();
    expect(slashWorkflows().map((w) => w.id)).toEqual(["meeting-note", "jrnl"]);
  });

  it("is empty with no source wired", () => {
    expect(slashWorkflows()).toEqual([]);
  });
});

describe("slashCompletions", () => {
  it("keeps the block items and adds the workflows", () => {
    source();
    const v = view("/", 1);
    const result = complete(v);
    expect(labels(result)).toContain("/Heading 1");
    expect(labels(result)).toContain("/Table");
    expect(labels(result)).toContain("/Meeting note (example)");
    expect(labels(result)).not.toContain("/Hidden");
    expect(labels(result)).not.toContain("/Broken");
    v.destroy();
  });

  it("filters workflows by name and by id", () => {
    source();
    expect(labels(complete(view("/meet", 5)))).toEqual(["/Meeting note (example)"]);
    // `jrnl` appears nowhere in the name — this only matches through the id.
    expect(labels(complete(view("/jrnl", 5)))).toEqual(["/Journal entry (example)"]);
    expect(labels(complete(view("/zzz", 4)))).toEqual([]);
  });

  it("still refuses a slash that does not start a line", () => {
    source();
    expect(complete(view("and/or", 6))).toBeNull();
  });

  it("removes the /query and starts the run flow with path and selection", () => {
    const { run } = source();
    const v = view("hello\n/meet", 11);
    const option = (complete(v)?.options ?? []).find((o) => o.label === "/Meeting note (example)");
    expect(option).toBeDefined();
    (option!.apply as (view: EditorView, c: Completion, from: number, to: number) => void)(
      v,
      option!,
      6,
      11,
    );
    expect(v.state.doc.toString()).toBe("hello\n");
    expect(v.state.selection.main.head).toBe(6);
    expect(run).toHaveBeenCalledWith("meeting-note", { currentPath: "Notes/Today.md" });
    v.destroy();
  });

  it("passes a real selection through, and never the trigger text itself", () => {
    const { run } = source();
    const v = view("pick me\n/meet", 13);
    const option = (complete(v)?.options ?? []).find((o) => o.label === "/Meeting note (example)");
    // A selection elsewhere in the note, the way a pointer-accepted completion
    // can leave it. The trigger range [8,13) is not part of it.
    v.dispatch({ selection: EditorSelection.range(0, 7) });
    (option!.apply as (view: EditorView, c: Completion, from: number, to: number) => void)(
      v,
      option!,
      8,
      13,
    );
    expect(run).toHaveBeenCalledWith("meeting-note", {
      currentPath: "Notes/Today.md",
      selection: "pick me",
    });
    v.destroy();
  });

  it("never offers or runs a workflow in a read-only editor", () => {
    const { run } = source();
    const open = view("/meet", 5);
    const option = (complete(open)?.options ?? []).find(
      (o) => o.label === "/Meeting note (example)",
    );
    open.destroy();

    const host = document.createElement("div");
    document.body.append(host);
    const locked = new EditorView({
      state: EditorState.create({
        doc: "/meet",
        selection: EditorSelection.cursor(5),
        extensions: [EditorState.readOnly.of(true)],
      }),
      parent: host,
    });
    expect(complete(locked)).toBeNull();
    // A pointer can accept a completion that opened before the state flipped.
    (option!.apply as (view: EditorView, c: Completion, from: number, to: number) => void)(
      locked,
      option!,
      0,
      5,
    );
    expect(locked.state.doc.toString()).toBe("/meet");
    expect(run).not.toHaveBeenCalled();
    locked.destroy();
  });
});
