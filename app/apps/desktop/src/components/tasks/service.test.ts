// The task service's two load-bearing promises: ONE service per vault, and a
// refresh that cannot publish an older answer than the one already painted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryTasks: vi.fn() }));

vi.mock("../../lib/ipc", () => ({
  queryTasks: mocks.queryTasks,
  MAX_TASK_PAGE_SIZE: 500,
}));

import {
  DEFAULT_FILTER,
  MAX_SCANNED_TASKS,
  batchTouchesTasks,
  closeTaskService,
  dueCountsByDate,
  getTaskVaultKey,
  openTaskService,
  refreshTasks,
  setFilter,
  tasksSnapshot,
} from "./service";

const line = (text: string) => ({
  noteId: "note-1",
  path: "Inbox.md",
  taskId: null,
  seriesId: null,
  line: 0,
  charFrom: 0,
  charTo: text.length,
  sourceText: text,
  status: text.includes("[x]") ? "done" : "todo",
  text,
  priority: null,
  due: null,
  scheduled: null,
  start: null,
  done: null,
  cancelled: null,
  created: null,
  recurrence: null,
  section: [],
  indent: "",
  tags: [],
});

const page = (texts: string[]) => ({
  items: texts.map(line),
  nextOffset: null,
  total: texts.length,
  generation: 1,
});

beforeEach(() => {
  mocks.queryTasks.mockReset();
  mocks.queryTasks.mockResolvedValue(page([]));
  closeTaskService();
});

afterEach(() => {
  closeTaskService();
});

// The index can only express some of a query's clauses. Asking it for `limit`
// rows and THEN running the rest over that page truncates before it filters:
// `description includes foo limit 1` answered "nothing" whenever the first
// indexed row was not the one that matched.
describe("client-side clauses see every candidate row", () => {
  const pageOf = (texts: string[], nextOffset: number | null, total: number) => ({
    items: texts.map(line),
    nextOffset,
    total,
    generation: 1,
  });

  it("pages through all rows before the limit is applied", async () => {
    mocks.queryTasks
      .mockResolvedValueOnce(pageOf(["- [ ] Write the plan"], 1, 2))
      .mockResolvedValueOnce(pageOf(["- [ ] Read foo carefully"], null, 2));
    openTaskService("/vaults/one");
    await setFilter("not done\ndescription includes foo\nlimit 1");

    expect(mocks.queryTasks).toHaveBeenCalledTimes(2);
    // The second page was asked for from where the first one ended, with the
    // page size the index allows — not the query's `limit`.
    expect(mocks.queryTasks.mock.calls[1][1]).toEqual({ limit: 500, offset: 1 });
    expect(tasksSnapshot().tasks.map((task) => task.text)).toEqual(["Read foo carefully"]);
  });

  it("asks for one page when the index can answer the whole query", async () => {
    mocks.queryTasks.mockResolvedValue(pageOf(["- [ ] Write the plan"], 1, 2));
    openTaskService("/vaults/one");
    await setFilter("not done\nlimit 1");

    expect(mocks.queryTasks).toHaveBeenCalledTimes(1);
    expect(mocks.queryTasks.mock.calls[0][1]).toEqual({ limit: 1 });
  });

  it("reports a capped scan instead of scanning forever", async () => {
    const full = Array.from({ length: 500 }, (_, i) => `- [ ] Task ${i}`);
    mocks.queryTasks.mockResolvedValue(pageOf(full, 500, 100000));
    openTaskService("/vaults/one");
    await setFilter("not done\ndescription includes foo");

    expect(mocks.queryTasks).toHaveBeenCalledTimes(MAX_SCANNED_TASKS / 500);
    expect(tasksSnapshot().parsed.issues.map((issue) => issue.code)).toContain("results-capped");

    // And the warning goes away when the next run does not hit the cap.
    mocks.queryTasks.mockResolvedValue(pageOf(["- [ ] foo"], null, 1));
    await refreshTasks();
    expect(tasksSnapshot().parsed.issues.map((issue) => issue.code)).not.toContain(
      "results-capped",
    );
  });
});

describe("task service lifecycle", () => {
  it("holds one service per vault and forgets the old one's rows", async () => {
    mocks.queryTasks.mockResolvedValueOnce(page(["- [ ] Write the plan"]));
    openTaskService("/vaults/one");
    await refreshTasks();
    expect(getTaskVaultKey()).toBe("/vaults/one");
    expect(tasksSnapshot().tasks).toHaveLength(1);

    openTaskService("/vaults/two");
    expect(getTaskVaultKey()).toBe("/vaults/two");
    expect(tasksSnapshot().tasks).toHaveLength(0);
  });

  it("does not query at all with no vault open", async () => {
    await refreshTasks();
    expect(mocks.queryTasks).not.toHaveBeenCalled();
  });

  it("narrows the index query from the clauses it can map 1:1", async () => {
    openTaskService("/vaults/one");
    await setFilter("done\npath: Projects\ntag: urgent");
    const calls = mocks.queryTasks.mock.calls;
    const [query] = calls[calls.length - 1]!;
    expect(query).toMatchObject({ statuses: ["done"], pathPrefix: "Projects", tag: "urgent" });
  });

  it("applies the client-side clauses the index cannot express", async () => {
    mocks.queryTasks.mockResolvedValue(
      page(["- [ ] Ship the board", "- [ ] Write the plan"]),
    );
    openTaskService("/vaults/one");
    await setFilter("not done\ntext includes board");
    expect(tasksSnapshot().tasks.map((task) => task.text)).toEqual(["Ship the board"]);
  });

  it("reports an unsupported line instead of widening the result", async () => {
    openTaskService("/vaults/one");
    await setFilter("not done\nmood is cheerful");
    expect(tasksSnapshot().parsed.unsupported).toEqual(["mood is cheerful"]);
  });

  it("never lets a slow refresh overwrite a newer one", async () => {
    const slow = page(["- [ ] Stale answer"]);
    const fast = page(["- [ ] Fresh answer"]);
    let releaseSlow: (() => void) | null = null;
    mocks.queryTasks
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          releaseSlow = () => resolve(slow);
        }),
      )
      .mockResolvedValueOnce(fast);

    openTaskService("/vaults/one");
    const first = refreshTasks();
    // Let the slow query actually start before asking for a newer one, which
    // is the ordering a watcher burst produces.
    await Promise.resolve();
    const second = refreshTasks();
    releaseSlow!();
    await Promise.all([first, second]);

    expect(tasksSnapshot().tasks.map((task) => task.text)).toEqual(["Fresh answer"]);
  });

  it("surfaces a failed query instead of showing a stale list", async () => {
    mocks.queryTasks.mockResolvedValueOnce(page(["- [ ] Write the plan"]));
    openTaskService("/vaults/one");
    await refreshTasks();
    mocks.queryTasks.mockRejectedValueOnce(new Error("vault closed"));
    await refreshTasks();
    expect(tasksSnapshot().error).toContain("vault closed");
    expect(tasksSnapshot().tasks).toHaveLength(0);
  });

  it("counts due tasks per day over an inclusive range", async () => {
    mocks.queryTasks.mockResolvedValueOnce({
      ...page([]),
      items: [
        { ...line("- [ ] a"), due: "2026-03-02" },
        { ...line("- [ ] b"), due: "2026-03-02" },
        { ...line("- [ ] c"), due: "2026-03-05" },
      ],
    });
    openTaskService("/vaults/one");
    const counts = await dueCountsByDate({ from: "2026-03-01", to: "2026-03-31" });
    expect(counts.get("2026-03-02")).toBe(2);
    expect(counts.get("2026-03-05")).toBe(1);
    const calls = mocks.queryTasks.mock.calls;
    const [query] = calls[calls.length - 1]!;
    // Exclusive bounds in the index, inclusive range for the caller.
    expect(query).toMatchObject({ dueAfter: "2026-02-28", dueBefore: "2026-04-01" });
  });

  it("counts every page of the window, not just the first", async () => {
    // More open tasks in the month than one page holds: a badge that read only
    // the first page would silently lose the dates on the later ones.
    mocks.queryTasks
      .mockResolvedValueOnce({
        items: [
          { ...line("- [ ] a"), due: "2026-03-02" },
          { ...line("- [ ] b"), due: "2026-03-02" },
        ],
        nextOffset: 2,
        total: 3,
        generation: 1,
      })
      .mockResolvedValueOnce({
        items: [{ ...line("- [ ] c"), due: "2026-03-05" }],
        nextOffset: null,
        total: 3,
        generation: 1,
      });
    openTaskService("/vaults/one");
    const counts = await dueCountsByDate({ from: "2026-03-01", to: "2026-03-31" });
    expect(counts.get("2026-03-02")).toBe(2);
    expect(counts.get("2026-03-05")).toBe(1);
    expect(mocks.queryTasks).toHaveBeenCalledTimes(2);
    const [, paging] = mocks.queryTasks.mock.calls[1]!;
    expect(paging).toMatchObject({ offset: 2 });
  });

  it("stops paging the badge window at the scan cap", async () => {
    // A page that always says "there is more" — the cap is what ends it.
    mocks.queryTasks.mockResolvedValue({
      items: Array.from({ length: 500 }, () => ({ ...line("- [ ] a"), due: "2026-03-02" })),
      nextOffset: 500,
      total: 100000,
      generation: 1,
    });
    openTaskService("/vaults/one");
    const counts = await dueCountsByDate({ from: "2026-03-01", to: "2026-03-31" });
    expect(counts.get("2026-03-02")).toBe(MAX_SCANNED_TASKS);
    expect(mocks.queryTasks).toHaveBeenCalledTimes(MAX_SCANNED_TASKS / 500);
  });

  it("opens on the default filter", () => {
    expect(tasksSnapshot().filterText).toBe(DEFAULT_FILTER);
  });
});

describe("batchTouchesTasks", () => {
  it("is true for any markdown change, calendar settings included", () => {
    expect(batchTouchesTasks([{ path: "Inbox.md", kind: "modified" }])).toBe(true);
    expect(batchTouchesTasks([{ path: "_Noam/Calendar.md", kind: "modified" }])).toBe(true);
    expect(batchTouchesTasks([{ path: "attachments/a.png", kind: "modified" }])).toBe(false);
    expect(batchTouchesTasks([])).toBe(false);
  });
});
