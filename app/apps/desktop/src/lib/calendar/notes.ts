/**
 * Periodic-note paths and the open-or-create flow the calendar panel drives
 * from Enter (daily) and `w` (weekly).
 *
 * Path expansion reuses the workflow engine's `{{date:…}}` token set
 * (`expand`/`formatDate`) rather than reimplementing it, so a calendar
 * template and a workflow template mean the same thing. The `now` the scope
 * carries is built from the `PlainDate` being opened, not the wall clock —
 * that is the "fixed clock" the plan calls for, and it is what makes
 * `dailyNotePath`/`weeklyNotePath` pure and deterministic in tests.
 *
 * Creation goes through an AD-HOC `WorkflowDefinition` with a single
 * `create-note` step, run via `deps.createViaWorkflow` — never a raw
 * `ipc.createNote` — so `onExists`, collisions and permissions are the exact
 * same code path a workflow author's `create-note` step gets. `deps.exists`
 * only decides open-vs-create; the note is never checked twice.
 */

import { expand, type ExecutionResult, type PromptValues, type WorkflowDefinition } from "../workflows";
import type { CalendarSettings, PlainDate } from "../tasks/contracts";

function toLocalDate(date: PlainDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

function expandPathTemplate(template: string, date: PlainDate): string {
  return expand(template, { values: {}, declared: new Set(), now: toLocalDate(date) }).text;
}

/** Vault-relative path of `date`'s daily note, per `settings.daily.pathTemplate`. */
export function dailyNotePath(settings: CalendarSettings, date: PlainDate): string {
  return expandPathTemplate(settings.daily.pathTemplate, date);
}

/** Vault-relative path of the weekly note covering `date`, per `settings.weekly.pathTemplate`. */
export function weeklyNotePath(settings: CalendarSettings, date: PlainDate): string {
  return expandPathTemplate(settings.weekly.pathTemplate, date);
}

export interface DailyNoteDeps {
  /** Does a note already exist at this vault-relative path? */
  exists(path: string): boolean | Promise<boolean>;
  /** Open the note already at this path. */
  open(path: string): void | Promise<void>;
  /** Run an ad-hoc single-step `create-note` workflow. */
  createViaWorkflow(definition: WorkflowDefinition, values: PromptValues): Promise<ExecutionResult>;
}

function createNoteDefinition(id: string, path: string, template: string | undefined): WorkflowDefinition {
  return {
    version: 1,
    id,
    name: "Calendar note",
    slash: false,
    steps: [
      {
        type: "create-note",
        path,
        open: false,
        ...(template === undefined ? {} : { template }),
      },
    ],
  };
}

function openedResult(id: string, path: string): ExecutionResult {
  return { ok: true, workflowId: id, effects: [{ kind: "opened", path }], warnings: [] };
}

async function openOrCreateNote(
  workflowId: string,
  path: string,
  template: string | undefined,
  deps: DailyNoteDeps,
): Promise<ExecutionResult> {
  if (await deps.exists(path)) {
    await deps.open(path);
    return openedResult(workflowId, path);
  }
  const result = await deps.createViaWorkflow(createNoteDefinition(workflowId, path, template), {});
  if (result.ok) await deps.open(path);
  return result;
}

/** Open `date`'s daily note, creating it (with its configured template, if
 *  any) through the workflow engine's create-note semantics when missing. */
export function openOrCreateDailyNote(
  settings: CalendarSettings,
  date: PlainDate,
  deps: DailyNoteDeps,
): Promise<ExecutionResult> {
  return openOrCreateNote("noam-calendar-daily-note", dailyNotePath(settings, date), settings.daily.template, deps);
}

/** Open the weekly note covering `date`, creating it when missing. */
export function openOrCreateWeeklyNote(
  settings: CalendarSettings,
  date: PlainDate,
  deps: DailyNoteDeps,
): Promise<ExecutionResult> {
  return openOrCreateNote("noam-calendar-weekly-note", weeklyNotePath(settings, date), settings.weekly.template, deps);
}
