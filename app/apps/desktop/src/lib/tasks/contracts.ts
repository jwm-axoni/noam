// Frozen shared contracts for Noam tasks: the task line, saved filters, the
// calendar settings note, and Kanban boards.
//
// This file is the boundary between four owners:
//   - the task engine (`src/lib/tasks/*`) and its Rust mirror (`src-tauri/src/tasks.rs`)
//   - the calendar (`src/lib/calendar/*`, `src/components/calendar/*`)
//   - the board (`src/lib/board/*`, `src/components/board/*`)
//   - the UI entry points (Tasks panel, Calendar panel, board view)
//
// Rules that every owner relies on:
//   - A task is a LINE in an ordinary vault note. There is no task database,
//     no `.context/` sidecar and no `%%t:%%` comment. The `.md` file is the
//     only durable truth; SQLite holds a DERIVED projection of it.
//   - Every write goes through `resolveTask` against LIVE text and then through
//     `replaceRange(path, revision, from, to, insert)`. An indexed offset is a
//     HINT and never reaches a write (see "Hints" below).
//   - Text the parser did not recognise is preserved VERBATIM in `unparsed`
//     and written back in place. Round-tripping a line we do not fully
//     understand must be byte-identical.
//   - Dates are FLOATING (see "Floating dates" below). No `Date.toISOString()`,
//     no UTC, no time zone conversion anywhere in the task pipeline.
//   - Nothing here evaluates code. Queries are a closed clause set; an
//     unsupported clause is REPORTED (`TaskIssue`), never guessed.
//
// Hints
//   `Task.path`, `Task.line`, `Task.from` and `Task.to` describe where the task
//   WAS when it was indexed. They are search hints for `resolveTask` and
//   nothing else. By the time an action runs, the note may have been edited by
//   a human, a teammate over CRDT, or an AI through MCP, so the adapter
//   re-finds the line in live text (by `^t-` id first, then by exact
//   `sourceText` nearest `line`) and recomputes the span it writes at. A write
//   planned against an indexed offset is a bug, not an optimisation.
//
// Floating dates
//   A task date is a wall-clock calendar day with no time and no zone: the
//   string `YYYY-MM-DD` exactly as it appears in the file. "Due 2026-03-09"
//   means the ninth of March wherever the vault is opened, so a vault that
//   travels does not shift by a day and a DST boundary is still 24 h of the
//   same date. Comparisons are STRING comparisons on `PlainDate`; when a
//   `Date` is unavoidable (calendar grids, recurrence arithmetic) it is built
//   from local parts (`new Date(y, m - 1, d)`) and read back with
//   `getFullYear`/`getMonth`/`getDate`.

import type { SpanChange } from "../frontmatter/edit";

/** Property edits and task edits plan the same shape. Re-exported so the task
 *  owners import one contract instead of reaching into `frontmatter/`. */
export type { SpanChange } from "../frontmatter/edit";

// ---------------------------------------------------------------------------
// The task line
// ---------------------------------------------------------------------------

/**
 * The only shape that is a task. Groups: 1 = leading whitespace (indent),
 * 2 = the list bullet, 3 = the checkbox character, 4 = the rest of the line.
 *
 * Deliberately strict, because a false positive rewrites a line nobody meant
 * as a task: the bullet needs at least one space after it, the checkbox is
 * exactly one character from a closed set, and exactly one whitespace
 * character must follow `]` — which it consumes, so it is not part of the
 * text. `- [ ]` with nothing after it is therefore NOT a task line, while
 * `- [ ] ` (one trailing space) is, with empty text. The separator is `\s`
 * rather than a literal space so that a tab-indented editor's `- [ ]\ttext`
 * is still a task; the parser only ever sees one line at a time, so `\s`
 * cannot reach across a line break.
 */
export const TASK_LINE_RE = /^(\s*)([-*+])\s+\[([ xX/-])\]\s(.*)$/;

export type TaskStatus = "todo" | "done" | "in-progress" | "cancelled";

/** Checkbox character → status. `X` and `x` are the same done. */
export const CHECKBOX_STATUS: Readonly<Record<string, TaskStatus>> = {
  " ": "todo",
  x: "done",
  X: "done",
  "/": "in-progress",
  "-": "cancelled",
};

/** Status → the character WE write. Reading accepts `X`, writing emits `x`. */
export const STATUS_CHECKBOX: Readonly<Record<TaskStatus, string>> = {
  todo: " ",
  done: "x",
  "in-progress": "/",
  cancelled: "-",
};

/**
 * Five levels, named for the plan's five glyphs in descending order. Obsidian
 * Tasks' 🔺 is NOT recognised: it stays in `unparsed` and round-trips
 * verbatim rather than being silently folded into "highest".
 */
export type Priority = "highest" | "high" | "medium" | "low" | "lowest";

/** Priority → marker glyph. Frozen; changing a glyph rewrites users' files. */
export const PRIORITY_MARKERS: Readonly<Record<Priority, string>> = {
  highest: "⏫",
  high: "🔼",
  medium: "▶",
  low: "🔽",
  lowest: "⏬",
};

/** Descending. The single source of order for sorting and for the cycle key. */
export const PRIORITY_ORDER: readonly Priority[] = [
  "highest",
  "high",
  "medium",
  "low",
  "lowest",
];

/**
 * Frozen field markers. These glyphs are the on-disk format: a task written by
 * Noam opens in Obsidian Tasks and back. `id`/`dependsOn` are PRESERVED, not
 * acted on — `🆔` stays the dependency id it is in Obsidian Tasks and is never
 * overloaded with our own identity (which is the `^t-` block id below).
 */
export const MARKERS = {
  due: "📅",
  scheduled: "⏳",
  start: "🛫",
  done: "✅",
  created: "➕",
  cancelled: "❌",
  recurrence: "🔁",
  id: "🆔",
  dependsOn: "⛔",
} as const;

export type MarkerField = keyof typeof MARKERS;

/** A floating calendar day, `YYYY-MM-DD`. See "Floating dates" above. */
export type PlainDate = string;
export const PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Identity is an Obsidian block-id suffix at the END of the line:
 * `… text ^t-k3x9f2a0b1`. Ten base36 characters after the `t-` prefix.
 *
 * Why this and not the alternatives:
 *   - It is standard Markdown that Obsidian already understands and that other
 *     tools leave alone; `%%t:…%%` comments render as noise in half of them.
 *   - It travels with the line through a copy, a move between notes, a rename
 *     and a rebuild, which a `.context/` sidecar keyed by path does not.
 *
 * Assignment is LAZY: a task has `id === null` until the first structured edit
 * (complete, reschedule, set priority, move a card), and that edit writes the
 * suffix in the SAME span replacement — one write, one undo step, no separate
 * "stamping" pass that would churn every file the moment a vault is opened.
 * See `PlanAssignId`.
 */
export type TaskId = string;
export const TASK_ID_RE = /^t-[0-9a-z]{10}$/;

/** The suffix as it appears at the end of a line: one space, `^`, the id. */
export const TASK_ID_SUFFIX_RE = /\s\^(t-[0-9a-z]{10})$/;

/**
 * A recurring task's series key. A series id IS the `TaskId` of the
 * occurrence that started the series, so it has the same shape.
 *
 * The plan left where a series id LIVES open. Chosen (simplest): it is
 * derived, never written to the file — the file would need a marker we would
 * then have to defend across other tools. A task whose series is unknown (a
 * hand-written `🔁` line, or the first occurrence after a rebuild) is its own
 * series head, i.e. `seriesId === id`. Two clients completing the same live
 * line agree because they read the same line; a client that lost the chain to
 * a rebuild can re-head a series and write a second next-occurrence line,
 * which `planDedupe` in `recurrence.ts` removes (idempotent, convergent).
 */
export type SeriesId = string;
export const SERIES_ID_RE = /^t-[0-9a-z]{10}$/;

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

/** Bounded recurrence subset. Anything outside it parses to `rule: null`. */
export interface RecurrenceRule {
  unit: "day" | "week" | "month" | "year";
  /** ≥ 1. `every other week` is `{ unit: "week", interval: 2 }`. */
  interval: number;
  /** 0 = Sunday … 6 = Saturday, ascending. Only for `unit: "week"`. */
  weekdays?: number[];
}

export interface Recurrence {
  /** Verbatim text after `🔁`, written back byte-for-byte. */
  raw: string;
  /** `null` when `raw` is outside the subset: the line is preserved and the
   *  completion reports an issue instead of guessing a next date. */
  rule: RecurrenceRule | null;
  /** `… when done` — the next occurrence counts from the completion date
   *  rather than from the current due date. */
  whenDone: boolean;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export interface Task {
  /** `null` until the first structured edit assigns one. See `TaskId`. */
  id: TaskId | null;
  /** Series head for a recurring task; `null` when the task does not recur. */
  seriesId: SeriesId | null;
  /** Stable note identity. Never resolve a task by path across layers. */
  docId: string;

  /** HINT. Vault-relative path at index time. */
  path: string;
  /** HINT. Zero-based line number at index time. */
  line: number;
  /** HINT. Doc-absolute offsets of the task LINE at index time. */
  from: number;
  to: number;

  /** The whole line, verbatim, without its line terminator. The adapter
   *  matches on this when the task has no id. */
  sourceText: string;

  status: TaskStatus;
  /** The line's text with the checkbox, every recognised marker and the id
   *  suffix removed, trimmed. What a list row shows. */
  text: string;
  /**
   * Everything after the checkbox that we did not recognise, in source order,
   * verbatim (including its glyph). Serialization re-emits these unchanged, so
   * an Obsidian Tasks field we do not model cannot be lost by a round-trip.
   */
  unparsed: string[];

  priority: Priority | null;
  /** `#tag` values without the `#`, in source order, duplicates removed. */
  tags: string[];

  due: PlainDate | null;
  scheduled: PlainDate | null;
  start: PlainDate | null;
  done: PlainDate | null;
  cancelled: PlainDate | null;
  created: PlainDate | null;

  recurrence: Recurrence | null;

  /** Heading trail above the task, outermost first, heading text only
   *  (no `#`). Empty when the task sits above any heading. */
  section: string[];
  /** The leading whitespace of the line, verbatim (tabs stay tabs). */
  indent: string;
}

// ---------------------------------------------------------------------------
// Query subset (version 1)
// ---------------------------------------------------------------------------

export type DateField = "due" | "scheduled" | "start" | "done" | "cancelled" | "created";

/**
 * An absolute `PlainDate` or a relative phrase (`today`, `tomorrow`,
 * `next week`, `in 3 days`). Relative phrases are stored UNRESOLVED and
 * resolved at QUERY time against the clock and the vault's `weekStart`, so a
 * saved filter called "Due this week" still means this week next month.
 */
export type DateOperand = string;

export type Clause =
  | { kind: "status"; values: TaskStatus[] }
  | { kind: "date"; field: DateField; op: "before" | "after" | "on"; value: DateOperand }
  | { kind: "date"; field: DateField; op: "in"; from: DateOperand; to: DateOperand }
  /** The field is absent on the line. */
  | { kind: "date"; field: DateField; op: "none" }
  | { kind: "priority"; values: Priority[] }
  | { kind: "tag"; value: string; negated: boolean }
  /** Path PREFIX, compared case-insensitively like every other path in Noam. */
  | { kind: "path"; value: string; negated: boolean }
  /** Exact heading text, no `#`. Matches any level of the task's `section`. */
  | { kind: "heading"; value: string }
  | { kind: "text"; op: "includes" | "excludes"; value: string }
  /** `flags` is bounded to `i`; the pattern is matched, never evaluated. */
  | { kind: "text"; op: "regex"; value: string; flags: string }
  | { kind: "recurring"; value: boolean };

export type ClauseKind = Clause["kind"];

export interface SortKey {
  field: "due" | "scheduled" | "start" | "priority" | "status" | "path" | "text";
  direction: "asc" | "desc";
}

export type GroupKey = "path" | "heading" | "status" | "priority" | "due" | "tag";

export interface TaskQuery {
  /** ANDed together. Values WITHIN a clause are ORed. */
  clauses: Clause[];
  /** Applied in order; ties fall through to the next key, then to document
   *  position, so a query is stable across runs. */
  sort: SortKey[];
  group: GroupKey | null;
  /** 1 … `MAX_QUERY_LIMIT`. A larger request is clamped and reported. */
  limit: number;
}

/**
 * Hard ceiling on one query. A task list is a panel, not an export: above this
 * the UI is unusable and the SQL is a table scan the user did not ask for.
 * Paging is the answer to "I have more", not a bigger number.
 */
export const MAX_QUERY_LIMIT = 500;

export interface TaskIssue {
  severity: "error" | "warning";
  /** Machine-readable code, e.g. "unsupported-clause", "bad-date", "clamped-limit". */
  code: string;
  message: string;
  /** Zero-based clause index when the issue belongs to a clause. */
  clause?: number;
  /** Dotted field path, e.g. "sort.1.field". */
  field?: string;
}

export interface ParsedQuery {
  query: TaskQuery;
  issues: TaskIssue[];
  /** Source lines the parser did not understand, verbatim and in source order.
   *  They are SHOWN to the user; they never silently widen the result. */
  unsupported: string[];
}

// ---------------------------------------------------------------------------
// Saved filters
// ---------------------------------------------------------------------------

/** Same frontmatter key the workflow contracts use (`WORKFLOW_KIND_KEY`). */
export const NOAM_KIND_KEY = "noam_kind";

/** `noam_kind: task-filter` plus exactly one `json noam-task-filter` fence. */
export const TASK_FILTER_KIND_VALUE = "task-filter";
export const TASK_FILTER_FENCE_INFO = "json noam-task-filter";

/** Default folder. Users may keep filters anywhere; this is only a default. */
export const DEFAULT_FILTERS_FOLDER = "Tasks";

export interface SavedFilter {
  version: 1;
  /** Stable id, lowercase `[a-z0-9][a-z0-9-]{0,63}`, unique per vault. */
  id: string;
  name: string;
  description?: string;
  /**
   * The query SOURCE, not a parsed `TaskQuery`. Storing what the user typed is
   * what lets a newer app understand a clause an older one reported as
   * unsupported, instead of the file having lost it at save time.
   */
  query: string;
  /** Unknown top-level fields are preserved verbatim by the parser. */
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Calendar settings
// ---------------------------------------------------------------------------

/** One note per vault, `noam_kind: calendar-settings`, one `json noam-calendar` fence. */
export const CALENDAR_SETTINGS_PATH = "_Noam/Calendar.md";
export const CALENDAR_KIND_VALUE = "calendar-settings";
export const CALENDAR_FENCE_INFO = "json noam-calendar";

/** Sunday, Monday or Saturday — the three starts real calendars use. */
export type WeekStart = 0 | 1 | 6;

export interface PeriodicNoteSettings {
  /**
   * Vault-relative destination, expanded by the workflow engine's `formatDate`
   * token set — which is why `GGGG` (ISO week-year) and `WW` (ISO week) were
   * added there: `Journal/{{date:GGGG}}/W{{date:WW}}.md` cannot be spelled
   * with `YYYY` without being wrong for six days a year.
   */
  pathTemplate: string;
  /** Vault-relative template note. Absent = create an empty note. */
  template?: string;
}

export interface CalendarSettings {
  version: 1;
  daily: PeriodicNoteSettings;
  weekly: PeriodicNoteSettings;
  weekStart: WeekStart;
  /** BCP-47 tag for month/weekday names. Absent = the system locale. */
  locale?: string;
  /** Unknown top-level fields are preserved verbatim by the parser. */
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

/** One note = one board. `noam_kind: board`. */
export const BOARD_KIND_VALUE = "board";

/** Obsidian Kanban's own markers, recognised so its boards open unchanged. */
export const KANBAN_PLUGIN_KEY = "kanban-plugin";
export const KANBAN_PLUGIN_BASIC = "basic";
export const KANBAN_SETTINGS_OPEN = "%% kanban:settings %%";

/** The `***` rule that separates the live lanes from the archive. */
export const BOARD_ARCHIVE_SEPARATOR = "***";
export const DEFAULT_ARCHIVE_LANE = "Archive";

export interface BoardCard {
  /** A card IS a task line, so every rule above applies to it unchanged. */
  task: Task;
  /** Lines nested under the card, verbatim, with the card's indent removed. */
  body: string[];
}

export interface BoardLane {
  /** Heading text without the `## `, verbatim. */
  title: string;
  /** HINT span of the whole lane, heading line included. */
  from: number;
  to: number;
  cards: BoardCard[];
  /** The lane after the `***` separator (`## Archive` by default). */
  archive: boolean;
}

export interface BoardSettings {
  /** The `kanban-plugin` frontmatter value, or `null` for a Noam-native board. */
  kanbanPlugin: string | null;
  /** The JSON inside `%% kanban:settings %%`, VERBATIM. A settings change is a
   *  minimal span edit of this text: unknown keys and key order survive
   *  because we never reserialize the object. */
  raw: string | null;
  /** HINT span of that JSON body. */
  span: { from: number; to: number } | null;
  /** The subset we understand. Everything else lives only in `raw`. */
  laneWidth?: number;
  showCheckboxes?: boolean;
  archiveLaneTitle?: string;
}

export interface BoardDocument {
  /** HINT. Vault-relative path at parse time. */
  path: string;
  docId: string;
  lanes: BoardLane[];
  settings: BoardSettings;
  /** Unsupported Kanban settings and malformed lanes are reported here. */
  issues: TaskIssue[];
}

// ---------------------------------------------------------------------------
// Resolution — the only way to a write
// ---------------------------------------------------------------------------

export type TaskResolutionFailure =
  /** Live text no longer matches what we resolved against; refresh and retry. */
  | "stale-target"
  /** Two lines answer to the same id or the same `sourceText`; dedupe first. */
  | "ambiguous-target"
  /** The line (or the note) is gone. */
  | "missing-target"
  /** The vault posture or a share caps this note at view. */
  | "read-only";

/**
 * A task re-found in LIVE text. `from`/`to` here are the ONLY offsets a write
 * may use, and `revision` is the note hash `replaceRange` checks against, so
 * check and apply cannot straddle another edit.
 */
export interface ResolvedTask {
  path: string;
  docId: string;
  /** Doc-absolute span of the task line in live text. */
  from: number;
  to: number;
  /** The live line, which may differ from the indexed `Task.sourceText`. */
  sourceText: string;
  /** Re-parsed from the live line, not the index row. */
  task: Task;
  revision: string;
}

export type TaskResolution =
  | { ok: true; resolved: ResolvedTask }
  | {
      ok: false;
      kind: TaskResolutionFailure;
      message: string;
      /** How many lines matched, when `kind === "ambiguous-target"`. */
      matches?: number;
    };

// ---------------------------------------------------------------------------
// Shared function signatures (declared here, implemented elsewhere)
// ---------------------------------------------------------------------------

/**
 * Merge a structured edit with the lazy assignment of the block id, so both
 * reach the file as ONE span replacement (one write, one undo step).
 *
 *   declare function planAssignId(task: Task, edit: SpanChange[], id: TaskId): SpanChange[];
 *
 * `task` must come from `ResolvedTask` (live spans). When `task.id !== null`
 * the returned changes are `edit` unchanged. Implemented in
 * `src/lib/tasks/identity.ts`.
 */
export type PlanAssignId = (task: Task, edit: SpanChange[], id: TaskId) => SpanChange[];

/**
 * The id of the NEXT occurrence of a recurring series.
 *
 *   declare function occurrenceId(seriesId: SeriesId, nextDue: PlainDate): Promise<TaskId>;
 *
 * `"t-" + BigInt("0x" + sha256hex(seriesId + "\n" + nextDue)).toString(36)
 *        .padStart(10, "0").slice(0, 10)`
 *
 * Pure and total: two clients completing the same occurrence offline write a
 * byte-identical next line, so the merge is a no-op instead of a duplicate.
 * `Promise` because the only sha-256 available to the renderer
 * (`bridge/adapter.ts sha256Hex`) is async. Implemented in
 * `src/lib/tasks/recurrence.ts`.
 */
export type OccurrenceId = (seriesId: SeriesId, nextDue: PlainDate) => Promise<TaskId>;

/** Type-level proof the two signatures above are the ones implementers see. */
export type TaskPlanners = { planAssignId: PlanAssignId; occurrenceId: OccurrenceId };
