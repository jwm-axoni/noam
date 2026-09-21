/**
 * Task edits as minimal span replacements — the same shape, and the same rule,
 * as `frontmatter/edit.ts`: a planner returns `SpanChange[]` and dispatches
 * nothing. The caller turns them into ONE editor transaction (open note) or
 * one `replaceRange` (closed note), so a task edit reaches the `.md`, the
 * index and Yjs undo exactly like typing does.
 *
 * Every offset here is doc-absolute, built from `task.from` plus a span found
 * by re-scanning `task.sourceText`. That is why the task passed in MUST come
 * from `resolveTask` (live text): re-scanning an indexed line would place a
 * write at an offset the file no longer has.
 *
 * What a planner never does: rewrite a byte it was not asked about. Setting a
 * due date on a line with an Obsidian Tasks field we do not model touches the
 * date and nothing else.
 */

import {
  MARKERS,
  PRIORITY_MARKERS,
  STATUS_CHECKBOX,
  type PlainDate,
  type Priority,
  type SpanChange,
  type Task,
  type TaskId,
  type TaskStatus,
} from "./contracts";
import { scanTaskLine, type TailSegment, type TaskDateField, type TaskLineScan } from "./parse";

const RANK: Record<string, number> = {
  priority: 0,
  recurrence: 1,
  created: 2,
  start: 3,
  scheduled: 4,
  due: 5,
  cancelled: 6,
  done: 7,
};

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A fresh block id. Random, because an ordinary structured edit has nothing to
 * converge with — a recurring completion uses the DERIVED id from
 * `recurrence.ts` instead, which is what makes two offline clients agree.
 *
 * Ten characters of base36 is ~51 bits; the modulo bias from 256 to 36 is far
 * below what would matter for collisions inside one note.
 */
export function newTaskId(): TaskId {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `t-${Array.from(bytes, (b) => ID_ALPHABET[b % 36]!).join("")}`;
}

function segmentFor(scan: TaskLineScan, key: string): TailSegment | null {
  for (const segment of scan.segments) {
    if (key === "priority" && segment.kind === "priority") return segment;
    if (segment.kind === "date" && segment.field === key) return segment;
    if (key === "recurrence" && segment.kind === "recurrence") return segment;
  }
  return null;
}

/** Where a field that is not on the line yet should go. */
function insertionPoint(scan: TaskLineScan, key: string): number {
  const rank = RANK[key]!;
  for (const segment of scan.segments) {
    if (segment.kind === "unparsed") continue;
    const other = segment.kind === "priority" ? "priority" : segment.field!;
    if (RANK[other]! > rank) return segment.from - segment.gap.length;
  }
  const last = scan.segments[scan.segments.length - 1];
  return last ? last.to : scan.descriptionTo;
}

function planSetField(task: Task, key: string, rendered: string | null): SpanChange[] {
  const scan = scanTaskLine(task.sourceText);
  if (!scan) return [];
  const segment = segmentFor(scan, key);
  if (segment) {
    if (rendered === null) {
      // The separator leaves with the field, or the line grows a double space.
      return [{ from: task.from + segment.from - segment.gap.length, to: task.from + segment.to, insert: "" }];
    }
    if (segment.raw === rendered) return [];
    return [{ from: task.from + segment.from, to: task.from + segment.to, insert: rendered }];
  }
  if (rendered === null) return [];
  const at = task.from + insertionPoint(scan, key);
  return [{ from: at, to: at, insert: ` ${rendered}` }];
}

/** Flip the checkbox character, and nothing else. */
export function planSetStatus(task: Task, status: TaskStatus): SpanChange[] {
  const scan = scanTaskLine(task.sourceText);
  if (!scan) return [];
  const next = STATUS_CHECKBOX[status];
  if (scan.checkbox === next) return [];
  return [{ from: task.from + scan.checkboxAt, to: task.from + scan.checkboxAt + 1, insert: next }];
}

/** Set, move or remove one date marker. `null` removes it. */
export function planSetDate(
  task: Task,
  field: TaskDateField,
  date: PlainDate | null,
): SpanChange[] {
  const scan = scanTaskLine(task.sourceText);
  if (!scan) return [];
  const segment = segmentFor(scan, field);
  // Replacing only the VALUE keeps a `📅2026-01-01` (no space) line spelled
  // the way its author spelled it.
  if (segment && date !== null && segment.valueFrom !== undefined) {
    if (segment.value === date) return [];
    return [{ from: task.from + segment.valueFrom, to: task.from + segment.valueTo!, insert: date }];
  }
  return planSetField(task, field, date === null ? null : `${MARKERS[field]} ${date}`);
}

/** Set or clear the priority glyph. Writing always emits the frozen glyph. */
export function planSetPriority(task: Task, priority: Priority | null): SpanChange[] {
  return planSetField(task, "priority", priority === null ? null : PRIORITY_MARKERS[priority]);
}

/**
 * Merge the lazy block id into the edit that triggered it, so both land as ONE
 * span replacement. Returns `edit` unchanged when the task already has an id.
 * See `PlanAssignId` in `contracts.ts`.
 */
export const planAssignId = (task: Task, edit: SpanChange[], id: TaskId): SpanChange[] => {
  if (task.id !== null) return edit;
  return [...edit, { from: task.to, to: task.to, insert: ` ^${id}` }];
};

/**
 * Sort a plan and fold inserts that land on the same point into one, in the
 * order they were planned. CodeMirror accepts a sorted, non-overlapping change
 * set; this is what keeps "set the date, then stamp the id, then add the next
 * occurrence" a single well-formed edit.
 */
export function mergeChanges(changes: SpanChange[]): SpanChange[] {
  const sorted = [...changes]
    .map((change, index) => ({ change, index }))
    .sort((a, b) => a.change.from - b.change.from || a.index - b.index)
    .map(({ change }) => change);
  const out: SpanChange[] = [];
  for (const change of sorted) {
    const last = out[out.length - 1];
    if (last && last.from === last.to && change.from === change.to && last.from === change.from) {
      out[out.length - 1] = { from: last.from, to: last.to, insert: last.insert + change.insert };
      continue;
    }
    out.push(change);
  }
  return out;
}

/** Apply a plan to a string. The tests' oracle, and the closed-note write. */
export function applyChanges(text: string, changes: SpanChange[]): string {
  let out = text;
  for (const change of [...mergeChanges(changes)].reverse()) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  }
  return out;
}
