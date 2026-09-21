// @vitest-environment jsdom
//
// The calendar host's wiring: what Enter and `w` on a day actually do, and
// when the due badges are fetched.
//
// The rule under test is the one the plan freezes: a daily note is NEVER
// created by a raw `ipc.createNote`. It goes through an ad-hoc single-step
// `create-note` workflow, so permissions, collisions and the frozen root are
// the workflow engine's — one code path, not two.

import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dueCountsByDate: vi.fn(),
  taskStore: {
    snapshot: { tasks: [] as unknown[] },
    listeners: new Set<() => void>(),
  },
  noteExists: vi.fn(),
  readNote: vi.fn(),
  openNoteByPath: vi.fn(),
  runWorkflow: vi.fn(),
  createWorkflowHost: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
  noteExists: mocks.noteExists,
  readNote: mocks.readNote,
}));
vi.mock("../../store", () => ({
  useStore: Object.assign(
    (selector: (state: { titles: unknown[] }) => unknown) => selector({ titles: [] }),
    { getState: () => ({ openNoteByPath: mocks.openNoteByPath }) },
  ),
}));
// Partial: `lib/calendar` expands path templates with the engine's real
// `expand`, which is the point — a calendar template and a workflow template
// mean the same thing.
vi.mock("../../lib/workflows", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runWorkflow: mocks.runWorkflow,
  createWorkflowHost: mocks.createWorkflowHost,
}));
vi.mock("../workflows/editorContext", () => ({ currentEditorContext: () => ({}) }));
vi.mock("../tasks/service", () => ({
  dueCountsByDate: mocks.dueCountsByDate,
  // The real hook is a `useSyncExternalStore` over the service; so is this, so
  // a "publish" reaches the host the same way.
  useTasks: () =>
    useSyncExternalStore(
      (listener: () => void) => {
        mocks.taskStore.listeners.add(listener);
        return () => mocks.taskStore.listeners.delete(listener);
      },
      () => mocks.taskStore.snapshot,
      () => mocks.taskStore.snapshot,
    ),
}));

/** What the service does on every refresh: a NEW rows array, then notify. */
function publishTasks(): void {
  mocks.taskStore.snapshot = { tasks: [] };
  for (const listener of [...mocks.taskStore.listeners]) listener();
}

import { DEFAULT_CALENDAR_SETTINGS, openOrCreateDailyNote, openOrCreateWeeklyNote } from "../../lib/calendar";
import { calendarNoteDeps, CalendarPanelHost } from "./CalendarPanelHost";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  mocks.noteExists.mockReset();
  mocks.openNoteByPath.mockReset();
  mocks.runWorkflow.mockReset();
  mocks.runWorkflow.mockResolvedValue({ ok: true, workflowId: "x", effects: [], warnings: [] });
  mocks.createWorkflowHost.mockReset();
  mocks.createWorkflowHost.mockReturnValue({ host: true });
  mocks.readNote.mockReset();
  mocks.readNote.mockResolvedValue(null);
  mocks.dueCountsByDate.mockReset();
  mocks.dueCountsByDate.mockResolvedValue(new Map());
  mocks.taskStore.snapshot = { tasks: [] };
  mocks.taskStore.listeners.clear();
});

describe("calendarNoteDeps", () => {
  it("asks Rust whether the note exists, under this vault's epoch", async () => {
    mocks.noteExists.mockResolvedValue(true);
    await calendarNoteDeps(7).exists("Journal/2026/2026-03-02.md");
    expect(mocks.noteExists).toHaveBeenCalledWith("Journal/2026/2026-03-02.md", 7);
  });

  it("opens an existing day's note and creates nothing", async () => {
    mocks.noteExists.mockResolvedValue(true);
    await openOrCreateDailyNote(DEFAULT_CALENDAR_SETTINGS, "2026-03-02", calendarNoteDeps(1));
    expect(mocks.openNoteByPath).toHaveBeenCalledWith("Journal/2026/2026-03-02.md");
    expect(mocks.runWorkflow).not.toHaveBeenCalled();
  });

  it("creates a missing day's note through the workflow engine, then opens it", async () => {
    mocks.noteExists.mockResolvedValue(false);
    await openOrCreateDailyNote(DEFAULT_CALENDAR_SETTINGS, "2026-03-02", calendarNoteDeps(1));

    expect(mocks.runWorkflow).toHaveBeenCalledTimes(1);
    const [definition, values, , host] = mocks.runWorkflow.mock.calls[0]!;
    expect(definition.steps).toEqual([
      { type: "create-note", path: "Journal/2026/2026-03-02.md", open: false },
    ]);
    expect(values).toEqual({});
    expect(host).toEqual({ host: true });
    expect(mocks.openNoteByPath).toHaveBeenCalledWith("Journal/2026/2026-03-02.md");
  });

  it("uses the ISO week-year path for the weekly note", async () => {
    mocks.noteExists.mockResolvedValue(true);
    // 2027-01-01 is a Friday in ISO week 53 of 2026.
    await openOrCreateWeeklyNote(DEFAULT_CALENDAR_SETTINGS, "2027-01-01", calendarNoteDeps(1));
    expect(mocks.openNoteByPath).toHaveBeenCalledWith("Journal/2026/Week 53.md");
  });
});

describe("CalendarPanelHost badges", () => {
  let container: HTMLDivElement;
  let root: Root;

  const props = {
    instanceId: "panel:calendar",
    vaultKey: "/vault",
    vaultEpoch: 1,
    activeNotePath: null,
    visible: true,
    compact: false,
    onOpenNote: vi.fn(),
    onRequestClose: vi.fn(),
  };

  const render = async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(CalendarPanelHost, props));
    });
  };

  const monthButton = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Once the user navigates past the prefetched window, a range pinned to
  // today badges every visible day zero.
  it("queries the range around the month on screen, not around today", async () => {
    await render();
    const lastRange = () => {
      const calls = mocks.dueCountsByDate.mock.calls;
      return calls[calls.length - 1]![0] as { from: string; to: string };
    };
    const first = lastRange();

    await act(async () => {
      monthButton("Next month").click();
    });
    await act(async () => {
      monthButton("Next month").click();
    });

    const after = lastRange();
    expect(after.from > first.from).toBe(true);
    // Two months on, the window is the two months around it: a range of
    // three month-starts, ending one month after the one displayed.
    const months = (range: { from: string; to: string }) =>
      (Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4))) * 12 +
      (Number(range.to.slice(5, 7)) - Number(range.from.slice(5, 7)));
    expect(months(after)).toBe(3);
    expect(months({ from: first.from, to: after.from })).toBe(2);
  });

  it("re-queries when the task service publishes, with no title change", async () => {
    await render();
    const before = mocks.dueCountsByDate.mock.calls.length;

    await act(async () => {
      publishTasks();
    });

    expect(mocks.dueCountsByDate.mock.calls.length).toBe(before + 1);
  });
});
