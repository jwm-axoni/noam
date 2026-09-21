// Planners only. Nothing here dispatches: the assertion is always "apply the
// plan to the text and look at what moved", plus "nothing outside the span
// changed".

import { describe, expect, it, vi } from "vitest";
import { applyChanges, mergeChanges, newTaskId, planAssignId, planSetDate, planSetPriority, planSetStatus } from "../edit";
import { parseTasks } from "../parse";
import { TASK_ID_RE, type Task } from "../contracts";

const NOTE = [
  "# Notes",
  "",
  "- [ ] Buy milk 📅 2026-03-09",
  "- [x] Old one ⏫ ✅ 2026-03-01 ^t-k3x9f2a0b1",
  "- [ ] Bare",
  "- [ ] Emoji priority ▶️ 🆔 keep-me",
].join("\n");

const tasks = (): Task[] => parseTasks(NOTE, "doc-1", "Notes.md");
const at = (index: number): Task => tasks()[index]!;
const lineAfter = (task: Task, changes: Parameters<typeof applyChanges>[1]): string =>
  applyChanges(NOTE, changes).split("\n")[task.line]!;

describe("planSetStatus", () => {
  it("replaces the checkbox character and nothing else", () => {
    const task = at(0);
    const changes = planSetStatus(task, "done");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.to - changes[0]!.from).toBe(1);
    expect(lineAfter(task, changes)).toBe("- [x] Buy milk 📅 2026-03-09");
  });

  it("is a no-op when the status already matches", () => {
    expect(planSetStatus(at(1), "done")).toEqual([]);
  });

  it("writes lowercase x over an uppercase X", () => {
    const upper = parseTasks("- [X] a", "d", "p")[0]!;
    expect(applyChanges("- [X] a", planSetStatus(upper, "todo"))).toBe("- [ ] a");
  });
});

describe("planSetDate", () => {
  it("replaces only the value of an existing marker", () => {
    const task = at(0);
    const changes = planSetDate(task, "due", "2026-04-01");
    expect(changes).toEqual([
      { from: task.to - "2026-03-09".length, to: task.to, insert: "2026-04-01" },
    ]);
    expect(lineAfter(task, changes)).toBe("- [ ] Buy milk 📅 2026-04-01");
  });

  it("adds a missing marker at its canonical position", () => {
    const task = at(1);
    // ➕ created sorts before ✅ done, so it lands in front of it.
    expect(lineAfter(task, planSetDate(task, "created", "2026-02-01"))).toBe(
      "- [x] Old one ⏫ ➕ 2026-02-01 ✅ 2026-03-01 ^t-k3x9f2a0b1",
    );
  });

  it("adds a marker to a line that has none", () => {
    const task = at(2);
    expect(lineAfter(task, planSetDate(task, "due", "2026-04-01"))).toBe("- [ ] Bare 📅 2026-04-01");
  });

  it("removes the marker and its separator", () => {
    const task = at(0);
    expect(lineAfter(task, planSetDate(task, "due", null))).toBe("- [ ] Buy milk");
  });

  it("is a no-op for the same date or for removing what is absent", () => {
    expect(planSetDate(at(0), "due", "2026-03-09")).toEqual([]);
    expect(planSetDate(at(2), "due", null)).toEqual([]);
  });

  it("keeps a no-space marker spelled the way it was written", () => {
    const [task] = parseTasks("- [ ] a 📅2026-03-09", "d", "p");
    expect(applyChanges("- [ ] a 📅2026-03-09", planSetDate(task!, "due", "2026-04-01"))).toBe(
      "- [ ] a 📅2026-04-01",
    );
  });

  it("leaves an unparsed field alone", () => {
    const task = at(3);
    expect(lineAfter(task, planSetDate(task, "due", "2026-04-01"))).toBe(
      "- [ ] Emoji priority ▶️ 🆔 keep-me 📅 2026-04-01",
    );
  });
});

describe("planSetPriority", () => {
  it("adds the glyph before every other marker", () => {
    const task = at(0);
    expect(lineAfter(task, planSetPriority(task, "high"))).toBe("- [ ] Buy milk 🔼 📅 2026-03-09");
  });

  it("replaces the emoji-presentation glyph with the frozen one", () => {
    const task = at(3);
    expect(lineAfter(task, planSetPriority(task, "highest"))).toBe(
      "- [ ] Emoji priority ⏫ 🆔 keep-me",
    );
  });

  it("clears the glyph with its separator", () => {
    const task = at(1);
    expect(lineAfter(task, planSetPriority(task, null))).toBe(
      "- [x] Old one ✅ 2026-03-01 ^t-k3x9f2a0b1",
    );
  });
});

describe("planAssignId", () => {
  it("returns the edit unchanged when the task already has an id", () => {
    const task = at(1);
    const edit = planSetStatus(task, "todo");
    expect(planAssignId(task, edit, "t-0000000001")).toBe(edit);
  });

  it("merges the id into the same span edit as the change that triggered it", () => {
    const task = at(0);
    const plan = mergeChanges(planAssignId(task, planSetStatus(task, "done"), "t-0000000001"));
    // One transaction, one undo step: the status change and the id are two
    // disjoint spans of the SAME plan, applied together.
    expect(plan).toHaveLength(2);
    expect(applyChanges(NOTE, plan).split("\n")[task.line]).toBe(
      "- [x] Buy milk 📅 2026-03-09 ^t-0000000001",
    );
  });

  it("folds an id that lands where another insert already did", () => {
    const task = at(2);
    const plan = mergeChanges(
      planAssignId(task, planSetDate(task, "due", "2026-04-01"), "t-0000000001"),
    );
    expect(plan).toHaveLength(1);
    expect(applyChanges(NOTE, plan).split("\n")[task.line]).toBe(
      "- [ ] Bare 📅 2026-04-01 ^t-0000000001",
    );
  });
});

describe("newTaskId", () => {
  it("is ten base36 characters from the platform CSPRNG", () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    const id = newTaskId();
    expect(spy).toHaveBeenCalled();
    expect(id).toMatch(TASK_ID_RE);
    spy.mockRestore();
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 200 }, newTaskId));
    expect(ids.size).toBe(200);
  });
});

describe("applyChanges", () => {
  it("leaves every byte outside the plan identical", () => {
    const task = at(0);
    const next = applyChanges(NOTE, planSetStatus(task, "done"));
    expect(next.slice(0, task.from)).toBe(NOTE.slice(0, task.from));
    expect(next.slice(task.to)).toBe(NOTE.slice(task.to));
  });
});
