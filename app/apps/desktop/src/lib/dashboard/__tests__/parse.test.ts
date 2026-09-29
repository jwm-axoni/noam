// The dashboard view grammar: a CLOSED clause set, one clause per line.
//
//   Every clause parses; nothing is evaluated.
//   An unknown or malformed filter line is a BLOCKING issue (the view shows
//   nothing rather than more than it was asked for); a bad presentation line
//   is a warning and the view still runs.
//   Relative dates are kept unresolved for the run to resolve.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_LIMIT,
  MAX_VIEW_LIMIT,
  extractViewBlocks,
  isBlocked,
  isDashboardDocument,
  parseDashboard,
  parseView,
} from "../parse";

const view = (...lines: string[]) => parseView(lines.join("\n"));

describe("isDashboardDocument", () => {
  it("reads the frontmatter only", () => {
    expect(isDashboardDocument("---\nnoam_kind: dashboard\n---\n")).toBe(true);
    expect(isDashboardDocument('---\ntitle: x\nnoam_kind: "dashboard"\n---\nbody')).toBe(true);
    expect(isDashboardDocument("---\r\nnoam_kind: dashboard\r\n---\r\n")).toBe(true);
    // The same words in the BODY are just words.
    expect(isDashboardDocument("# Notes\n\nnoam_kind: dashboard\n")).toBe(false);
    expect(isDashboardDocument("---\ntitle: x\n---\nnoam_kind: dashboard\n")).toBe(false);
    expect(isDashboardDocument("---\nnoam_kind: board\n---\n")).toBe(false);
    // Unclosed frontmatter is not frontmatter.
    expect(isDashboardDocument("---\nnoam_kind: dashboard\n")).toBe(false);
    // A nested key is not the top-level key.
    expect(isDashboardDocument("---\nmeta:\n  noam_kind: dashboard\n---\n")).toBe(false);
  });
});

describe("extractViewBlocks", () => {
  it("finds noam-view blocks in document order and skips every other fence", () => {
    const text = [
      "---",
      "noam_kind: dashboard",
      "---",
      "Intro prose.",
      "```noam-view",
      "title: One",
      "```",
      "````md",
      "```noam-view",
      "title: quoted, not a view",
      "```",
      "````",
      "~~~noam-view",
      "title: Two",
      "~~~",
      "```js",
      "title: code",
      "```",
    ].join("\n");
    const blocks = extractViewBlocks(text);
    expect(blocks.map((b) => b.source)).toEqual(["title: One", "title: Two"]);
    expect(blocks.map((b) => b.line)).toEqual([4, 12]);
    expect(parseDashboard(text).views.map((v) => v.title)).toEqual(["One", "Two"]);
  });

  it("does not look inside the frontmatter, and an unclosed block runs to the end", () => {
    const text = "---\nnoam_kind: dashboard\n---\n```noam-view\nview: table";
    expect(extractViewBlocks(text)).toEqual([{ line: 3, source: "view: table" }]);
  });
});

describe("parseView", () => {
  it("defaults: cards, full width, 24 notes, no filters", () => {
    const spec = view();
    expect(spec).toMatchObject({
      title: null,
      view: "cards",
      width: "full",
      limit: DEFAULT_VIEW_LIMIT,
      where: [],
      sort: null,
      columns: null,
      issues: [],
    });
  });

  it("parses every clause", () => {
    const spec = view(
      "title: Conversations with Paul",
      "view: table            # cards | table",
      "where: type = conversation",
      "where: people has [[Paul]]",
      "where: created >= 2026-01-01",
      "where: tag = #meeting",
      "where: priority > 2",
      "where: summary contains launch",
      "sort: modified desc",
      "limit: 50",
      "columns: name, type, people, modified",
      "width: half",
    );
    expect(spec.issues).toEqual([]);
    expect(spec.title).toBe("Conversations with Paul");
    expect(spec.view).toBe("table");
    expect(spec.width).toBe("half");
    expect(spec.limit).toBe(50);
    expect(spec.sort).toEqual({ key: "modified", direction: "desc" });
    expect(spec.columns).toEqual(["name", "type", "people", "modified"]);
    expect(spec.where.map(({ key, op, value }) => [key, op, value])).toEqual([
      ["type", "eq", "conversation"],
      ["people", "has", "[[Paul]]"],
      ["created", "gte", "2026-01-01"],
      ["tag", "eq", "#meeting"],
      ["priority", "gt", "2"],
      ["summary", "contains", "launch"],
    ]);
  });

  it("keeps relative dates UNRESOLVED", () => {
    const spec = view("where: created >= last 30 days", "where: modified = this week", "where: created < today");
    expect(spec.issues).toEqual([]);
    expect(spec.where.map((w) => w.value)).toEqual(["last 30 days", "this week", "today"]);
  });

  it("strips quotes and comments but keeps #tags", () => {
    const spec = view('where: status = "in review"  # quoted', "# a whole-line comment", "where: tag = #x");
    expect(spec.issues).toEqual([]);
    expect(spec.where.map((w) => w.value)).toEqual(["in review", "#x"]);
  });

  it("points a where line at its line in the note", () => {
    const spec = parseView("title: T\nwhere: type = a", { index: 2, line: 10 });
    expect(spec.index).toBe(2);
    expect(spec.where[0]!.line).toBe(12);
  });

  describe("never silently widens", () => {
    it.each([
      ["an unknown clause", "color: red"],
      ["a line with no clause", "type = conversation"],
      ["a filter with no operator", "where: type conversation"],
      ["not-equal (unsupported)", "where: type != meeting"],
      ["an empty filter", "where:"],
      ["a bad date", "where: created >= next tuesday"],
      ["contains on a date", "where: created contains 2026"],
      ["an empty operand", 'where: type = ""'],
    ])("%s blocks the view", (_label, line) => {
      const spec = view("title: T", line);
      expect(spec.issues).toHaveLength(1);
      expect(spec.issues[0]!.blocking).toBe(true);
      expect(isBlocked(spec)).toBe(true);
    });
  });

  describe("presentation problems warn but still run", () => {
    it.each([
      ["view: kanban", "bad-view"],
      ["width: third", "bad-width"],
      ["limit: many", "bad-limit"],
      ["limit: 0", "bad-limit"],
      ["sort: ", "bad-sort"],
      ["columns: ,", "bad-columns"],
    ])("%s", (line, code) => {
      const spec = view(line);
      expect(spec.issues.map((i) => i.code)).toEqual([code]);
      expect(isBlocked(spec)).toBe(false);
    });

    it("clamps a limit over the maximum", () => {
      const spec = view("limit: 5000");
      expect(spec.limit).toBe(MAX_VIEW_LIMIT);
      expect(spec.issues.map((i) => i.code)).toEqual(["clamped-limit"]);
      expect(isBlocked(spec)).toBe(false);
    });

    it("keeps the first of a repeated clause", () => {
      const spec = view("view: table", "view: cards");
      expect(spec.view).toBe("table");
      expect(spec.issues.map((i) => i.code)).toEqual(["duplicate-clause"]);
    });

    it("columns only apply to a table", () => {
      expect(view("columns: name, type").issues.map((i) => i.code)).toEqual(["columns-cards"]);
      expect(view("view: table", "columns: name, type").issues).toEqual([]);
    });

    it("sort direction is optional", () => {
      expect(view("sort: name").sort).toEqual({ key: "name", direction: null });
      expect(view("sort: priority ascending").sort).toEqual({ key: "priority", direction: "asc" });
    });
  });
});
