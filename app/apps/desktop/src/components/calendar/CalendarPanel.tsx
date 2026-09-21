// The Calendar panel: a month view over the vault's daily notes.
//
// Every data source is optional and injected — `noteExists`, `dueCounts`,
// `onOpenDay`, `onOpenWeek`, `settings` — so this file has no import of
// `ipc`, the store, or the workflow host. The caller that places this panel
// wires those to the real vault (existence via a note-path lookup, opening
// via `openOrCreateDailyNote`/`openOrCreateWeeklyNote` from `lib/calendar`).
// With no props at all it still renders a full month with no marks.
//
// Keyboard: arrow keys move the focused day (roving tabindex, one grid cell
// at a time); PageUp/PageDown move a month, clamped to the shorter month's
// last day; `t` jumps to today; Enter opens/creates the focused day's note;
// `w` opens/creates the note for its week. All of it re-derives from a single
// `focused: PlainDate` — there is no separate "displayed month" state, the
// grid always shows the month `focused` falls in.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CalendarGrid } from "./CalendarGrid";
import {
  DEFAULT_CALENDAR_SETTINGS,
  addDays,
  addMonths,
  dailyNotePath,
  monthGrid,
  today as todayDate,
} from "../../lib/calendar";
import type { CalendarSettings, PlainDate } from "../../lib/tasks/contracts";
import "./calendar.css";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface CalendarPanelProps {
  /** Does a daily note already exist at this vault-relative path? */
  noteExists?: (path: string) => boolean;
  /** Due-task count per day, for the badge. */
  dueCounts?: Map<PlainDate, number>;
  /** Enter (or a click) on a day: open/create its daily note. */
  onOpenDay?: (date: PlainDate) => void;
  /** `w` on a focused day: open/create the note for its week. */
  onOpenWeek?: (date: PlainDate) => void;
  settings?: CalendarSettings;
  /** Which day starts focused/displayed. Defaults to today; a test hook. */
  initialDate?: PlainDate;
  /**
   * The month now on screen (1-12), whenever it changes and on mount. The
   * panel owns its focused month; the host needs it to fetch badges for the
   * dates a user actually navigated to.
   */
  onMonthChange?: (year: number, month: number) => void;
}

function yearMonthOf(date: PlainDate): [number, number] {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return [y, m];
}

export default function CalendarPanel({
  noteExists,
  dueCounts,
  onOpenDay,
  onOpenWeek,
  settings = DEFAULT_CALENDAR_SETTINGS,
  initialDate,
  onMonthChange,
}: CalendarPanelProps) {
  const [today] = useState<PlainDate>(() => todayDate());
  const [focused, setFocused] = useState<PlainDate>(() => initialDate ?? today);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [year, month] = useMemo(() => yearMonthOf(focused), [focused]);
  const weeks = useMemo(
    () => monthGrid(year, month, settings.weekStart),
    [year, month, settings.weekStart],
  );

  const hasNote = (date: PlainDate) => noteExists?.(dailyNotePath(settings, date)) ?? false;
  const dueCount = (date: PlainDate) => dueCounts?.get(date) ?? 0;

  useEffect(() => {
    onMonthChange?.(year, month);
  }, [onMonthChange, year, month]);

  // Roving tabindex: keep DOM focus on the cell that becomes `focused`, but
  // only when focus is already inside the grid — a header button click or
  // the initial mount must never steal page focus.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !wrap.contains(document.activeElement)) return;
    wrap.querySelector<HTMLElement>(`[data-date="${focused}"]`)?.focus();
  }, [focused]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        setFocused((f) => addDays(f, -1));
        break;
      case "ArrowRight":
        event.preventDefault();
        setFocused((f) => addDays(f, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setFocused((f) => addDays(f, -7));
        break;
      case "ArrowDown":
        event.preventDefault();
        setFocused((f) => addDays(f, 7));
        break;
      case "PageUp":
        event.preventDefault();
        setFocused((f) => addMonths(f, -1));
        break;
      case "PageDown":
        event.preventDefault();
        setFocused((f) => addMonths(f, 1));
        break;
      case "t":
      case "T":
        event.preventDefault();
        setFocused(today);
        break;
      case "Enter":
        event.preventDefault();
        onOpenDay?.(focused);
        break;
      case "w":
      case "W":
        event.preventDefault();
        onOpenWeek?.(focused);
        break;
      default:
        break;
    }
  }

  return (
    <div className="calendar-panel">
      <header className="calendar-panel-header">
        <button
          type="button"
          className="calendar-nav-btn"
          aria-label="Previous month"
          onClick={() => setFocused((f) => addMonths(f, -1))}
        >
          ‹
        </button>
        <div className="calendar-panel-title">
          {MONTH_NAMES[month - 1]} {year}
        </div>
        <button
          type="button"
          className="calendar-nav-btn"
          aria-label="Next month"
          onClick={() => setFocused((f) => addMonths(f, 1))}
        >
          ›
        </button>
        <button type="button" className="calendar-today-btn" onClick={() => setFocused(today)}>
          Today
        </button>
      </header>
      <div className="calendar-panel-grid-wrap" ref={wrapRef} onKeyDown={handleKeyDown}>
        <CalendarGrid
          weeks={weeks}
          year={year}
          month={month}
          focused={focused}
          today={today}
          weekStart={settings.weekStart}
          hasNote={hasNote}
          dueCount={dueCount}
          onFocus={setFocused}
          onActivate={(date) => {
            setFocused(date);
            onOpenDay?.(date);
          }}
        />
      </div>
    </div>
  );
}
