/**
 * Task → line.
 *
 * The contract this file keeps is `serializeTask(parseTaskLine(line)) === line`
 * for ANY task line, not just the ones we fully understand. It gets there by
 * rebuilding the line from the SAME scan the parser used: every field is
 * re-emitted where it already was, with the whitespace it already had, and a
 * field we did not model comes back verbatim out of `unparsed`.
 *
 * A field the caller CHANGED is re-rendered in place; a field it cleared takes
 * its separator with it; a field it added lands at its canonical position
 * relative to the fields already on the line. A task with no `sourceText`
 * (something a test or a template built by hand) gets the canonical order.
 *
 * Note what this file is NOT for: the app never writes a task by serializing
 * one over its line. Every write is a minimal span replacement planned in
 * `edit.ts`, so a line we misread cannot be rewritten by a user action. This
 * is for building a NEW line (the next occurrence of a recurring task) and for
 * previews.
 */

import {
  CHECKBOX_STATUS,
  MARKERS,
  PRIORITY_MARKERS,
  STATUS_CHECKBOX,
  type Task,
} from "./contracts";
import { DATE_FIELDS, scanTaskLine, type TaskDateField, type TaskLineScan } from "./parse";

/** Canonical field order — the order Obsidian Tasks itself emits. */
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

interface Slot {
  rank: number;
  gap: string;
  text: string;
}

function renderField(task: Task, key: string): string | null {
  if (key === "priority") {
    return task.priority ? PRIORITY_MARKERS[task.priority] : null;
  }
  if (key === "recurrence") {
    return task.recurrence ? `${MARKERS.recurrence} ${task.recurrence.raw}` : null;
  }
  const value = task[key as TaskDateField];
  return value ? `${MARKERS[key as TaskDateField]} ${value}` : null;
}

/** Re-render a segment that has not changed, verbatim. */
function unchanged(scan: TaskLineScan, index: number): string {
  return scan.segments[index]!.raw;
}

export function serializeTask(task: Task): string {
  const scan = task.sourceText ? scanTaskLine(task.sourceText) : null;
  return scan ? fromScan(task, scan) : canonical(task);
}

function fromScan(task: Task, scan: TaskLineScan): string {
  const slots: Slot[] = [];
  let unparsedIndex = 0;
  let lastRank = -1;

  const emitted = new Set<string>();
  for (let i = 0; i < scan.segments.length; i += 1) {
    const segment = scan.segments[i]!;
    const key = segment.kind === "priority" ? "priority" : (segment.field as string | undefined);
    // A SECOND `📅` on one line is an unparsed entry, not a second due date —
    // exactly how the parser read it.
    const repeat = key !== undefined && emitted.has(key);
    if (segment.kind === "unparsed" || repeat) {
      const raw = task.unparsed[unparsedIndex];
      unparsedIndex += 1;
      // A caller that dropped an entry drops the segment; it never shifts the
      // remaining entries onto the wrong glyph.
      if (raw === undefined) continue;
      slots.push({ rank: lastRank + 0.5, gap: segment.gap, text: raw });
      continue;
    }
    emitted.add(key!);
    lastRank = RANK[key!]!;
    const rendered = renderField(task, key!);
    if (rendered === null) continue; // the field was cleared
    const same =
      segment.kind === "priority"
        ? segment.priority === task.priority
        : segment.value === fieldValue(task, key!);
    slots.push({ rank: lastRank, gap: segment.gap, text: same ? unchanged(scan, i) : rendered });
  }

  // Fields the task has but the line did not: insert at canonical position.
  const present = emitted;
  for (const key of ["priority", "recurrence", ...DATE_FIELDS]) {
    if (present.has(key)) continue;
    const rendered = renderField(task, key);
    if (rendered === null) continue;
    const rank = RANK[key]!;
    const at = slots.findIndex((slot) => slot.rank > rank);
    const slot: Slot = { rank, gap: " ", text: rendered };
    if (at === -1) slots.push(slot);
    else slots.splice(at, 0, slot);
  }

  // Entries the caller ADDED to `unparsed` go at the end, one space apart.
  for (let i = unparsedIndex; i < task.unparsed.length; i += 1) {
    slots.push({ rank: Number.MAX_SAFE_INTEGER, gap: " ", text: task.unparsed[i]! });
  }

  const checkbox =
    CHECKBOX_STATUS[scan.checkbox] === task.status ? scan.checkbox : STATUS_CHECKBOX[task.status];
  const description = task.text === scan.description ? scan.description : task.text;
  const head = `${scan.indent}${scan.bullet}${scan.bulletGap}[${checkbox}]${scan.separator}${scan.leadGap}${description}`;
  const body = slots.map((slot) => `${slot.gap}${slot.text}`).join("");
  const id = task.id ? `${scan.idGap || " "}^${task.id}` : "";
  return `${head}${body}${scan.trailGap}${id}`;
}

function fieldValue(task: Task, key: string): string | null {
  if (key === "recurrence") return task.recurrence?.raw ?? null;
  return task[key as TaskDateField] ?? null;
}

/** No source line to follow: canonical order, single spaces. */
function canonical(task: Task): string {
  const parts: string[] = [];
  for (const key of ["priority", "recurrence", ...DATE_FIELDS]) {
    const rendered = renderField(task, key);
    if (rendered !== null) parts.push(rendered);
  }
  parts.push(...task.unparsed);
  const tail = parts.length > 0 ? ` ${parts.join(" ")}` : "";
  const id = task.id ? ` ^${task.id}` : "";
  return `${task.indent}- [${STATUS_CHECKBOX[task.status]}] ${task.text}${tail}${id}`;
}
