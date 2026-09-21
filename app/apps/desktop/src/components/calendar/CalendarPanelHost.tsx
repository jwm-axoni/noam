// The Calendar panel's host: the file that knows about this vault, so
// `CalendarPanel` itself does not.
//
// Everything the panel needs arrives as a prop — the settings note, which days
// already have a note, the due badges, and what Enter/`w` do. The two rules
// that shaped it:
//
//   CREATION GOES THROUGH THE WORKFLOW ENGINE. `createViaWorkflow` runs an
//   ad-hoc single-step `create-note` definition through `runWorkflow` +
//   `createWorkflowHost`, so a daily note gets the same permission check,
//   collision handling and frozen-root refusal a workflow author's
//   `create-note` step gets. There is no second create path to keep in sync.
//   BADGES FOLLOW THE MONTH ON SCREEN, AND THE TASK SERVICE. The panel owns
//   its focused month and reports it (`onMonthChange`), so navigating past the
//   prefetched window re-queries instead of badging zero; and the query re-runs
//   on every task-service publish, because an ordinary task edit changes no
//   note title.
//   SETTINGS NEVER THROW. A missing or malformed `_Noam/Calendar.md` falls
//   back to `DEFAULT_CALENDAR_SETTINGS` (`parseCalendarSettings` reports why).

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PanelBodyProps } from "../../layout/panelRegistry";
import * as ipc from "../../lib/ipc";
import { useStore } from "../../store";
import {
  DEFAULT_CALENDAR_SETTINGS,
  addMonths,
  openOrCreateDailyNote,
  openOrCreateWeeklyNote,
  parseCalendarSettings,
  today as todayDate,
  type DailyNoteDeps,
} from "../../lib/calendar";
import {
  CALENDAR_SETTINGS_PATH,
  type CalendarSettings,
  type PlainDate,
} from "../../lib/tasks";
import { createWorkflowHost, runWorkflow } from "../../lib/workflows";
import { currentEditorContext } from "../workflows/editorContext";
import { dueCountsByDate, useTasks } from "../tasks/service";
import CalendarPanel from "./CalendarPanel";

/** The I/O half, injected so the open-or-create flow stays testable. */
export function calendarNoteDeps(epoch: ipc.VaultEpoch): DailyNoteDeps {
  return {
    exists: (path) => ipc.noteExists(path, epoch),
    open: (path) => useStore.getState().openNoteByPath(path),
    createViaWorkflow: (definition, values) =>
      runWorkflow(definition, values, currentEditorContext(), createWorkflowHost()),
  };
}

/** First and last day of the window we badge: the month around `date`, with a
 *  month either side so one PageUp/PageDown is already painted. */
function badgeWindow(date: PlainDate): { from: PlainDate; to: PlainDate } {
  const first = `${addMonths(date, -1).slice(0, 7)}-01`;
  const lastMonth = addMonths(date, 2).slice(0, 7);
  return { from: first, to: `${lastMonth}-01` };
}

export function CalendarPanelHost({ vaultKey, vaultEpoch }: PanelBodyProps) {
  const titles = useStore((state) => state.titles);
  // The badge counts follow the TASK service, not the title list: completing or
  // rescheduling a task in an existing note changes no title, and `titles` kept
  // the badge stale until something unrelated happened.
  const { tasks } = useTasks();
  // Which month `CalendarPanel` is showing — it owns that state, and tells us.
  const [shownMonth, setShownMonth] = useState<string>(() => todayDate().slice(0, 7));
  const onMonthChange = useCallback((year: number, month: number) => {
    setShownMonth(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`);
  }, []);
  const [settings, setSettings] = useState<CalendarSettings>(DEFAULT_CALENDAR_SETTINGS);
  const [dueCounts, setDueCounts] = useState<Map<PlainDate, number>>(() => new Map());

  // `_Noam/Calendar.md` is an ordinary note, so the watcher's title refresh is
  // the beat to re-read it on.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let text: string | null = null;
      try {
        text = await ipc.readNote(CALENDAR_SETTINGS_PATH, vaultEpoch);
      } catch {
        text = null;
      }
      if (cancelled) return;
      setSettings(text === null ? DEFAULT_CALENDAR_SETTINGS : parseCalendarSettings(text).settings);
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultKey, vaultEpoch, titles]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const counts = await dueCountsByDate(badgeWindow(`${shownMonth}-01`));
        if (!cancelled) setDueCounts(counts);
      } catch {
        if (!cancelled) setDueCounts(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultKey, tasks, shownMonth]);

  // Paths compare case-insensitively here exactly as they do everywhere else.
  const known = useMemo(
    () => new Set(titles.map((title) => title.path.toLowerCase())),
    [titles],
  );

  const deps = useMemo(() => calendarNoteDeps(vaultEpoch), [vaultEpoch]);

  return (
    <CalendarPanel
      settings={settings}
      dueCounts={dueCounts}
      noteExists={(path) => known.has(path.toLowerCase())}
      onOpenDay={(date) => void openOrCreateDailyNote(settings, date, deps)}
      onOpenWeek={(date) => void openOrCreateWeeklyNote(settings, date, deps)}
      onMonthChange={onMonthChange}
    />
  );
}

export default CalendarPanelHost;
