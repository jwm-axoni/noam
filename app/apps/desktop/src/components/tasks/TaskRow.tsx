// One task line, and the whole keyboard contract for it.
//
// The row is the tab stop (roving tabindex over the list); with focus on it:
//   Space   toggle done — a recurring task completes through `planComplete`,
//           so the next occurrence spawns in the same write;
//   d       open a small due-date field (Enter commits, Escape cancels);
//   p       cycle the priority;
//   Enter   open the note;
//   ↑ / ↓   move focus to the next / previous row.
//
// A row that cannot be written renders every control disabled, with the reason
// as a `title` AND as a visible label: a padlock nobody can read is a bug
// report waiting to happen.
//
// The layout is two lines because the panel is 220 px wide at its narrowest:
// checkbox + text, then the meta (due, priority, note).

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PRIORITY_MARKERS, type PlainDate, type Task } from "../../lib/tasks";
import { noteLabel } from "../../lib/notePath";

export interface TaskRowProps {
  task: Task;
  focused: boolean;
  /** Present when this note cannot be written; the reason is SHOWN. */
  readOnly: { reason: string } | null;
  onFocus: () => void;
  onToggle: (task: Task) => void;
  onSetDue: (task: Task, date: PlainDate | null) => void;
  onCyclePriority: (task: Task) => void;
  onOpen: (task: Task) => void;
  /** `+1` = next row, `-1` = previous. */
  onMoveFocus: (delta: number) => void;
}

const CHECKBOX_GLYPH: Record<Task["status"], string> = {
  todo: "",
  done: "✓",
  "in-progress": "/",
  cancelled: "×",
};

export function TaskRow({
  task,
  focused,
  readOnly,
  onFocus,
  onToggle,
  onSetDue,
  onCyclePriority,
  onOpen,
  onMoveFocus,
}: TaskRowProps) {
  const [editingDate, setEditingDate] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const locked = readOnly !== null;

  useEffect(() => {
    if (focused && !editingDate && document.activeElement !== rowRef.current) {
      // Only pull DOM focus when focus already lives in this list; mounting the
      // panel must never steal it from the editor.
      if (rowRef.current?.parentElement?.contains(document.activeElement)) {
        rowRef.current.focus();
      }
    }
  }, [focused, editingDate]);

  useEffect(() => {
    if (editingDate) dateRef.current?.focus();
  }, [editingDate]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case " ":
        event.preventDefault();
        if (!locked) onToggle(task);
        break;
      case "d":
        event.preventDefault();
        if (!locked) setEditingDate(true);
        break;
      case "p":
        event.preventDefault();
        if (!locked) onCyclePriority(task);
        break;
      case "Enter":
        event.preventDefault();
        onOpen(task);
        break;
      case "ArrowDown":
        event.preventDefault();
        onMoveFocus(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        onMoveFocus(-1);
        break;
      default:
        break;
    }
  }

  function handleDateKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // The field lives inside the row: nothing typed here may reach the row's
    // shortcuts (Space would complete the task, Enter would open the note).
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      const value = dateRef.current?.value ?? "";
      setEditingDate(false);
      onSetDue(task, value === "" ? null : value);
      rowRef.current?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditingDate(false);
      rowRef.current?.focus();
    }
  }

  return (
    <div
      ref={rowRef}
      className={`task-row${task.status === "done" ? " done" : ""}${locked ? " locked" : ""}`}
      role="option"
      aria-selected={focused}
      aria-disabled={locked || undefined}
      data-task-row={task.sourceText}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      onKeyDown={handleKeyDown}
    >
      <div className="task-row-main">
        <button
          type="button"
          className="task-check"
          role="checkbox"
          aria-checked={task.status === "done"}
          aria-label={task.status === "done" ? `Reopen ${task.text}` : `Complete ${task.text}`}
          disabled={locked}
          title={readOnly?.reason}
          onClick={() => onToggle(task)}
        >
          {CHECKBOX_GLYPH[task.status]}
        </button>
        <span className="task-text">{task.text}</span>
      </div>
      <div className="task-meta">
        {task.due && <span className="task-due">📅 {task.due}</span>}
        {task.priority && (
          <span className="task-priority" title={task.priority}>
            {PRIORITY_MARKERS[task.priority]}
          </span>
        )}
        {task.recurrence && <span className="task-recurring" title={task.recurrence.raw}>🔁</span>}
        <span className="task-note" title={task.path}>{noteLabel(task.path)}</span>
        {readOnly && (
          <span className="task-locked" title={readOnly.reason}>Read-only</span>
        )}
      </div>
      {editingDate && (
        <input
          ref={dateRef}
          className="task-date-input"
          type="date"
          aria-label={`Due date for ${task.text}`}
          defaultValue={task.due ?? ""}
          disabled={locked}
          onKeyDown={handleDateKeyDown}
          onBlur={() => setEditingDate(false)}
        />
      )}
    </div>
  );
}
