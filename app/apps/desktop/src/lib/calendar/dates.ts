/**
 * Pure `PlainDate` arithmetic for the calendar panel.
 *
 * Every `Date` here is built from local `y/m/d` parts (`new Date(y, m - 1,
 * d)`) and read back with `getFullYear`/`getMonth`/`getDate` — never
 * `toISOString`, never UTC — so a day stays the same calendar day regardless
 * of time zone or a DST transition inside it (see `tasks/contracts.ts`
 * "Floating dates"). Adding days moves the `Date` object's day field
 * (`setDate`), not a millisecond offset, which is what keeps a day whole
 * across a spring-forward/fall-back boundary.
 */

import type { PlainDate, WeekStart } from "../tasks/contracts";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toDate(date: PlainDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

function fromDate(d: Date): PlainDate {
  return `${String(d.getFullYear()).padStart(4, "0")}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Today, as the local wall-clock calendar day. */
export function today(): PlainDate {
  return fromDate(new Date());
}

/** `date` shifted by `days` (negative moves backward). Whole-day arithmetic
 *  via `Date#setDate`, so a DST boundary never skips or repeats a day. */
export function addDays(date: PlainDate, days: number): PlainDate {
  const d = toDate(date);
  d.setDate(d.getDate() + days);
  return fromDate(d);
}

/** `date` shifted by `months` (negative moves backward), clamped to the last
 *  day of the target month (31 Jan + 1 month = 28/29 Feb, never 3 March). */
export function addMonths(date: PlainDate, months: number): PlainDate {
  const d = toDate(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInMonth));
  return fromDate(d);
}

/** The first day of `date`'s week, given which weekday starts a week. */
export function startOfWeek(date: PlainDate, weekStart: WeekStart): PlainDate {
  const dow = toDate(date).getDay();
  const diff = (dow - weekStart + 7) % 7;
  return addDays(date, -diff);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ISO 8601 week-year and week number: week 1 is the week containing the
 * year's first Thursday, weeks run Monday to Sunday. Mirrors the algorithm in
 * `workflows/engine/variables.ts` `isoWeek` (same definition, independently
 * implemented here over `PlainDate` rather than a `Date` built from `now`).
 */
export function isoWeek(date: PlainDate): { year: number; week: number } {
  const d = toDate(date);
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  thursday.setDate(thursday.getDate() - ((thursday.getDay() + 6) % 7) + 3);
  const year = thursday.getFullYear();

  const firstThursday = new Date(year, 0, 4);
  firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);

  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return { year, week };
}

/**
 * A 6-row-by-7-column grid of `PlainDate`s covering `month` (1-12) of `year`,
 * padded with the trailing days of the previous month and the leading days of
 * the next so every row is a full week starting on `weekStart`.
 */
export function monthGrid(year: number, month: number, weekStart: WeekStart): PlainDate[][] {
  const firstOfMonth = fromDate(new Date(year, month - 1, 1));
  const rows: PlainDate[][] = [];
  let cursor = startOfWeek(firstOfMonth, weekStart);
  for (let r = 0; r < 6; r++) {
    const row: PlainDate[] = [];
    for (let c = 0; c < 7; c++) {
      row.push(cursor);
      cursor = addDays(cursor, 1);
    }
    rows.push(row);
  }
  return rows;
}

/** String comparison is correct here: `YYYY-MM-DD` sorts chronologically. */
export function compare(a: PlainDate, b: PlainDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isSameMonth(a: PlainDate, b: PlainDate): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}
