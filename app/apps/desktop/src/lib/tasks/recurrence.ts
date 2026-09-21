/**
 * Recurrence: reading `🔁 every other week`, working out the next date, and
 * planning the completion that spawns the next occurrence.
 *
 * THE CONVERGENCE RULE. Two people (or one person on two devices, offline)
 * can complete the same recurring line. Both spawn a next occurrence. Nothing
 * coordinates them, so the only way the merge is not a duplicate is for both
 * to write the SAME BYTES: same date, same text, same id.
 *
 *   - The date is derived from the line, so it already agrees.
 *   - The id is `occurrenceId(parentId, nextDue)` — a hash, not a random
 *     number — where `parentId` is the `^t-` id of the occurrence that was
 *     completed. An occurrence that has no id yet gets one derived from its
 *     note and its own bytes (`contentTaskId`), so two clients looking at the
 *     same line still agree on it. Nothing random reaches a recurring line.
 *
 * `planDedupe` is the backstop for the cases derivation cannot cover (a
 * rebuild that re-headed a series, a paste): it deletes every line after the
 * first that carries an id already seen, which is idempotent and convergent —
 * running it on either client, in either order, ends at the same text.
 *
 * Dates are floating. `new Date(y, m - 1, d)` and `getFullYear/Month/Date`
 * only; nothing here calls `toISOString`.
 */

import {
  PLAIN_DATE_RE,
  type PlainDate,
  type Recurrence,
  type RecurrenceRule,
  type SeriesId,
  type SpanChange,
  type Task,
  type TaskId,
  type TaskIssue,
  TASK_ID_SUFFIX_RE,
} from "./contracts";
import { DATE_FIELDS, parseTaskLine, scanTaskLine, type TaskDateField } from "./parse";
import { applyChanges, mergeChanges, planAssignId, planSetDate, planSetStatus } from "./edit";
import { serializeTask } from "./serialize";

// ---------------------------------------------------------------------------
// Floating date arithmetic
// ---------------------------------------------------------------------------

export function parsePlainDate(date: PlainDate): { y: number; m: number; d: number } | null {
  if (!PLAIN_DATE_RE.test(date)) return null;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function toPlainDate(date: Date): PlainDate {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toLocalDate(date: PlainDate): Date | null {
  const parts = parsePlainDate(date);
  return parts ? new Date(parts.y, parts.m - 1, parts.d) : null;
}

export function todayPlainDate(now: Date = new Date()): PlainDate {
  return toPlainDate(now);
}

export function addDays(date: PlainDate, days: number): PlainDate {
  const base = toLocalDate(date);
  if (!base) return date;
  base.setDate(base.getDate() + days);
  return toPlainDate(base);
}

/** Whole days from `a` to `b`, floating (so a DST boundary is still one day). */
export function daysBetween(a: PlainDate, b: PlainDate): number {
  const from = toLocalDate(a);
  const to = toLocalDate(b);
  if (!from || !to) return 0;
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/** Add months, clamping the day to the target month (Jan 31 + 1 = Feb 28/29). */
export function addMonths(date: PlainDate, months: number): PlainDate {
  const parts = parsePlainDate(date);
  if (!parts) return date;
  const target = new Date(parts.y, parts.m - 1 + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(parts.d, lastDay));
  return toPlainDate(target);
}

export function dayOfWeek(date: PlainDate): number {
  return toLocalDate(date)?.getDay() ?? 0;
}

// ---------------------------------------------------------------------------
// `🔁 …`
// ---------------------------------------------------------------------------

const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const UNIT_RE = /^every\s+(?:(other)\s+|(\d+)\s+)?(day|week|month|year)s?$/;
const WEEKDAY_RE = /^every\s+(?:(?:(\d+)|other)\s+weeks?\s+on\s+|week\s+on\s+)?(.+)$/;

function weekdayList(text: string): number[] | null {
  const parts = text
    .split(/,|\band\b/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return null;
  const days: number[] = [];
  for (const part of parts) {
    const day = WEEKDAYS[part];
    if (day === undefined) return null;
    if (!days.includes(day)) days.push(day);
  }
  return days.sort((a, b) => a - b);
}

/**
 * The supported subset, and nothing beyond it. `raw` is kept verbatim so an
 * unsupported rule survives every round-trip untouched; `rule: null` is what
 * makes the completion REPORT instead of inventing a date.
 */
export function parseRecurrence(raw: string): Recurrence {
  const trimmed = raw.trim();
  let body = trimmed.toLowerCase();
  let whenDone = false;
  const whenDoneMatch = /\s+when\s+done$/.exec(body);
  if (whenDoneMatch) {
    whenDone = true;
    body = body.slice(0, body.length - whenDoneMatch[0]!.length).trim();
  }

  const unit = UNIT_RE.exec(body);
  if (unit) {
    const interval = unit[1] ? 2 : unit[2] ? Number(unit[2]) : 1;
    if (interval >= 1) {
      return {
        raw,
        rule: { unit: unit[3] as RecurrenceRule["unit"], interval },
        whenDone,
      };
    }
  }

  const weekly = WEEKDAY_RE.exec(body);
  if (weekly) {
    const days = weekdayList(weekly[2]!);
    if (days) {
      const interval = weekly[1] ? Number(weekly[1]) : body.includes("other week") ? 2 : 1;
      if (interval >= 1) {
        return { raw, rule: { unit: "week", interval, weekdays: days }, whenDone };
      }
    }
  }

  return { raw, rule: null, whenDone };
}

// ---------------------------------------------------------------------------
// The next occurrence
// ---------------------------------------------------------------------------

/** The date the recurrence counts from: due, else scheduled, else start. */
export function primaryDateField(task: Task): TaskDateField | null {
  if (task.due) return "due";
  if (task.scheduled) return "scheduled";
  if (task.start) return "start";
  return null;
}

function nextFromRule(rule: RecurrenceRule, base: PlainDate): PlainDate {
  if (rule.unit === "week" && rule.weekdays && rule.weekdays.length > 0) {
    const from = dayOfWeek(base);
    for (let ahead = 1; ahead <= 7; ahead += 1) {
      const day = (from + ahead) % 7;
      if (rule.weekdays.includes(day)) {
        // A jump into the next week takes the interval with it, so
        // `every 2 weeks on monday` skips a week and not a Monday.
        const weeksAhead = from + ahead >= 7 ? rule.interval - 1 : 0;
        return addDays(base, ahead + weeksAhead * 7);
      }
    }
  }
  switch (rule.unit) {
    case "day":
      return addDays(base, rule.interval);
    case "week":
      return addDays(base, 7 * rule.interval);
    case "month":
      return addMonths(base, rule.interval);
    default:
      return addMonths(base, 12 * rule.interval);
  }
}

/**
 * The next date for `task`'s primary field, or `null` when the task does not
 * recur, the rule is outside the subset, or the line carries no date to move.
 */
export function nextDue(task: Task, today: PlainDate): PlainDate | null {
  const rule = task.recurrence?.rule;
  if (!rule) return null;
  const field = primaryDateField(task);
  if (!field) return null;
  const base = task.recurrence!.whenDone ? today : task[field]!;
  if (!parsePlainDate(base)) return null;
  return nextFromRule(rule, base);
}

async function sha256Hex(text: string): Promise<string> {
  // The same six lines as `bridge/adapter.ts sha256Hex`, kept local on purpose:
  // that module wires IPC and the store, and the task engine is pure.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toId(hex: string): TaskId {
  return `t-${BigInt(`0x${hex}`).toString(36).padStart(10, "0").slice(0, 10)}`;
}

/** The frozen formula. See `OccurrenceId` in `contracts.ts`. */
export async function occurrenceId(seriesId: SeriesId, next: PlainDate): Promise<TaskId> {
  return toId(await sha256Hex(`${seriesId}\n${next}`));
}

/**
 * The id an un-stamped line gets when it is completed. Derived from the note
 * and the line's own bytes rather than from `crypto.getRandomValues`, because
 * two clients completing the same line offline have to agree on it — and the
 * id they agree on is what makes the next occurrence they each spawn
 * identical. (An ordinary structured edit does use a random id: there is
 * nothing to converge with.)
 */
export async function contentTaskId(task: Task): Promise<TaskId> {
  return toId(await sha256Hex(`${task.docId}\n${task.sourceText}`));
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export interface CompletionPlan {
  /** ONE edit: status, the ✅ date, the id suffix and the new line below. */
  changes: SpanChange[];
  /** The id the completed line carries after the edit. */
  taskId: TaskId;
  /** The spawned line, or `null` when the task does not recur. */
  nextLine: string | null;
  nextId: TaskId | null;
  issues: TaskIssue[];
}

/**
 * Complete `task` and, when it recurs, spawn its next occurrence directly
 * below — as one span edit, so it is one write, one undo step, and one
 * CRDT transaction that a teammate sees whole.
 *
 * `liveText` is the text the changes will be applied to. It is checked against
 * the task's own span first: planning against text the task is not in would
 * produce offsets pointing at somebody else's line.
 */
export async function planComplete(
  task: Task,
  liveText: string,
  today: PlainDate,
): Promise<CompletionPlan> {
  const issues: TaskIssue[] = [];
  const taskId = task.id ?? (await contentTaskId(task));
  if (liveText.slice(task.from, task.to) !== task.sourceText) {
    return {
      changes: [],
      taskId,
      nextLine: null,
      nextId: null,
      issues: [
        {
          severity: "error",
          code: "stale-target",
          message: "The line moved since it was read; refresh and retry.",
        },
      ],
    };
  }

  let changes: SpanChange[] = [
    ...planSetStatus(task, "done"),
    ...planSetDate(task, "done", today),
  ];
  changes = planAssignId(task, changes, taskId);

  let nextLine: string | null = null;
  let nextId: TaskId | null = null;
  if (task.recurrence) {
    if (!task.recurrence.rule) {
      issues.push({
        severity: "warning",
        code: "unsupported-recurrence",
        message: `"${task.recurrence.raw}" is outside the recurrence rules Noam understands, so no next occurrence was created.`,
      });
    } else {
      const field = primaryDateField(task);
      const next = nextDue(task, today);
      if (!field || !next) {
        issues.push({
          severity: "warning",
          code: "no-recurrence-date",
          message: "A recurring task needs a due, scheduled or start date before it can repeat.",
        });
      } else {
        nextId = await occurrenceId(taskId, next);
        nextLine = buildNextLine(task, field, next, nextId);
        changes.push({ from: task.to, to: task.to, insert: `\n${nextLine}` });
      }
    }
  }

  return { changes: mergeChanges(changes), taskId, nextLine, nextId, issues };
}

/**
 * The spawned line, built from the completed one so that everything we did not
 * model travels with it: same text, same tags, same unparsed fields, dates
 * shifted by the same number of days, `✅`/`❌` dropped, a fresh id.
 */
function buildNextLine(
  task: Task,
  field: TaskDateField,
  next: PlainDate,
  nextId: TaskId,
): string {
  const shift = daysBetween(task[field]!, next);
  const spawned: Task = { ...task, id: nextId, status: "todo", done: null, cancelled: null };
  for (const dateField of DATE_FIELDS) {
    if (dateField === "done" || dateField === "cancelled" || dateField === "created") continue;
    const value = task[dateField];
    if (!value) continue;
    spawned[dateField] = dateField === field ? next : addDays(value, shift);
  }
  return serializeTask(spawned);
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/**
 * Delete every task line whose `^t-` id was already seen higher up the note.
 *
 * Idempotent (a second run finds nothing) and convergent (position order is
 * the same on every client, so everyone keeps the same line). A no-op when
 * every id is unique, which is the normal case — nothing calls this
 * speculatively-expensive path unless the adapter reported an ambiguity.
 */
export function planDedupe(liveText: string): SpanChange[] {
  const seen = new Set<string>();
  const changes: SpanChange[] = [];
  let offset = 0;
  for (const raw of liveText.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const from = offset;
    offset += raw.length + 1;
    const scan = scanTaskLine(line);
    if (!scan?.id) continue;
    if (!seen.has(scan.id)) {
      seen.add(scan.id);
      continue;
    }
    const to = from + raw.length;
    // Take the line's own newline with it; the last line of a note has none,
    // so it takes the one in front of it instead.
    if (to < liveText.length) changes.push({ from, to: to + 1, insert: "" });
    else changes.push({ from: Math.max(0, from - 1), to, insert: "" });
  }
  return changes;
}

/** Every `^t-` id that appears on more than one line, in document order. */
export function duplicateIds(liveText: string): string[] {
  const counts = new Map<string, number>();
  for (const raw of liveText.split("\n")) {
    const match = TASK_ID_SUFFIX_RE.exec(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}

/** Convenience for tests and for the dedupe queue: text with dupes removed. */
export function dedupe(liveText: string): string {
  return applyChanges(liveText, planDedupe(liveText));
}

/** Re-parse a line on its own — used when a caller has a line but no context. */
export function parseStandalone(line: string, docId = "", path = ""): Task | null {
  return parseTaskLine(line, { docId, path, line: 0, from: 0 });
}
