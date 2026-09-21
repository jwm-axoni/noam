// Validation is the gate an imported workflow has to pass before it can write
// anything, so the tests here are mostly about REFUSAL: a path that escapes the
// vault, a variable nobody declared, a chain of workflows that never ends.

import { describe, expect, it } from "vitest";
import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowStep,
} from "../contracts";
import { validateDefinition, type ValidationRegistry } from "../engine/validate";

function def(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    id: "capture",
    name: "Capture",
    steps: [{ type: "append", target: { path: "Inbox.md" }, content: "- note" }],
    ...over,
  };
}

const codes = (issues: WorkflowIssue[]) => issues.map((i) => i.code);
const errors = (issues: WorkflowIssue[]) => issues.filter((i) => i.severity === "error");
const withSteps = (...steps: unknown[]) => def({ steps: steps as WorkflowStep[] });

describe("header fields", () => {
  it("accepts a minimal valid definition with no issues", () => {
    expect(validateDefinition(def())).toEqual([]);
  });

  it("refuses a schema version it does not understand", () => {
    const issues = validateDefinition(def({ version: 2 as unknown as 1 }));
    expect(codes(issues)).toContain("bad-version");
    expect(issues[0]!.field).toBe("version");
  });

  it.each([["Capture"], ["-capture"], ["cap ture"], ["capture!"], [""], ["a".repeat(65)]])(
    "refuses the id %j",
    (id) => {
      expect(codes(validateDefinition(def({ id })))).toContain("bad-id");
    },
  );

  it("requires a name", () => {
    expect(codes(validateDefinition(def({ name: "  " })))).toContain("missing-field");
  });

  it("checks the icon encoding", () => {
    expect(validateDefinition(def({ icon: "lucide:inbox" }))).toEqual([]);
    expect(validateDefinition(def({ icon: "emoji:📥" }))).toEqual([]);
    expect(codes(validateDefinition(def({ icon: "img:/etc/passwd" })))).toContain("bad-icon");
  });

  it("accepts a well-formed shortcut and refuses the rest", () => {
    expect(validateDefinition(def({ shortcut: "mod+shift+m" }))).toEqual([]);
    for (const shortcut of ["m", "Mod+M", "mod+mod+m", "hyper+m", "mod+", "mod+shift"]) {
      expect(codes(validateDefinition(def({ shortcut })))).toContain("bad-shortcut");
    }
  });

  it("warns when a shortcut collides with one the app owns", () => {
    const registry: ValidationRegistry = { reservedShortcuts: new Set(["mod+p"]) };
    const issues = validateDefinition(def({ shortcut: "mod+p" }), registry);
    expect(codes(issues)).toEqual(["shortcut-conflict"]);
    expect(issues[0]!.severity).toBe("warning");
  });

  it("reports an id claimed by another file", () => {
    const registry: ValidationRegistry = { duplicateIds: new Set(["capture"]) };
    expect(codes(validateDefinition(def(), registry))).toContain("duplicate-id");
  });
});

describe("variables", () => {
  const use = (name: string) =>
    [{ type: "append", target: { path: "Inbox.md" }, content: `- {{${name}}}` }] as WorkflowStep[];

  it("refuses a name outside the pattern", () => {
    const issues = validateDefinition(def({ variables: [{ name: "Topic" }], steps: use("Topic") }));
    expect(codes(issues)).toContain("bad-variable-name");
    expect(issues[0]!.field).toBe("variables.0.name");
  });

  it("refuses a name that shadows a built-in", () => {
    const issues = validateDefinition(def({ variables: [{ name: "date" }], steps: use("date") }));
    expect(codes(issues)).toContain("shadows-builtin");
  });

  it("refuses the same variable twice", () => {
    const issues = validateDefinition(
      def({ variables: [{ name: "topic" }, { name: "topic" }], steps: use("topic") }),
    );
    expect(codes(issues)).toContain("duplicate-variable");
    expect(issues.find((i) => i.code === "duplicate-variable")!.field).toBe("variables.1.name");
  });

  it("requires choices for a choice prompt", () => {
    const bad = def({ variables: [{ name: "kind", type: "choice" }], steps: use("kind") });
    expect(codes(validateDefinition(bad))).toContain("missing-choices");
    const good = def({
      variables: [{ name: "kind", type: "choice", choices: ["a", "b"] }],
      steps: use("kind"),
    });
    expect(validateDefinition(good)).toEqual([]);
  });

  it("refuses an unknown prompt type", () => {
    const issues = validateDefinition(
      def({ variables: [{ name: "k", type: "eval" as never }], steps: use("k") }),
    );
    expect(codes(issues)).toContain("unknown-type");
  });

  it("errors on a reference nobody declared, with the step and field", () => {
    const issues = validateDefinition(def({ steps: use("topic") }));
    const issue = issues.find((i) => i.code === "unknown-variable")!;
    expect(issue.step).toBe(0);
    expect(issue.field).toBe("steps.0.content");
  });

  it("warns about a declared variable nothing uses", () => {
    const issues = validateDefinition(def({ variables: [{ name: "topic" }] }));
    expect(codes(issues)).toEqual(["unused-variable"]);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.field).toBe("variables.0.name");
  });

  it("does not call a variable unused when a step renders a template file that may use it", () => {
    const issues = validateDefinition(
      def({
        variables: [{ name: "attendees" }],
        requires: { templates: ["Templates/Meeting.md"] },
        steps: [{ type: "create-note", path: "Meetings/{{date}}.md", template: "Templates/Meeting.md" }],
      }),
    );
    expect(codes(issues)).not.toContain("unused-variable");
  });

  describe("with the templates read", () => {
    const templated = (variables: Array<{ name: string }>) =>
      def({
        variables,
        requires: { templates: ["Templates/Meeting.md"] },
        steps: [{ type: "create-note", path: "Meetings/{{date}}.md", template: "Templates/Meeting.md" }],
      });
    const sources = (text: string): ValidationRegistry => ({
      templateSources: new Map([["Templates/Meeting.md", text]]),
    });

    it("counts a variable the template uses as used", () => {
      const issues = validateDefinition(
        templated([{ name: "attendees" }]),
        sources("# Meeting\n\nWith {{attendees}}.\n"),
      );
      expect(codes(issues)).not.toContain("unused-variable");
    });

    it("still warns about a variable neither the steps nor the template mention", () => {
      const issues = validateDefinition(
        templated([{ name: "attendees" }, { name: "nobody" }]),
        sources("# Meeting\n\nWith {{attendees}}.\n"),
      );
      expect(codes(issues)).toEqual(["unused-variable"]);
      expect(issues[0]!.message).toContain("nobody");
      expect(issues[0]!.field).toBe("variables.1.name");
    });

    it("stays quiet when one of the templates could not be read", () => {
      const issues = validateDefinition(
        def({
          variables: [{ name: "nobody" }],
          requires: { templates: ["Templates/Meeting.md", "Templates/Gone.md"] },
          steps: [
            { type: "create-note", path: "A/{{date}}.md", template: "Templates/Meeting.md" },
            { type: "create-note", path: "B/{{date}}.md", template: "Templates/Gone.md" },
          ],
        }),
        sources("# Meeting\n"),
      );
      expect(codes(issues)).not.toContain("unused-variable");
    });

    it("counts a variable a nested workflow declares as used", () => {
      const child = def({
        id: "child",
        name: "Child",
        variables: [{ name: "topic" }],
        steps: [{ type: "append", target: { path: "Inbox.md" }, content: "- {{topic}}" }],
      });
      const issues = validateDefinition(
        def({
          id: "macro",
          variables: [{ name: "topic" }, { name: "nobody" }],
          requires: { workflows: ["child"] },
          steps: [{ type: "run-workflow", id: "child" }],
        }),
        { byId: new Map([["child", child]]) },
      );
      expect(codes(issues)).toEqual(["unused-variable"]);
      expect(issues[0]!.message).toContain("nobody");
    });
  });

  it("errors on an unknown built-in in the colon form", () => {
    const issues = validateDefinition(withSteps({
      type: "append",
      target: { path: "Inbox.md" },
      content: "{{exec:ls}}",
    }));
    expect(codes(issues)).toContain("unknown-builtin");
  });

  it("warns about a date format with no recognised token", () => {
    const issues = validateDefinition(withSteps({
      type: "append",
      target: { path: "Inbox.md" },
      content: "{{date:yyyy-mm-dd}}",
    }));
    expect(codes(issues)).toEqual(["bad-date-format"]);
    expect(issues[0]!.severity).toBe("warning");
    expect(errors(issues)).toEqual([]);
  });

  it("accepts every supported date token without complaint", () => {
    const issues = validateDefinition(withSteps({
      type: "append",
      target: { path: "Inbox.md" },
      content: "{{date:ddd DD MMM YYYY}} {{time:HH:mm:ss}} {{date:YY/MM}}",
    }));
    expect(issues).toEqual([]);
  });
});

describe("steps", () => {
  it("requires at least one step", () => {
    expect(codes(validateDefinition(def({ steps: [] })))).toContain("missing-field");
  });

  it("refuses an unknown step type with the step index", () => {
    const issues = validateDefinition(withSteps({ type: "run-shell", cmd: "rm -rf /" }));
    const issue = issues.find((i) => i.code === "unknown-step")!;
    expect(issue.step).toBe(0);
    expect(issue.field).toBe("steps.0.type");
  });

  it("reports missing required fields per step type", () => {
    expect(codes(validateDefinition(withSteps({ type: "create-note" })))).toContain("missing-field");
    expect(codes(validateDefinition(withSteps({ type: "append", target: "current" })))).toContain(
      "missing-field",
    );
    expect(codes(validateDefinition(withSteps({ type: "insert", target: "current" })))).toContain(
      "missing-field",
    );
    expect(codes(validateDefinition(withSteps({ type: "open-note" })))).toContain("missing-field");
    expect(codes(validateDefinition(withSteps({ type: "run-workflow" })))).toContain("bad-id");
  });

  it("refuses an insert that does not target the current note", () => {
    const issues = validateDefinition(withSteps({
      type: "insert",
      target: { path: "Other.md" },
      content: "x",
    }));
    const issue = issues.find((i) => i.code === "bad-target")!;
    expect(issue.field).toBe("steps.0.target");
  });

  it("requires a create-note destination to end in .md", () => {
    const issues = validateDefinition(withSteps({ type: "create-note", path: "Notes/Thing.txt" }));
    expect(codes(issues)).toContain("bad-path");
    expect(validateDefinition(withSteps({ type: "create-note", path: "Notes/{{date}}.md" }))).toEqual([]);
  });

  it("refuses create-note with both a template and literal content", () => {
    const issues = validateDefinition(withSteps({
      type: "create-note",
      path: "a.md",
      template: "Templates/T.md",
      content: "hi",
      // declared so the dependency warning is not what we are reading
    }));
    expect(codes(issues)).toContain("conflicting-fields");
  });

  it("requires a heading to be a real ATX heading line", () => {
    const bad = withSteps({ type: "append", target: "current", content: "x", heading: "Inbox" });
    expect(codes(validateDefinition(bad))).toContain("bad-heading");
    const good = withSteps({ type: "append", target: "current", content: "x", heading: "## Inbox" });
    expect(validateDefinition(good)).toEqual([]);
  });

  it.each([
    ["/etc/passwd.md"],
    ["../outside.md"],
    ["Notes/../../outside.md"],
    ["C:/Windows/notes.md"],
    [".context/config.md"],
    ["Notes\\Thing.md"],
  ])("refuses the unsafe path %j everywhere a path appears", (path) => {
    expect(codes(validateDefinition(withSteps({ type: "create-note", path })))).toContain("unsafe-path");
    expect(
      codes(validateDefinition(withSteps({ type: "append", target: { path }, content: "x" }))),
    ).toContain("unsafe-path");
    expect(codes(validateDefinition(withSteps({ type: "open-note", path })))).toContain("unsafe-path");
    expect(
      codes(
        validateDefinition(
          withSteps({ type: "create-note", path: "ok.md", template: path }),
        ),
      ),
    ).toContain("unsafe-path");
    expect(
      codes(validateDefinition(withSteps({ type: "append", target: "current", content: `{{link:${path}}}` }))),
    ).toContain("unsafe-path");
  });
});

describe("dependencies and cycles", () => {
  it("warns when a template is used but not declared, and stays quiet once it is", () => {
    const step = { type: "create-note", path: "a.md", template: "Templates/T.md" } as const;
    expect(codes(validateDefinition(withSteps(step)))).toEqual(["undeclared-dependency"]);
    expect(
      validateDefinition(def({ steps: [step] as WorkflowStep[], requires: { templates: ["Templates/T.md"] } })),
    ).toEqual([]);
  });

  it("warns when a called workflow is not declared", () => {
    const registry: ValidationRegistry = { byId: new Map([["other", def({ id: "other" })]]) };
    const issues = validateDefinition(withSteps({ type: "run-workflow", id: "other" }), registry);
    expect(codes(issues)).toEqual(["undeclared-dependency"]);
  });

  it("errors when a called workflow does not exist in the vault", () => {
    const registry: ValidationRegistry = { byId: new Map() };
    const issues = validateDefinition(
      def({ steps: [{ type: "run-workflow", id: "ghost" }], requires: { workflows: ["ghost"] } }),
      registry,
    );
    expect(codes(issues)).toEqual(["unknown-workflow"]);
  });

  it("refuses a workflow that calls itself", () => {
    const self = def({ steps: [{ type: "run-workflow", id: "capture" }], requires: { workflows: ["capture"] } });
    const issues = validateDefinition(self, { byId: new Map([["capture", self]]) });
    expect(codes(issues)).toEqual(["cycle"]);
    expect(issues[0]!.step).toBe(0);
  });

  it("refuses an indirect cycle a → b → c → a", () => {
    const a = def({ id: "a", steps: [{ type: "run-workflow", id: "b" }], requires: { workflows: ["b"] } });
    const b = def({ id: "b", steps: [{ type: "run-workflow", id: "c" }], requires: { workflows: ["c"] } });
    const c = def({ id: "c", steps: [{ type: "run-workflow", id: "a" }], requires: { workflows: ["a"] } });
    const byId = new Map([
      ["a", a],
      ["b", b],
      ["c", c],
    ]);
    expect(codes(validateDefinition(a, { byId }))).toEqual(["cycle"]);
    expect(codes(validateDefinition(b, { byId }))).toEqual(["cycle"]);
  });

  it("allows a diamond that is not a cycle", () => {
    const leaf = def({ id: "leaf" });
    const left = def({ id: "left", steps: [{ type: "run-workflow", id: "leaf" }], requires: { workflows: ["leaf"] } });
    const right = def({ id: "right", steps: [{ type: "run-workflow", id: "leaf" }], requires: { workflows: ["leaf"] } });
    const top = def({
      id: "top",
      steps: [
        { type: "run-workflow", id: "left" },
        { type: "run-workflow", id: "right" },
      ],
      requires: { workflows: ["left", "right"] },
    });
    const byId = new Map([
      ["leaf", leaf],
      ["left", left],
      ["right", right],
      ["top", top],
    ]);
    expect(validateDefinition(top, { byId })).toEqual([]);
  });
});
