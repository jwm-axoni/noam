/**
 * The task query subset — a closed clause set, parsed line by line.
 *
 * Two rules, both from the contracts:
 *
 *   1. NOTHING IS EVALUATED. There is no expression language, no `eval`, no
 *      function clauses. A regex clause is MATCHED with bounded flags, never
 *      compiled from user text into behaviour.
 *   2. NOTHING IS GUESSED. A line we do not understand is reported in
 *      `issues` and echoed in `unsupported`. It never becomes "match
 *      everything", which would quietly widen a saved filter the next time
 *      somebody opened it in an older build.
 *
 * Relative dates (`today`, `next week`, `in 3 days`) are stored UNRESOLVED and
 * resolved in `matchTask` against the clock and the vault's week start, so a
 * filter called "Due this week" still means this week next month.
 */

import {
  MAX_QUERY_LIMIT,
  PRIORITY_ORDER,
  type Clause,
  type DateField,
  type GroupKey,
  type ParsedQuery,
  type PlainDate,
  type Priority,
  type SortKey,
  type Task,
  type TaskIssue,
  type TaskQuery,
  type TaskStatus,
  type WeekStart,
  PLAIN_DATE_RE,
} from "./contracts";
import { addDays, dayOfWeek, todayPlainDate } from "./recurrence";

export interface QueryContext {
  today: PlainDate;
  weekStart: WeekStart;
}

const DEFAULT_CONTEXT = (): QueryContext => ({ today: todayPlainDate(), weekStart: 1 });

const DATE_FIELD_NAMES: Record<string, DateField> = {
  due: "due",
  scheduled: "scheduled",
  start: "start",
  done: "done",
  cancelled: "cancelled",
  created: "created",
};

const STATUS_NAMES: Record<string, TaskStatus> = {
  todo: "todo",
  "to-do": "todo",
  done: "done",
  "in-progress": "in-progress",
  "in progress": "in-progress",
  doing: "in-progress",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const PRIORITY_NAMES: Record<string, Priority> = {
  highest: "highest",
  high: "high",
  medium: "medium",
  low: "low",
  lowest: "lowest",
};

const SORT_FIELDS = new Set<SortKey["field"]>([
  "due",
  "scheduled",
  "start",
  "priority",
  "status",
  "path",
  "text",
]);

const GROUP_KEYS = new Set<GroupKey>(["path", "heading", "status", "priority", "due", "tag"]);

/** The relative phrases we resolve. Anything else must be a `YYYY-MM-DD`. */
const RELATIVE_RE =
  /^(today|tomorrow|yesterday|this week|next week|last week|in \d+ days?|\d+ days? ago)$/;

export function isDateOperand(text: string): boolean {
  return PLAIN_DATE_RE.test(text) || RELATIVE_RE.test(text.toLowerCase());
}

/** A relative phrase can name a RANGE, so every operand resolves to one. */
export function resolveOperand(
  operand: string,
  ctx: QueryContext,
): { from: PlainDate; to: PlainDate } | null {
  if (PLAIN_DATE_RE.test(operand)) return { from: operand, to: operand };
  const text = operand.toLowerCase();
  const day = (offset: number) => {
    const at = addDays(ctx.today, offset);
    return { from: at, to: at };
  };
  if (text === "today") return day(0);
  if (text === "tomorrow") return day(1);
  if (text === "yesterday") return day(-1);
  const inDays = /^in (\d+) days?$/.exec(text);
  if (inDays) return day(Number(inDays[1]));
  const ago = /^(\d+) days? ago$/.exec(text);
  if (ago) return day(-Number(ago[1]));
  if (text === "this week" || text === "next week" || text === "last week") {
    const shift = text === "next week" ? 7 : text === "last week" ? -7 : 0;
    const offsetIntoWeek = (dayOfWeek(ctx.today) - ctx.weekStart + 7) % 7;
    const from = addDays(ctx.today, shift - offsetIntoWeek);
    return { from, to: addDays(from, 6) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function splitList(text: string): string[] {
  return text
    .split(/,| or /i)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * One clause per line. Blank lines and `#` comments are ignored; everything
 * else either matches a clause form or is reported.
 */
export function parseQuery(text: string, ctx: QueryContext = DEFAULT_CONTEXT()): ParsedQuery {
  const clauses: Clause[] = [];
  const issues: TaskIssue[] = [];
  const unsupported: string[] = [];
  const sort: SortKey[] = [];
  let group: GroupKey | null = null;
  let limit = MAX_QUERY_LIMIT;

  // Operands are STORED unresolved, but they are checked against the clock
  // now, so a saved filter cannot hide a typo until the day it is opened.
  const validDate = (operand: string) => resolveOperand(operand, ctx) !== null;

  const reject = (line: string, code: string, message: string) => {
    unsupported.push(line);
    issues.push({ severity: "error", code, message });
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const lower = line.toLowerCase();

    // --- status ---------------------------------------------------------
    if (lower === "done") {
      clauses.push({ kind: "status", values: ["done"] });
      continue;
    }
    if (lower === "not done") {
      // Cancelled is not "not done" — it is finished, just not by doing it.
      clauses.push({ kind: "status", values: ["todo", "in-progress"] });
      continue;
    }
    const status = /^status\s*(?::|is|includes)\s*(.+)$/.exec(lower);
    if (status) {
      const values = splitList(status[1]!).map((name) => STATUS_NAMES[name]);
      if (values.some((value) => value === undefined)) {
        reject(line, "unsupported-clause", `Unknown status in "${line}".`);
        continue;
      }
      clauses.push({ kind: "status", values: values as TaskStatus[] });
      continue;
    }

    // --- dates ----------------------------------------------------------
    const none = /^(?:no|without)\s+(\w+)(?:\s+date)?$/.exec(lower);
    if (none && DATE_FIELD_NAMES[none[1]!]) {
      clauses.push({ kind: "date", field: DATE_FIELD_NAMES[none[1]!]!, op: "none" });
      continue;
    }
    const between = /^(\w+)(?:\s+date)?\s+in\s+(.+?)\s+to\s+(.+)$/.exec(lower);
    if (between && DATE_FIELD_NAMES[between[1]!]) {
      const [from, to] = [between[2]!.trim(), between[3]!.trim()];
      if (!validDate(from) || !validDate(to)) {
        reject(line, "bad-date", `"${line}" is not a date Noam understands.`);
        continue;
      }
      clauses.push({ kind: "date", field: DATE_FIELD_NAMES[between[1]!]!, op: "in", from, to });
      continue;
    }
    const compare = /^(\w+)(?:\s+date)?\s+(before|after|on|is)\s+(.+)$/.exec(lower);
    if (compare && DATE_FIELD_NAMES[compare[1]!]) {
      const field = DATE_FIELD_NAMES[compare[1]!]!;
      const operand = compare[3]!.trim();
      if (operand === "none") {
        clauses.push({ kind: "date", field, op: "none" });
        continue;
      }
      if (!validDate(operand)) {
        reject(line, "bad-date", `"${operand}" is not a date Noam understands.`);
        continue;
      }
      const op = compare[2] === "is" ? "on" : (compare[2] as "before" | "after" | "on");
      clauses.push({ kind: "date", field, op, value: operand });
      continue;
    }

    // --- priority -------------------------------------------------------
    const priority = /^priority\s*(?::|is|includes)\s*(.+)$/.exec(lower);
    if (priority) {
      const values = splitList(priority[1]!).map((name) => PRIORITY_NAMES[name]);
      if (values.some((value) => value === undefined)) {
        reject(line, "unsupported-clause", `Unknown priority in "${line}".`);
        continue;
      }
      clauses.push({ kind: "priority", values: values as Priority[] });
      continue;
    }

    // --- tag / path / heading -------------------------------------------
    const tag = /^(no\s+|not\s+)?tag\s*(?::|is|includes)?\s*#?(\S+)$/i.exec(line);
    if (tag) {
      clauses.push({ kind: "tag", value: tag[2]!, negated: tag[1] !== undefined });
      continue;
    }
    const path = /^(not\s+)?path\s*(?::|is|includes|starts with)\s*(.+)$/i.exec(line);
    if (path) {
      clauses.push({ kind: "path", value: path[2]!.trim(), negated: path[1] !== undefined });
      continue;
    }
    const heading = /^heading\s*(?::|is|includes)\s*(.+)$/i.exec(line);
    if (heading) {
      clauses.push({ kind: "heading", value: heading[1]!.trim() });
      continue;
    }

    // --- text -----------------------------------------------------------
    const regex = /^(?:description|text)\s+regex\s+\/(.+)\/([a-z]*)$/i.exec(line);
    if (regex) {
      const flags = regex[2]!;
      if (flags !== "" && flags !== "i") {
        reject(line, "unsupported-clause", `Only the "i" regex flag is supported.`);
        continue;
      }
      try {
        new RegExp(regex[1]!, flags);
      } catch {
        reject(line, "bad-regex", `"${regex[1]}" is not a valid pattern.`);
        continue;
      }
      clauses.push({ kind: "text", op: "regex", value: regex[1]!, flags });
      continue;
    }
    const text2 = /^(?:description|text)\s+(does not include|excludes|includes|:)\s*(.+)$/i.exec(line);
    if (text2) {
      const op = text2[1]!.toLowerCase() === "includes" || text2[1] === ":" ? "includes" : "excludes";
      clauses.push({ kind: "text", op, value: text2[2]!.trim() });
      continue;
    }

    // --- recurring ------------------------------------------------------
    if (lower === "is recurring" || lower === "recurring") {
      clauses.push({ kind: "recurring", value: true });
      continue;
    }
    if (lower === "is not recurring" || lower === "not recurring") {
      clauses.push({ kind: "recurring", value: false });
      continue;
    }

    // --- sort / group / limit -------------------------------------------
    const sortLine = /^sort by\s+(\w+)(?:\s+(asc|desc|ascending|descending))?$/.exec(lower);
    if (sortLine) {
      const field = sortLine[1] as SortKey["field"];
      if (!SORT_FIELDS.has(field)) {
        reject(line, "unsupported-clause", `Cannot sort by "${sortLine[1]}".`);
        continue;
      }
      sort.push({ field, direction: sortLine[2]?.startsWith("desc") ? "desc" : "asc" });
      continue;
    }
    const groupLine = /^group by\s+(\w+)$/.exec(lower);
    if (groupLine) {
      const key = groupLine[1] as GroupKey;
      if (!GROUP_KEYS.has(key)) {
        reject(line, "unsupported-clause", `Cannot group by "${groupLine[1]}".`);
        continue;
      }
      group = key;
      continue;
    }
    const limitLine = /^limit\s+(?:to\s+)?(\d+)$/.exec(lower);
    if (limitLine) {
      const value = Number(limitLine[1]);
      if (value < 1) {
        reject(line, "bad-limit", "A limit must be at least 1.");
        continue;
      }
      if (value > MAX_QUERY_LIMIT) {
        limit = MAX_QUERY_LIMIT;
        issues.push({
          severity: "warning",
          code: "clamped-limit",
          message: `A query returns at most ${MAX_QUERY_LIMIT} tasks; "${line}" was clamped.`,
          field: "limit",
        });
        continue;
      }
      limit = value;
      continue;
    }

    reject(line, "unsupported-clause", `Noam does not understand "${line}".`);
  }

  return { query: { clauses, sort, group, limit }, issues, unsupported };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function matchDate(task: Task, clause: Extract<Clause, { kind: "date" }>, ctx: QueryContext): boolean {
  const value = task[clause.field];
  if (clause.op === "none") return value === null;
  if (value === null) return false;
  if (clause.op === "in") {
    const from = resolveOperand(clause.from, ctx);
    const to = resolveOperand(clause.to, ctx);
    if (!from || !to) return false;
    return value >= from.from && value <= to.to;
  }
  const range = resolveOperand(clause.value, ctx);
  if (!range) return false;
  if (clause.op === "before") return value < range.from;
  if (clause.op === "after") return value > range.to;
  return value >= range.from && value <= range.to;
}

function matchClause(clause: Clause, task: Task, ctx: QueryContext): boolean {
  switch (clause.kind) {
    case "status":
      return clause.values.includes(task.status);
    case "date":
      return matchDate(task, clause, ctx);
    case "priority":
      return task.priority !== null && clause.values.includes(task.priority);
    case "tag": {
      const has = task.tags.some((tag) => tag.toLowerCase() === clause.value.toLowerCase());
      return clause.negated ? !has : has;
    }
    case "path": {
      // Prefix, case-insensitively, like every other path comparison in Noam.
      const has = task.path.toLowerCase().startsWith(clause.value.toLowerCase());
      return clause.negated ? !has : has;
    }
    case "heading":
      return task.section.some((heading) => heading.toLowerCase() === clause.value.toLowerCase());
    case "text": {
      if (clause.op === "regex") {
        try {
          return new RegExp(clause.value, clause.flags).test(task.text);
        } catch {
          return false;
        }
      }
      const has = task.text.toLowerCase().includes(clause.value.toLowerCase());
      return clause.op === "includes" ? has : !has;
    }
    case "recurring":
      return (task.recurrence !== null) === clause.value;
    default:
      return true;
  }
}

/** Every clause must hold; values inside one clause are ORed. */
export function matchTask(
  query: TaskQuery,
  task: Task,
  ctx: QueryContext = DEFAULT_CONTEXT(),
): boolean {
  return query.clauses.every((clause) => matchClause(clause, task, ctx));
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

const STATUS_ORDER: TaskStatus[] = ["in-progress", "todo", "done", "cancelled"];

function keyOf(task: Task, field: SortKey["field"]): string | number | null {
  switch (field) {
    case "priority":
      return task.priority === null ? null : PRIORITY_ORDER.indexOf(task.priority);
    case "status":
      return STATUS_ORDER.indexOf(task.status);
    case "path":
      return task.path.toLowerCase();
    case "text":
      return task.text.toLowerCase();
    default:
      return task[field];
  }
}

/**
 * Stable and total: equal keys fall through to the next key and finally to
 * document position, so the same query over the same vault is the same list
 * every time. A missing value always sorts last, whatever the direction —
 * "no due date" is not "due in the year zero".
 */
export function sortTasks(tasks: readonly Task[], sort: readonly SortKey[]): Task[] {
  return [...tasks].sort((a, b) => {
    for (const key of sort) {
      const left = keyOf(a, key.field);
      const right = keyOf(b, key.field);
      if (left === right) continue;
      if (left === null) return 1;
      if (right === null) return -1;
      const order = left < right ? -1 : 1;
      return key.direction === "desc" ? -order : order;
    }
    return a.path.localeCompare(b.path) || a.line - b.line;
  });
}

export interface TaskGroup {
  /** The raw value; `""` means the task had none. */
  key: string;
  /** What a heading should say. */
  label: string;
  tasks: Task[];
}

const NO_VALUE: Record<GroupKey, string> = {
  path: "No path",
  heading: "No heading",
  status: "No status",
  priority: "No priority",
  due: "No due date",
  tag: "Untagged",
};

function groupKeysFor(task: Task, key: GroupKey): string[] {
  switch (key) {
    case "path":
      return [task.path];
    case "heading":
      return [task.section.length > 0 ? task.section.join(" › ") : ""];
    case "status":
      return [task.status];
    case "priority":
      return [task.priority ?? ""];
    case "due":
      return [task.due ?? ""];
    default:
      // A task with three tags belongs to three groups — the one case where
      // grouping is not a partition.
      return task.tags.length > 0 ? task.tags : [""];
  }
}

/** Groups in key order, with the "no value" group last. */
export function groupTasks(tasks: readonly Task[], key: GroupKey): TaskGroup[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    for (const value of groupKeysFor(task, key)) {
      const bucket = groups.get(value);
      if (bucket) bucket.push(task);
      else groups.set(value, [task]);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([value, group]) => ({
      key: value,
      label: value === "" ? NO_VALUE[key] : value,
      tasks: group,
    }));
}

/** Filter, sort and clamp in one call — what a panel actually wants. */
export function selectTasks(
  query: TaskQuery,
  tasks: readonly Task[],
  ctx: QueryContext = DEFAULT_CONTEXT(),
): Task[] {
  const matched = tasks.filter((task) => matchTask(query, task, ctx));
  return sortTasks(matched, query.sort).slice(0, Math.min(query.limit, MAX_QUERY_LIMIT));
}
