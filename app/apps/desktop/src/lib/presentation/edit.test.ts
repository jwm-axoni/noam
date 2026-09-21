// @vitest-environment jsdom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  applyPresentationChangesToText,
  applyPresentationPatch,
  applySafePresentationUndo,
  planConditionalPresentationUndo,
  planPresentationPatch,
  presentationSnapshot,
  planSafePresentationUndo,
} from "./edit";
import { PRESENTATION_KEYS } from "./types";

function apply(source: string, patch: Parameters<typeof planPresentationPatch>[1]): string {
  const state = EditorState.create({ doc: source });
  const result = planPresentationPatch(state.doc, patch);
  if (!result.ok) throw new Error(result.reason);
  return state.update({ changes: result.changes }).state.doc.toString();
}

describe("presentation frontmatter edits", () => {
  it("adds portable fields without touching the body", () => {
    expect(
      apply("Hello\n", {
        [PRESENTATION_KEYS.icon]: { kind: "text", value: "emoji:🌿" },
      }),
    ).toBe('---\nnoam_presentation_version: 1\nnoam_icon: "emoji:🌿"\n---\nHello\n');
  });

  it("preserves comments, ordering and quoted unrelated values", () => {
    const source = "---\ntitle: \"A # title\" # keep\nnoam_icon: lucide:star\ntags: [one, two]\n---\nBody";
    const next = apply(source, {
      [PRESENTATION_KEYS.icon]: { kind: "text", value: "lucide:house" },
    });
    expect(next).toContain('title: "A # title" # keep');
    expect(next).toContain("tags: [one, two]");
    expect(next).toContain('noam_icon: "lucide:house"');
    expect(next.endsWith("---\nBody")).toBe(true);
  });

  it("refuses YAML outside the flat supported subset", () => {
    const doc = EditorState.create({ doc: "---\nnested:\n  key: value\n---\nBody" }).doc;
    expect(
      planPresentationPatch(doc, {
        [PRESENTATION_KEYS.icon]: { kind: "text", value: "lucide:house" },
      }),
    ).toEqual({ ok: false, reason: "unsupported-yaml" });
  });

  it("removes only requested fields and keeps the schema version", () => {
    const source = "---\nnoam_presentation_version: 1\nnoam_icon: emoji:🌿\nnoam_icon_color: green\nowner: Jane\n---\n";
    const next = apply(source, { [PRESENTATION_KEYS.icon]: null });
    expect(next).not.toContain("noam_icon: emoji");
    expect(next).toContain("noam_icon_color: green");
    expect(next).toContain("noam_presentation_version: 1");
    expect(next).toContain("owner: Jane");
  });

  it("can reset the only presentation field while adding the schema version", () => {
    expect(
      apply('---\nnoam_icon: "emoji:🌿"\n---\nBody', {
        [PRESENTATION_KEYS.icon]: null,
      }),
    ).toBe("---\nnoam_presentation_version: 1\n---\nBody");
  });

  it("records icon and cover metadata as one undoable editor action", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: "Body\n", extensions: [history()] }),
    });

    expect(
      applyPresentationPatch(view, {
        [PRESENTATION_KEYS.icon]: { kind: "text", value: "lucide:leaf" },
        [PRESENTATION_KEYS.cover]: {
          kind: "text",
          value: "attachments/cover.png",
        },
      }).ok,
    ).toBe(true);
    expect(view.state.doc.toString()).toContain("noam_icon:");
    expect(view.state.doc.toString()).toContain("noam_cover:");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("Body\n");
    view.destroy();
    parent.remove();
  });

  it("undoes a folder write only while its exact result is still current", () => {
    const previous = "---\nnoam_kind: folder-presentation\n---\n";
    const expected = "---\nnoam_kind: folder-presentation\nnoam_icon: lucide:leaf\n---\n";
    expect(planSafePresentationUndo(expected, expected, previous)).toEqual({
      ok: true,
      source: previous,
    });
    expect(
      planSafePresentationUndo(`${expected}concurrent edit\n`, expected, previous),
    ).toEqual({ ok: false, reason: "conflict" });
  });

  it("does not write when a concurrent folder edit makes undo unsafe", async () => {
    const expected = "folder appearance after action";
    const previous = "folder appearance before action";
    const write = vi.fn(async () => undefined);
    await expect(
      applySafePresentationUndo(
        expected,
        previous,
        async () => `${expected} plus someone else's edit`,
        write,
      ),
    ).resolves.toEqual({ ok: false, reason: "conflict" });
    expect(write).not.toHaveBeenCalled();

    await expect(
      applySafePresentationUndo(expected, previous, async () => expected, write),
    ).resolves.toEqual({ ok: true });
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(previous);
  });

  it("merges concurrent icon and color fields through minimal Y.Text transactions", () => {
    const initial = "---\nnoam_kind: folder-presentation\nnoam_presentation_version: 1\n---\n";
    const left = new Y.Doc();
    const right = new Y.Doc();
    left.getText("content").insert(0, initial);
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    const edit = (doc: Y.Doc, patch: Parameters<typeof planPresentationPatch>[1]) => {
      const text = doc.getText("content");
      doc.transact(() => {
        const state = EditorState.create({ doc: text.toString() });
        const plan = planPresentationPatch(state.doc, patch);
        if (!plan.ok) throw new Error(plan.reason);
        applyPresentationChangesToText(text, plan.changes);
      }, "presentation");
    };
    const leftBefore = Y.encodeStateVector(left);
    const rightBefore = Y.encodeStateVector(right);
    edit(left, { [PRESENTATION_KEYS.icon]: { kind: "text", value: "lucide:leaf" } });
    edit(right, { [PRESENTATION_KEYS.iconColor]: { kind: "text", value: "green" } });
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right, leftBefore));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left, rightBefore));

    expect(left.getText("content").toString()).toBe(right.getText("content").toString());
    expect(left.getText("content").toString()).toContain('noam_icon: "lucide:leaf"');
    expect(left.getText("content").toString()).toContain("noam_icon_color: green");
  });

  it("undoes only matching presentation fields and preserves a concurrent field", () => {
    const source = [
      "---",
      "noam_kind: folder-presentation",
      "noam_presentation_version: 1",
      'noam_icon: "lucide:leaf"',
      'noam_icon_color: "green"',
      "owner: Jane",
      "---",
      "",
    ].join("\n");
    const state = EditorState.create({ doc: source });
    const keys = [PRESENTATION_KEYS.icon, PRESENTATION_KEYS.iconColor];
    const expected = presentationSnapshot(state.doc, keys)!;
    const plan = planConditionalPresentationUndo(state.doc, expected, {
      [PRESENTATION_KEYS.icon]: null,
      [PRESENTATION_KEYS.iconColor]: null,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const next = state.update({ changes: plan.changes }).state.doc.toString();
    expect(next).not.toContain("noam_icon:");
    expect(next).not.toContain("noam_icon_color:");
    expect(next).toContain("owner: Jane");

    const changed = EditorState.create({ doc: source.replace("lucide:leaf", "lucide:star") });
    expect(planConditionalPresentationUndo(changed.doc, expected, {
      [PRESENTATION_KEYS.icon]: null,
    })).toEqual({ ok: false, reason: "conflict" });
  });
});
