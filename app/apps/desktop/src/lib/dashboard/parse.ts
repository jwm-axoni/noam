/**
 * Dashboards (plan `docs/PLAN-INTERACTIVE-VIEWS.md` Part 2, `docs/DASHBOARDS.md`).
 *
 * A dashboard is an ordinary note whose FRONTMATTER says `noam_kind:
 * dashboard`. Its views are the fenced blocks whose info string is exactly
 * `noam-view`, in document order. Each block is a CLOSED clause set, one clause
 * per line, in the house style of the task query (`lib/tasks/query.ts`):
 *
 *   1. NOTHING IS EVALUATED. There is no expression language: a clause is a
 *      key, an operator and a literal, and every literal renders as text.
 *   2. NOTHING IS GUESSED. A line we do not understand is reported in the
 *      view's `issues`. When dropping it could WIDEN the result (an unknown
 *      line, a malformed `where`), the issue is `blocking` and the view shows
 *      no results at all rather than more than it was asked for. A bad
 *      presentation line (`view`, `width`, `limit`, `sort`, `columns`,
 *      `title`) cannot widen anything, so the view still runs.
 *
 * Relative dates (`today`, `this week`, `last 30 days`) are stored
 * UNRESOLVED and resolved when the view runs (`query.ts`), so "Created this
 * week" still means this week next month.
 */

export const NOAM_KIND_KEY = "noam_kind";
export const DASHBOARD_KIND_VALUE = "dashboard";
export const VIEW_INFO_STRING = "noam-view";

export const DEFAULT_VIEW_LIMIT = 24;
export const MAX_VIEW_LIMIT = 200;
/** A table with more columns than this is unreadable; the rest are dropped. */
export const MAX_COLUMNS = 12;

export type ViewKind = "cards" | "table";
export type ViewWidth = "full" | "half";
export type WhereOp = "eq" | "contains" | "lt" | "lte" | "gt" | "gte" | "has";
export type SortDirection = "asc" | "desc";

/** One `where:` line, parsed but NOT interpreted: `key` is still the word the
 *  author wrote, and `value` the literal (quotes removed, relative dates kept). */
export interface WhereClause {
  key: string;
  op: WhereOp;
  value: string;
  /** 0-based line in the NOTE, so an issue can point at it. */
  line: number;
}

export interface SortSpec {
  key: string;
  /** null = the key's natural default (newest first for dates). */
  direction: SortDirection | null;
}

export interface ViewIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  /** 0-based line in the note; null for a problem found at run time. */
  line: number | null;
  /** True when ignoring the line could widen the result: the view then shows nothing. */
  blocking: boolean;
}

export interface DashboardViewSpec {
  /** Position among the note's views (0-based). */
  index: number;
  /** 0-based line of the opening fence. */
  line: number;
  /** The block's text, verbatim — the identity a live re-run compares. */
  source: string;
  title: string | null;
  view: ViewKind;
  where: WhereClause[];
  sort: SortSpec | null;
  limit: number;
  /** `columns:` as written (table only); null = the default columns. */
  columns: string[] | null;
  width: ViewWidth;
  issues: ViewIssue[];
}

export interface ParsedDashboard {
  views: DashboardViewSpec[];
}

// ---------------------------------------------------------------------------
// Detection — frontmatter only
// ---------------------------------------------------------------------------

const FM_KEY_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

/** Where the frontmatter ends: `{ body, end }` (end = offset after the closing
 *  fence line), or null when the note has none. */
function frontmatter(text: string): { body: string; endLine: number } | null {
  const lines = text.split("\n");
  if (!/^---[ \t]*\r?$/.test(lines[0] ?? "")) return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^(?:---|\.\.\.)[ \t]*\r?$/.test(lines[i]!)) {
      return { body: lines.slice(1, i).join("\n"), endLine: i + 1 };
    }
  }
  return null;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Is this note a dashboard? The `noam_kind: dashboard` key has to be in the
 * FRONTMATTER — the same words in the body are just words (the Boards rule).
 */
export function isDashboardDocument(text: string): boolean {
  const fm = frontmatter(text);
  if (!fm) return false;
  for (const raw of fm.body.split("\n")) {
    const m = FM_KEY_RE.exec(raw.replace(/\r$/, ""));
    if (m && m[1] === NOAM_KIND_KEY) return unquote(m[2]!) === DASHBOARD_KIND_VALUE;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Every `noam-view` block after the frontmatter, in order. Other fences are
 * skipped whole, so a block QUOTED inside a longer fence is not a view.
 */
export function extractViewBlocks(text: string): Array<{ line: number; source: string }> {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const start = frontmatter(text)?.endLine ?? 0;
  const out: Array<{ line: number; source: string }> = [];
  let open: { marker: string; line: number; isView: boolean } | null = null;
  let body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fence = FENCE_RE.exec(line);
    if (!open) {
      if (!fence) continue;
      const info = fence[2]!.trim();
      // A backtick fence's info string may not contain a backtick (CommonMark).
      if (fence[1]![0] === "`" && info.includes("`")) continue;
      open = { marker: fence[1]!, line: i, isView: info === VIEW_INFO_STRING };
      body = [];
      continue;
    }
    if (
      fence &&
      fence[1]![0] === open.marker[0] &&
      fence[1]!.length >= open.marker.length &&
      fence[2]!.trim() === ""
    ) {
      if (open.isView) out.push({ line: open.line, source: body.join("\n") });
      open = null;
      continue;
    }
    body.push(line);
  }
  // An unclosed fence runs to the end of the document (CommonMark).
  if (open?.isView) out.push({ line: open.line, source: body.join("\n") });
  return out;
}

export function parseDashboard(text: string): ParsedDashboard {
  return {
    views: extractViewBlocks(text).map((block, index) =>
      parseView(block.source, { index, line: block.line }),
    ),
  };
}

// ---------------------------------------------------------------------------
// One view
// ---------------------------------------------------------------------------

/** `# …` to the end of the line, when the `#` starts the line or follows
 *  whitespace AND is followed by whitespace — so `#meeting` is a value. */
function stripComment(line: string): string {
  const m = /(^|\s)#(\s|$)/.exec(line);
  return m ? line.slice(0, m.index) : line;
}

const SYSTEM_DATE_KEYS = new Set(["created", "modified"]);

/** ISO date or datetime in the contract's grammar (spec 06). */
export const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** The relative phrases a date operand may use (resolved at run time). */
export const RELATIVE_DATE_RE =
  /^(today|yesterday|this week|last week|this month|last month|(?:last|past) (\d{1,4}) (days?|weeks?))$/i;

export function isDateOperand(value: string): boolean {
  return ISO_TIMESTAMP_RE.test(value) || RELATIVE_DATE_RE.test(value.trim());
}

const WORD_OP_RE = /^(\S+)\s+(contains|has)\s+(.+)$/i;
const SYMBOL_OP_RE = /^([^\s<>=!]+)\s*(>=|<=|!=|=|<|>)\s*(.+)$/;
const SYMBOL_OPS: Record<string, WhereOp> = {
  "=": "eq",
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
};

const SORT_RE = /^(\S+)(?:\s+(asc|desc|ascending|descending))?$/i;
const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function parseView(
  source: string,
  at: { index: number; line: number } = { index: 0, line: 0 },
): DashboardViewSpec {
  const spec: DashboardViewSpec = {
    index: at.index,
    line: at.line,
    source,
    title: null,
    view: "cards",
    where: [],
    sort: null,
    limit: DEFAULT_VIEW_LIMIT,
    columns: null,
    width: "full",
    issues: [],
  };
  const seen = new Set<string>();
  const issue = (line: number, code: string, message: string, blocking: boolean) =>
    spec.issues.push({ severity: blocking ? "error" : "warning", code, message, line, blocking });

  source.split("\n").forEach((raw, offset) => {
    // The block's first line sits one below the fence.
    const lineNo = at.line + 1 + offset;
    const line = stripComment(raw).trim();
    if (line === "") return;
    const clause = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    if (!clause) {
      issue(lineNo, "unsupported-clause", `Noam does not understand "${line}".`, true);
      return;
    }
    const key = clause[1]!.toLowerCase();
    const value = clause[2]!.trim();
    const once = (): boolean => {
      if (seen.has(key)) {
        issue(lineNo, "duplicate-clause", `Only the first "${key}:" line counts.`, false);
        return false;
      }
      seen.add(key);
      return true;
    };

    switch (key) {
      case "title":
        if (!once()) return;
        spec.title = unquote(value) || null;
        return;
      case "view": {
        if (!once()) return;
        const kind = value.toLowerCase();
        if (kind === "cards" || kind === "table") spec.view = kind;
        else issue(lineNo, "bad-view", `"${value}" is not a view; use cards or table.`, false);
        return;
      }
      case "width": {
        if (!once()) return;
        const width = value.toLowerCase();
        if (width === "full" || width === "half") spec.width = width;
        else issue(lineNo, "bad-width", `"${value}" is not a width; use full or half.`, false);
        return;
      }
      case "limit": {
        if (!once()) return;
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          issue(lineNo, "bad-limit", `A limit is a whole number from 1 to ${MAX_VIEW_LIMIT}.`, false);
          return;
        }
        const n = Number(value);
        if (n > MAX_VIEW_LIMIT) {
          issue(lineNo, "clamped-limit", `A view shows at most ${MAX_VIEW_LIMIT} notes at a time; "${line}" was clamped.`, false);
        }
        spec.limit = Math.min(n, MAX_VIEW_LIMIT);
        return;
      }
      case "sort": {
        if (!once()) return;
        const m = SORT_RE.exec(value);
        if (!m || !KEY_RE.test(m[1]!)) {
          issue(lineNo, "bad-sort", `"${value}" is not a sort; write "sort: modified desc".`, false);
          return;
        }
        spec.sort = {
          key: m[1]!,
          direction: m[2] ? (m[2].toLowerCase().startsWith("desc") ? "desc" : "asc") : null,
        };
        return;
      }
      case "columns": {
        if (!once()) return;
        const names = value
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "");
        const bad = names.find((name) => !KEY_RE.test(name));
        if (names.length === 0 || bad !== undefined) {
          issue(lineNo, "bad-columns", `"${value}" is not a column list; write "columns: name, type, modified".`, false);
          return;
        }
        if (names.length > MAX_COLUMNS) {
          issue(lineNo, "too-many-columns", `A table shows at most ${MAX_COLUMNS} columns.`, false);
        }
        spec.columns = names.slice(0, MAX_COLUMNS);
        return;
      }
      case "where": {
        const parsed = parseWhere(value);
        if (typeof parsed === "string") {
          issue(lineNo, "bad-where", parsed, true);
          return;
        }
        spec.where.push({ ...parsed, line: lineNo });
        return;
      }
      default:
        issue(lineNo, "unsupported-clause", `Noam does not understand "${line}".`, true);
    }
  });

  if (spec.columns && spec.view !== "table") {
    spec.issues.push({
      severity: "warning",
      code: "columns-cards",
      message: "columns: only applies to a table view.",
      line: null,
      blocking: false,
    });
  }
  return spec;
}

/** A `where:` value → clause, or the message explaining why it is not one. */
function parseWhere(value: string): Omit<WhereClause, "line"> | string {
  if (value === "") return 'An empty "where:" matches nothing; write "where: type = meeting".';
  let key: string;
  let op: WhereOp;
  let operand: string;
  const word = WORD_OP_RE.exec(value);
  const symbol = word ? null : SYMBOL_OP_RE.exec(value);
  if (word) {
    key = word[1]!;
    op = word[2]!.toLowerCase() as WhereOp;
    operand = word[3]!;
  } else if (symbol) {
    if (symbol[2] === "!=") return `"${value}": Noam has no "not equal" filter.`;
    key = symbol[1]!;
    op = SYMBOL_OPS[symbol[2]!]!;
    operand = symbol[3]!;
  } else {
    return `"${value}" is not a filter; write "key = value" (also contains, has, <, <=, >, >=).`;
  }
  if (!KEY_RE.test(key)) return `"${key}" is not a property name.`;
  const literal = unquote(operand);
  if (literal === "") return `"${value}" compares with nothing.`;
  const lowerKey = key.toLowerCase();
  if (SYSTEM_DATE_KEYS.has(lowerKey)) {
    if (op === "contains" || op === "has") return `${lowerKey} compares with =, <, <=, > or >=.`;
    if (!isDateOperand(literal)) return `"${literal}" is not a date Noam understands.`;
    return { key: lowerKey, op, value: literal };
  }
  return { key, op, value: literal };
}

/** A view whose issues say "showing anything would be a guess". */
export function isBlocked(view: Pick<DashboardViewSpec, "issues">): boolean {
  return view.issues.some((issue) => issue.blocking);
}
