/**
 * The calendar library's public surface. UI code imports from here, not from
 * the individual modules, so `dates.ts`/`settings.ts`/`notes.ts` stay free to
 * reorganise.
 */

export { addDays, addMonths, compare, isSameMonth, isoWeek, monthGrid, startOfWeek, today } from "./dates";

export {
  DEFAULT_CALENDAR_SETTINGS,
  parseCalendarSettings,
  serializeCalendarSettings,
  type CalendarSettingsIssue,
} from "./settings";

export {
  dailyNotePath,
  openOrCreateDailyNote,
  openOrCreateWeeklyNote,
  weeklyNotePath,
  type DailyNoteDeps,
} from "./notes";
