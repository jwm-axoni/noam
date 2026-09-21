// The query subset. Every test here is really one of two assertions: a clause
// we support does what it says, or a clause we do not support is REPORTED
// rather than dropped (which would widen the result behind the user's back).

import { describe, expect, it } from "vitest";
import {
  groupTasks,
  matchTask,
  parseQuery,
  resolveOperand,
  selectTasks,
  sortTasks,
  type QueryContext,
} from "../query";
import { parseTasks } from "../parse";
import { MAX_QUERY_LIMIT, type Task } from "../contracts";

// 2026-03-11 is a Wednesday.
const ctx: QueryContext = { today: "2026-03-11", weekStart: 1 };

const NOTE = [
  "# Work",
  "- [ ] Alpha ⏫ 📅 2026-03-09 #work",
  "- [ ] Beta 🔽 📅 2026-03-12 #home",
  "- [x] Gamma ✅ 2026-03-10 📅 2026-03-10 #work",
  "## Later",
  "- [/] Delta 🔁 every week ⏳ 2026-03-20",
  "- [-] Epsilon",
].join("\n");

const tasks = (path = "Projects/Work.md"): Task[] => parseTasks(NOTE, "doc-1", path);
const run = (source: string, list: Task[] = tasks()): string[] => {
  const parsed = parseQuery(source, ctx);
  return selectTasks(parsed.query, list, ctx).map((task) => task.text);
};

describe("parseQuery", () => {
  it("reads the clause set", () => {
    const parsed = parseQuery(
      [
        "not done",
        "due before today",
        "priority is high, highest",
        "tag: work",
        "path: Projects/",
        "heading is Later",
        "description includes al",
        "is recurring",
        "sort by due desc",
        "group by path",
        "limit 20",
      ].join("\n"),
      ctx,
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.unsupported).toEqual([]);
    expect(parsed.query.clauses).toEqual([
      { kind: "status", values: ["todo", "in-progress"] },
      { kind: "date", field: "due", op: "before", value: "today" },
      { kind: "priority", values: ["high", "highest"] },
      { kind: "tag", value: "work", negated: false },
      { kind: "path", value: "Projects/", negated: false },
      { kind: "heading", value: "Later" },
      { kind: "text", op: "includes", value: "al" },
      { kind: "recurring", value: true },
    ]);
    expect(parsed.query.sort).toEqual([{ field: "due", direction: "desc" }]);
    expect(parsed.query.group).toBe("path");
    expect(parsed.query.limit).toBe(20);
  });

  it("stores a relative date unresolved", () => {
    const parsed = parseQuery("due in today to next week", ctx);
    expect(parsed.query.clauses[0]).toEqual({
      kind: "date",
      field: "due",
      op: "in",
      from: "today",
      to: "next week",
    });
  });

  it("reports what it does not understand and never guesses", () => {
    const parsed = parseQuery(
      [
        "due before next fortnight",
        "sort by vibes",
        "group by mood",
        "filter by function (task) => true",
        "priority is urgent",
        "description regex /unclosed(/",
        "description regex /a/gim",
      ].join("\n"),
      ctx,
    );
    expect(parsed.query.clauses).toEqual([]);
    expect(parsed.unsupported).toHaveLength(7);
    expect(parsed.issues.map((issue) => issue.code)).toEqual([
      "bad-date",
      "unsupported-clause",
      "unsupported-clause",
      "unsupported-clause",
      "unsupported-clause",
      "bad-regex",
      "unsupported-clause",
    ]);
  });

  it("ignores blank lines and comments", () => {
    const parsed = parseQuery("\n# just a note\n\nnot done\n", ctx);
    expect(parsed.query.clauses).toHaveLength(1);
    expect(parsed.unsupported).toEqual([]);
  });

  it("clamps an oversized limit and says so", () => {
    const parsed = parseQuery("limit 5000", ctx);
    expect(parsed.query.limit).toBe(MAX_QUERY_LIMIT);
    expect(parsed.issues[0]!.code).toBe("clamped-limit");
    expect(parseQuery("", ctx).query.limit).toBe(MAX_QUERY_LIMIT);
  });
});

describe("relative dates", () => {
  it("resolves against the clock and the week start", () => {
    expect(resolveOperand("today", ctx)).toEqual({ from: "2026-03-11", to: "2026-03-11" });
    expect(resolveOperand("tomorrow", ctx)).toEqual({ from: "2026-03-12", to: "2026-03-12" });
    expect(resolveOperand("yesterday", ctx)).toEqual({ from: "2026-03-10", to: "2026-03-10" });
    expect(resolveOperand("in 3 days", ctx)).toEqual({ from: "2026-03-14", to: "2026-03-14" });
    expect(resolveOperand("2 days ago", ctx)).toEqual({ from: "2026-03-09", to: "2026-03-09" });
    // Wednesday 11 March, week starting Monday.
    expect(resolveOperand("this week", ctx)).toEqual({ from: "2026-03-09", to: "2026-03-15" });
    expect(resolveOperand("next week", ctx)).toEqual({ from: "2026-03-16", to: "2026-03-22" });
    expect(resolveOperand("last week", ctx)).toEqual({ from: "2026-03-02", to: "2026-03-08" });
    // The same day with a Sunday week start.
    expect(resolveOperand("this week", { ...ctx, weekStart: 0 })).toEqual({
      from: "2026-03-08",
      to: "2026-03-14",
    });
    expect(resolveOperand("never", ctx)).toBeNull();
  });

  it("matches the range a phrase names, not just its first day", () => {
    expect(run("due on this week")).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(run("due after this week")).toEqual([]);
    expect(run("due before this week")).toEqual([]);
  });
});

describe("matchTask", () => {
  it("filters on every clause kind", () => {
    expect(run("not done")).toEqual(["Alpha", "Beta", "Delta"]);
    expect(run("done")).toEqual(["Gamma"]);
    expect(run("status is cancelled")).toEqual(["Epsilon"]);
    expect(run("due before today")).toEqual(["Alpha", "Gamma"]);
    expect(run("due after today")).toEqual(["Beta"]);
    expect(run("due on 2026-03-12")).toEqual(["Beta"]);
    expect(run("no due date")).toEqual(["Delta", "Epsilon"]);
    expect(run("due in yesterday to tomorrow")).toEqual(["Beta", "Gamma"]);
    expect(run("priority is highest")).toEqual(["Alpha"]);
    expect(run("tag: work")).toEqual(["Alpha", "Gamma"]);
    expect(run("no tag work")).toEqual(["Beta", "Delta", "Epsilon"]);
    expect(run("heading is Later")).toEqual(["Delta", "Epsilon"]);
    expect(run("description includes et")).toEqual(["Beta"]);
    expect(run("description does not include a")).toEqual(["Epsilon"]);
    expect(run("description regex /^(Alpha|Beta)$/")).toEqual(["Alpha", "Beta"]);
    expect(run("description regex /alpha/i")).toEqual(["Alpha"]);
    expect(run("is recurring")).toEqual(["Delta"]);
    expect(run("is not recurring")).toEqual(["Alpha", "Beta", "Gamma", "Epsilon"]);
  });

  it("ANDs clauses and ORs the values inside one", () => {
    expect(run("not done\ntag: work")).toEqual(["Alpha"]);
    expect(run("status is todo, in-progress\nno due date")).toEqual(["Delta"]);
  });

  it("compares paths as a case-insensitive prefix", () => {
    expect(run("path: projects/")).toHaveLength(5);
    expect(run("path: Projects/Work.md")).toHaveLength(5);
    expect(run("not path: Projects")).toEqual([]);
    expect(run("path: Archive", tasks("Archive/Old.md"))).toHaveLength(5);
  });

  it("never matches a task on a date field it does not have", () => {
    const query = parseQuery("done before today", ctx).query;
    expect(tasks().filter((task) => matchTask(query, task, ctx)).map((t) => t.text)).toEqual([
      "Gamma",
    ]);
  });
});

describe("sortTasks", () => {
  it("falls through to the next key and then to document position", () => {
    const sorted = sortTasks(tasks(), [{ field: "priority", direction: "asc" }]);
    // Highest first, then no priority at all — in document order.
    expect(sorted.map((task) => task.text)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
    ]);
  });

  it("keeps a missing value last whichever way it sorts", () => {
    const asc = sortTasks(tasks(), [{ field: "due", direction: "asc" }]).map((t) => t.text);
    const desc = sortTasks(tasks(), [{ field: "due", direction: "desc" }]).map((t) => t.text);
    expect(asc.slice(0, 3)).toEqual(["Alpha", "Gamma", "Beta"]);
    expect(desc.slice(0, 3)).toEqual(["Beta", "Gamma", "Alpha"]);
    expect(asc.slice(3)).toEqual(["Delta", "Epsilon"]);
    expect(desc.slice(3)).toEqual(["Delta", "Epsilon"]);
  });
});

describe("groupTasks", () => {
  it("groups by heading, status and due, with the empty group last", () => {
    expect(groupTasks(tasks(), "heading").map((g) => [g.label, g.tasks.length])).toEqual([
      ["Work", 3],
      ["Work › Later", 2],
    ]);
    const dueGroups = groupTasks(tasks(), "due").map((g) => g.label);
    expect(dueGroups[dueGroups.length - 1]).toBe("No due date");
    expect(groupTasks(tasks(), "priority").map((g) => g.label)).toEqual([
      "highest",
      "low",
      "No priority",
    ]);
  });

  it("puts a multi-tagged task in every one of its groups", () => {
    const list = parseTasks("- [ ] a #x #y\n- [ ] b", "d", "p");
    expect(groupTasks(list, "tag").map((g) => [g.key, g.tasks.length])).toEqual([
      ["x", 1],
      ["y", 1],
      ["", 1],
    ]);
  });
});

describe("selectTasks", () => {
  it("applies the limit after sorting", () => {
    const parsed = parseQuery("sort by text desc\nlimit 2", ctx);
    expect(selectTasks(parsed.query, tasks(), ctx).map((t) => t.text)).toEqual([
      "Gamma",
      "Epsilon",
    ]);
  });
});
