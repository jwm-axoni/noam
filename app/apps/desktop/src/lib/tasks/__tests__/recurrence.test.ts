// The convergence suite. The two-client tests are the reason `occurrenceId`
// exists: if they ever fail, a recurring task completed on two devices grows a
// duplicate that no merge can remove.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  addMonths,
  contentTaskId,
  daysBetween,
  dedupe,
  duplicateIds,
  nextDue,
  occurrenceId,
  parseRecurrence,
  planComplete,
  planDedupe,
} from "../recurrence";
import { applyChanges } from "../edit";
import { parseTasks } from "../parse";
import { TASK_ID_RE, type Task } from "../contracts";

const one = (line: string, docId = "doc-1"): Task => parseTasks(line, docId, "Notes.md")[0]!;

describe("parseRecurrence", () => {
  it.each([
    ["every day", { unit: "day", interval: 1 }, false],
    ["every 3 days", { unit: "day", interval: 3 }, false],
    ["every other day", { unit: "day", interval: 2 }, false],
    ["every week", { unit: "week", interval: 1 }, false],
    ["every other week", { unit: "week", interval: 2 }, false],
    ["every 2 weeks", { unit: "week", interval: 2 }, false],
    ["every month", { unit: "month", interval: 1 }, false],
    ["every 6 months", { unit: "month", interval: 6 }, false],
    ["every year", { unit: "year", interval: 1 }, false],
    ["every day when done", { unit: "day", interval: 1 }, true],
    ["Every Week When Done", { unit: "week", interval: 1 }, true],
    ["every friday", { unit: "week", interval: 1, weekdays: [5] }, false],
    ["every monday, friday", { unit: "week", interval: 1, weekdays: [1, 5] }, false],
    ["every week on monday and thursday", { unit: "week", interval: 1, weekdays: [1, 4] }, false],
    ["every 2 weeks on monday", { unit: "week", interval: 2, weekdays: [1] }, false],
  ])("reads %s", (raw, rule, whenDone) => {
    expect(parseRecurrence(raw)).toEqual({ raw, rule, whenDone });
  });

  it("keeps anything outside the subset verbatim with no rule", () => {
    for (const raw of [
      "every third blue moon",
      "every 0 days",
      "on the last friday of the month",
      "",
    ]) {
      expect(parseRecurrence(raw)).toEqual({ raw, rule: null, whenDone: false });
    }
  });
});

describe("nextDue", () => {
  const due = (line: string, today = "2026-03-10") => nextDue(one(line), today);

  it("counts from the due date", () => {
    expect(due("- [ ] a 🔁 every day 📅 2026-03-09")).toBe("2026-03-10");
    expect(due("- [ ] a 🔁 every other week 📅 2026-03-09")).toBe("2026-03-23");
    expect(due("- [ ] a 🔁 every month 📅 2026-03-09")).toBe("2026-04-09");
    expect(due("- [ ] a 🔁 every year 📅 2026-03-09")).toBe("2027-03-09");
  });

  it("counts from the completion date for `when done`", () => {
    expect(due("- [ ] a 🔁 every day when done 📅 2026-03-09", "2026-03-20")).toBe("2026-03-21");
  });

  it("clamps a month that is too short", () => {
    expect(due("- [ ] a 🔁 every month 📅 2026-01-31")).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });

  it("walks the weekday list, and skips whole weeks for an interval", () => {
    // 2026-03-09 is a Monday.
    expect(due("- [ ] a 🔁 every friday 📅 2026-03-09")).toBe("2026-03-13");
    expect(due("- [ ] a 🔁 every monday, friday 📅 2026-03-13")).toBe("2026-03-16");
    expect(due("- [ ] a 🔁 every 2 weeks on monday 📅 2026-03-09")).toBe("2026-03-23");
  });

  it("falls back to scheduled, then start, as the date it moves", () => {
    expect(due("- [ ] a 🔁 every day ⏳ 2026-03-09")).toBe("2026-03-10");
    expect(due("- [ ] a 🔁 every day 🛫 2026-03-09")).toBe("2026-03-10");
  });

  it("is null without a rule or without a date to move", () => {
    expect(due("- [ ] a 📅 2026-03-09")).toBeNull();
    expect(due("- [ ] a 🔁 every blue moon 📅 2026-03-09")).toBeNull();
    expect(due("- [ ] a 🔁 every day")).toBeNull();
  });
});

describe("occurrenceId", () => {
  it("matches the frozen formula", async () => {
    const hex = createHash("sha256").update("t-k3x9f2a0b1\n2026-03-16", "utf8").digest("hex");
    const expected = `t-${BigInt(`0x${hex}`).toString(36).padStart(10, "0").slice(0, 10)}`;
    expect(await occurrenceId("t-k3x9f2a0b1", "2026-03-16")).toBe(expected);
    expect(expected).toMatch(TASK_ID_RE);
  });

  it("is pure: the same input is the same id", async () => {
    const a = await occurrenceId("t-k3x9f2a0b1", "2026-03-16");
    const b = await occurrenceId("t-k3x9f2a0b1", "2026-03-16");
    expect(a).toBe(b);
    expect(await occurrenceId("t-k3x9f2a0b1", "2026-03-17")).not.toBe(a);
  });

  it("derives a stamp-free line's id from the note and the line's bytes", async () => {
    const task = one("- [ ] a 🔁 every day 📅 2026-03-09");
    expect(await contentTaskId(task)).toBe(await contentTaskId(one("- [ ] a 🔁 every day 📅 2026-03-09")));
    expect(await contentTaskId(task)).not.toBe(await contentTaskId(one("- [ ] a 🔁 every day 📅 2026-03-09", "doc-2")));
    expect(await contentTaskId(task)).toMatch(TASK_ID_RE);
  });
});

describe("planComplete", () => {
  const NOTE = [
    "# Chores",
    "",
    "- [ ] Weekly review 🔁 every week ⏳ 2026-03-07 📅 2026-03-09 #home",
    "- [ ] One off 📅 2026-03-09",
    "- [ ] Stamped 🔁 every day 📅 2026-03-09 ^t-k3x9f2a0b1",
    "- [ ] Broken rule 🔁 every blue moon 📅 2026-03-09",
    "- [ ] No dates 🔁 every day",
  ].join("\n");
  const tasks = () => parseTasks(NOTE, "doc-1", "Chores.md");
  const today = "2026-03-10";

  it("marks done, stamps the ✅ date and spawns the next line below, in one plan", async () => {
    const task = tasks()[0]!;
    const plan = await planComplete(task, NOTE, today);
    const next = applyChanges(NOTE, plan.changes);
    const lines = next.split("\n");
    expect(lines[2]).toBe(
      `- [x] Weekly review 🔁 every week ⏳ 2026-03-07 📅 2026-03-09 #home ✅ ${today} ^${plan.taskId}`,
    );
    // Every other date moves by the same number of days as the due date.
    expect(lines[3]).toBe(
      `- [ ] Weekly review 🔁 every week ⏳ 2026-03-14 📅 2026-03-16 #home ^${plan.nextId}`,
    );
    expect(plan.nextId).toBe(await occurrenceId(plan.taskId, "2026-03-16"));
    expect(plan.issues).toEqual([]);
    // Nothing outside the completed line's own span moved.
    expect(next.slice(0, task.from)).toBe(NOTE.slice(0, task.from));
    expect(next.slice(task.to + (plan.nextLine!.length + 1) + ` ✅ ${today} ^${plan.taskId}`.length))
      .toBe(NOTE.slice(task.to));
  });

  it("uses the line's own id as the series key when it has one", async () => {
    const plan = await planComplete(tasks()[2]!, NOTE, today);
    expect(plan.taskId).toBe("t-k3x9f2a0b1");
    expect(plan.nextId).toBe(await occurrenceId("t-k3x9f2a0b1", "2026-03-10"));
  });

  it("never spawns for a task that does not recur", async () => {
    const plan = await planComplete(tasks()[1]!, NOTE, today);
    expect(plan.nextLine).toBeNull();
    expect(plan.nextId).toBeNull();
    expect(applyChanges(NOTE, plan.changes).split("\n")[3]).toBe(
      `- [x] One off 📅 2026-03-09 ✅ ${today} ^${plan.taskId}`,
    );
    expect(applyChanges(NOTE, plan.changes).split("\n")).toHaveLength(NOTE.split("\n").length);
  });

  it("reports rather than guesses when the rule or the date is missing", async () => {
    const broken = await planComplete(tasks()[3]!, NOTE, today);
    expect(broken.nextLine).toBeNull();
    expect(broken.issues[0]!.code).toBe("unsupported-recurrence");
    const dateless = await planComplete(tasks()[4]!, NOTE, today);
    expect(dateless.nextLine).toBeNull();
    expect(dateless.issues[0]!.code).toBe("no-recurrence-date");
    // Both still complete the task.
    expect(applyChanges(NOTE, broken.changes)).toContain("- [x] Broken rule");
  });

  it("refuses to plan against text the task is not in", async () => {
    const plan = await planComplete(tasks()[0]!, `x\n${NOTE}`, today);
    expect(plan.changes).toEqual([]);
    expect(plan.issues[0]!.code).toBe("stale-target");
  });

  describe("two clients completing the same occurrence", () => {
    it("write byte-identical lines, stamped or not", async () => {
      for (const index of [0, 2]) {
        const a = await planComplete(parseTasks(NOTE, "doc-1", "Chores.md")[index]!, NOTE, today);
        const b = await planComplete(parseTasks(NOTE, "doc-1", "Chores.md")[index]!, NOTE, today);
        expect(a.changes).toEqual(b.changes);
        expect(a.nextLine).toBe(b.nextLine);
        expect(applyChanges(NOTE, a.changes)).toBe(applyChanges(NOTE, b.changes));
      }
    });

    it("converge to one occurrence once both edits merge", async () => {
      const a = await planComplete(tasks()[0]!, NOTE, today);
      const b = await planComplete(tasks()[0]!, NOTE, today);
      const settled = applyChanges(NOTE, a.changes);
      // What a CRDT merge of two independent inserts looks like: both lines
      // are there, in some order, and the completed line was edited twice.
      const merged = settled.split("\n");
      merged.splice(3, 0, b.nextLine!);
      expect(merged.filter((l) => l === a.nextLine)).toHaveLength(2);
      expect(dedupe(merged.join("\n"))).toBe(settled);
      // Idempotent: a second pass finds nothing.
      expect(planDedupe(settled)).toEqual([]);
    });
  });
});

describe("planDedupe", () => {
  it("is a no-op when every id is unique", () => {
    const text = "- [ ] a ^t-0000000001\n- [ ] b ^t-0000000002\n- [ ] c\n";
    expect(planDedupe(text)).toEqual([]);
    expect(duplicateIds(text)).toEqual([]);
  });

  it("keeps the first line by document position and deletes the rest", () => {
    const text = [
      "- [ ] first ^t-0000000001",
      "not a task",
      "- [ ] second ^t-0000000001",
      "- [ ] other ^t-0000000002",
      "- [ ] third ^t-0000000001",
    ].join("\n");
    expect(duplicateIds(text)).toEqual(["t-0000000001"]);
    expect(dedupe(text)).toBe(
      ["- [ ] first ^t-0000000001", "not a task", "- [ ] other ^t-0000000002"].join("\n"),
    );
    expect(planDedupe(dedupe(text))).toEqual([]);
  });

  it("converges from either side", () => {
    const text = "- [ ] a ^t-0000000001\n- [ ] a ^t-0000000001\n- [ ] a ^t-0000000001\n";
    expect(dedupe(dedupe(text))).toBe(dedupe(text));
    expect(dedupe(text)).toBe("- [ ] a ^t-0000000001\n");
  });
});

describe("floating dates", () => {
  it("counts whole days across a DST boundary", () => {
    // 2026-03-08 is a US DST start; the day count must still be one per day.
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-10-24", "2026-11-02")).toBe(9);
  });
});
