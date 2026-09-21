/**
 * Schema checks for a parsed workflow definition.
 *
 * The definition arrives as untrusted JSON — possibly from a package someone
 * downloaded — so every field is re-checked here rather than trusted because
 * TypeScript says so. Two classes of result:
 *   - `error` makes the workflow non-runnable. Anything that could write to the
 *     wrong place (an absolute path, a `..`, a `.md`-less destination) is an
 *     error, never a warning.
 *   - `warning` is advice the author can ignore: an unused variable, a
 *     dependency that works today but is not declared, a date format with no
 *     recognised token in it.
 *
 * Every issue carries the zero-based `step` and the dotted `field` it belongs
 * to, because the Workflows view highlights exactly that line.
 */

import {
  BUILTIN_VARIABLES,
  DATE_FORMAT_TOKENS,
  VARIABLE_NAME_PATTERN,
  WORKFLOW_ID_PATTERN,
  WORKFLOW_SCHEMA_VERSION,
  type PromptType,
  type WorkflowDefinition,
  type WorkflowId,
  type WorkflowIssue,
} from "../contracts";
import { scanVariableRefs } from "./variables";

/** What the vault knows that a single file cannot. All parts optional. */
export interface ValidationRegistry {
  /** Every workflow in the vault, by id — for `run-workflow` and cycles. */
  byId?: ReadonlyMap<WorkflowId, WorkflowDefinition>;
  /** Ids claimed by more than one file. Both files are non-runnable. */
  duplicateIds?: ReadonlySet<WorkflowId>;
  /** Shortcuts the app already owns; a clash is a warning and the app wins. */
  reservedShortcuts?: ReadonlySet<string>;
  /**
   * Text of the template files the definition's steps render, by the path the
   * step names. The registry reads them (it is already reading notes), so a
   * variable only a TEMPLATE uses is not reported unused — and one nothing uses
   * anywhere still is. A template missing from this map is one we could not
   * read, which silences the warning rather than guessing.
   */
  templateSources?: ReadonlyMap<string, string>;
}

const PROMPT_TYPES = new Set<PromptType>(["text", "multiline", "choice", "date", "clipboard"]);
const ON_EXISTS = new Set(["fail", "open", "suffix"]);
const POSITIONS = new Set(["start", "end"]);
const STEP_TYPES = new Set(["create-note", "append", "insert", "open-note", "run-workflow"]);
const BUILTINS = new Set<string>(BUILTIN_VARIABLES);
const ARGUMENT_BUILTINS = new Set(["date", "time", "link"]);

const SHORTCUT_MODIFIERS = new Set(["mod", "ctrl", "alt", "shift", "meta"]);
const SHORTCUT_KEY =
  /^([a-z0-9]|f[1-9]|f1[0-2]|enter|escape|space|tab|backspace|delete|up|down|left|right|home|end|pageup|pagedown|[,./;'[\]\\=`-])$/;
const ICON = /^(lucide:[a-z0-9-]+|emoji:.+)$/;

/** An ATX heading line, which is the only form `append.heading` can match. */
const HEADING = /^#{1,6}\s+\S/;

function error(code: string, message: string, extra: Partial<WorkflowIssue> = {}): WorkflowIssue {
  return { severity: "error", code, message, ...extra };
}

function warning(code: string, message: string, extra: Partial<WorkflowIssue> = {}): WorkflowIssue {
  return { severity: "warning", code, message, ...extra };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Is this string safe to use as a vault-relative path?
 *
 * Rust refuses an escape at the door (`vault.rs resolve_in_vault`), but a
 * workflow that only fails at write time has already run half its steps. The
 * same rules, applied before anything is written: relative, no `..`, no dot
 * segments (which is how `.context/` would be reached), forward slashes only.
 */
export function unsafePathReason(path: string): string | null {
  if (path.trim() === "") return "is empty";
  if (path.includes("\\")) return "must use / as its separator";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "must be vault-relative, not absolute";
  const segments = path.split("/");
  if (segments.some((s) => s === ".." )) return "must not contain ..";
  if (segments.some((s) => s.startsWith("."))) return "must not start a segment with .";
  if (segments.some((s) => s === "")) return "must not contain an empty segment";
  return null;
}

/** Longest first, so `MMM` is never read as `MM` plus a literal `M`. */
const DATE_TOKENS_BY_LENGTH = [...DATE_FORMAT_TOKENS].sort((a, b) => b.length - a.length);

/**
 * Why this format string is probably a typo, or null when it reads fine.
 *
 * Unknown characters are literal by design — `{{date:Week of YYYY}}` is a
 * legitimate format — so the test is narrower than "contains letters". Two
 * things are reported: a format with no token in it at all (a constant string
 * is never what someone meant by a date), and a RUN of the same letter that no
 * token consumed. The second is what catches the real mistake, `yyyy-mm-dd`:
 * `mm` is the minutes token, and the leftover `yyyy` and `dd` are the tell.
 */
function dateFormatComplaint(format: string): string | null {
  let residue = "";
  let matched = false;
  let i = 0;
  outer: while (i < format.length) {
    for (const token of DATE_TOKENS_BY_LENGTH) {
      if (format.startsWith(token, i)) {
        matched = true;
        i += token.length;
        // A separator, so two tokens either side of nothing cannot form a run.
        residue += "\u0000";
        continue outer;
      }
    }
    residue += format[i];
    i += 1;
  }
  if (!matched) return "has no date token in it";
  const run = /([A-Za-z])\1+/.exec(residue);
  return run ? `leaves "${run[0]}" as literal text (the tokens are case-sensitive)` : null;
}

/**
 * Check every `{{…}}` in one string. `declared` is the set of variable names
 * the definition declares; `used` collects the ones actually referenced so the
 * caller can warn about the rest.
 */
function checkRefs(
  text: string,
  field: string,
  step: number | undefined,
  declared: ReadonlySet<string>,
  used: Set<string>,
  out: WorkflowIssue[],
): void {
  const where = step === undefined ? { field } : { field, step };
  for (const { name, arg } of scanVariableRefs(text)) {
    if (arg !== null && !ARGUMENT_BUILTINS.has(name)) {
      out.push(error("unknown-builtin", `Unknown built-in "${name}:…".`, where));
      continue;
    }
    if (name === "link" && !arg) {
      out.push(error("bad-builtin-arg", "{{link:…}} needs a vault-relative note path.", where));
      continue;
    }
    if (name === "link" && arg) {
      const reason = unsafePathReason(arg);
      if (reason) out.push(error("unsafe-path", `{{link:${arg}}} ${reason}.`, where));
      continue;
    }
    if (name === "date" || name === "time") {
      const complaint = arg ? dateFormatComplaint(arg) : null;
      if (complaint) {
        out.push(warning("bad-date-format", `{{${name}:${arg}}} ${complaint}.`, where));
      }
      continue;
    }
    if (BUILTINS.has(name)) continue;
    if (declared.has(name)) {
      used.add(name);
      continue;
    }
    out.push(
      error("unknown-variable", `"${name}" is not a built-in and is not declared by this workflow.`, where),
    );
  }
}

function checkVariables(def: WorkflowDefinition, out: WorkflowIssue[]): Set<string> {
  const declared = new Set<string>();
  const raw = def.variables;
  if (raw === undefined) return declared;
  if (!Array.isArray(raw)) {
    out.push(error("bad-shape", "`variables` must be an array.", { field: "variables" }));
    return declared;
  }
  raw.forEach((variable, i) => {
    const field = `variables.${i}`;
    if (!isObject(variable)) {
      out.push(error("bad-shape", "Each variable must be an object.", { field }));
      return;
    }
    const name = variable.name;
    if (typeof name !== "string" || name === "") {
      out.push(error("missing-field", "A variable needs a `name`.", { field: `${field}.name` }));
      return;
    }
    if (!VARIABLE_NAME_PATTERN.test(name)) {
      out.push(
        error(
          "bad-variable-name",
          `"${name}" must match ${VARIABLE_NAME_PATTERN.source}.`,
          { field: `${field}.name` },
        ),
      );
      return;
    }
    if (BUILTINS.has(name)) {
      out.push(
        error("shadows-builtin", `"${name}" is a built-in and cannot be declared.`, {
          field: `${field}.name`,
        }),
      );
      return;
    }
    if (declared.has(name)) {
      out.push(error("duplicate-variable", `"${name}" is declared twice.`, { field: `${field}.name` }));
      return;
    }
    declared.add(name);
    const type = (variable.type ?? "text") as PromptType;
    if (!PROMPT_TYPES.has(type)) {
      out.push(error("unknown-type", `Unknown prompt type "${String(variable.type)}".`, {
        field: `${field}.type`,
      }));
    }
    if (type === "choice") {
      const choices = variable.choices;
      if (!Array.isArray(choices) || choices.length === 0 || choices.some((c) => typeof c !== "string")) {
        out.push(
          error("missing-choices", `"${name}" is a choice and needs a non-empty \`choices\` array.`, {
            field: `${field}.choices`,
          }),
        );
      }
    }
  });
  return declared;
}

/** One path-shaped field: safe, and (when required) a Markdown destination. */
function checkPathField(
  value: unknown,
  field: string,
  step: number,
  opts: { requireMarkdown?: boolean },
  out: WorkflowIssue[],
): boolean {
  if (typeof value !== "string" || value.trim() === "") {
    out.push(error("missing-field", `\`${field}\` must be a non-empty path.`, { field, step }));
    return false;
  }
  // Variables expand later; the executor re-checks the expanded path with the
  // same rule. Here we check the literal parts only, so `{{date}}.md` passes.
  const literal = value.replace(/\{\{[^{}]*\}\}/g, "x");
  const reason = unsafePathReason(literal);
  if (reason) {
    out.push(error("unsafe-path", `\`${field}\` ${reason}.`, { field, step }));
    return false;
  }
  if (opts.requireMarkdown && !literal.toLowerCase().endsWith(".md")) {
    out.push(error("bad-path", `\`${field}\` must end in .md.`, { field, step }));
    return false;
  }
  return true;
}

function checkSteps(
  def: WorkflowDefinition,
  declared: ReadonlySet<string>,
  used: Set<string>,
  out: WorkflowIssue[],
): { templates: string[]; workflows: WorkflowId[] } {
  const templates: string[] = [];
  const workflows: WorkflowId[] = [];
  const raw = def.steps;
  if (!Array.isArray(raw) || raw.length === 0) {
    out.push(error("missing-field", "A workflow needs at least one step.", { field: "steps" }));
    return { templates, workflows };
  }
  raw.forEach((rawStep, step) => {
    const base = `steps.${step}`;
    if (!isObject(rawStep)) {
      out.push(error("bad-shape", "Each step must be an object.", { field: base, step }));
      return;
    }
    const type = rawStep.type;
    if (typeof type !== "string" || !STEP_TYPES.has(type)) {
      out.push(error("unknown-step", `Unknown step type "${String(type)}".`, {
        field: `${base}.type`,
        step,
      }));
      return;
    }
    const text = (value: unknown, field: string) => {
      if (typeof value === "string") checkRefs(value, field, step, declared, used, out);
    };

    if (type === "create-note") {
      checkPathField(rawStep.path, `${base}.path`, step, { requireMarkdown: true }, out);
      text(rawStep.path, `${base}.path`);
      if (rawStep.template !== undefined && rawStep.content !== undefined) {
        out.push(
          error("conflicting-fields", "A step may have `template` or `content`, not both.", {
            field: `${base}.content`,
            step,
          }),
        );
      }
      if (rawStep.template !== undefined) {
        if (checkPathField(rawStep.template, `${base}.template`, step, { requireMarkdown: false }, out)) {
          templates.push(rawStep.template as string);
        }
        text(rawStep.template, `${base}.template`);
      }
      text(rawStep.content, `${base}.content`);
      if (rawStep.onExists !== undefined && !ON_EXISTS.has(String(rawStep.onExists))) {
        out.push(error("bad-field", `\`onExists\` must be one of ${[...ON_EXISTS].join(", ")}.`, {
          field: `${base}.onExists`,
          step,
        }));
      }
      if (rawStep.open !== undefined && typeof rawStep.open !== "boolean") {
        out.push(error("bad-field", "`open` must be a boolean.", { field: `${base}.open`, step }));
      }
      return;
    }

    if (type === "append") {
      const target = rawStep.target;
      if (target === "current") {
        // nothing more to check
      } else if (isObject(target) && typeof target.path === "string") {
        checkPathField(target.path, `${base}.target.path`, step, { requireMarkdown: true }, out);
        text(target.path, `${base}.target.path`);
      } else {
        out.push(
          error("missing-field", '`target` must be "current" or { path }.', {
            field: `${base}.target`,
            step,
          }),
        );
      }
      if (typeof rawStep.content !== "string" || rawStep.content === "") {
        out.push(error("missing-field", "`content` is required.", { field: `${base}.content`, step }));
      }
      text(rawStep.content, `${base}.content`);
      if (rawStep.heading !== undefined) {
        const heading = rawStep.heading;
        if (typeof heading !== "string" || !HEADING.test(heading)) {
          out.push(
            error("bad-heading", "`heading` must be a full ATX heading line, e.g. `## Inbox`.", {
              field: `${base}.heading`,
              step,
            }),
          );
        } else {
          text(heading, `${base}.heading`);
        }
      }
      if (rawStep.position !== undefined && !POSITIONS.has(String(rawStep.position))) {
        out.push(error("bad-field", '`position` must be "start" or "end".', {
          field: `${base}.position`,
          step,
        }));
      }
      const seed = rawStep.createIfMissing;
      if (seed !== undefined) {
        if (!isObject(seed)) {
          out.push(error("bad-shape", "`createIfMissing` must be an object.", {
            field: `${base}.createIfMissing`,
            step,
          }));
        } else {
          if (seed.template !== undefined) {
            const field = `${base}.createIfMissing.template`;
            if (checkPathField(seed.template, field, step, { requireMarkdown: false }, out)) {
              templates.push(seed.template as string);
            }
            text(seed.template, field);
          }
          text(seed.content, `${base}.createIfMissing.content`);
        }
      }
      return;
    }

    if (type === "insert") {
      if (rawStep.target !== "current") {
        out.push(
          error("bad-target", 'An insert writes at the caret, so `target` must be "current".', {
            field: `${base}.target`,
            step,
          }),
        );
      }
      if (typeof rawStep.content !== "string" || rawStep.content === "") {
        out.push(error("missing-field", "`content` is required.", { field: `${base}.content`, step }));
      }
      text(rawStep.content, `${base}.content`);
      return;
    }

    if (type === "open-note") {
      checkPathField(rawStep.path, `${base}.path`, step, { requireMarkdown: false }, out);
      text(rawStep.path, `${base}.path`);
      return;
    }

    // run-workflow
    const id = rawStep.id;
    if (typeof id !== "string" || !WORKFLOW_ID_PATTERN.test(id)) {
      out.push(error("bad-id", "`id` must be another workflow's id.", { field: `${base}.id`, step }));
      return;
    }
    workflows.push(id);
  });
  return { templates, workflows };
}

/**
 * Does following `run-workflow` from `start` ever come back to `target`?
 *
 * A plain depth-first walk with a visited set — the graph is the vault's
 * workflows, so it is small, and the visited set is what stops an unrelated
 * cycle elsewhere from hanging this one.
 */
function reaches(start: WorkflowId, target: WorkflowId, byId: ReadonlyMap<WorkflowId, WorkflowDefinition>): boolean {
  const seen = new Set<WorkflowId>();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const next = byId.get(id);
    if (!next || !Array.isArray(next.steps)) continue;
    for (const step of next.steps) {
      if (isObject(step) && step.type === "run-workflow" && typeof step.id === "string") {
        queue.push(step.id);
      }
    }
  }
  return false;
}

function checkShortcut(def: WorkflowDefinition, registry: ValidationRegistry | undefined, out: WorkflowIssue[]): void {
  const shortcut = def.shortcut;
  if (shortcut === undefined) return;
  const bad = (): void => {
    out.push(
      error("bad-shortcut", `"${String(shortcut)}" must be modifiers plus one key, e.g. "mod+shift+m".`, {
        field: "shortcut",
      }),
    );
  };
  if (typeof shortcut !== "string" || shortcut !== shortcut.toLowerCase()) return bad();
  const parts = shortcut.split("+");
  const modifiers = parts.slice(0, -1);
  const key = parts[parts.length - 1]!;
  if (
    parts.length < 2 ||
    new Set(modifiers).size !== modifiers.length ||
    !modifiers.every((m) => SHORTCUT_MODIFIERS.has(m)) ||
    !SHORTCUT_KEY.test(key)
  ) {
    return bad();
  }
  if (registry?.reservedShortcuts?.has(shortcut)) {
    out.push(
      warning("shortcut-conflict", `"${shortcut}" is a built-in shortcut, which wins.`, {
        field: "shortcut",
      }),
    );
  }
}

/**
 * Names this definition's variables that something it hands its values to
 * references: the text of a template a step renders, or the declarations of a
 * workflow a step runs (the executor passes down exactly what the child
 * declares). Only what the registry could supply is consulted.
 */
function usedDownstream(
  def: WorkflowDefinition,
  templates: readonly string[],
  workflows: readonly WorkflowId[],
  registry: ValidationRegistry | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const path of new Set(templates)) {
    const text = registry?.templateSources?.get(path);
    if (text === undefined) continue;
    for (const { name } of scanVariableRefs(text)) names.add(name);
  }
  for (const id of new Set(workflows)) {
    if (id === def.id) continue; // a cycle; reported as an error elsewhere
    for (const variable of registry?.byId?.get(id)?.variables ?? []) {
      if (typeof variable?.name === "string") names.add(variable.name);
    }
  }
  return names;
}

/**
 * Validate one definition. `registry` adds the checks a single file cannot
 * make: a duplicated id, a `run-workflow` that names nothing, and cycles.
 */
export function validateDefinition(
  def: WorkflowDefinition,
  registry?: ValidationRegistry,
): WorkflowIssue[] {
  const out: WorkflowIssue[] = [];

  if (def.version !== WORKFLOW_SCHEMA_VERSION) {
    out.push(
      error(
        "bad-version",
        `This app understands workflow schema version ${WORKFLOW_SCHEMA_VERSION}, not ${String(def.version)}.`,
        { field: "version" },
      ),
    );
  }
  if (typeof def.id !== "string" || !WORKFLOW_ID_PATTERN.test(def.id)) {
    out.push(error("bad-id", `\`id\` must match ${WORKFLOW_ID_PATTERN.source}.`, { field: "id" }));
  } else if (registry?.duplicateIds?.has(def.id)) {
    out.push(
      error("duplicate-id", `Another workflow file already uses the id "${def.id}".`, { field: "id" }),
    );
  }
  if (typeof def.name !== "string" || def.name.trim() === "") {
    out.push(error("missing-field", "`name` is what the command palette shows.", { field: "name" }));
  }
  if (def.description !== undefined && typeof def.description !== "string") {
    out.push(error("bad-field", "`description` must be a string.", { field: "description" }));
  }
  if (def.icon !== undefined && (typeof def.icon !== "string" || !ICON.test(def.icon))) {
    out.push(error("bad-icon", "`icon` must be `lucide:<id>` or `emoji:<grapheme>`.", { field: "icon" }));
  }
  if (def.slash !== undefined && typeof def.slash !== "boolean") {
    out.push(error("bad-field", "`slash` must be a boolean.", { field: "slash" }));
  }
  checkShortcut(def, registry, out);

  const declared = checkVariables(def, out);
  const used = new Set<string>();
  const { templates, workflows } = checkSteps(def, declared, used, out);

  // A variable this definition's own strings never mention may still be used
  // downstream — by a template a step renders, or by a workflow a step runs,
  // both of which are expanded against the same values. So ASK them: the
  // registry passes the template text and the other definitions in. When one of
  // them cannot be consulted, the answer is unknowable and the warning is
  // withheld; warning wrongly is worse than not warning, because the fix an
  // author would apply is to delete a variable that is doing its job.
  for (const name of usedDownstream(def, templates, workflows, registry)) used.add(name);
  const unknowable =
    templates.some((path) => !registry?.templateSources?.has(path)) ||
    workflows.some((id) => !registry?.byId?.has(id));
  for (const name of declared) {
    if (!used.has(name) && !unknowable) {
      const index = (def.variables ?? []).findIndex((v) => v?.name === name);
      out.push(
        warning("unused-variable", `"${name}" is prompted for but never used.`, {
          field: `variables.${index}.name`,
        }),
      );
    }
  }

  const requiredTemplates = new Set(def.requires?.templates ?? []);
  for (const template of new Set(templates)) {
    if (!requiredTemplates.has(template)) {
      out.push(
        warning("undeclared-dependency", `"${template}" is used but not listed in \`requires.templates\`.`, {
          field: "requires.templates",
        }),
      );
    }
  }
  const requiredWorkflows = new Set(def.requires?.workflows ?? []);
  for (const id of new Set(workflows)) {
    if (!requiredWorkflows.has(id)) {
      out.push(
        warning("undeclared-dependency", `"${id}" is called but not listed in \`requires.workflows\`.`, {
          field: "requires.workflows",
        }),
      );
    }
  }

  const byId = registry?.byId;
  if (byId && typeof def.id === "string") {
    (def.steps ?? []).forEach((step, index) => {
      if (!isObject(step) || step.type !== "run-workflow" || typeof step.id !== "string") return;
      const target = step.id;
      if (target === def.id || reaches(target, def.id, byId)) {
        out.push(
          error("cycle", `Running "${target}" would come back to "${def.id}".`, {
            field: `steps.${index}.id`,
            step: index,
          }),
        );
        return;
      }
      if (!byId.has(target)) {
        out.push(
          error("unknown-workflow", `No workflow in this vault has the id "${target}".`, {
            field: `steps.${index}.id`,
            step: index,
          }),
        );
      }
    });
  }

  return out;
}
