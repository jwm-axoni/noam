// QuickAdd import: a BOUNDED, declarative subset. Never a compatibility claim.
//
// The rule that shapes every test here: nothing from the source is ever
// executed. QuickAdd macros run user JavaScript and Templater expressions;
// this converter reads `data.json` as data, maps the declarative choices it
// understands, and itemizes everything else with a reason and a short excerpt
// so the user can rebuild it by hand knowing exactly what was dropped.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AppendStep, CreateNoteStep, QuickAddConversion } from "../contracts";
import { parseWorkflowNote } from "../packages/noteFormat";
import { convertQuickAdd } from "../quickadd/convert";

const data = JSON.parse(
  readFileSync(new URL("./fixtures/quickadd/data.json", import.meta.url), "utf8"),
) as unknown;

const convert = () => convertQuickAdd(data);
const workflow = (result: QuickAddConversion, id: string) =>
  result.workflows.find((w) => w.definition.id === id)!;
const item = (result: QuickAddConversion, name: string) =>
  result.report.find((r) => r.sourceName === name)!;

describe("converting a QuickAdd data.json", () => {
  it("maps a Template choice onto create-note", () => {
    const result = convert();
    const daily = workflow(result, "daily-journal");

    expect(daily.path).toBe("Workflows/Daily journal.md");
    expect(daily.definition.steps).toEqual([
      {
        type: "create-note",
        path: "Journal/{{date:YYYY-MM-DD}} {{value}}.md",
        template: "Templates/Journal.md",
        onExists: "suffix",
        open: true,
      } satisfies CreateNoteStep,
    ]);
    expect(daily.definition.variables).toEqual([
      { name: "value", label: "Value", type: "text", required: true },
    ]);
    expect(item(result, "Daily journal")).toMatchObject({
      status: "converted",
      sourceType: "Template",
      workflowId: "daily-journal",
    });
  });

  it("maps a Capture choice onto append, with the heading and the target path", () => {
    const step = workflow(convert(), "add-task-to-inbox").definition.steps[0] as AppendStep;

    expect(step).toEqual({
      type: "append",
      target: { path: "Inbox.md" },
      content: "- [ ] {{value}} (added {{date:YYYY-MM-DD HH:mm}})",
      heading: "## Tasks",
      createIfMissing: { content: "" },
    } satisfies AppendStep);
  });

  it("maps capture-to-active-file and prepend onto target current / position start", () => {
    const step = workflow(convert(), "log-to-todays-note").definition.steps[0] as AppendStep;

    expect(step.target).toBe("current");
    expect(step.position).toBe("start");
    expect(step.content).toBe("{{time}} {{selection}}");
  });

  it("recurses into a Multi choice and names the group as skipped", () => {
    const result = convert();
    const step = workflow(result, "new-project").definition.steps[0] as CreateNoteStep;

    expect(step.path).toBe("Projects/{{project_name}}.md");
    expect(workflow(result, "new-project").definition.variables).toEqual([
      { name: "project_name", label: "Project name", type: "text", required: true },
    ]);
    expect(item(result, "Project intake")).toMatchObject({ sourceType: "Multi", status: "skipped" });
  });

  it("refuses a Templater expression instead of guessing at it", () => {
    const reported = item(convert(), "Templater project");

    expect(reported.status).toBe("unsupported");
    expect(reported.reason).toMatch(/Templater/i);
    expect(reported.sourceExcerpt!.length).toBeLessThanOrEqual(200);
    expect(convert().workflows.some((w) => w.definition.id === "templater-project")).toBe(false);
  });

  it("converts a macro of nested Template/Capture choices into a run-workflow sequence", () => {
    const result = convert();
    const macro = workflow(result, "capture-and-open");

    expect(macro.definition.steps).toEqual([
      { type: "run-workflow", id: "meeting-note" },
      { type: "run-workflow", id: "log-the-meeting" },
    ]);
    expect(workflow(result, "meeting-note").definition.steps[0].type).toBe("create-note");
    expect(workflow(result, "log-the-meeting").definition.steps[0].type).toBe("append");
    expect(item(result, "Capture and open").status).toBe("converted");
  });

  it("hoists a nested workflow's variables into the macro, so the prompt collects them", () => {
    const result = convert();
    const macro = workflow(result, "capture-and-open");

    // The executor passes a nested run only what the OUTER workflow declares,
    // so a macro whose children prompt has to prompt for the same things.
    expect(macro.definition.variables).toEqual([
      { name: "attendee", label: "Attendee", type: "text", required: true },
      { name: "value", label: "Value", type: "text", required: true },
    ]);
    expect(workflow(result, "meeting-note").definition.variables).toEqual([
      { name: "attendee", label: "Attendee", type: "text", required: true },
    ]);
  });

  it("declares a variable two macro steps share exactly once", () => {
    const capture = (name: string, to: string) => ({
      name,
      type: "Capture",
      captureTo: to,
      format: { enabled: true, format: "- {{VALUE:Task}}" },
    });
    const result = convertQuickAdd({
      choices: [
        {
          name: "Both",
          type: "Macro",
          macro: {
            id: "m",
            commands: [
              { name: "a", type: "NestedChoice", choice: capture("A", "A.md") },
              { name: "b", type: "NestedChoice", choice: capture("B", "B.md") },
            ],
          },
        },
      ],
    });

    expect(result.workflows.find((w) => w.definition.id === "both")!.definition.variables).toEqual([
      { name: "task", label: "Task", type: "text", required: true },
    ]);
  });

  it("refuses a whole macro that runs a script, an Obsidian command or a wait", () => {
    const reported = item(convert(), "Run my script");

    expect(reported.status).toBe("unsupported");
    expect(reported.reason).toMatch(/UserScript/);
    expect(reported.reason).toMatch(/Obsidian/);
    expect(reported.reason).toMatch(/Wait/);
    expect(reported.reason).toMatch(/fetchWeather\.js/);
    expect(reported.sourceExcerpt!.length).toBeLessThanOrEqual(200);
    expect(convert().workflows.some((w) => w.definition.id === "run-my-script")).toBe(false);
  });

  it("refuses QuickAdd tokens with no bounded equivalent", () => {
    const reported = item(convert(), "Fancy fields");

    expect(reported.status).toBe("unsupported");
    expect(reported.reason).toMatch(/\{\{FIELD/i);
  });

  it("reports every choice it saw exactly once", () => {
    const result = convert();
    const names = result.report.map((r) => r.sourceName);

    expect(names).toEqual([
      "Daily journal",
      "Add task to inbox",
      "Log to today's note",
      "Project intake",
      "New project",
      "Templater project",
      "Meeting note",
      "Log the meeting",
      "Capture and open",
      "Run my script",
      "Fancy fields",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("writes workflow notes this app can read back", () => {
    for (const { markdown, definition, path } of convert().workflows) {
      expect(markdown).toContain("noam_kind: workflow");
      expect(markdown).toContain("```json noam-workflow");
      expect(parseWorkflowNote(markdown)?.id).toBe(definition.id);
      expect(path.startsWith("Workflows/")).toBe(true);
      expect(path.endsWith(".md")).toBe(true);
    }
  });

  it("gives colliding names distinct ids and paths", () => {
    const result = convertQuickAdd({
      choices: [
        { name: "Note", type: "Capture", captureTo: "A.md", format: { enabled: true, format: "a" } },
        { name: "Note", type: "Capture", captureTo: "B.md", format: { enabled: true, format: "b" } },
        { name: "Note", type: "Capture", captureTo: "C.md", format: { enabled: true, format: "c" } },
      ],
    });

    expect(result.workflows.map((w) => w.definition.id)).toEqual(["note", "note-2", "note-3"]);
    expect(result.workflows.map((w) => w.path)).toEqual([
      "Workflows/Note.md",
      "Workflows/Note 2.md",
      "Workflows/Note 3.md",
    ]);
  });

  it("reports a file that is not QuickAdd settings at all", () => {
    expect(convertQuickAdd("nope").workflows).toEqual([]);
    expect(convertQuickAdd("nope").report[0]).toMatchObject({ status: "unsupported" });
    expect(convertQuickAdd({ choices: {} }).report[0].reason).toMatch(/choices/i);
  });

  it("never evaluates anything from the source", () => {
    const realFunction = globalThis.Function;
    const realEval = globalThis.eval;
    let calls = 0;
    const count = () => {
      calls += 1;
    };
    // A Proxy rather than a spy: this has to catch `new Function(body)` too,
    // which is how a "just run the macro" implementation would do it.
    globalThis.Function = new Proxy(realFunction, {
      apply: (t, thisArg, args) => (count(), Reflect.apply(t as never, thisArg, args)),
      construct: (t, args) => (count(), Reflect.construct(t as never, args)),
    });
    globalThis.eval = ((code: string) => {
      count();
      return realEval(code);
    }) as typeof globalThis.eval;

    try {
      const result = convert();
      expect(result.workflows.length).toBeGreaterThan(0);
    } finally {
      globalThis.Function = realFunction;
      globalThis.eval = realEval;
    }
    expect(calls).toBe(0);
  });
});
