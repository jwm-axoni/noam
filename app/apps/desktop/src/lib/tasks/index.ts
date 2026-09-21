/**
 * The task engine's public surface.
 *
 * The Tasks panel, the calendar and the board import from HERE, never from
 * `parse.ts`/`edit.ts` directly: which file owns a planner is free to move,
 * and this list is the promise that does not.
 *
 * The shape of an action, end to end:
 *
 *   1. `resolveTask(ref)` re-finds the task in LIVE text and hands back a
 *      `ResolvedTask` whose `from`/`to` are the only offsets a write may use;
 *   2. a planner (`planSetStatus`, `planSetDate`, `planSetPriority`,
 *      `planComplete`) turns it into `SpanChange[]`, with `planAssignId`
 *      folding the lazy `^t-` id into the SAME edit;
 *   3. `applyTaskEdit(resolved, changes)` writes them as ONE transaction.
 *
 * `editTask(ref, plan)` is all three in one call, which is what a keyboard
 * shortcut wants.
 */

// The frozen contracts, so nobody has to know they live one level down.
export * from "./contracts";

// Reading task lines.
export {
  DATE_FIELDS,
  PRIORITY_MEDIUM_EMOJI,
  TAG_RE,
  parseTaskLine,
  parseTasks,
  scanTaskLine,
  tagsIn,
  type SegmentKind,
  type TailSegment,
  type TaskDateField,
  type TaskLineContext,
  type TaskLineScan,
} from "./parse";

// Writing one back. Byte-identical for a line nothing changed on.
export { serializeTask } from "./serialize";

// Planners. Nothing here dispatches; every one returns `SpanChange[]`.
export {
  applyChanges,
  mergeChanges,
  newTaskId,
  planAssignId,
  planSetDate,
  planSetPriority,
  planSetStatus,
} from "./edit";

// Recurrence, completion and the dedupe backstop.
export {
  addDays,
  addMonths,
  contentTaskId,
  dayOfWeek,
  daysBetween,
  dedupe,
  duplicateIds,
  nextDue,
  occurrenceId,
  parsePlainDate,
  parseRecurrence,
  parseStandalone,
  planComplete,
  planDedupe,
  primaryDateField,
  toLocalDate,
  toPlainDate,
  todayPlainDate,
  type CompletionPlan,
} from "./recurrence";

// Queries: the closed clause set, matching, ordering and grouping.
export {
  groupTasks,
  isDateOperand,
  matchTask,
  parseQuery,
  resolveOperand,
  selectTasks,
  sortTasks,
  type QueryContext,
  type TaskGroup,
} from "./query";

// The only door to a write.
export {
  applyTaskEdit,
  editTask,
  resolveTask,
  taskNoteText,
  type TaskEditResult,
  type TaskRef,
} from "./adapter";
