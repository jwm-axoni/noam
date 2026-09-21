// The bundled examples must be valid against the same parser, validator and
// executor that run user workflows, and must run end to end on a fake vault.

import { describe, expect, it } from "vitest";
import { EXAMPLE_FILES } from "../examples";
import { parseWorkflowNote } from "../engine/parse";
import { validateDefinition } from "../engine/validate";
import { renderTemplate } from "../engine/template";
import { runWorkflow } from "../engine/executor";
import { createCommandService } from "../engine/registry";
import { FakeHost } from "./fixtures/fakeHost";
import type { WorkflowDefinition } from "../contracts";

const workflows = EXAMPLE_FILES.filter((f) => f.kind === "workflow");
const templates = EXAMPLE_FILES.filter((f) => f.kind === "template");
const templateByPath = new Map(templates.map((t) => [t.path, t.content]));

function parsed(path: string, content: string): WorkflowDefinition {
  const file = parseWorkflowNote(path, content);
  const errors = file.issues.filter((i) => i.severity === "error");
  expect(errors, `${path}: ${JSON.stringify(errors)}`).toEqual([]);
  expect(file.definition).not.toBeNull();
  return file.definition!;
}

describe("bundled examples", () => {
  it("every file is marked as an example so it cannot pass for user data", () => {
    for (const file of EXAMPLE_FILES) {
      expect(file.path.toLowerCase()).toContain("(example)");
      expect(file.content.toLowerCase()).toContain("example");
    }
  });

  it("every workflow parses and validates without errors", () => {
    const ids = new Set<string>();
    for (const file of workflows) {
      const def = parsed(file.path, file.content);
      expect(ids.has(def.id), `duplicate id ${def.id}`).toBe(false);
      ids.add(def.id);
      const issues = validateDefinition(def).filter((i) => i.severity === "error");
      expect(issues, `${file.path}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it("declared template dependencies exist and render with the workflow's variables", () => {
    for (const file of workflows) {
      const def = parsed(file.path, file.content);
      const declared = new Set((def.variables ?? []).map((v) => v.name));
      const values = Object.fromEntries([...declared].map((n) => [n, `value-${n}`]));
      for (const t of def.requires?.templates ?? []) {
        const body = templateByPath.get(t);
        expect(body, `${file.path} requires missing template ${t}`).toBeDefined();
        const out = renderTemplate(body!, {
          values,
          declared,
          now: new Date("2026-09-20T10:30:00"),
          currentPath: "Notes/Open.md",
          selection: "",
        });
        const errors = out.issues.filter((i) => i.severity === "error");
        expect(errors, `${t}: ${JSON.stringify(errors)}`).toEqual([]);
        expect(out.text).not.toContain("{{");
      }
    }
  });

  it("the whole set registers as runnable in the command service", async () => {
    const notes = new Map(EXAMPLE_FILES.map((f) => [f.path, f.content]));
    const host = new FakeHost({ notes: Object.fromEntries(notes) });
    const service = createCommandService({
      listNotes: async () => [...notes.keys()],
      readNote: async (p) => notes.get(p) ?? null,
      host,
    });
    await service.refresh();
    const list = service.list();
    expect(list.map((w) => w.id).sort()).toEqual(workflows.map((f) => parsed(f.path, f.content).id).sort());
    for (const w of list) expect(w.runnable, `${w.id}: ${JSON.stringify(w.issues)}`).toBe(true);
  });

  it("capture task creates the inbox on first use and appends under the heading afterwards", async () => {
    const file = workflows.find((f) => f.path.includes("Capture task"))!;
    const def = parsed(file.path, file.content);
    const host = new FakeHost({ currentPath: "Notes/Open.md", now: new Date("2026-09-20T10:30:00") });

    const first = await runWorkflow(def, { task: "Call the dentist" }, { currentPath: "Notes/Open.md" }, host);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const created = host.notes.get("Tasks/Inbox.md")?.text ?? "";
    expect(created).toContain("## Inbox");
    expect(created).toContain("- [ ] Call the dentist (2026-09-20)");

    const second = await runWorkflow(def, { task: "Buy milk" }, { currentPath: "Notes/Open.md" }, host);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    const text = host.notes.get("Tasks/Inbox.md")!.text;
    const inbox = text.slice(text.indexOf("## Inbox"), text.indexOf("## Done"));
    expect(inbox).toContain("- [ ] Call the dentist (2026-09-20)");
    expect(inbox).toContain("- [ ] Buy milk (2026-09-20)");
    expect(text.indexOf("Call the dentist")).toBeLessThan(text.indexOf("Buy milk"));
  });

  it("meeting note renders the template into a dated note and opens it", async () => {
    const file = workflows.find((f) => f.path.includes("Meeting note"))!;
    const def = parsed(file.path, file.content);
    const host = new FakeHost({
      notes: Object.fromEntries(templates.map((t) => [t.path, t.content])),
      currentPath: null,
      now: new Date("2026-09-20T10:30:00"),
    });
    const result = await runWorkflow(def, { topic: "Weekly sync", attendees: "Ada, Lin" }, {}, host);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const text = host.notes.get("Meetings/2026-09-20 Weekly sync.md")?.text ?? "";
    expect(text).toContain("# Weekly sync");
    expect(text).toContain("Ada, Lin");
    expect(text).not.toContain("{{");
    expect(host.opened).toContain("Meetings/2026-09-20 Weekly sync.md");
  });

  it("the clipboard example only expands an explicitly captured clipboard", async () => {
    const file = workflows.find((f) => f.path.includes("clipboard"))!;
    const def = parsed(file.path, file.content);
    const host = new FakeHost({
      notes: { "Notes/Open.md": "# Open\n" },
      currentPath: "Notes/Open.md",
      hasEditor: true,
    });
    const denied = await runWorkflow(def, {}, { currentPath: "Notes/Open.md" }, host);
    expect(denied.ok).toBe(false);
    const ok = await runWorkflow(def, { clip: "pasted text" }, { currentPath: "Notes/Open.md", clipboard: "pasted text" }, host);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(host.caretInserts[0]).toContain("> pasted text");
  });
});
