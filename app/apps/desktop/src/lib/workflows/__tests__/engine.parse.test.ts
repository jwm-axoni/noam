// Recognition, fence extraction and the round trip. A workflow note is an
// ordinary Markdown file, so the parser has to be sure about which files it is
// claiming — and has to hand back enough position information for the UI to
// edit the JSON in place.

import { describe, expect, it } from "vitest";
import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from "../contracts";
import { isWorkflowNote, parseWorkflowNote, serializeWorkflowNote } from "../engine/parse";

const DEF: WorkflowDefinition = {
  version: WORKFLOW_SCHEMA_VERSION,
  id: "daily-log",
  name: "Daily log",
  variables: [{ name: "entry", label: "Entry", type: "multiline" }],
  steps: [{ type: "append", target: { path: "Journal/{{date}}.md" }, content: "- {{entry}}" }],
};

function note(json: string, frontmatter = "noam_kind: workflow"): string {
  return `---\n${frontmatter}\n---\n\nSome prose.\n\n\`\`\`json noam-workflow\n${json}\n\`\`\`\n`;
}

describe("recognition", () => {
  it("claims a note with the kind marker and the fence", () => {
    const md = note(JSON.stringify(DEF));
    expect(isWorkflowNote(md)).toBe(true);
    expect(parseWorkflowNote("Workflows/Daily.md", md).definition?.id).toBe("daily-log");
  });

  it("does not claim a note without the frontmatter marker", () => {
    const md = note(JSON.stringify(DEF), "noam_kind: note");
    expect(isWorkflowNote(md)).toBe(false);
    const parsed = parseWorkflowNote("Notes/Thing.md", md);
    expect(parsed.definition).toBeNull();
    expect(parsed.issues.map((i) => i.code)).toContain("not-a-workflow");
  });

  it("does not claim a note with no frontmatter at all", () => {
    expect(isWorkflowNote("# Just a note\n\n```json noam-workflow\n{}\n```\n")).toBe(false);
  });

  it("does not claim a marked note that has no workflow fence", () => {
    const md = "---\nnoam_kind: workflow\n---\n\nNothing here.\n";
    expect(isWorkflowNote(md)).toBe(false);
    const parsed = parseWorkflowNote("Workflows/Empty.md", md);
    expect(parsed.definition).toBeNull();
    expect(parsed.issues.map((i) => i.code)).toContain("missing-fence");
  });
});

describe("fence extraction", () => {
  it("ignores fences with other info strings", () => {
    const md = [
      "---",
      "noam_kind: workflow",
      "---",
      "",
      "```json",
      '{ "not": "the workflow" }',
      "```",
      "",
      "```json noam-workflow",
      JSON.stringify(DEF),
      "```",
      "",
      "```",
      "plain",
      "```",
      "",
    ].join("\n");
    const parsed = parseWorkflowNote("W.md", md);
    expect(parsed.definition?.id).toBe("daily-log");
  });

  it("reports two workflow fences rather than guessing", () => {
    const body = "```json noam-workflow\n{}\n```";
    const md = `---\nnoam_kind: workflow\n---\n\n${body}\n\n${body}\n`;
    const parsed = parseWorkflowNote("W.md", md);
    expect(parsed.definition).toBeNull();
    expect(parsed.issues.map((i) => i.code)).toContain("duplicate-fence");
  });

  it("returns the offsets of the fence body so the UI can edit in place", () => {
    const json = JSON.stringify(DEF, null, 2);
    const md = note(json);
    const parsed = parseWorkflowNote("W.md", md);
    expect(parsed.fence).not.toBeNull();
    expect(md.slice(parsed.fence!.from, parsed.fence!.to)).toBe(json);
  });

  it("does not mistake an inner fence for the end of the block", () => {
    const json = JSON.stringify({ ...DEF, description: "uses ``` in prose" });
    const md = `---\nnoam_kind: workflow\n---\n\n~~~~json noam-workflow\n${json}\n~~~~\n`;
    expect(parseWorkflowNote("W.md", md).definition?.description).toBe("uses ``` in prose");
  });
});

describe("shape and unknown fields", () => {
  it("reports malformed JSON with a field, and keeps the fence offsets", () => {
    const md = note('{ "id": "x", }');
    const parsed = parseWorkflowNote("W.md", md);
    expect(parsed.definition).toBeNull();
    const bad = parsed.issues.find((i) => i.code === "bad-json");
    expect(bad).toBeDefined();
    expect(bad!.field).toBe("json");
    expect(bad!.severity).toBe("error");
    expect(parsed.fence).not.toBeNull();
  });

  it("reports a JSON value that is not an object", () => {
    const parsed = parseWorkflowNote("W.md", note("[1, 2]"));
    expect(parsed.definition).toBeNull();
    expect(parsed.issues.map((i) => i.code)).toContain("bad-shape");
  });

  it("preserves unknown top-level fields verbatim and warns about them", () => {
    const md = note(JSON.stringify({ ...DEF, futureThing: { a: 1 }, colour: "teal" }));
    const parsed = parseWorkflowNote("W.md", md);
    expect(parsed.unknownFields).toEqual({ futureThing: { a: 1 }, colour: "teal" });
    expect(parsed.definition!.futureThing).toEqual({ a: 1 });
    const warned = parsed.issues.filter((i) => i.code === "unknown-field");
    expect(warned.map((i) => i.field).sort()).toEqual(["colour", "futureThing"]);
    expect(warned.every((i) => i.severity === "warning")).toBe(true);
  });

  it("carries step and field on a schema issue found during a parse", () => {
    const broken = { ...DEF, steps: [{ type: "create-note", path: "Notes/x.txt" }] };
    const parsed = parseWorkflowNote("W.md", note(JSON.stringify(broken)));
    const issue = parsed.issues.find((i) => i.code === "bad-path");
    expect(issue).toBeDefined();
    expect(issue!.step).toBe(0);
    expect(issue!.field).toBe("steps.0.path");
  });

  it("can be asked to skip validation, for callers that revalidate with a registry", () => {
    const broken = { ...DEF, steps: [{ type: "create-note", path: "Notes/x.txt" }] };
    const parsed = parseWorkflowNote("W.md", note(JSON.stringify(broken)), { validate: false });
    expect(parsed.issues.some((i) => i.code === "bad-path")).toBe(false);
    expect(parsed.definition).not.toBeNull();
  });
});

describe("serializeWorkflowNote", () => {
  it("round-trips a definition, including unknown fields", () => {
    const rich: WorkflowDefinition = {
      ...DEF,
      description: "Add an entry",
      icon: "lucide:notebook",
      shortcut: "mod+shift+l",
      slash: false,
      requires: { templates: ["Templates/Day.md"] },
      futureThing: { nested: [1, 2] },
    };
    const md = serializeWorkflowNote(rich, "Prose about the workflow.");
    expect(isWorkflowNote(md)).toBe(true);
    const parsed = parseWorkflowNote("Workflows/Daily.md", md);
    expect(parsed.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(parsed.definition).toEqual(rich);
    expect(md).toContain("Prose about the workflow.");
  });

  it("writes a note that is stable under a second round trip", () => {
    const once = serializeWorkflowNote(DEF);
    const twice = serializeWorkflowNote(parseWorkflowNote("W.md", once).definition!);
    expect(twice).toBe(once);
  });
});
