/**
 * Running a workflow: the one place in the app that turns a definition into
 * writes.
 *
 * Three rules shape everything below.
 *
 * 1. RE-RESOLVE BEFORE WRITING. A step asks the host where its target is
 *    immediately before it writes there, and hands the revision it was given
 *    back to `replaceRange`. Anything that moved in between — a teammate's
 *    edit, an AI rewrite, a rename — comes back as `stale-target` instead of
 *    landing at a byte offset that now means something else. Note the ORDER:
 *    resolve, then read, then write. Reading first would let the text move
 *    under a revision that still looked current.
 *
 * 2. A FAILURE IS A REPORT, NOT AN EXCEPTION. Every outcome is an
 *    `ExecutionResult`: the effects that DID complete, which step stopped, and
 *    a recovery record. A capture the user typed is never dropped on the floor
 *    — if there is rendered content and it could not be written, it is
 *    preserved through the host and the path comes back in `recovery`.
 *
 * 3. NOTHING IS EVALUATED. Steps are data. The only computation is `{{…}}`
 *    expansion (see `variables.ts`), and a path that expands into something
 *    unsafe is re-checked here, after expansion, because validation could only
 *    see the literal parts.
 */

import {
  type AppendStep,
  type CreateNoteStep,
  type EditorContext,
  type ExecutionEffect,
  type ExecutionFailure,
  type ExecutionFailureKind,
  type ExecutionRecovery,
  type ExecutionResult,
  type InsertStep,
  type OpenNoteStep,
  type PromptValues,
  type ResolvedTarget,
  type RunWorkflowStep,
  type WorkflowDefinition,
  type WorkflowHost,
  type WorkflowId,
  type WorkflowIssue,
  type WorkflowStep,
} from "../contracts";
import { renderTemplate } from "./template";
import { expand, type VariableScope } from "./variables";
import { unsafePathReason } from "./validate";

/** How many workflows a `run-workflow` chain may be deep, including the first. */
export const MAX_WORKFLOW_DEPTH = 8;
/** How many ` 2`, ` 3`, … suffixes a `suffix` create will try before giving up. */
const MAX_SUFFIX = 100;

/** Failures where the identical call could succeed on a second try. */
const RETRYABLE = new Set<ExecutionFailureKind>(["stale-target", "offline", "error"]);

/** Internal failure carrier. Becomes an `ExecutionFailure` at the top level. */
interface Fail {
  kind: ExecutionFailureKind;
  message: string;
  step?: number;
  field?: string;
  /** Rendered text this step was about to write, if any. */
  pendingContent?: string;
}

interface RunContext {
  host: WorkflowHost;
  registry: ReadonlyMap<WorkflowId, WorkflowDefinition>;
  editor: EditorContext;
  effects: ExecutionEffect[];
  warnings: WorkflowIssue[];
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function fail(kind: ExecutionFailureKind, message: string, extra: Partial<Fail> = {}): Fail {
  return { kind, message, ...extra };
}

// ---------------------------------------------------------------------------
// Prompt values
// ---------------------------------------------------------------------------

interface ResolvedPrompts {
  values: Record<string, string>;
  declared: Set<string>;
}

/**
 * Turn what the prompt UI collected into the scope a run expands against.
 *
 * Strict in both directions: a required variable with nothing behind it stops
 * the run before a single byte is written, and a value for a variable the
 * definition does not declare stops it too. The second one matters more than it
 * looks — a stray key is how a caller silently loses an answer it thought it
 * was passing, and `{{name}}` would then expand from a default instead.
 */
function resolvePrompts(def: WorkflowDefinition, values: PromptValues): ResolvedPrompts | Fail {
  const variables = def.variables ?? [];
  const declared = new Set(variables.map((v) => v.name));
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) {
      return fail("validation", `"${key}" is not a variable of "${def.name}".`, { field: key });
    }
  }
  const resolved: Record<string, string> = {};
  for (const variable of variables) {
    const supplied = values[variable.name];
    if (supplied !== undefined && typeof supplied !== "string") {
      return fail("validation", `"${variable.name}" must be text.`, { field: variable.name });
    }
    const value = supplied ?? variable.default;
    const required = variable.required !== false;
    if (value === undefined || value === "") {
      if (required) {
        return fail("validation", `"${variable.label ?? variable.name}" is required.`, {
          field: variable.name,
        });
      }
      resolved[variable.name] = "";
      continue;
    }
    if (variable.type === "choice" && variable.choices && !variable.choices.includes(value)) {
      return fail("validation", `"${value}" is not one of the choices for "${variable.name}".`, {
        field: variable.name,
      });
    }
    resolved[variable.name] = value;
  }
  return { values: resolved, declared };
}

// ---------------------------------------------------------------------------
// Expansion helpers
// ---------------------------------------------------------------------------

type Rendered = { text: string } | { fail: Fail };

function isFail(r: Rendered): r is { fail: Fail } {
  return "fail" in r;
}

function render(
  template: string,
  scope: VariableScope,
  ctx: RunContext,
  field: string,
  step: number,
): Rendered {
  const result = expand(template, scope);
  const error = result.issues.find((i) => i.severity === "error");
  if (error) return { fail: fail("validation", error.message, { field, step }) };
  ctx.warnings.push(...result.issues.map((i) => ({ ...i, field, step })));
  return { text: result.text };
}

/** A path, expanded and then re-checked: validation only saw the literal parts. */
function renderPath(
  template: string,
  scope: VariableScope,
  ctx: RunContext,
  field: string,
  step: number,
): Rendered {
  const rendered = render(template, scope, ctx, field, step);
  if (isFail(rendered)) return rendered;
  const reason = unsafePathReason(rendered.text);
  if (reason) {
    return { fail: fail("validation", `"${rendered.text}" ${reason}.`, { field, step }) };
  }
  return rendered;
}

/** Read and render a template file. */
async function renderTemplateFile(
  path: string,
  scope: VariableScope,
  ctx: RunContext,
  field: string,
  step: number,
): Promise<Rendered> {
  const source = await ctx.host.readNote(path);
  if (source === null) {
    return { fail: fail("missing-target", `The template "${path}" is not in this vault.`, { field, step }) };
  }
  const result = renderTemplate(source, scope);
  const error = result.issues.find((i) => i.severity === "error");
  if (error) return { fail: fail("validation", error.message, { field, step }) };
  ctx.warnings.push(...result.issues.map((i) => ({ ...i, field, step })));
  return { text: result.text };
}

/** `edit` or a refusal. Checked before every write, never inferred from a read. */
function permissionFail(target: ResolvedTarget, step: number, pendingContent?: string): Fail | null {
  if (target.permission === "none") {
    const message = target.permissionReason ?? `You do not have access to "${target.path}".`;
    return fail("permission", message, { step, pendingContent });
  }
  if (target.permission === "view") {
    const message = target.permissionReason ?? `"${target.path}" is read-only.`;
    return fail("read-only", message, { step, pendingContent });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Where an append lands
// ---------------------------------------------------------------------------

interface LineSpan {
  text: string;
  from: number;
  to: number;
}

function lineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let from = 0;
  for (const raw of text.split("\n")) {
    spans.push({ text: raw, from, to: from + raw.length });
    from += raw.length + 1;
  }
  return spans;
}

/** Heading level, or 0 when the line is not an ATX heading. */
function headingLevel(line: string): number {
  const m = /^(#{1,6})\s+\S/.exec(line.trimEnd());
  return m ? m[1]!.length : 0;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** End of the last non-blank line in `[first, last]`, or null when all blank. */
function lastContentEnd(lines: LineSpan[], first: number, last: number): number | null {
  for (let i = last; i >= first; i--) {
    if (!isBlank(lines[i]!.text)) return lines[i]!.to;
  }
  return null;
}

/**
 * Where the frontmatter ends, so a prepend never lands above it.
 *
 * A block opened with `---` closes with `---` OR with `...`, YAML's document
 * end — the same pair `lib/tasks/parse.ts` accepts when it decides which lines
 * are body. Inserting above the opening fence is not a cosmetic slip: the
 * metadata stops being frontmatter the moment anything precedes it.
 *
 * `editor/frontmatter.ts findFrontmatter` is deliberately NOT reused: it is
 * pinned line-for-line to Rust's `split_frontmatter` (which recognises only
 * `---`) because the index, the search body and the Properties panel all have
 * to agree on the same region. Widening it there would move all three.
 */
function afterFrontmatter(lines: LineSpan[]): number {
  if (lines.length < 2 || lines[0]!.text.trimEnd() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    const text = lines[i]!.text.trimEnd();
    if (text === "---" || text === "...") return lines[i]!.to;
  }
  return 0;
}

export type AppendPlan =
  | { ok: true; at: number; insert: string }
  | { ok: false; reason: "missing-heading" };

/**
 * Where to put `content`, and what exactly to insert.
 *
 * A heading's SECTION runs from the heading line to the next heading of the
 * same level or higher — so `### Today` nested under `## Journal` stays part of
 * the Journal section, and appending to Journal lands after it. The insertion
 * point is the end of the last non-blank line of the section, never the start
 * of the next heading: the blank line an author left above their next heading
 * is theirs, and pushing text into it is how an append slowly eats a note's
 * shape.
 */
export function planAppend(
  text: string,
  heading: string | undefined,
  position: "start" | "end",
  content: string,
): AppendPlan {
  const lines = lineSpans(text);
  let at: number;

  if (heading === undefined) {
    if (position === "start") {
      at = afterFrontmatter(lines);
    } else {
      at = lastContentEnd(lines, 0, lines.length - 1) ?? 0;
    }
  } else {
    const wanted = heading.trim();
    const index = lines.findIndex((line) => line.text.trimEnd() === wanted);
    if (index === -1) return { ok: false, reason: "missing-heading" };
    const level = headingLevel(lines[index]!.text);
    let end = lines.length - 1;
    for (let i = index + 1; i < lines.length; i++) {
      const next = headingLevel(lines[i]!.text);
      if (next > 0 && next <= level) {
        end = i - 1;
        break;
      }
    }
    at =
      position === "start"
        ? lines[index]!.to
        : (lastContentEnd(lines, index + 1, end) ?? lines[index]!.to);
  }

  const before = text.slice(0, at);
  const after = text.slice(at);
  let insert = content.replace(/\n+$/, "");
  if (before.length > 0 && !before.endsWith("\n")) insert = `\n${insert}`;
  if (after.length === 0 || !after.startsWith("\n")) insert = `${insert}\n`;
  return { ok: true, at, insert };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** The first free `Name 2.md`, `Name 3.md`, … after `path` is taken. */
async function freeSuffixedPath(
  path: string,
  ctx: RunContext,
): Promise<{ path: string; target: ResolvedTarget } | null> {
  const dot = path.lastIndexOf(".");
  const stem = dot === -1 ? path : path.slice(0, dot);
  const ext = dot === -1 ? "" : path.slice(dot);
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const candidate = `${stem} ${n}${ext}`;
    const target = await ctx.host.resolveTarget(candidate);
    if (!target.exists) return { path: candidate, target };
  }
  return null;
}

async function runCreateNote(
  step: CreateNoteStep,
  index: number,
  scope: VariableScope,
  ctx: RunContext,
): Promise<Fail | null> {
  const base = `steps.${index}`;
  const path = renderPath(step.path, scope, ctx, `${base}.path`, index);
  if (isFail(path)) return path.fail;

  let content = "";
  if (step.template !== undefined) {
    const templatePath = renderPath(step.template, scope, ctx, `${base}.template`, index);
    if (isFail(templatePath)) return templatePath.fail;
    const rendered = await renderTemplateFile(templatePath.text, scope, ctx, `${base}.template`, index);
    if (isFail(rendered)) return rendered.fail;
    content = rendered.text;
  } else if (step.content !== undefined) {
    const rendered = render(step.content, scope, ctx, `${base}.content`, index);
    if (isFail(rendered)) return rendered.fail;
    content = rendered.text;
  }

  let destination = path.text;
  let target = await ctx.host.resolveTarget(destination);
  if (target.exists) {
    const onExists = step.onExists ?? "fail";
    if (onExists === "fail") {
      return fail("conflict", `"${destination}" already exists.`, {
        step: index,
        field: `${base}.path`,
        pendingContent: content,
      });
    }
    if (onExists === "open") {
      await ctx.host.openNote(target.path);
      ctx.effects.push({ kind: "opened", path: target.path });
      return null;
    }
    const free = await freeSuffixedPath(destination, ctx);
    if (!free) {
      return fail("conflict", `Could not find a free name near "${destination}".`, {
        step: index,
        field: `${base}.path`,
        pendingContent: content,
      });
    }
    destination = free.path;
    target = free.target;
  }

  const refused = permissionFail(target, index, content);
  if (refused) return refused;

  let created: ResolvedTarget;
  try {
    created = await ctx.host.createNote(destination, content);
  } catch (err) {
    return fail("error", `Could not create "${destination}": ${(err as Error).message}`, {
      step: index,
      field: `${base}.path`,
      pendingContent: content,
    });
  }
  ctx.effects.push({ kind: "created", path: created.path });
  if (step.open !== false) {
    await ctx.host.openNote(created.path);
    ctx.effects.push({ kind: "opened", path: created.path });
  }
  return null;
}

async function runAppend(
  step: AppendStep,
  index: number,
  scope: VariableScope,
  ctx: RunContext,
): Promise<Fail | null> {
  const base = `steps.${index}`;
  let path: string;
  if (step.target === "current") {
    const current = ctx.host.currentNotePath();
    if (!current) {
      return fail("missing-target", "This step writes to the open note, and nothing is open.", {
        step: index,
        field: `${base}.target`,
      });
    }
    path = current;
  } else {
    const rendered = renderPath(step.target.path, scope, ctx, `${base}.target.path`, index);
    if (isFail(rendered)) return rendered.fail;
    path = rendered.text;
  }

  const rendered = render(step.content, scope, ctx, `${base}.content`, index);
  if (isFail(rendered)) return rendered.fail;
  const content = rendered.text;

  // The heading is matched against the note's text, so it has to be expanded
  // first — `## {{section}}` searched for literally never matches anything.
  let heading: string | undefined;
  if (step.heading !== undefined) {
    const renderedHeading = render(step.heading, scope, ctx, `${base}.heading`, index);
    if (isFail(renderedHeading)) return renderedHeading.fail;
    heading = renderedHeading.text;
  }

  let target = await ctx.host.resolveTarget(path);
  if (!target.exists) {
    if (!step.createIfMissing) {
      return fail("missing-target", `"${path}" is not in this vault.`, {
        step: index,
        field: `${base}.target`,
        pendingContent: content,
      });
    }
    const refusedSeed = permissionFail(target, index, content);
    if (refusedSeed) return refusedSeed;
    let seed = "";
    if (step.createIfMissing.template !== undefined) {
      const templatePath = renderPath(
        step.createIfMissing.template,
        scope,
        ctx,
        `${base}.createIfMissing.template`,
        index,
      );
      if (isFail(templatePath)) return templatePath.fail;
      const body = await renderTemplateFile(
        templatePath.text,
        scope,
        ctx,
        `${base}.createIfMissing.template`,
        index,
      );
      if (isFail(body)) return body.fail;
      seed = body.text;
    } else if (step.createIfMissing.content !== undefined) {
      const body = render(step.createIfMissing.content, scope, ctx, `${base}.createIfMissing.content`, index);
      if (isFail(body)) return body.fail;
      seed = body.text;
    }
    try {
      await ctx.host.createNote(path, seed);
    } catch (err) {
      return fail("error", `Could not create "${path}": ${(err as Error).message}`, {
        step: index,
        field: `${base}.target`,
        pendingContent: content,
      });
    }
    ctx.effects.push({ kind: "created", path });
    // Resolve again: the write below must quote the revision of what is on
    // disk NOW, not of what we think we just wrote.
    target = await ctx.host.resolveTarget(path);
  }

  const refused = permissionFail(target, index, content);
  if (refused) return refused;

  const text = await ctx.host.readNote(target.path);
  if (text === null || target.revision === null) {
    return fail("missing-target", `"${target.path}" could not be read.`, {
      step: index,
      field: `${base}.target`,
      pendingContent: content,
    });
  }

  const plan = planAppend(text, heading, step.position ?? "end", content);
  if (!plan.ok) {
    return fail("missing-heading", `"${target.path}" has no heading "${heading}".`, {
      step: index,
      field: `${base}.heading`,
      pendingContent: content,
    });
  }

  const write = await ctx.host.replaceRange(target.path, target.revision, plan.at, plan.at, plan.insert);
  if (!write.ok) {
    return fail(write.kind, write.message, {
      step: index,
      field: `${base}.target`,
      pendingContent: content,
    });
  }
  ctx.effects.push({
    kind: "appended",
    path: target.path,
    ...(heading === undefined ? {} : { heading }),
    bytes: bytes(plan.insert),
  });
  return null;
}

async function runInsert(
  step: InsertStep,
  index: number,
  scope: VariableScope,
  ctx: RunContext,
): Promise<Fail | null> {
  const base = `steps.${index}`;
  const path = ctx.host.currentNotePath();
  if (!path) {
    return fail("missing-target", "This step inserts at the caret, and no note is open.", {
      step: index,
      field: `${base}.target`,
    });
  }
  const rendered = render(step.content, scope, ctx, `${base}.content`, index);
  if (isFail(rendered)) return rendered.fail;

  const target = await ctx.host.resolveTarget(path);
  const refused = permissionFail(target, index, rendered.text);
  if (refused) return refused;

  // `insertAtCaret` writes to whatever note is active WHEN IT RUNS, and the
  // resolve above is an await the user can click through. Without this the
  // permission verdict and the reported effect are about note A while the text
  // lands in note B.
  if (ctx.host.currentNotePath() !== target.path) {
    return fail(
      "stale-target",
      `"${target.path}" is no longer the note on screen, so nothing was inserted.`,
      { step: index, field: `${base}.target`, pendingContent: rendered.text },
    );
  }

  if (!(await ctx.host.insertAtCaret(rendered.text))) {
    return fail("missing-target", `"${path}" did not accept an insert at the caret.`, {
      step: index,
      field: `${base}.content`,
      pendingContent: rendered.text,
    });
  }
  ctx.effects.push({ kind: "inserted", path, bytes: bytes(rendered.text) });
  return null;
}

async function runOpenNote(
  step: OpenNoteStep,
  index: number,
  scope: VariableScope,
  ctx: RunContext,
): Promise<Fail | null> {
  const field = `steps.${index}.path`;
  const rendered = renderPath(step.path, scope, ctx, field, index);
  if (isFail(rendered)) return rendered.fail;
  const target = await ctx.host.resolveTarget(rendered.text);
  if (!target.exists) {
    return fail("missing-target", `"${rendered.text}" is not in this vault.`, { step: index, field });
  }
  if (target.permission === "none") {
    return fail("permission", `You do not have access to "${target.path}".`, { step: index, field });
  }
  await ctx.host.openNote(target.path);
  ctx.effects.push({ kind: "opened", path: target.path });
  return null;
}

async function runNested(
  step: RunWorkflowStep,
  index: number,
  values: Record<string, string>,
  ctx: RunContext,
  stack: readonly WorkflowId[],
): Promise<Fail | null> {
  const field = `steps.${index}.id`;
  if (stack.includes(step.id)) {
    return fail("validation", `Running "${step.id}" here would repeat a workflow already running.`, {
      step: index,
      field,
    });
  }
  if (stack.length >= MAX_WORKFLOW_DEPTH) {
    return fail(
      "validation",
      `Workflows may be nested ${MAX_WORKFLOW_DEPTH} deep; "${step.id}" would be one more.`,
      { step: index, field },
    );
  }
  const next = ctx.registry.get(step.id);
  if (!next) {
    return fail("validation", `No workflow in this vault has the id "${step.id}".`, { step: index, field });
  }
  // A nested workflow is prompted for by the OUTER run, so it inherits only the
  // answers it actually declares; anything else it needs must have a default.
  const declared = new Set((next.variables ?? []).map((v) => v.name));
  const inherited: PromptValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (declared.has(key)) inherited[key] = value;
  }
  const nested = await runSteps(next, inherited, ctx, stack);
  if (nested) {
    return {
      ...nested,
      // The UI points at the step of the workflow the USER ran; the inner index
      // is in the message so a nested failure is still locatable.
      step: index,
      field,
      message: `${next.name}: ${nested.message}`,
    };
  }
  ctx.effects.push({ kind: "ran-workflow", id: step.id });
  return null;
}

async function runStep(
  step: WorkflowStep,
  index: number,
  scope: VariableScope,
  values: Record<string, string>,
  ctx: RunContext,
  stack: readonly WorkflowId[],
): Promise<Fail | null> {
  switch (step.type) {
    case "create-note":
      return runCreateNote(step, index, scope, ctx);
    case "append":
      return runAppend(step, index, scope, ctx);
    case "insert":
      return runInsert(step, index, scope, ctx);
    case "open-note":
      return runOpenNote(step, index, scope, ctx);
    case "run-workflow":
      return runNested(step, index, values, ctx, stack);
    default:
      return fail("validation", `Unknown step type "${(step as { type: string }).type}".`, {
        step: index,
        field: `steps.${index}.type`,
      });
  }
}

/** Run one definition's steps into the shared effect list. */
async function runSteps(
  def: WorkflowDefinition,
  values: PromptValues,
  ctx: RunContext,
  stack: readonly WorkflowId[],
): Promise<Fail | null> {
  const prompts = resolvePrompts(def, values);
  if ("kind" in prompts) return prompts;

  const scope: VariableScope = {
    values: prompts.values,
    declared: prompts.declared,
    now: ctx.host.now(),
    currentPath: ctx.editor.currentPath ?? ctx.host.currentNotePath(),
    ...(ctx.editor.selection === undefined ? {} : { selection: ctx.editor.selection }),
    ...(ctx.editor.clipboard === undefined ? {} : { clipboard: ctx.editor.clipboard }),
  };

  const steps = def.steps ?? [];
  const nextStack = [...stack, def.id];
  for (let i = 0; i < steps.length; i++) {
    const failure = await runStep(steps[i]!, i, scope, prompts.values, ctx, nextStack);
    if (failure) return { ...failure, step: failure.step ?? i };
  }
  return null;
}

/**
 * Run a workflow. Never throws: an unexpected error from the host comes back as
 * an `ExecutionFailure` with `kind: "error"`, because a half-run workflow the
 * caller cannot see is worse than any message.
 */
export async function runWorkflow(
  def: WorkflowDefinition,
  values: PromptValues,
  editor: EditorContext,
  host: WorkflowHost,
  registry: ReadonlyMap<WorkflowId, WorkflowDefinition> = new Map(),
): Promise<ExecutionResult> {
  const ctx: RunContext = { host, registry, editor, effects: [], warnings: [] };
  let failure: Fail | null;
  try {
    failure = await runSteps(def, values, ctx, []);
  } catch (err) {
    failure = fail("error", (err as Error).message ?? String(err));
  }
  if (!failure) {
    return { ok: true, workflowId: def.id, effects: ctx.effects, warnings: ctx.warnings };
  }

  const recovery: ExecutionRecovery = { retryable: RETRYABLE.has(failure.kind) };
  if (failure.pendingContent) {
    recovery.pendingContent = failure.pendingContent;
    // The content exists only in this run; if it cannot be written it has to
    // land somewhere a person can find it.
    const preservedAt = await host
      .preserveCapture(def.id, failure.pendingContent)
      .catch(() => null);
    if (preservedAt) recovery.preservedAt = preservedAt;
  }
  const result: ExecutionFailure = {
    ok: false,
    workflowId: def.id,
    kind: failure.kind,
    message: failure.message,
    completed: ctx.effects,
    recovery,
  };
  if (failure.step !== undefined) result.step = failure.step;
  if (failure.field !== undefined) result.field = failure.field;
  return result;
}
