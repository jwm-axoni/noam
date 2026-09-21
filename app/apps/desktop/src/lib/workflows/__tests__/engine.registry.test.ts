// The command service: what a vault scan turns into, and what the UI can ask
// it. Broken files are part of the contract — they stay listed, they carry
// their issues, and they refuse to run.

import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from "../contracts";
import { createCommandService } from "../engine/registry";
import { serializeWorkflowNote } from "../engine/parse";
import { FakeHost } from "./fixtures/fakeHost";

function def(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    id: "capture",
    name: "Capture",
    steps: [{ type: "append", target: { path: "Inbox.md" }, content: "- note" }],
    ...over,
  };
}

function vault(files: Record<string, string>, host = new FakeHost({ notes: { "Inbox.md": "" } })) {
  const service = createCommandService({
    listNotes: async () => Object.keys(files),
    readNote: async (path) => files[path] ?? host.textOf(path) ?? null,
    host,
  });
  return { service, host };
}

describe("scanning", () => {
  it("registers workflow notes and sorts them by name", async () => {
    const { service } = vault({
      "Workflows/Zeta.md": serializeWorkflowNote(def({ id: "zeta", name: "Zebra" })),
      "Workflows/Alpha.md": serializeWorkflowNote(def({ id: "alpha", name: "Apple" })),
      "Notes/Ordinary.md": "# Just a note\n",
    });
    await service.refresh();
    expect(service.list().map((w) => w.definition?.name)).toEqual(["Apple", "Zebra"]);
    expect(service.list().map((w) => w.id)).toEqual(["alpha", "zeta"]);
    expect(service.list().every((w) => w.runnable)).toBe(true);
    expect(service.get("alpha")?.path).toBe("Workflows/Alpha.md");
    expect(service.get("nothing")).toBeNull();
  });

  it("ignores notes that do not carry the marker", async () => {
    const { service } = vault({
      "Notes/A.md": "---\nnoam_kind: note\n---\n\n```json noam-workflow\n{}\n```\n",
      "Notes/B.md": "# nothing\n",
      "Notes/C.txt": serializeWorkflowNote(def()),
    });
    await service.refresh();
    expect(service.list()).toEqual([]);
  });

  it("lists a marked-but-broken file with its issues, non-runnable", async () => {
    const { service } = vault({
      "Workflows/Broken.md": "---\nnoam_kind: workflow\n---\n\n```json noam-workflow\n{ nope\n```\n",
      "Workflows/NoFence.md": "---\nnoam_kind: workflow\n---\n\nI deleted the block.\n",
    });
    await service.refresh();
    const paths = service.list().map((w) => w.path);
    expect(paths).toEqual(["Workflows/Broken.md", "Workflows/NoFence.md"]);
    expect(service.list().every((w) => !w.runnable)).toBe(true);
    expect(service.list()[0]!.issues.map((i) => i.code)).toContain("bad-json");
    expect(service.list()[1]!.issues.map((i) => i.code)).toContain("missing-fence");
    expect(service.list().every((w) => w.definition === null)).toBe(true);
  });

  it("marks a file whose schema is wrong as non-runnable but keeps its definition", async () => {
    const { service } = vault({
      "Workflows/Bad.md": serializeWorkflowNote(
        def({ steps: [{ type: "create-note", path: "x.txt", content: "" }] }),
      ),
    });
    await service.refresh();
    const entry = service.list()[0]!;
    expect(entry.runnable).toBe(false);
    expect(entry.definition?.id).toBe("capture");
    expect(entry.issues.map((i) => i.code)).toContain("bad-path");
  });

  it("makes BOTH files non-runnable when two claim the same id", async () => {
    const { service } = vault({
      "Workflows/One.md": serializeWorkflowNote(def({ name: "One" })),
      "Workflows/Two.md": serializeWorkflowNote(def({ name: "Two" })),
    });
    await service.refresh();
    expect(service.list()).toHaveLength(2);
    expect(service.list().every((w) => !w.runnable)).toBe(true);
    for (const entry of service.list()) {
      expect(entry.issues.map((i) => i.code)).toContain("duplicate-id");
    }
  });

  it("validates across files, so a run-workflow cycle is caught by the scan", async () => {
    const { service } = vault({
      "Workflows/A.md": serializeWorkflowNote(
        def({ id: "a", name: "A", steps: [{ type: "run-workflow", id: "b" }], requires: { workflows: ["b"] } }),
      ),
      "Workflows/B.md": serializeWorkflowNote(
        def({ id: "b", name: "B", steps: [{ type: "run-workflow", id: "a" }], requires: { workflows: ["a"] } }),
      ),
    });
    await service.refresh();
    expect(service.list().map((w) => w.issues.map((i) => i.code))).toEqual([["cycle"], ["cycle"]]);
  });

  it("reads a step's template, so only a genuinely unused variable is warned about", async () => {
    const { service } = vault({
      "Templates/Meeting.md": "# Meeting\n\nWith {{attendees}}.\n",
      "Workflows/Meeting.md": serializeWorkflowNote(
        def({
          id: "meeting",
          name: "Meeting",
          variables: [{ name: "attendees" }, { name: "nobody" }],
          requires: { templates: ["Templates/Meeting.md"] },
          steps: [
            { type: "create-note", path: "Meetings/{{date}}.md", template: "Templates/Meeting.md" },
          ],
        }),
      ),
    });
    await service.refresh();

    const unused = service.list()[0]!.issues.filter((i) => i.code === "unused-variable");
    expect(unused.map((i) => i.message)).toEqual([
      expect.stringContaining("nobody"),
    ]);
    expect(service.list()[0]!.runnable).toBe(true);
  });

  it("says nothing about unused variables when the template is not in the vault", async () => {
    const { service } = vault({
      "Workflows/Meeting.md": serializeWorkflowNote(
        def({
          id: "meeting",
          name: "Meeting",
          variables: [{ name: "nobody" }],
          requires: { templates: ["Templates/Gone.md"] },
          steps: [{ type: "create-note", path: "Meetings/x.md", template: "Templates/Gone.md" }],
        }),
      ),
    });
    await service.refresh();

    expect(service.list()[0]!.issues.map((i) => i.code)).not.toContain("unused-variable");
  });

  it("skips a note it cannot read instead of failing the whole scan", async () => {
    const service = createCommandService({
      listNotes: async () => ["Gone.md", "Workflows/A.md"],
      readNote: async (path) => (path === "Gone.md" ? null : serializeWorkflowNote(def({ id: "a" }))),
      host: new FakeHost(),
    });
    await service.refresh();
    expect(service.list().map((w) => w.id)).toEqual(["a"]);
  });
});

describe("subscribe", () => {
  it("notifies every subscriber on a refresh, and stops after unsubscribe", async () => {
    const { service } = vault({ "Workflows/A.md": serializeWorkflowNote(def({ id: "a" })) });
    const first = vi.fn();
    const second = vi.fn();
    const off = service.subscribe(first);
    service.subscribe(second);

    await service.refresh();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    // The listener sees the new list, not the one from before the scan.
    expect(service.list()).toHaveLength(1);

    off();
    await service.refresh();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("picks up a file added between refreshes", async () => {
    const files: Record<string, string> = {
      "Workflows/A.md": serializeWorkflowNote(def({ id: "a", name: "A" })),
    };
    const service = createCommandService({
      listNotes: async () => Object.keys(files),
      readNote: async (p) => files[p] ?? null,
      host: new FakeHost(),
    });
    await service.refresh();
    expect(service.list()).toHaveLength(1);
    files["Workflows/B.md"] = serializeWorkflowNote(def({ id: "b", name: "B" }));
    await service.refresh();
    expect(service.list().map((w) => w.id)).toEqual(["a", "b"]);
  });
});

describe("promptsFor and run", () => {
  const prompting = def({
    id: "capture",
    name: "Capture",
    variables: [
      { name: "topic", label: "Topic" },
      { name: "body", type: "multiline", required: false, default: "" },
    ],
    steps: [{ type: "append", target: { path: "Inbox.md" }, content: "- {{topic}} {{body}}" }],
  });

  it("returns the declared variables in order", async () => {
    const { service } = vault({ "Workflows/A.md": serializeWorkflowNote(prompting) });
    await service.refresh();
    expect(service.promptsFor("capture").map((v) => v.name)).toEqual(["topic", "body"]);
    expect(service.promptsFor("missing")).toEqual([]);
  });

  it("runs through the host", async () => {
    const { service, host } = vault({ "Workflows/A.md": serializeWorkflowNote(prompting) });
    await service.refresh();
    const result = await service.run("capture", { topic: "Kelp", body: "" }, {});
    expect(result.ok).toBe(true);
    expect(host.textOf("Inbox.md")).toBe("- Kelp \n");
  });

  it("refuses an unknown id", async () => {
    const { service } = vault({});
    await service.refresh();
    const result = await service.run("ghost", {}, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("validation");
  });

  it("refuses to run a workflow with an error, quoting the problem", async () => {
    const { service, host } = vault({
      "Workflows/Bad.md": serializeWorkflowNote(
        def({ steps: [{ type: "append", target: { path: "../out.md" }, content: "x" }] }),
      ),
    });
    await service.refresh();
    const result = await service.run("capture", {}, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("validation");
      expect(result.field).toBe("steps.0.target.path");
    }
    expect(host.textOf("../out.md")).toBeUndefined();
  });

  it("lets a runnable workflow call another one through the registry", async () => {
    const { service, host } = vault({
      "Workflows/Outer.md": serializeWorkflowNote(
        def({
          id: "outer",
          name: "Outer",
          steps: [{ type: "run-workflow", id: "inner" }],
          requires: { workflows: ["inner"] },
        }),
      ),
      "Workflows/Inner.md": serializeWorkflowNote(
        def({ id: "inner", name: "Inner", steps: [{ type: "append", target: { path: "Inbox.md" }, content: "hi" }] }),
      ),
    });
    await service.refresh();
    const result = await service.run("outer", {}, {});
    expect(result.ok).toBe(true);
    expect(host.textOf("Inbox.md")).toBe("hi\n");
  });
});
