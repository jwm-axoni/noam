// @vitest-environment jsdom
//
// The four promises the Tasks panel makes:
//
//   KEYBOARD COMPLETION WRITES THROUGH THE ADAPTER — Space on the focused row
//   calls `editTask`, and the plan it hands over is a status change (a
//   recurring task's plan carries its next occurrence with it).
//   A STALE REFUSAL REFRESHES AND STOPS — one write, a notice, no retry.
//   A READ-ONLY ROW IS DISABLED, WITH THE REASON VISIBLE.
//   AN UNSUPPORTED QUERY LINE IS SHOWN, never silently dropped.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseQuery } from "../../lib/tasks/query";
import { parseTaskLine } from "../../lib/tasks/parse";
import type { ResolvedTask, SpanChange, Task } from "../../lib/tasks/contracts";

const mocks = vi.hoisted(() => ({
  editTask: vi.fn(),
  taskNoteText: vi.fn(),
  refreshTasks: vi.fn(),
  setFilter: vi.fn(),
  permission: "edit" as string,
  snapshot: null as unknown,
}));

vi.mock("../../lib/tasks", async () => {
  const [contracts, parse, edit, query, recurrence] = await Promise.all([
    vi.importActual<Record<string, unknown>>("../../lib/tasks/contracts"),
    vi.importActual<Record<string, unknown>>("../../lib/tasks/parse"),
    vi.importActual<Record<string, unknown>>("../../lib/tasks/edit"),
    vi.importActual<Record<string, unknown>>("../../lib/tasks/query"),
    vi.importActual<Record<string, unknown>>("../../lib/tasks/recurrence"),
  ]);
  return {
    ...contracts,
    ...parse,
    ...edit,
    ...query,
    ...recurrence,
    // The adapter itself reaches the store and Tauri; the panel only ever
    // calls these two, and what it PASSES them is what these tests pin.
    editTask: mocks.editTask,
    taskNoteText: mocks.taskNoteText,
  };
});
vi.mock("../../lib/workflows/adapter", () => ({
  permissionForPath: () => mocks.permission,
}));
vi.mock("./service", () => ({
  useTasks: () => mocks.snapshot,
  refreshTasks: mocks.refreshTasks,
  setFilter: mocks.setFilter,
}));
vi.mock("../../lib/ipc", () => ({ readNote: vi.fn(), writeNoteIfMissing: vi.fn(), ensureFolder: vi.fn() }));
vi.mock("../../store", () => ({
  useStore: Object.assign(
    (selector: (state: { titles: unknown[] }) => unknown) => selector({ titles: [] }),
    { getState: () => ({ refreshTitles: vi.fn() }) },
  ),
}));

import { TasksPanel } from "./TasksPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE = "Inbox.md";

function taskFrom(line: string): Task {
  const task = parseTaskLine(line, { docId: "note-1", path: NOTE, line: 0, from: 0 });
  if (!task) throw new Error(`not a task line: ${line}`);
  return task;
}

function resolvedFrom(task: Task): ResolvedTask {
  return {
    path: task.path,
    docId: task.docId,
    from: task.from,
    to: task.to,
    sourceText: task.sourceText,
    task,
    revision: "rev-1",
  };
}

function snapshotOf(tasks: Task[], filterText = "not done") {
  return { tasks, filterText, parsed: parseQuery(filterText), total: tasks.length, loading: false, error: null };
}

const props = {
  instanceId: "panel:tasks",
  vaultKey: "/vault",
  vaultEpoch: 1,
  activeNotePath: null,
  visible: true,
  compact: true,
  onOpenNote: vi.fn(),
  onRequestClose: vi.fn(),
};

let host: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(TasksPanel, props));
  });
}

function row(): HTMLElement {
  const found = host.querySelector<HTMLElement>(".task-row");
  if (!found) throw new Error("no task row rendered");
  return found;
}

async function press(key: string): Promise<void> {
  await act(async () => {
    row().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

beforeEach(() => {
  mocks.editTask.mockReset();
  mocks.editTask.mockResolvedValue({ ok: true, revision: "rev-2" });
  mocks.taskNoteText.mockReset();
  mocks.refreshTasks.mockReset();
  mocks.refreshTasks.mockResolvedValue(undefined);
  mocks.setFilter.mockReset();
  mocks.permission = "edit";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("TasksPanel keyboard actions", () => {
  it("completes the focused task through editTask, with a status change", async () => {
    const task = taskFrom("- [ ] Write the plan 📅 2026-03-02");
    mocks.snapshot = snapshotOf([task]);
    mocks.taskNoteText.mockResolvedValue(task.sourceText);
    await render();
    await press(" ");

    expect(mocks.editTask).toHaveBeenCalledTimes(1);
    const [ref, plan] = mocks.editTask.mock.calls[0]!;
    expect(ref).toMatchObject({ path: NOTE, sourceText: task.sourceText });
    const changes: SpanChange[] = await plan(resolvedFrom(task));
    expect(changes.some((change) => change.insert === "x")).toBe(true);
    expect(mocks.refreshTasks).toHaveBeenCalled();
  });

  it("spawns the next occurrence when the task recurs", async () => {
    const task = taskFrom("- [ ] Water plants 🔁 every day 📅 2026-03-02");
    mocks.snapshot = snapshotOf([task]);
    mocks.taskNoteText.mockResolvedValue(task.sourceText);
    await render();
    await press(" ");

    const [, plan] = mocks.editTask.mock.calls[0]!;
    const changes: SpanChange[] = await plan(resolvedFrom(task));
    expect(changes.some((change) => change.insert.includes("2026-03-03"))).toBe(true);
  });

  it("cycles the priority with p", async () => {
    const task = taskFrom("- [ ] Write the plan");
    mocks.snapshot = snapshotOf([task]);
    await render();
    await press("p");

    const [, plan] = mocks.editTask.mock.calls[0]!;
    const changes: SpanChange[] = await plan(resolvedFrom(task));
    expect(changes.some((change) => change.insert.includes("⏫"))).toBe(true);
  });

  it("opens a due-date field on d and writes what it is given", async () => {
    const task = taskFrom("- [ ] Write the plan");
    mocks.snapshot = snapshotOf([task]);
    await render();
    await press("d");

    const field = host.querySelector<HTMLInputElement>(".task-date-input");
    expect(field).not.toBeNull();
    field!.value = "2026-04-01";
    await act(async () => {
      field!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const [, plan] = mocks.editTask.mock.calls[0]!;
    const changes: SpanChange[] = await plan(resolvedFrom(task));
    expect(changes.some((change) => change.insert.includes("2026-04-01"))).toBe(true);
  });

  // The plan still completes the task; what it could NOT do has to be said,
  // or a recurring task silently stops recurring.
  it("completes a task whose recurrence it cannot extend, and says so", async () => {
    const task = taskFrom("- [ ] Water plants 🔁 every second tuesday-ish 📅 2026-03-02");
    mocks.snapshot = snapshotOf([task]);
    mocks.taskNoteText.mockResolvedValue(task.sourceText);
    // The real adapter RUNS the plan; the notice depends on what it reports.
    let changes: SpanChange[] = [];
    mocks.editTask.mockImplementation(async (_ref: unknown, plan: (r: ResolvedTask) => Promise<SpanChange[]>) => {
      changes = await plan(resolvedFrom(task));
      return { ok: true, revision: "rev-2" };
    });
    await render();
    await press(" ");

    // The plan, the write and the notice are three awaits deep; settle rather
    // than guess a tick count.
    for (let i = 0; i < 20 && host.querySelector(".tasks-notice") === null; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    // Completed …
    expect(changes.some((change) => change.insert === "x")).toBe(true);
    // … and no successor line.
    expect(changes.some((change) => change.insert.includes("🔁"))).toBe(false);
    const notice = host.querySelector(".tasks-notice");
    expect(notice?.textContent).toContain("Completed");
    expect(notice?.textContent).toContain("no next occurrence was created");
  });

  // The lazy-identity contract: the FIRST structured edit of an unstamped line
  // carries the `^t-` id, not just completion.
  it("stamps an id on a due-date edit of an unstamped task", async () => {
    const task = taskFrom("- [ ] Write the plan");
    expect(task.id).toBeNull();
    mocks.snapshot = snapshotOf([task]);
    await render();
    await press("d");
    const field = host.querySelector<HTMLInputElement>(".task-date-input")!;
    field.value = "2026-04-01";
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    const [, plan] = mocks.editTask.mock.calls[0]!;
    const changes: SpanChange[] = await plan(resolvedFrom(task));
    expect(changes.some((change) => /\s\^t-[0-9a-z]+$/.test(change.insert))).toBe(true);
  });

  it("stamps an id on a priority edit, and leaves a stamped task alone", async () => {
    const task = taskFrom("- [ ] Write the plan");
    mocks.snapshot = snapshotOf([task]);
    await render();
    await press("p");

    const [, plan] = mocks.editTask.mock.calls[0]!;
    const changes: SpanChange[] = await plan(resolvedFrom(task));
    expect(changes.some((change) => /\s\^t-[0-9a-z]+$/.test(change.insert))).toBe(true);

    const already = taskFrom("- [ ] Write the plan ^t-aaaaaaaaaa");
    const again: SpanChange[] = await plan(resolvedFrom(already));
    expect(again.some((change) => change.insert.includes("^t-"))).toBe(false);
  });

  it("refreshes and explains a stale refusal without writing twice", async () => {
    const task = taskFrom("- [ ] Write the plan");
    mocks.snapshot = snapshotOf([task]);
    mocks.taskNoteText.mockResolvedValue(task.sourceText);
    mocks.editTask.mockResolvedValue({
      ok: false,
      kind: "stale-target",
      message: '"Inbox.md" changed; refresh and try again.',
    });
    await render();
    await press(" ");

    expect(mocks.editTask).toHaveBeenCalledTimes(1);
    expect(mocks.refreshTasks).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".tasks-notice")?.textContent).toMatch(/changed on disk/i);
  });

  it("disables a read-only row and shows the reason", async () => {
    mocks.permission = "view";
    const task = taskFrom("- [ ] Write the plan");
    mocks.snapshot = snapshotOf([task]);
    await render();

    const checkbox = host.querySelector<HTMLButtonElement>(".task-check")!;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.title).toMatch(/read-only/i);
    expect(host.querySelector(".task-locked")?.textContent).toBe("Read-only");

    await press(" ");
    expect(mocks.editTask).not.toHaveBeenCalled();
  });
});

describe("TasksPanel query", () => {
  it("shows a query line it does not understand", async () => {
    mocks.snapshot = snapshotOf([taskFrom("- [ ] Write the plan")], "not done\nmood is cheerful");
    await render();
    expect(host.querySelector('[data-unsupported-line="mood is cheerful"]')).not.toBeNull();
  });
});

describe("TasksPanel row identity and the date field", () => {
  it("renders two byte-identical lines as two rows without a duplicate-key warning", async () => {
    const a = parseTaskLine("- [ ] Ambiguous line", { docId: "note-1", path: NOTE, line: 3, from: 40 });
    const b = parseTaskLine("- [ ] Ambiguous line", { docId: "note-1", path: NOTE, line: 4, from: 61 });
    if (!a || !b) throw new Error("fixture");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.snapshot = snapshotOf([a, b]);
    await render();
    expect(host.querySelectorAll(".task-row").length).toBe(2);
    const dupKey = errors.mock.calls.some((call) => String(call[0]).includes("same key"));
    errors.mockRestore();
    expect(dupKey).toBe(false);
  });

  it("renders two lines carrying the SAME id as two rows, without a duplicate-key warning", async () => {
    // A copy-pasted line brings its `^t-` id with it. The adapter refuses to
    // write to either until they are deduped, but both have to be on screen —
    // that is how a person finds the duplicate.
    const a = parseTaskLine("- [ ] Twin ^t-k3x9f2a0b1", { docId: "note-1", path: NOTE, line: 3, from: 40 });
    const b = parseTaskLine("- [ ] Twin ^t-k3x9f2a0b1", { docId: "note-1", path: NOTE, line: 4, from: 65 });
    if (!a || !b) throw new Error("fixture");
    expect(a.id).toBe(b.id);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.snapshot = snapshotOf([a, b]);
    await render();
    expect(host.querySelectorAll(".task-row").length).toBe(2);
    const dupKey = errors.mock.calls.some((call) => String(call[0]).includes("same key"));
    errors.mockRestore();
    expect(dupKey).toBe(false);
  });

  it("keeps keys typed into the due-date field away from the row's shortcuts", async () => {
    mocks.snapshot = snapshotOf([taskFrom("- [ ] Write the plan 📅 2026-09-22")]);
    await render();
    await press("d");
    const input = host.querySelector<HTMLInputElement>(".task-date-input");
    if (!input) throw new Error("date field did not open");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }));
    });
    expect(mocks.editTask).not.toHaveBeenCalled();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(props.onOpenNote).not.toHaveBeenCalled();
  });
});
