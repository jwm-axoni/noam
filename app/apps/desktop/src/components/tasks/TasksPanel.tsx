// The Tasks view: this vault's task lines, filtered by an Obsidian-Tasks-style
// query, grouped the way that query asks (due date by default, overdue first).
//
// Two rules this panel exists to keep:
//
//   A LINE WE DO NOT UNDERSTAND IS SHOWN, NEVER IGNORED. `parseQuery` reports
//   unsupported lines; they are listed above the results, because a filter
//   that silently widened would complete the wrong task.
//   EVERY STRUCTURED EDIT STAMPS AN ID. The first time an action touches an
//   unstamped line — due, priority, status — the lazy `^t-` id is folded into
//   the SAME span edit (`planAssignId`), exactly as completion does. A line
//   that has been edited once must not still depend on matching its own text.
//   EVERY WRITE GOES THROUGH THE ADAPTER. Actions call `editTask`, which
//   re-resolves the line against LIVE text; a `stale-target`/`ambiguous-target`
//   refusal refreshes the list and says so, and never retries — the second
//   write is exactly the one that would hit somebody else's line.

import { useEffect, useMemo, useState } from "react";
import type { PanelBodyProps } from "../../layout/panelRegistry";
import { permissionForPath } from "../../lib/workflows/adapter";
import {
  PRIORITY_ORDER,
  contentTaskId,
  editTask,
  mergeChanges,
  planAssignId,
  groupTasks,
  planComplete,
  planSetDate,
  planSetPriority,
  planSetStatus,
  taskNoteText,
  todayPlainDate,
  type PlainDate,
  type Priority,
  type ResolvedTask,
  type SpanChange,
  type Task,
  type TaskRef,
} from "../../lib/tasks";
import { SavedFilters } from "./SavedFilters";
import { TaskRow } from "./TaskRow";
import { refreshTasks, setFilter, useTasks } from "./service";
import "./tasks.css";

/** `null` is part of the cycle: `p` must be able to take a priority OFF. */
const PRIORITY_CYCLE: Array<Priority | null> = [null, ...PRIORITY_ORDER];

const refOf = (task: Task): TaskRef => ({
  path: task.path,
  docId: task.docId,
  id: task.id,
  line: task.line,
  sourceText: task.sourceText,
});

export function TasksPanel({ vaultEpoch, onOpenNote }: PanelBodyProps) {
  const { tasks, filterText, parsed, error } = useTasks();
  const [draft, setDraft] = useState(filterText);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // A saved filter applied elsewhere replaces what is in the box.
  useEffect(() => setDraft(filterText), [filterText]);

  const groups = useMemo(
    () => groupTasks(tasks, parsed.query.group ?? "due"),
    [tasks, parsed.query.group],
  );
  const ordered = useMemo(() => groups.flatMap((group) => group.tasks), [groups]);
  // An id is only an identity while it is UNIQUE here. Two lines carrying the
  // same `^t-` id is a supported transient state (a copy-pasted line), and
  // keying both by it would collide: one row, and the focus ring on whichever
  // React kept.
  const sharedIds = useMemo(() => {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const task of ordered) {
      if (task.id === null) continue;
      const id = `${task.path}\u0000${task.id}`;
      if (seen.has(id)) shared.add(id);
      seen.add(id);
    }
    return shared;
  }, [ordered]);
  // Identity for rendering and focus. The id when it names exactly one line —
  // so focus survives an edit that moves the line — and the line number
  // otherwise, which is what distinguishes two byte-identical (or two
  // same-id) lines in one note.
  const keyOf = (task: Task) => {
    const byId = task.id === null ? null : `${task.path}\u0000${task.id}`;
    return byId !== null && !sharedIds.has(byId) ? byId : `${task.path}\u0000line:${task.line}`;
  };
  const activeKey =
    (focusKey && ordered.some((task) => keyOf(task) === focusKey) ? focusKey : null) ??
    (ordered[0] ? keyOf(ordered[0]) : null);

  const lockOf = (task: Task) => {
    const permission = permissionForPath(task.path);
    return permission === "edit"
      ? null
      : { reason: `"${task.path}" is read-only; you have ${permission} access.` };
  };

  /**
   * The lazy identity contract: an edit to a line with no `^t-` id carries one
   * with it. Completion plans its own (`planComplete`), so this wraps the
   * OTHER actions, and folds both into one span edit.
   */
  async function stamped(resolved: ResolvedTask, changes: SpanChange[]): Promise<SpanChange[]> {
    if (resolved.task.id !== null || changes.length === 0) return changes;
    const id = await contentTaskId(resolved.task);
    return mergeChanges(planAssignId(resolved.task, changes, id));
  }

  /** True when the write landed. */
  async function run(
    task: Task,
    plan: (resolved: ResolvedTask) => SpanChange[] | Promise<SpanChange[]>,
  ): Promise<boolean> {
    const result = await editTask(refOf(task), plan);
    if (result.ok) {
      setNotice(null);
      await refreshTasks();
      return true;
    }
    if (result.kind === "stale-target" || result.kind === "ambiguous-target") {
      // Refresh, tell the user, and STOP. Retrying against text that moved is
      // how the wrong line gets completed.
      setNotice(
        result.kind === "stale-target"
          ? "That task changed on disk. The list is refreshed — try again."
          : result.message,
      );
      await refreshTasks();
      return false;
    }
    setNotice(result.message);
    return false;
  }

  const toggle = (task: Task) =>
    void (async () => {
      // A recurrence the engine could not extend is a WARNING, not a refusal:
      // the task still completes, and the user is told no successor was made.
      let warning: string | null = null;
      const ok = await run(task, async (resolved) => {
        if (resolved.task.status === "done") {
          return stamped(resolved, [
            ...planSetStatus(resolved.task, "todo"),
            ...planSetDate(resolved.task, "done", null),
          ]);
        }
        // Recurrence lives in `planComplete`: completing a `🔁` task is what
        // spawns the next occurrence, in the same span edit.
        const text = (await taskNoteText(resolved.path)) ?? "";
        const plan = await planComplete(resolved.task, text, todayPlainDate());
        warning = plan.issues.find((issue) => issue.severity === "warning")?.message ?? null;
        return plan.changes;
      });
      if (ok && warning) setNotice(`Completed — ${warning}`);
    })();

  const setDue = (task: Task, date: PlainDate | null) =>
    void run(task, (resolved) => stamped(resolved, planSetDate(resolved.task, "due", date)));

  const cyclePriority = (task: Task) =>
    void run(task, (resolved) => {
      const at = PRIORITY_CYCLE.indexOf(resolved.task.priority);
      const next = PRIORITY_CYCLE[(at + 1) % PRIORITY_CYCLE.length]!;
      return stamped(resolved, planSetPriority(resolved.task, next));
    });

  const moveFocus = (delta: number) => {
    const at = ordered.findIndex((task) => keyOf(task) === activeKey);
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, at + delta))];
    if (next) setFocusKey(keyOf(next));
  };

  const applyDraft = () => void setFilter(draft);

  return (
    <div className="tasks-panel">
      <div className="tasks-query">
        <textarea
          className="tasks-query-input"
          aria-label="Task query"
          rows={2}
          value={draft}
          spellCheck={false}
          placeholder={"not done\ndue before next week"}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={applyDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              applyDraft();
            }
          }}
        />
        <button type="button" className="tasks-query-apply" onClick={applyDraft}>
          Apply
        </button>
      </div>

      <SavedFilters
        vaultEpoch={vaultEpoch}
        currentQuery={filterText}
        onApply={(query) => void setFilter(query)}
        onError={setNotice}
      />

      {parsed.unsupported.length > 0 && (
        <div className="tasks-warnings" role="status">
          <strong>Not applied:</strong>
          <ul>
            {parsed.unsupported.map((line, index) => (
              <li key={`${line}-${index}`} data-unsupported-line={line}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {notice && (
        <div className="tasks-notice" role="alert">
          {notice}
        </div>
      )}
      {error && (
        <div className="tasks-notice" role="alert">
          {error}
        </div>
      )}

      <div className="tasks-list" role="listbox" aria-label="Tasks">
        {ordered.length === 0 && <p className="tasks-empty">No tasks match this filter.</p>}
        {groups.map((group) => (
          <section key={group.key} className="tasks-group">
            <h3 className="tasks-group-label">{group.label}</h3>
            {group.tasks.map((task) => (
              <TaskRow
                key={keyOf(task)}
                task={task}
                focused={keyOf(task) === activeKey}
                readOnly={lockOf(task)}
                onFocus={() => setFocusKey(keyOf(task))}
                onToggle={toggle}
                onSetDue={setDue}
                onCyclePriority={cyclePriority}
                onOpen={(t) => onOpenNote(t.path)}
                onMoveFocus={moveFocus}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
