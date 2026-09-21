// The month grid itself: 7 columns, up to 6 rows, one roving-tabindex ARIA
// grid. Purely presentational — `CalendarPanel` owns the focused date, the
// displayed month and the keyboard handling; this component only renders a
// `weeks` grid and reports focus/activation back up.
//
// `role="gridcell"` divs, not `<button>`s: a `<button>`'s native Enter
// activation would fire a synthetic click on top of whatever `onActivate`
// already did for the Enter key one level up, double-firing "open this day".

import { isSameMonth } from "../../lib/calendar";
import type { PlainDate, WeekStart } from "../../lib/tasks/contracts";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function weekdayLabels(weekStart: WeekStart): readonly string[] {
  return [...WEEKDAY_LABELS.slice(weekStart), ...WEEKDAY_LABELS.slice(0, weekStart)];
}

export interface CalendarGridProps {
  /** 6 rows x 7 columns, from `monthGrid`. */
  weeks: PlainDate[][];
  /** The displayed month, 1-12 (with `year`, decides which days are dimmed). */
  month: number;
  year: number;
  /** The one day with `tabIndex={0}` / `aria-selected`. */
  focused: PlainDate;
  today: PlainDate;
  weekStart: WeekStart;
  hasNote: (date: PlainDate) => boolean;
  dueCount: (date: PlainDate) => number;
  /** A day gained focus (click, or roving-tabindex keyboard move). */
  onFocus: (date: PlainDate) => void;
  /** A day was activated (click, or Enter handled by the parent). */
  onActivate: (date: PlainDate) => void;
}

export function CalendarGrid({
  weeks,
  month,
  year,
  focused,
  today,
  weekStart,
  hasNote,
  dueCount,
  onFocus,
  onActivate,
}: CalendarGridProps) {
  const monthAnchor = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;

  return (
    <div className="calendar-grid" role="grid" aria-label="Month">
      <div className="calendar-grid-row calendar-grid-weekdays" role="row">
        {weekdayLabels(weekStart).map((label) => (
          <div key={label} className="calendar-grid-weekday" role="columnheader">
            {label}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <div className="calendar-grid-row" role="row" key={week[0]}>
          {week.map((date) => {
            const selected = date === focused;
            const count = dueCount(date);
            const classNames = [
              "calendar-day",
              isSameMonth(date, monthAnchor) ? "" : "calendar-day-outside",
              date === today ? "calendar-day-today" : "",
              hasNote(date) ? "calendar-day-has-note" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={date}
                role="gridcell"
                data-date={date}
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                className={classNames}
                onClick={() => {
                  onFocus(date);
                  onActivate(date);
                }}
              >
                <span className="calendar-day-number">{Number(date.slice(8, 10))}</span>
                {count > 0 && <span className="calendar-day-count">{count}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
