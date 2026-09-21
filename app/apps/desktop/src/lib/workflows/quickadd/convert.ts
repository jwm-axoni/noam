// QuickAdd → Noam workflows: a bounded, declarative subset.
//
// THIS IS NOT QUICKADD COMPATIBILITY, and it never will be. QuickAdd's Macro
// choices run user JavaScript (`UserScript`), fire arbitrary Obsidian and
// editor commands, and its templates can embed Templater expressions — all of
// which are code. Noam does not execute code from a vault file, so this
// converter reads `data.json` as DATA, maps the declarative choices that have
// an exact equivalent, and itemizes everything else with a reason and a short
// excerpt so the user knows precisely what they have to rebuild.
//
// Nothing in this file calls `eval`, `new Function`, or any template engine.
//
// What maps:
//   Template choice → create-note (folder + file-name format + template)
//   Capture choice  → append (+ open-note when it opened the file)
//   Multi choice    → its children, converted individually
//   Macro choice    → run-workflow sequence, but ONLY when every command is a
//                     Template/Capture/NestedChoice; one UserScript, Obsidian
//                     command, EditorCommand or Wait refuses the whole macro.
//   Format tokens   → {{date}} {{time}} {{value}} {{title}} {{selection}}
//                     {{clipboard}} and named {{VALUE:label}} prompts.
//
// What does not: {{MACRO}}, {{TEMPLATE}}, {{TEMPLATER}}, {{FIELD}}, {{MATH}},
// {{VDATE}}, `<% … %>`, date formats outside `DATE_FORMAT_TOKENS`, interactive
// folder pickers, and every fileExistsMode that overwrites or appends.

import {
  BUILTIN_VARIABLES,
  DATE_FORMAT_TOKENS,
  DEFAULT_WORKFLOWS_FOLDER,
  WORKFLOW_SCHEMA_VERSION,
  type AppendStep,
  type CreateNoteStep,
  type OnExists,
  type QuickAddConversion,
  type QuickAddReportItem,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowVariable,
} from "../contracts";
import { serializeWorkflowNote } from "../packages/noteFormat";

const EXCERPT_MAX = 200;

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const bool = (v: unknown): boolean => v === true;

/** A short, safe look at the source item. Never a script body — only settings. */
function excerpt(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length <= EXCERPT_MAX ? text : `${text.slice(0, EXCERPT_MAX - 1)}…`;
}

// ---------------------------------------------------------------------------
// Names, ids and variables
// ---------------------------------------------------------------------------

function slugId(name: string): string {
  const base = name
    .toLowerCase()
    // An apostrophe is not a word break: "today's" should not become "today-s".
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return /^[a-z0-9]/.test(base) ? base : `w-${base}`.slice(0, 64) || "workflow";
}

function variableName(label: string): string {
  let base = label
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  if (!/^[a-z]/.test(base)) base = `v_${base}`.slice(0, 32);
  if ((BUILTIN_VARIABLES as readonly string[]).includes(base)) base = `v_${base}`;
  return base;
}

/** A file name that is safe on every platform the app runs on. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "Workflow";
}

// ---------------------------------------------------------------------------
// Format strings
// ---------------------------------------------------------------------------

function dateFormatError(format: string): string | null {
  for (const run of format.match(/[A-Za-z]+/g) ?? []) {
    for (const token of run.match(/(.)\1*/g) ?? []) {
      if (!(DATE_FORMAT_TOKENS as readonly string[]).includes(token)) {
        return `date format "${format}" uses "${token}", which Noam's bounded formats do not have`;
      }
    }
  }
  return null;
}

interface Vars {
  order: string[];
  byName: Map<string, WorkflowVariable>;
}

function addVariable(vars: Vars, label: string): string {
  const name = variableName(label);
  if (!vars.byName.has(name)) {
    vars.byName.set(name, { name, label, type: "text", required: true });
    vars.order.push(name);
  }
  return name;
}

/**
 * Translate one QuickAdd format string into Noam's variable syntax, or explain
 * why it cannot be. Unknown tokens are refusals, never pass-through: a
 * `{{MACRO:x}}` left in the text would silently become literal output.
 */
function mapFormat(source: string, vars: Vars): { text: string } | { error: string } {
  if (source.includes("<%")) {
    return { error: "this uses a Templater expression (`<% … %>`), which Noam never executes" };
  }
  let error: string | null = null;
  const text = source.replace(/\{\{([^{}]*)\}\}/g, (whole, body: string) => {
    if (error) return whole;
    const colon = body.indexOf(":");
    const name = (colon < 0 ? body : body.slice(0, colon)).trim().toUpperCase();
    const arg = colon < 0 ? "" : body.slice(colon + 1).trim();

    switch (name) {
      case "DATE":
      case "TIME": {
        const builtin = name === "DATE" ? "date" : "time";
        if (!arg) return `{{${builtin}}}`;
        const bad = dateFormatError(arg);
        if (bad) {
          error = bad;
          return whole;
        }
        return `{{${builtin}:${arg}}}`;
      }
      case "VALUE":
      case "NAME":
        return `{{${addVariable(vars, arg || "Value")}}}`;
      case "TITLE":
        return "{{title}}";
      case "CLIPBOARD":
        return "{{clipboard}}";
      case "SELECTED":
        return "{{selection}}";
      default:
        error = `{{${name}}} has no Noam equivalent`;
        return whole;
    }
  });
  return error ? { error } : { text };
}

// ---------------------------------------------------------------------------
// Conversion context
// ---------------------------------------------------------------------------

interface Ctx {
  folder: string;
  ids: Set<string>;
  paths: Set<string>;
  workflows: QuickAddConversion["workflows"];
  report: QuickAddReportItem[];
}

function uniqueId(ctx: Ctx, base: string): string {
  let id = base;
  let n = 1;
  while (ctx.ids.has(id)) {
    n += 1;
    id = `${base}-${n}`.slice(0, 64);
  }
  ctx.ids.add(id);
  return id;
}

function uniquePath(ctx: Ctx, name: string): string {
  const stem = safeFileName(name);
  let path = `${ctx.folder}/${stem}.md`;
  let n = 1;
  while (ctx.paths.has(path.toLowerCase())) {
    n += 1;
    path = `${ctx.folder}/${stem} ${n}.md`;
  }
  ctx.paths.add(path.toLowerCase());
  return path;
}

interface Built {
  steps: WorkflowStep[];
  vars: Vars;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Choice converters
// ---------------------------------------------------------------------------

const FILE_EXISTS: Record<string, OnExists> = {
  "Increment the file name": "suffix",
  Nothing: "open",
};

function convertTemplate(choice: Json): Built | { error: string } {
  const vars: Vars = { order: [], byName: new Map() };
  const notes: string[] = [];

  const template = str(choice.templatePath);
  if (!template) return { error: "this template choice has no template file" };

  const folderSetting = isRecord(choice.folder) ? choice.folder : {};
  const folders = Array.isArray(folderSetting.folders) ? folderSetting.folders.map(str) : [];
  if (bool(folderSetting.enabled)) {
    if (bool(folderSetting.chooseWhenCreatingNote) || bool(folderSetting.chooseFromSubfolders)) {
      return { error: "it asks the user to pick a folder at run time, which Noam has no step for" };
    }
    if (bool(folderSetting.createInSameFolderAsActiveFile)) {
      return { error: "it creates the note beside the active file, which Noam has no step for" };
    }
    if (folders.length > 1) {
      return { error: `it offers ${folders.length} folders to choose from at run time` };
    }
  }
  const folder = bool(folderSetting.enabled) ? (folders[0] ?? "").replace(/^\/+|\/+$/g, "") : "";

  const nameSetting = isRecord(choice.fileNameFormat) ? choice.fileNameFormat : {};
  const rawName =
    bool(nameSetting.enabled) && str(nameSetting.format) ? str(nameSetting.format) : "{{VALUE}}";
  const mappedName = mapFormat(rawName, vars);
  if ("error" in mappedName) return mappedName;
  const fileName = mappedName.text.toLowerCase().endsWith(".md")
    ? mappedName.text
    : `${mappedName.text}.md`;

  let onExists: OnExists | undefined;
  if (bool(choice.setFileExistsBehavior) && str(choice.fileExistsMode)) {
    const mode = str(choice.fileExistsMode);
    const mapped = FILE_EXISTS[mode];
    if (!mapped) {
      return { error: `the "${mode}" behaviour for an existing file has no Noam equivalent` };
    }
    onExists = mapped;
    if (mapped === "open") {
      notes.push(`"${mode}" became "open the existing note"`);
    }
  }
  if (bool(choice.appendLink)) notes.push("the 'append link' option was dropped");

  const step: CreateNoteStep = {
    type: "create-note",
    path: folder ? `${folder}/${fileName}` : fileName,
    template,
    ...(onExists ? { onExists } : {}),
    open: choice.openFile === undefined ? true : bool(choice.openFile),
  };
  return { steps: [step], vars, notes };
}

function convertCapture(choice: Json): Built | { error: string } {
  const vars: Vars = { order: [], byName: new Map() };
  const notes: string[] = [];

  const rawFormat = isRecord(choice.format) ? choice.format : {};
  const source = bool(rawFormat.enabled) && str(rawFormat.format) ? str(rawFormat.format) : "{{VALUE}}";
  const mapped = mapFormat(source, vars);
  if ("error" in mapped) return mapped;
  let content = mapped.text;
  if (bool(choice.task) && !/^\s*- \[[ x]\]/.test(content)) content = `- [ ] ${content}`;

  let target: AppendStep["target"];
  let path = "";
  if (bool(choice.captureToActiveFile)) {
    target = "current";
  } else {
    const rawTarget = str(choice.captureTo);
    if (!rawTarget) return { error: "this capture names no file to capture to" };
    const mappedTarget = mapFormat(rawTarget, vars);
    if ("error" in mappedTarget) return mappedTarget;
    path = mappedTarget.text.toLowerCase().endsWith(".md")
      ? mappedTarget.text
      : `${mappedTarget.text}.md`;
    target = { path };
  }

  const step: AppendStep = { type: "append", target, content };

  const insertAfter = isRecord(choice.insertAfter) ? choice.insertAfter : {};
  if (bool(insertAfter.enabled) && str(insertAfter.after)) {
    const heading = mapFormat(str(insertAfter.after), vars);
    if ("error" in heading) return heading;
    step.heading = heading.text;
    if (bool(insertAfter.createIfNotFound)) {
      notes.push("a missing heading is reported instead of being created");
    }
    if (bool(insertAfter.insertAtEnd)) {
      notes.push("'insert at end of section' became an ordinary append under the heading");
    }
  }
  if (bool(choice.prepend)) step.position = "start";

  const createIfMissing = isRecord(choice.createFileIfItDoesntExist)
    ? choice.createFileIfItDoesntExist
    : {};
  if (bool(createIfMissing.enabled) && target !== "current") {
    step.createIfMissing =
      bool(createIfMissing.createWithTemplate) && str(createIfMissing.template)
        ? { template: str(createIfMissing.template) }
        : { content: "" };
  }
  if (bool(choice.appendLink)) notes.push("the 'append link' option was dropped");

  const steps: WorkflowStep[] = [step];
  if (bool(choice.openFile) && path) steps.push({ type: "open-note", path });
  return { steps, vars, notes };
}

/** Commands a macro may contain and still be convertible. */
const NESTED_COMMAND_TYPES = new Set(["NestedChoice", "Template", "Capture", "Choice"]);

function convertMacro(choice: Json, ctx: Ctx, macros: Json[]): Built | { error: string } {
  const inline = isRecord(choice.macro) ? choice.macro : null;
  const macro = inline ?? macros.find((m) => str(m.id) === str(choice.macroId)) ?? null;
  const commands = macro && Array.isArray(macro.commands) ? macro.commands : null;
  if (!commands) return { error: "this macro has no commands Noam can read" };

  const refused = commands
    .filter((c): c is Json => isRecord(c))
    .filter((c) => !NESTED_COMMAND_TYPES.has(str(c.type)))
    .map((c) => `${str(c.type) || "unknown"} "${str(c.name) || "unnamed"}"`);
  if (refused.length > 0) {
    return {
      error: `this macro runs ${refused.join(", ")}; Noam never executes scripts, Obsidian commands or waits`,
    };
  }

  const steps: WorkflowStep[] = [];
  // A macro is a sequence of `run-workflow` steps, and the executor hands a
  // nested run only the values the OUTER workflow declares. So the macro has to
  // declare what its children prompt for, or every run of it would stop at the
  // child's "… is required". Deduplicated by name: two steps asking for the
  // same thing ask once, and the first child's label wins.
  const vars: Vars = { order: [], byName: new Map() };
  for (const command of commands) {
    if (!isRecord(command)) return { error: "this macro has a command Noam cannot read" };
    const nested = isRecord(command.choice) ? command.choice : command;
    const id = convertChoice(nested, ctx, macros);
    if (!id) return { error: `the macro step "${str(command.name) || "unnamed"}" could not be converted` };
    steps.push({ type: "run-workflow", id });
    const child = ctx.workflows.find((w) => w.definition.id === id);
    for (const variable of child?.definition.variables ?? []) {
      if (!vars.byName.has(variable.name)) {
        vars.byName.set(variable.name, { ...variable });
        vars.order.push(variable.name);
      }
    }
  }
  if (steps.length === 0) return { error: "this macro does nothing Noam can reproduce" };
  return { steps, vars, notes: [] };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Convert one choice; returns the workflow id when something was produced. */
function convertChoice(choice: unknown, ctx: Ctx, macros: Json[]): string | null {
  if (!isRecord(choice)) {
    ctx.report.push({
      sourceName: "(unnamed)",
      sourceType: "unknown",
      status: "unsupported",
      reason: "this entry is not a QuickAdd choice",
      sourceExcerpt: excerpt(choice),
    });
    return null;
  }

  const name = str(choice.name) || "Untitled";
  const type = str(choice.type) || "unknown";

  if (type === "Multi") {
    const children = Array.isArray(choice.choices) ? choice.choices : [];
    ctx.report.push({
      sourceName: name,
      sourceType: type,
      status: "skipped",
      reason: `a group of ${children.length} choices; each one was converted on its own`,
    });
    for (const child of children) convertChoice(child, ctx, macros);
    return null;
  }

  let built: Built | { error: string };
  if (type === "Template") built = convertTemplate(choice);
  else if (type === "Capture") built = convertCapture(choice);
  else if (type === "Macro") built = convertMacro(choice, ctx, macros);
  else built = { error: `choice type "${type}" is not supported` };

  if ("error" in built) {
    ctx.report.push({
      sourceName: name,
      sourceType: type,
      status: "unsupported",
      reason: built.error,
      sourceExcerpt: excerpt(choice),
    });
    return null;
  }

  const id = uniqueId(ctx, slugId(name));
  const path = uniquePath(ctx, name);
  const variables = built.vars.order.map((v) => built.vars.byName.get(v)!);
  const definition: WorkflowDefinition = {
    version: WORKFLOW_SCHEMA_VERSION,
    id,
    name,
    description: `Imported from QuickAdd (${type}).`,
    ...(variables.length > 0 ? { variables } : {}),
    steps: built.steps,
  };

  ctx.workflows.push({ path, definition, markdown: serializeWorkflowNote(definition) });
  ctx.report.push({
    sourceName: name,
    sourceType: type,
    status: "converted",
    workflowId: id,
    ...(built.notes.length > 0 ? { reason: `converted with changes: ${built.notes.join("; ")}` } : {}),
  });
  return id;
}

export interface QuickAddConvertOptions {
  /** Where the workflow notes should be written. Default `Workflows`. */
  folder?: string;
}

/** Convert a QuickAdd `data.json` into workflow notes plus a full report. */
export function convertQuickAdd(
  json: unknown,
  options: QuickAddConvertOptions = {},
): QuickAddConversion {
  const ctx: Ctx = {
    folder: (options.folder ?? DEFAULT_WORKFLOWS_FOLDER).replace(/^\/+|\/+$/g, ""),
    ids: new Set(),
    paths: new Set(),
    workflows: [],
    report: [],
  };

  if (!isRecord(json)) {
    ctx.report.push({
      sourceName: "data.json",
      sourceType: "file",
      status: "unsupported",
      reason: "this is not a QuickAdd settings file (expected a JSON object)",
      sourceExcerpt: excerpt(json),
    });
    return { workflows: [], report: ctx.report };
  }
  if (!Array.isArray(json.choices)) {
    ctx.report.push({
      sourceName: "data.json",
      sourceType: "file",
      status: "unsupported",
      reason: "this QuickAdd file has no `choices` list",
      sourceExcerpt: excerpt(json),
    });
    return { workflows: [], report: ctx.report };
  }

  const macros = Array.isArray(json.macros) ? json.macros.filter(isRecord) : [];
  for (const choice of json.choices) convertChoice(choice, ctx, macros);

  return { workflows: ctx.workflows, report: ctx.report };
}
