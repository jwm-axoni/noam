// Everything a run can do, and everything it can refuse to do. The host is the
// in-memory fake, so these are pure: no Tauri, no store, no editor.

import { describe, expect, it } from "vitest";
import {
  WORKFLOW_SCHEMA_VERSION,
  type ExecutionFailure,
  type ExecutionResult,
  type ExecutionSuccess,
  type WorkflowDefinition,
  type WorkflowStep,
} from "../contracts";
import { MAX_WORKFLOW_DEPTH, runWorkflow } from "../engine/executor";
import { FakeHost } from "./fixtures/fakeHost";

function def(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    id: "capture",
    name: "Capture",
    steps: [],
    ...over,
  };
}

const ok = (r: ExecutionResult): ExecutionSuccess => {
  if (!r.ok) throw new Error(`expected success, got ${r.kind}: ${r.message}`);
  return r;
};
const nope = (r: ExecutionResult): ExecutionFailure => {
  if (r.ok) throw new Error("expected a failure");
  return r;
};

describe("prompt values", () => {
  const withVar = def({
    variables: [
      { name: "topic", label: "Topic" },
      { name: "note", required: false, default: "none" },
    ],
    steps: [{ type: "append", target: { path: "Inbox.md" }, content: "- {{topic}} / {{note}}" }],
  });

  it("uses supplied values and falls back to defaults", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "# Inbox\n" } });
    ok(await runWorkflow(withVar, { topic: "Kelp" }, {}, host));
    expect(host.textOf("Inbox.md")).toBe("# Inbox\n- Kelp / none\n");
  });

  it("refuses a missing required value, naming the field, before writing", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "# Inbox\n" } });
    const r = nope(await runWorkflow(withVar, {}, {}, host));
    expect(r.kind).toBe("validation");
    expect(r.field).toBe("topic");
    expect(r.message).toContain("Topic");
    expect(r.completed).toEqual([]);
    expect(host.textOf("Inbox.md")).toBe("# Inbox\n");
  });

  it("refuses a value for a variable the workflow does not declare", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "" } });
    const r = nope(await runWorkflow(withVar, { topic: "Kelp", colour: "teal" }, {}, host));
    expect(r.kind).toBe("validation");
    expect(r.field).toBe("colour");
  });

  it("refuses a malformed value: a choice outside its choices", async () => {
    const workflow = def({
      variables: [{ name: "kind", type: "choice", choices: ["idea", "task"] }],
      steps: [{ type: "append", target: { path: "Inbox.md" }, content: "- {{kind}}" }],
    });
    const host = new FakeHost({ notes: { "Inbox.md": "" } });
    const r = nope(await runWorkflow(workflow, { kind: "rant" }, {}, host));
    expect(r.kind).toBe("validation");
    expect(r.field).toBe("kind");
  });

  it("refuses a malformed value: not text", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "" } });
    const r = nope(
      await runWorkflow(withVar, { topic: 7 as unknown as string }, {}, host),
    );
    expect(r.kind).toBe("validation");
    expect(r.field).toBe("topic");
  });

  it("a declared variable prompted twice is impossible, so the last value wins", async () => {
    // PromptValues is a record: the UI cannot hand the engine the same name
    // twice. The duplicate-declaration case is a validation error instead.
    const host = new FakeHost({ notes: { "Inbox.md": "" } });
    ok(await runWorkflow(withVar, { ...{ topic: "a" }, ...{ topic: "b" } }, {}, host));
    expect(host.textOf("Inbox.md")).toBe("- b / none\n");
  });
});

describe("create-note", () => {
  const create = (over: Partial<WorkflowStep> = {}) =>
    def({
      steps: [
        { type: "create-note", path: "Journal/{{date}}.md", content: "# {{date}}\n", ...over } as WorkflowStep,
      ],
    });

  it("creates a new note and opens it", async () => {
    const host = new FakeHost();
    const r = ok(await runWorkflow(create(), {}, {}, host));
    expect(host.textOf("Journal/2026-03-09.md")).toBe("# 2026-03-09\n");
    expect(r.effects).toEqual([
      { kind: "created", path: "Journal/2026-03-09.md" },
      { kind: "opened", path: "Journal/2026-03-09.md" },
    ]);
  });

  it("does not open when asked not to", async () => {
    const host = new FakeHost();
    const r = ok(await runWorkflow(create({ open: false } as Partial<WorkflowStep>), {}, {}, host));
    expect(r.effects).toEqual([{ kind: "created", path: "Journal/2026-03-09.md" }]);
    expect(host.opened).toEqual([]);
  });

  it("renders a template, frontmatter included", async () => {
    const host = new FakeHost({
      notes: { "Templates/Day.md": "---\ncreated: {{date}}\n---\n\n# {{date}}\n" },
    });
    const workflow = def({
      steps: [{ type: "create-note", path: "Journal/{{date}}.md", template: "Templates/Day.md" }],
    });
    ok(await runWorkflow(workflow, {}, {}, host));
    expect(host.textOf("Journal/2026-03-09.md")).toBe(
      "---\ncreated: 2026-03-09\n---\n\n# 2026-03-09\n",
    );
  });

  it("reports a template that is not there", async () => {
    const host = new FakeHost();
    const workflow = def({
      steps: [{ type: "create-note", path: "a.md", template: "Templates/Gone.md" }],
    });
    const r = nope(await runWorkflow(workflow, {}, {}, host));
    expect(r.kind).toBe("missing-target");
    expect(r.field).toBe("steps.0.template");
  });

  it("honours onExists: fail", async () => {
    const host = new FakeHost({ notes: { "Journal/2026-03-09.md": "taken" } });
    const r = nope(await runWorkflow(create(), {}, {}, host));
    expect(r.kind).toBe("conflict");
    expect(host.textOf("Journal/2026-03-09.md")).toBe("taken");
    expect(r.recovery.pendingContent).toBe("# 2026-03-09\n");
  });

  it("honours onExists: open", async () => {
    const host = new FakeHost({ notes: { "Journal/2026-03-09.md": "taken" } });
    const r = ok(await runWorkflow(create({ onExists: "open" } as Partial<WorkflowStep>), {}, {}, host));
    expect(r.effects).toEqual([{ kind: "opened", path: "Journal/2026-03-09.md" }]);
    expect(host.textOf("Journal/2026-03-09.md")).toBe("taken");
  });

  it("honours onExists: suffix, counting from 2", async () => {
    const host = new FakeHost({
      notes: { "Journal/2026-03-09.md": "one", "Journal/2026-03-09 2.md": "two" },
    });
    ok(await runWorkflow(create({ onExists: "suffix" } as Partial<WorkflowStep>), {}, {}, host));
    expect(host.textOf("Journal/2026-03-09 3.md")).toBe("# 2026-03-09\n");
  });

  it("refuses a path that only becomes unsafe once expanded", async () => {
    const workflow = def({
      variables: [{ name: "name" }],
      steps: [{ type: "create-note", path: "Notes/{{name}}.md", content: "x" }],
    });
    const host = new FakeHost();
    const r = nope(await runWorkflow(workflow, { name: "../../etc/passwd" }, {}, host));
    expect(r.kind).toBe("validation");
    expect(r.field).toBe("steps.0.path");
    // Nothing was rendered, so nothing needed preserving and nothing was written.
    expect(host.notes.size).toBe(0);
    expect(r.recovery.pendingContent).toBeUndefined();
  });
});

describe("append", () => {
  const append = (over: Partial<WorkflowStep> = {}) =>
    def({
      steps: [
        { type: "append", target: { path: "Inbox.md" }, content: "- new", ...over } as WorkflowStep,
      ],
    });

  it("appends at the end of a note", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "# Inbox\n\n- old\n" } });
    const r = ok(await runWorkflow(append(), {}, {}, host));
    expect(host.textOf("Inbox.md")).toBe("# Inbox\n\n- old\n- new\n");
    expect(r.effects).toEqual([{ kind: "appended", path: "Inbox.md", bytes: 6 }]);
  });

  it("appends to a note with no trailing newline", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "- old" } });
    ok(await runWorkflow(append(), {}, {}, host));
    expect(host.textOf("Inbox.md")).toBe("- old\n- new\n");
  });

  it("appends to an empty note", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "" } });
    ok(await runWorkflow(append(), {}, {}, host));
    expect(host.textOf("Inbox.md")).toBe("- new\n");
  });

  it("prepends below the frontmatter, never above it", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "---\na: 1\n---\n\n- old\n" } });
    ok(await runWorkflow(append({ position: "start" } as Partial<WorkflowStep>), {}, {}, host));
    expect(host.textOf("Inbox.md")).toBe("---\na: 1\n---\n- new\n\n- old\n");
  });

  it("prepends below frontmatter closed with a YAML document end", async () => {
    // `...` ends a YAML document exactly as `---` ends the block; inserting
    // above the opening fence would stop the metadata being frontmatter at all.
    const host = new FakeHost({ notes: { "Inbox.md": "---\na: 1\n...\n\n- old\n" } });
    ok(await runWorkflow(append({ position: "start" } as Partial<WorkflowStep>), {}, {}, host));
    expect(host.textOf("Inbox.md")).toBe("---\na: 1\n...\n- new\n\n- old\n");
  });

  it("writes to the note open in the editor when the target is current", async () => {
    const host = new FakeHost({ notes: { "Open.md": "body\n" }, currentPath: "Open.md" });
    ok(await runWorkflow(append({ target: "current" } as Partial<WorkflowStep>), {}, {}, host));
    expect(host.textOf("Open.md")).toBe("body\n- new\n");
  });

  it("refuses a current target with nothing open", async () => {
    const host = new FakeHost({ currentPath: null });
    const r = nope(await runWorkflow(append({ target: "current" } as Partial<WorkflowStep>), {}, {}, host));
    expect(r.kind).toBe("missing-target");
  });

  it("creates the target from createIfMissing and then appends into it", async () => {
    const host = new FakeHost();
    const workflow = append({
      createIfMissing: { content: "# Inbox\n" },
    } as Partial<WorkflowStep>);
    const r = ok(await runWorkflow(workflow, {}, {}, host));
    expect(host.textOf("Inbox.md")).toBe("# Inbox\n- new\n");
    expect(r.effects.map((e) => e.kind)).toEqual(["created", "appended"]);
  });

  describe("headings", () => {
    const NOTE = [
      "# Journal",
      "",
      "## Inbox",
      "- a",
      "",
      "### Later",
      "- b",
      "",
      "## Archive",
      "- c",
      "",
    ].join("\n");

    it("appends at the end of a heading's section", async () => {
      const host = new FakeHost({ notes: { "Inbox.md": NOTE } });
      ok(await runWorkflow(append({ heading: "### Later" } as Partial<WorkflowStep>), {}, {}, host));
      expect(host.textOf("Inbox.md")).toBe(NOTE.replace("- b\n", "- b\n- new\n"));
    });

    it("prepends right under the heading when position is start", async () => {
      const host = new FakeHost({ notes: { "Inbox.md": NOTE } });
      const workflow = append({ heading: "## Inbox", position: "start" } as Partial<WorkflowStep>);
      ok(await runWorkflow(workflow, {}, {}, host));
      expect(host.textOf("Inbox.md")).toBe(NOTE.replace("## Inbox\n", "## Inbox\n- new\n"));
    });

    it("treats a deeper heading as part of the section, not its end", async () => {
      const host = new FakeHost({ notes: { "Inbox.md": NOTE } });
      ok(await runWorkflow(append({ heading: "## Inbox" } as Partial<WorkflowStep>), {}, {}, host));
      // The Inbox section runs through `### Later`, so the append lands after
      // `- b` and before `## Archive`.
      expect(host.textOf("Inbox.md")).toBe(NOTE.replace("- b\n", "- b\n- new\n"));
    });

    it("stops a section at the next heading of the same level", async () => {
      const host = new FakeHost({ notes: { "Inbox.md": NOTE } });
      ok(await runWorkflow(append({ heading: "## Archive" } as Partial<WorkflowStep>), {}, {}, host));
      expect(host.textOf("Inbox.md")).toBe(`${NOTE.trimEnd()}\n- new\n`);
    });

    it("records the heading on the effect", async () => {
      const host = new FakeHost({ notes: { "Inbox.md": NOTE } });
      const r = ok(await runWorkflow(append({ heading: "## Inbox" } as Partial<WorkflowStep>), {}, {}, host));
      expect(r.effects[0]).toMatchObject({ kind: "appended", heading: "## Inbox" });
    });

    it("fails with missing-heading rather than appending somewhere else", async () => {
      const host = new FakeHost({ notes: { "Inbox.md": NOTE } });
      const r = nope(await runWorkflow(append({ heading: "## Nope" } as Partial<WorkflowStep>), {}, {}, host));
      expect(r.kind).toBe("missing-heading");
      expect(r.field).toBe("steps.0.heading");
      expect(host.textOf("Inbox.md")).toBe(NOTE);
      expect(r.recovery.pendingContent).toBe("- new");
      expect(r.recovery.preservedAt).toBe("Captures/Unsaved capture 1.md");
      expect(host.textOf(r.recovery.preservedAt!)).toBe("- new");
    });

    it("expands variables in the heading before looking for it", async () => {
      const host = new FakeHost({ notes: { "Inbox.md": NOTE } });
      const workflow = def({
        variables: [{ name: "section" }],
        steps: [
          {
            type: "append",
            target: { path: "Inbox.md" },
            content: "- new",
            heading: "## {{section}}",
          } as WorkflowStep,
        ],
      });

      const r = ok(await runWorkflow(workflow, { section: "Archive" }, {}, host));

      expect(host.textOf("Inbox.md")).toBe(`${NOTE.trimEnd()}\n- new\n`);
      // The effect names the heading it actually wrote under, not the template.
      expect(r.effects[0]).toMatchObject({ kind: "appended", heading: "## Archive" });
    });

    it("reports the expanded heading when it is not there", async () => {
      const host = new FakeHost({ notes: { "Inbox.md": NOTE } });
      const workflow = def({
        variables: [{ name: "section" }],
        steps: [
          {
            type: "append",
            target: { path: "Inbox.md" },
            content: "- new",
            heading: "## {{section}}",
          } as WorkflowStep,
        ],
      });

      const r = nope(await runWorkflow(workflow, { section: "Nope" }, {}, host));

      expect(r.kind).toBe("missing-heading");
      expect(r.message).toContain("## Nope");
      expect(host.textOf("Inbox.md")).toBe(NOTE);
    });

    it("matches a heading exactly, not as a prefix", async () => {
      const host = new FakeHost({ notes: { "Inbox.md": "## Inbox items\n- a\n" } });
      const r = nope(await runWorkflow(append({ heading: "## Inbox" } as Partial<WorkflowStep>), {}, {}, host));
      expect(r.kind).toBe("missing-heading");
    });
  });
});

describe("targets that moved or refuse", () => {
  const append = def({
    steps: [{ type: "append", target: { path: "Inbox.md" }, content: "- new" }],
  });

  it("refuses to write when the note changed between resolve and write", async () => {
    const host = new FakeHost({
      notes: { "Inbox.md": "- old\n" },
      afterResolve: (path, h) => {
        if (path === "Inbox.md") h.setNote(path, "- old\n- someone else\n");
      },
    });
    const r = nope(await runWorkflow(append, {}, {}, host));
    expect(r.kind).toBe("stale-target");
    expect(r.recovery.retryable).toBe(true);
    expect(r.recovery.pendingContent).toBe("- new");
    expect(r.recovery.preservedAt).toBe("Captures/Unsaved capture 1.md");
    expect(host.textOf("Inbox.md")).toBe("- old\n- someone else\n");
  });

  it("resolves the target immediately before it writes", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "- old\n" } });
    ok(await runWorkflow(append, {}, {}, host));
    expect(host.calls.map((c) => c.op)).toEqual(["resolveTarget", "readNote", "replaceRange"]);
  });

  it("reports a target that is not in the vault", async () => {
    const host = new FakeHost();
    const r = nope(await runWorkflow(append, {}, {}, host));
    expect(r.kind).toBe("missing-target");
    expect(r.recovery.preservedAt).toBe("Captures/Unsaved capture 1.md");
  });

  it("reports a read-only note without attempting the write", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": { text: "- old\n", permission: "view" } } });
    const r = nope(await runWorkflow(append, {}, {}, host));
    expect(r.kind).toBe("read-only");
    expect(r.recovery.retryable).toBe(false);
    expect(host.calls.some((c) => c.op === "replaceRange")).toBe(false);
    expect(host.textOf("Inbox.md")).toBe("- old\n");
  });

  it("reports a note with no access at all", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": { text: "- old\n", permission: "none" } } });
    const r = nope(await runWorkflow(append, {}, {}, host));
    expect(r.kind).toBe("permission");
    expect(host.calls.some((c) => c.op === "replaceRange")).toBe(false);
  });

  it("refuses to create where there is no write access", async () => {
    const host = new FakeHost({ permissionForNewPaths: "view" });
    const workflow = def({ steps: [{ type: "create-note", path: "Locked/a.md", content: "x" }] });
    const r = nope(await runWorkflow(workflow, {}, {}, host));
    expect(r.kind).toBe("read-only");
    expect(host.calls.some((c) => c.op === "createNote")).toBe(false);
  });
});

describe("insert and open-note", () => {
  it("inserts at the caret of the open note", async () => {
    const host = new FakeHost({ notes: { "Open.md": "body" }, currentPath: "Open.md" });
    const workflow = def({ steps: [{ type: "insert", target: "current", content: "{{date}}" }] });
    const r = ok(await runWorkflow(workflow, {}, {}, host));
    expect(host.caretInserts).toEqual(["2026-03-09"]);
    expect(r.effects).toEqual([{ kind: "inserted", path: "Open.md", bytes: 10 }]);
  });

  it("refuses to insert when the user switched notes while the target resolved", async () => {
    // The user clicks another note during the await. Without the recheck the
    // permission verdict is about Open.md and the text lands in Other.md.
    const host = new FakeHost({
      notes: { "Open.md": "body", "Other.md": "theirs" },
      currentPath: "Open.md",
      afterResolve: (_path, h) => {
        h.currentPath = "Other.md";
      },
    });
    const workflow = def({ steps: [{ type: "insert", target: "current", content: "x" }] });
    const r = nope(await runWorkflow(workflow, {}, {}, host));
    expect(r.kind).toBe("stale-target");
    expect(r.message).toContain("Open.md");
    expect(host.caretInserts).toEqual([]);
    expect(host.textOf("Other.md")).toBe("theirs");
    expect(r.recovery.pendingContent).toBe("x");
  });

  it("reports when there is no editor to insert into", async () => {
    const host = new FakeHost({ notes: { "Open.md": "body" }, currentPath: "Open.md", hasEditor: false });
    const workflow = def({ steps: [{ type: "insert", target: "current", content: "x" }] });
    const r = nope(await runWorkflow(workflow, {}, {}, host));
    expect(r.kind).toBe("missing-target");
    expect(r.recovery.pendingContent).toBe("x");
  });

  it("opens an existing note", async () => {
    const host = new FakeHost({ notes: { "Notes/A.md": "a" } });
    const workflow = def({ steps: [{ type: "open-note", path: "Notes/A.md" }] });
    const r = ok(await runWorkflow(workflow, {}, {}, host));
    expect(r.effects).toEqual([{ kind: "opened", path: "Notes/A.md" }]);
  });

  it("refuses to open a note that is not there", async () => {
    const host = new FakeHost();
    const workflow = def({ steps: [{ type: "open-note", path: "Notes/A.md" }] });
    expect(nope(await runWorkflow(workflow, {}, {}, host)).kind).toBe("missing-target");
  });
});

describe("sequences", () => {
  it("reports the step that failed and the effects that completed before it", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "- old\n" } });
    const workflow = def({
      steps: [
        { type: "append", target: { path: "Inbox.md" }, content: "- one" },
        { type: "append", target: { path: "Gone.md" }, content: "- two" },
        { type: "append", target: { path: "Inbox.md" }, content: "- three" },
      ],
    });
    const r = nope(await runWorkflow(workflow, {}, {}, host));
    expect(r.step).toBe(1);
    expect(r.kind).toBe("missing-target");
    expect(r.completed).toEqual([{ kind: "appended", path: "Inbox.md", bytes: 6 }]);
    expect(host.textOf("Inbox.md")).toBe("- old\n- one\n");
  });

  it("runs a nested workflow and records it", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "", "Log.md": "" } });
    const inner = def({
      id: "log",
      name: "Log",
      steps: [{ type: "append", target: { path: "Log.md" }, content: "logged" }],
    });
    const outer = def({
      steps: [
        { type: "append", target: { path: "Inbox.md" }, content: "captured" },
        { type: "run-workflow", id: "log" },
      ],
    });
    const r = ok(await runWorkflow(outer, {}, {}, host, new Map([["log", inner]])));
    expect(r.effects.map((e) => e.kind)).toEqual(["appended", "appended", "ran-workflow"]);
    expect(host.textOf("Log.md")).toBe("logged\n");
  });

  it("passes only the answers the nested workflow declares", async () => {
    const host = new FakeHost({ notes: { "Log.md": "" } });
    const inner = def({
      id: "log",
      name: "Log",
      variables: [{ name: "topic" }],
      steps: [{ type: "append", target: { path: "Log.md" }, content: "{{topic}}" }],
    });
    const outer = def({
      variables: [{ name: "topic" }, { name: "mood" }],
      steps: [{ type: "run-workflow", id: "log" }],
    });
    ok(await runWorkflow(outer, { topic: "kelp", mood: "fine" }, {}, host, new Map([["log", inner]])));
    expect(host.textOf("Log.md")).toBe("kelp\n");
  });

  it("reports a nested failure against the outer step", async () => {
    const host = new FakeHost();
    const inner = def({
      id: "log",
      name: "Log",
      steps: [{ type: "append", target: { path: "Gone.md" }, content: "logged" }],
    });
    const outer = def({ steps: [{ type: "open-note", path: "A.md" }, { type: "run-workflow", id: "log" }] });
    host.setNote("A.md", "a");
    const r = nope(await runWorkflow(outer, {}, {}, host, new Map([["log", inner]])));
    expect(r.step).toBe(1);
    expect(r.kind).toBe("missing-target");
    expect(r.message).toContain("Log:");
    expect(r.completed).toEqual([{ kind: "opened", path: "A.md" }]);
  });

  it("refuses a cycle at run time even if it reached the registry", async () => {
    const host = new FakeHost();
    const a = def({ id: "a", name: "A", steps: [{ type: "run-workflow", id: "b" }] });
    const b = def({ id: "b", name: "B", steps: [{ type: "run-workflow", id: "a" }] });
    const r = nope(await runWorkflow(a, {}, {}, host, new Map([["a", a], ["b", b]])));
    expect(r.kind).toBe("validation");
    expect(r.message).toContain("already running");
  });

  it("refuses a chain deeper than the limit and allows one exactly at it", async () => {
    const host = new FakeHost({ notes: { "End.md": "" } });
    const chain = (n: number) =>
      def({
        id: `w${n}`,
        name: `W${n}`,
        steps: [
          n === 0
            ? { type: "append", target: { path: "End.md" }, content: "end" }
            : { type: "run-workflow", id: `w${n - 1}` },
        ],
      });
    const registry = new Map<string, WorkflowDefinition>();
    for (let n = 0; n <= 20; n++) registry.set(`w${n}`, chain(n));

    // `MAX_WORKFLOW_DEPTH` workflows in one chain is the last one that runs.
    ok(await runWorkflow(registry.get(`w${MAX_WORKFLOW_DEPTH - 1}`)!, {}, {}, host, registry));
    expect(host.textOf("End.md")).toBe("end\n");

    const r = nope(await runWorkflow(registry.get(`w${MAX_WORKFLOW_DEPTH}`)!, {}, {}, host, registry));
    expect(r.kind).toBe("validation");
    expect(r.message).toContain("nested");
  });

  it("refuses a nested id the registry does not know", async () => {
    const host = new FakeHost();
    const outer = def({ steps: [{ type: "run-workflow", id: "ghost" }] });
    expect(nope(await runWorkflow(outer, {}, {}, host)).kind).toBe("validation");
  });
});

describe("the editor context", () => {
  it("expands selection and clipboard from the context only", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "" }, currentPath: "Inbox.md" });
    const workflow = def({
      steps: [
        {
          type: "append",
          target: { path: "Inbox.md" },
          content: "> {{selection}}\n\nfrom {{title}} / {{clipboard}}",
        },
      ],
    });
    ok(
      await runWorkflow(workflow, {}, { selection: "quoted", clipboard: "pasted" }, host),
    );
    expect(host.textOf("Inbox.md")).toBe("> quoted\n\nfrom Inbox / pasted\n");
  });

  it("fails rather than inventing a clipboard nobody captured", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "" } });
    const workflow = def({
      steps: [{ type: "append", target: { path: "Inbox.md" }, content: "{{clipboard}}" }],
    });
    const r = nope(await runWorkflow(workflow, {}, {}, host));
    expect(r.kind).toBe("validation");
    expect(r.message).toContain("clipboard");
    expect(host.textOf("Inbox.md")).toBe("");
  });

  it("never reaches for navigator.clipboard", async () => {
    const g = globalThis as Record<string, unknown>;
    const had = "navigator" in g;
    const original = g.navigator;
    Object.defineProperty(g, "navigator", {
      configurable: true,
      get() {
        throw new Error("the engine read navigator");
      },
    });
    try {
      const host = new FakeHost({ notes: { "Inbox.md": "" } });
      const workflow = def({
        steps: [{ type: "append", target: { path: "Inbox.md" }, content: "{{clipboard}}" }],
      });
      ok(await runWorkflow(workflow, {}, { clipboard: "only this" }, host));
      expect(host.textOf("Inbox.md")).toBe("only this\n");
    } finally {
      delete g.navigator;
      if (had) g.navigator = original;
    }
  });

  it("prefers the context's current path over the host's live one", async () => {
    const host = new FakeHost({ notes: { "Inbox.md": "" }, currentPath: "Other.md" });
    const workflow = def({
      steps: [{ type: "append", target: { path: "Inbox.md" }, content: "{{path}}" }],
    });
    ok(await runWorkflow(workflow, {}, { currentPath: "Snapshot.md" }, host));
    expect(host.textOf("Inbox.md")).toBe("Snapshot.md\n");
  });
});
