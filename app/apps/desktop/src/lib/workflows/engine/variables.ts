/**
 * `{{…}}` expansion — the whole of what a workflow can compute.
 *
 * There is no expression language here and there will not be one: a token is a
 * NAME, optionally followed by `:` and one literal argument, and the set of
 * names is closed (`BUILTIN_VARIABLES` plus what the definition declares). That
 * is what makes a workflow file safe to accept from someone else — an imported
 * package can write text into your vault, and nothing else.
 *
 * Two rules the rest of the engine leans on:
 *   - A name we cannot resolve produces an ISSUE and leaves the token verbatim.
 *     Silently expanding to "" would turn a typo into a half-written capture,
 *     and the token surviving is what makes `pendingContent` readable.
 *   - `{{clipboard}}` reads `scope.clipboard` and nothing else. The engine never
 *     reaches for `navigator.clipboard`; the prompt UI captures it on an
 *     explicit user action and passes it in. An absent capture (`undefined`) is
 *     an error, while an explicitly empty one ("") expands to "".
 */

import {
  BUILTIN_VARIABLES,
  DATE_FORMAT_TOKENS,
  DEFAULT_DATE_FORMAT,
  DEFAULT_TIME_FORMAT,
  type WorkflowIssue,
} from "../contracts";
import { noteLabel } from "../../notePath";

/** Everything an expansion is allowed to know. Nothing is read ambiently. */
export interface VariableScope {
  /** Prompt values, keyed by declared variable name. */
  values: Readonly<Record<string, string>>;
  /** Names the definition declared. A name outside this set and the built-ins
   *  is an error even when `values` happens to carry it. */
  declared: ReadonlySet<string>;
  /** The run's clock, so a run is reproducible in tests. */
  now: Date;
  /** Vault-relative path of the note open in the editor, if any. */
  currentPath?: string | null;
  /** Editor selection; absent and empty are the same thing (contract). */
  selection?: string;
  /** Clipboard text the UI captured on an explicit user action. `undefined`
   *  means "nobody captured it", which is NOT the same as "". */
  clipboard?: string;
}

export interface ExpansionResult {
  text: string;
  issues: WorkflowIssue[];
}

/** One `{{name}}` / `{{name:arg}}` reference, as written. */
export interface VariableRef {
  name: string;
  arg: string | null;
}

/** `{{ … }}` with no nested braces, so a stray `{` can never start a token. */
const TOKEN = /\{\{([^{}]*)\}\}/g;

/** Built-ins that take the `name:arg` form. Everything else is bare. */
const ARGUMENT_BUILTINS = new Set(["date", "time", "link"]);

const BUILTINS = new Set<string>(BUILTIN_VARIABLES);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Longest first, so `MMM` is never read as `MM` + a literal `M`. */
const TOKENS_BY_LENGTH = [...DATE_FORMAT_TOKENS].sort((a, b) => b.length - a.length);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ISO 8601 week-year and week number, from LOCAL date parts only.
 *
 * The rule: week 1 is the week containing the year's first Thursday, and a
 * week runs Monday to Sunday. Equivalently, the Thursday of a date's own week
 * decides which year the week belongs to — which is why 30 December 2024 is
 * 2025-W01 and 1 January 2027 is 2026-W53.
 *
 * Every `Date` here is built from `getFullYear`/`getMonth`/`getDate`, so the
 * result is the same wall-clock week the user sees on a paper calendar. Going
 * through UTC would move the week by a day for anyone east or west of it. The
 * one subtraction of two local timestamps is rounded to whole weeks, so a DST
 * shift inside the span cannot push it into the previous week.
 */
function isoWeek(d: Date): { year: number; week: number } {
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // Monday = 0 … Sunday = 6, then step to that week's Thursday.
  thursday.setDate(thursday.getDate() - ((thursday.getDay() + 6) % 7) + 3);
  const year = thursday.getFullYear();

  // 4 January is always in week 1; walk it back to its own Thursday.
  const firstThursday = new Date(year, 0, 4);
  firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);

  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return { year, week };
}

function tokenValue(token: string, d: Date): string {
  switch (token) {
    case "YYYY": return String(d.getFullYear()).padStart(4, "0");
    case "YY": return pad2(d.getFullYear() % 100);
    case "MM": return pad2(d.getMonth() + 1);
    case "DD": return pad2(d.getDate());
    case "HH": return pad2(d.getHours());
    case "mm": return pad2(d.getMinutes());
    case "ss": return pad2(d.getSeconds());
    case "ddd": return WEEKDAYS[d.getDay()]!;
    case "MMM": return MONTHS[d.getMonth()]!;
    case "GGGG": return String(isoWeek(d).year).padStart(4, "0");
    case "WW": return pad2(isoWeek(d).week);
    default: return token;
  }
}

/**
 * Render `date` with the bounded token set. Every character that is not part of
 * a known token is copied through verbatim — there is no escape syntax and no
 * locale lookup, so the same format string means the same thing on every
 * machine that opens the vault.
 */
export function formatDate(date: Date, format: string): string {
  let out = "";
  let i = 0;
  outer: while (i < format.length) {
    for (const token of TOKENS_BY_LENGTH) {
      if (format.startsWith(token, i)) {
        out += tokenValue(token, date);
        i += token.length;
        continue outer;
      }
    }
    out += format[i];
    i += 1;
  }
  return out;
}

/** Split one token body into its name and (optional) single argument. */
function splitRef(body: string): VariableRef {
  const colon = body.indexOf(":");
  if (colon === -1) return { name: body.trim(), arg: null };
  return { name: body.slice(0, colon).trim(), arg: body.slice(colon + 1).trim() };
}

/**
 * Every reference in `template`, in source order. Shared with `validate.ts` so
 * the validator and the expander can never disagree about what a token is.
 */
export function scanVariableRefs(template: string): VariableRef[] {
  const refs: VariableRef[] = [];
  TOKEN.lastIndex = 0;
  for (const m of template.matchAll(TOKEN)) refs.push(splitRef(m[1]!));
  return refs;
}

/** The part of a path a link shows: the file name without its note extension. */
function linkLabel(path: string): string {
  return noteLabel(path);
}

/** The folder a vault-relative path sits in; "" at the vault root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function issue(code: string, message: string): WorkflowIssue {
  return { severity: "error", code, message };
}

/**
 * Resolve one reference. Returning `null` means "leave the token alone and take
 * the issue" — the caller writes the raw token back into the output.
 */
function resolve(ref: VariableRef, scope: VariableScope): { text: string } | { issue: WorkflowIssue } {
  const { name, arg } = ref;

  if (arg !== null && !ARGUMENT_BUILTINS.has(name)) {
    return {
      issue: issue("unknown-builtin", `Unknown built-in "${name}". Built-ins taking an argument are ${[...ARGUMENT_BUILTINS].join(", ")}.`),
    };
  }

  switch (name) {
    case "date":
      return { text: formatDate(scope.now, arg || DEFAULT_DATE_FORMAT) };
    case "time":
      return { text: formatDate(scope.now, arg || DEFAULT_TIME_FORMAT) };
    case "link": {
      if (!arg) return { issue: issue("bad-builtin-arg", "{{link:…}} needs a vault-relative note path.") };
      // Only spaces are encoded: the rest of a vault path is already legal in a
      // Markdown destination, and encoding more would stop the link resolving
      // against the file name people see in the sidebar.
      return { text: `[${linkLabel(arg)}](${arg.replace(/ /g, "%20")})` };
    }
    case "title":
      return { text: scope.currentPath ? noteLabel(scope.currentPath) : "" };
    case "path":
      return { text: scope.currentPath ?? "" };
    case "folder":
      return { text: scope.currentPath ? folderOf(scope.currentPath) : "" };
    case "selection":
      return { text: scope.selection ?? "" };
    case "clipboard":
      if (scope.clipboard === undefined) {
        return {
          issue: issue(
            "missing-clipboard",
            "{{clipboard}} needs clipboard text, which only an explicit paste in the prompt provides.",
          ),
        };
      }
      return { text: scope.clipboard };
  }

  if (scope.declared.has(name)) {
    const value = scope.values[name];
    if (value === undefined) {
      return { issue: issue("missing-value", `No value for "${name}".`) };
    }
    return { text: value };
  }
  return {
    issue: issue(
      "unknown-variable",
      BUILTINS.has(name)
        ? `Built-in "${name}" cannot be used here.`
        : `"${name}" is not a built-in and the workflow does not declare it.`,
    ),
  };
}

/**
 * Expand every reference in `template`. A single pass: a value that itself
 * contains `{{…}}` is output as-is and never re-scanned, so no prompt answer
 * can smuggle in another expansion.
 */
export function expand(template: string, scope: VariableScope): ExpansionResult {
  const issues: WorkflowIssue[] = [];
  const text = template.replace(TOKEN, (whole, body: string) => {
    const resolved = resolve(splitRef(body), scope);
    if ("issue" in resolved) {
      issues.push(resolved.issue);
      return whole;
    }
    return resolved.text;
  });
  return { text, issues };
}
