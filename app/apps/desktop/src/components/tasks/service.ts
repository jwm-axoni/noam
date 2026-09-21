// The one task service this app holds, and the React hook over it.
//
// Modelled on `components/workflows/service.ts`, for the same reason: the list
// it publishes is a query against THIS vault's derived index, so switching
// vaults must build a new one rather than answer from the old one's rows.
//
// Two rules this file exists to keep:
//
//   REFRESHES ARE SERIALIZED. Every refresh takes a token and joins one chain;
//   a page that comes back after a newer refresh was asked for is DROPPED
//   rather than published, so a burst of watcher batches can never leave the
//   panel showing an older answer than the one it already painted.
//   THE LIMIT IS APPLIED LAST. The index can only express some of a query's
//   clauses; the rest run here, over the rows. So a query with a clause the
//   index cannot express pages through ALL of its candidates (to a hard cap)
//   and lets `selectTasks` sort and clamp — asking the index for `limit` rows
//   first is what made `description includes foo limit 1` answer "nothing".
//   OFFSETS FROM THE INDEX NEVER REACH A WRITE. Rows are re-parsed into `Task`
//   values whose `line`/`from`/`to` are hints; every action goes back through
//   `lib/tasks/adapter.ts`, which re-finds the line in live text.

import { useSyncExternalStore } from "react";
import * as ipc from "../../lib/ipc";
import {
  MAX_QUERY_LIMIT,
  addDays,
  parseQuery,
  parseTaskLine,
  selectTasks,
  type ParsedQuery,
  type PlainDate,
  type Task,
} from "../../lib/tasks";

/** What the panel reads. One frozen object per publish. */
export interface TasksSnapshot {
  /** Filtered, sorted and clamped by the current query. */
  tasks: readonly Task[];
  /** The query text as typed. */
  filterText: string;
  parsed: ParsedQuery;
  /** Rows the index matched before the client-side clauses narrowed them. */
  total: number;
  loading: boolean;
  /** Set when the last refresh threw (a closed vault, a stale epoch). */
  error: string | null;
}

/** "Everything still to do" — what an empty panel opens on. */
export const DEFAULT_FILTER = "not done";

const EMPTY: TasksSnapshot = {
  tasks: [],
  filterText: DEFAULT_FILTER,
  parsed: parseQuery(DEFAULT_FILTER),
  total: 0,
  loading: false,
  error: null,
};

let vaultKey: string | null = null;
let snapshot: TasksSnapshot = EMPTY;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function publish(next: Partial<TasksSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  notify();
}

/** Which vault the live service belongs to (its path), or null. */
export function getTaskVaultKey(): string | null {
  return vaultKey;
}

/**
 * Point the service at `vaultPath`, replacing a service from another vault.
 * Idempotent for the same key, so the effect that calls it can re-run freely.
 * Does NOT query — call `refreshTasks()`.
 */
export function openTaskService(vaultPath: string): void {
  if (vaultKey === vaultPath) return;
  closeTaskService();
  vaultKey = vaultPath;
  notify();
}

/** Tear down on vault switch or unmount. */
export function closeTaskService(): void {
  vaultKey = null;
  // A newer token than anything in flight: results already on the wire for the
  // vault we just closed cannot publish into the next one, and the queue they
  // were waiting in is abandoned rather than held open behind them.
  token += 1;
  chain = Promise.resolve();
  // The filter goes back to the default too: "path: Projects" means a folder
  // in the vault that is closing, not one in the vault that opens next.
  snapshot = EMPTY;
  notify();
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

/** Replace the query and re-run it. Unsupported lines are reported, not dropped. */
export function setFilter(queryText: string): Promise<void> {
  publish({ filterText: queryText, parsed: parseQuery(queryText) });
  return refreshTasks();
}

export function getFilter(): string {
  return snapshot.filterText;
}

/**
 * The narrowing we can hand the index without guessing.
 *
 * Only clauses that map 1:1 onto a column go here; everything else — relative
 * dates, regex, headings, negations — is applied by `selectTasks` over the
 * rows, which is the same code the saved-filter tests pin.
 *
 * `exhaustive` says whether the index alone decided the answer. When it is
 * false the index's page is a CANDIDATE SET, not a result: asking it for
 * `limit` rows would cut the list before the client-side clauses ever saw the
 * row that matches, so the caller pages through everything instead.
 */
function indexQuery(parsed: ParsedQuery): { query: ipc.LocalTaskQuery; exhaustive: boolean } {
  const query: ipc.LocalTaskQuery = {};
  let exhaustive = true;
  for (const clause of parsed.query.clauses) {
    if (clause.kind === "status" && query.statuses === undefined) {
      query.statuses = [...clause.values];
    } else if (clause.kind === "tag" && !clause.negated && query.tag == null) {
      query.tag = clause.value;
    } else if (clause.kind === "path" && !clause.negated && query.pathPrefix == null) {
      query.pathPrefix = clause.value;
    } else {
      exhaustive = false;
    }
  }
  return { query, exhaustive };
}

/**
 * The most rows a client-side scan will pull out of the index. A vault big
 * enough to hit this gets a truncated answer and is TOLD so (`results-capped`),
 * rather than a silently short list or a frozen panel.
 */
export const MAX_SCANNED_TASKS = 5000;

const CAPPED_CODE = "results-capped";

/** `parsed` with our own cap warning added or cleared — never stacked. */
function withCapIssue(parsed: ParsedQuery, capped: boolean): ParsedQuery {
  const issues = parsed.issues.filter((issue) => issue.code !== CAPPED_CODE);
  if (!capped) return issues.length === parsed.issues.length ? parsed : { ...parsed, issues };
  return {
    ...parsed,
    issues: [
      ...issues,
      {
        severity: "warning",
        code: CAPPED_CODE,
        message: `More than ${MAX_SCANNED_TASKS} tasks matched before this filter narrowed them; results are capped. Add a path or tag clause to narrow the search.`,
      },
    ],
  };
}

function rowToTask(row: ipc.LocalTaskRow): Task | null {
  return parseTaskLine(row.sourceText, {
    docId: row.noteId,
    path: row.path,
    line: row.line,
    from: row.charFrom,
  });
}

let token = 0;
let chain: Promise<void> = Promise.resolve();

async function runRefresh(mine: number, key: string): Promise<void> {
  // A newer refresh was asked for while this one waited its turn.
  if (mine !== token || vaultKey !== key) return;
  const parsed = snapshot.parsed;
  const { query, exhaustive } = indexQuery(parsed);
  const limit = Math.min(parsed.query.limit, MAX_QUERY_LIMIT, ipc.MAX_TASK_PAGE_SIZE);
  try {
    const tasks: Task[] = [];
    let total = 0;
    let scanned = 0;
    let capped = false;
    let offset = 0;
    for (;;) {
      const page = await ipc.queryTasks(
        query,
        exhaustive ? { limit } : { limit: ipc.MAX_TASK_PAGE_SIZE, offset },
      );
      if (mine !== token || vaultKey !== key) return;
      total = page.total;
      scanned += page.items.length;
      for (const row of page.items) {
        const task = rowToTask(row);
        if (task) tasks.push(task);
      }
      // One page is the whole answer when the index applied every clause.
      if (exhaustive || page.nextOffset === null) break;
      if (scanned >= MAX_SCANNED_TASKS) {
        capped = true;
        break;
      }
      offset = page.nextOffset;
    }
    publish({
      tasks: selectTasks(parsed.query, tasks),
      parsed: withCapIssue(parsed, capped),
      total,
      loading: false,
      error: null,
    });
  } catch (err) {
    if (mine !== token || vaultKey !== key) return;
    publish({ tasks: [], total: 0, loading: false, error: String(err) });
  }
}

/** Re-run the current filter. Safe to call with no vault open. */
export function refreshTasks(): Promise<void> {
  const key = vaultKey;
  if (key === null) return Promise.resolve();
  const mine = (token += 1);
  publish({ loading: true });
  chain = chain.then(() => runRefresh(mine, key));
  return chain;
}

// ---------------------------------------------------------------------------
// The calendar's badge
// ---------------------------------------------------------------------------

/**
 * How many open tasks are due on each day of `[from, to]`.
 *
 * Its own query, not a slice of the panel's: the calendar shows a month the
 * panel's filter knows nothing about. The index compares dates as strings and
 * its bounds are exclusive, hence the one-day margin.
 *
 * EVERY page is counted, under the same `MAX_SCANNED_TASKS` cap the panel's
 * refresh uses. A busy month holds more than one page of open tasks, and
 * counting only the first one badges some days with a number smaller than the
 * list they open — which reads as a bug in the list, not in the badge.
 */
export async function dueCountsByDate(range: {
  from: PlainDate;
  to: PlainDate;
}): Promise<Map<PlainDate, number>> {
  const counts = new Map<PlainDate, number>();
  if (vaultKey === null) return counts;
  const query = {
    statuses: ["todo", "in-progress"] as const,
    dueAfter: addDays(range.from, -1),
    dueBefore: addDays(range.to, 1),
  };
  let offset = 0;
  let scanned = 0;
  for (;;) {
    const page = await ipc.queryTasks(
      { ...query, statuses: [...query.statuses] },
      { limit: ipc.MAX_TASK_PAGE_SIZE, offset },
    );
    scanned += page.items.length;
    for (const row of page.items) {
      if (!row.due) continue;
      counts.set(row.due, (counts.get(row.due) ?? 0) + 1);
    }
    if (page.nextOffset === null || scanned >= MAX_SCANNED_TASKS) break;
    offset = page.nextOffset;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// React + the watcher
// ---------------------------------------------------------------------------

export function subscribeTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function tasksSnapshot(): TasksSnapshot {
  return snapshot;
}

export function useTasks(): TasksSnapshot {
  return useSyncExternalStore(subscribeTasks, tasksSnapshot, tasksSnapshot);
}

/**
 * Does this watcher batch mean the list is out of date? A task lives in an
 * ordinary `.md` note, so any Markdown change can add, complete or remove one —
 * and `_Noam/Calendar.md` changes the week start the relative dates resolve
 * against, which is the same list seen differently.
 */
export function batchTouchesTasks(
  changes: ReadonlyArray<{ path: string; kind: string }>,
): boolean {
  // `_Noam/Calendar.md` — which sets the week start the relative dates resolve
  // against — is a `.md` note too, so one test covers both.
  return changes.some((change) => change.path.toLowerCase().endsWith(".md"));
}
