import { describe, expect, it, vi } from "vitest";
import type { ExecutionResult, WorkflowDefinition } from "../../workflows";
import { DEFAULT_CALENDAR_SETTINGS } from "../settings";
import { dailyNotePath, openOrCreateDailyNote, openOrCreateWeeklyNote, weeklyNotePath } from "../notes";
import type { CalendarSettings } from "../../tasks/contracts";

describe("dailyNotePath / weeklyNotePath", () => {
  it("expands the default templates against the given date, not the wall clock", () => {
    expect(dailyNotePath(DEFAULT_CALENDAR_SETTINGS, "2026-03-09")).toBe("Journal/2026/2026-03-09.md");
    // 2026-03-09 is a Monday, ISO week 11 of 2026.
    expect(weeklyNotePath(DEFAULT_CALENDAR_SETTINGS, "2026-03-09")).toBe("Journal/2026/Week 11.md");
  });

  it("uses the ISO week-year across a year boundary", () => {
    expect(weeklyNotePath(DEFAULT_CALENDAR_SETTINGS, "2026-12-31")).toBe("Journal/2026/Week 53.md");
  });
});

describe("openOrCreateDailyNote", () => {
  const settings: CalendarSettings = DEFAULT_CALENDAR_SETTINGS;
  const date = "2026-03-09";
  const path = dailyNotePath(settings, date);

  it("opens an existing note without creating one", async () => {
    const exists = vi.fn().mockResolvedValue(true);
    const open = vi.fn().mockResolvedValue(undefined);
    const createViaWorkflow = vi.fn();

    const result = await openOrCreateDailyNote(settings, date, { exists, open, createViaWorkflow });

    expect(exists).toHaveBeenCalledWith(path);
    expect(open).toHaveBeenCalledWith(path);
    expect(createViaWorkflow).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("creates a missing note through the workflow engine, then opens it", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const open = vi.fn().mockResolvedValue(undefined);
    const success: ExecutionResult = {
      ok: true,
      workflowId: "noam-calendar-daily-note",
      effects: [{ kind: "created", path }],
      warnings: [],
    };
    const createViaWorkflow = vi.fn().mockResolvedValue(success);

    const result = await openOrCreateDailyNote(settings, date, { exists, open, createViaWorkflow });

    expect(createViaWorkflow).toHaveBeenCalledTimes(1);
    const [definition, values] = createViaWorkflow.mock.calls[0]! as [WorkflowDefinition, unknown];
    expect(definition.steps).toEqual([{ type: "create-note", path, open: false }]);
    expect(values).toEqual({});
    expect(open).toHaveBeenCalledWith(path);
    expect(result).toBe(success);
  });

  it("applies the configured template on the create-note step", async () => {
    const withTemplate: CalendarSettings = {
      ...settings,
      daily: { ...settings.daily, template: "Templates/Daily.md" },
    };
    const exists = vi.fn().mockResolvedValue(false);
    const open = vi.fn();
    const createViaWorkflow = vi.fn().mockResolvedValue({ ok: true, workflowId: "x", effects: [], warnings: [] });

    await openOrCreateDailyNote(withTemplate, date, { exists, open, createViaWorkflow });

    const [definition] = createViaWorkflow.mock.calls[0]! as [WorkflowDefinition];
    expect(definition.steps[0]).toMatchObject({ template: "Templates/Daily.md" });
  });

  it("does not open the note when creation fails", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const open = vi.fn();
    const failure: ExecutionResult = {
      ok: false,
      workflowId: "noam-calendar-daily-note",
      kind: "conflict",
      message: "already exists",
      completed: [],
      recovery: { retryable: false },
    };
    const createViaWorkflow = vi.fn().mockResolvedValue(failure);

    const result = await openOrCreateDailyNote(settings, date, { exists, open, createViaWorkflow });

    expect(open).not.toHaveBeenCalled();
    expect(result).toBe(failure);
  });
});

describe("openOrCreateWeeklyNote", () => {
  it("opens or creates the weekly note for the given date", async () => {
    const settings: CalendarSettings = DEFAULT_CALENDAR_SETTINGS;
    const path = weeklyNotePath(settings, "2026-03-09");
    const exists = vi.fn().mockResolvedValue(true);
    const open = vi.fn().mockResolvedValue(undefined);
    const createViaWorkflow = vi.fn();

    await openOrCreateWeeklyNote(settings, "2026-03-09", { exists, open, createViaWorkflow });

    expect(exists).toHaveBeenCalledWith(path);
    expect(open).toHaveBeenCalledWith(path);
  });
});
