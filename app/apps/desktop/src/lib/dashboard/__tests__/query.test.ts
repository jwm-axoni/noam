// Grammar → `queryNotes` arguments, and the run that pages them.
//
//   Keys resolve through the EFFECTIVE catalog (seeded `type`/`people`).
//   Relative dates resolve at run time, against the clock of that run.
//   A relationship filter resolves [[Paul]] with the index's resolver and
//   becomes the contract's `traverse`; nothing filters in TS.
//   Anything the builder cannot express blocks the view (never widen).

import { describe, expect, it, vi } from "vitest";
import type { NoteCardRow } from "../../ipc";
import { withDefaultCatalogEntries } from "../../knowledge/catalog";
import type { NoteEntry } from "../../knowledge/noteTimes";
import type { KnowledgeCatalogV1 } from "../../knowledge/types";
import { parseView } from "../parse";
import {
  buildView,
  cellValue,
  resolveColumns,
  resolveRelative,
  runView,
  sortRows,
  wikilinkTarget,
  type ViewDeps,
} from "../query";

const catalog = withDefaultCatalogEntries(null);
const custom: KnowledgeCatalogV1 = withDefaultCatalogEntries({
  version: 1,
  properties: [
    { id: "prio", key: "priority", name: "Priority", type: { kind: "number", cardinality: "one" } },
    { id: "due", key: "due", name: "Due", type: { kind: "date", cardinality: "one" } },
    { id: "done", key: "done", name: "Done", type: { kind: "checkbox", cardinality: "one" } },
    { id: "stage", key: "stage", name: "Stage", type: { kind: "label", cardinality: "one" } },
  ],
  labels: [{ id: "wip", name: "In progress" }],
  relationships: [{ id: "owner", name: "Owner", cardinality: "one" }],
});
// Tuesday 29 Sept 2026, 15:00 local.
const NOW = new Date(2026, 8, 29, 15, 0, 0);
const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

const build = (text: string, cat = catalog, now = NOW) => buildView(parseView(text), { catalog: cat, now });

describe("buildView", () => {
  it("maps property filters through the catalog", () => {
    const built = build("where: type = conversation\nwhere: summary contains launch");
    expect(built.blocked).toBe(false);
    expect(built.where).toEqual([
      { propertyId: "type", op: "eq", value: "conversation" },
      { propertyId: "summary", op: "contains", value: "launch" },
    ]);
    // Default sort: newest first.
    expect(built.sort).toEqual({ key: "modified", direction: "desc" });
  });

  it("types values by the catalog: numbers, checkboxes, label names", () => {
    const built = build(
      "where: priority >= 2\nwhere: done = true\nwhere: stage = In progress\nwhere: Priority < 9",
      custom,
    );
    expect(built.where).toEqual([
      { propertyId: "prio", op: "gte", value: 2 },
      { propertyId: "done", op: "eq", value: true },
      { propertyId: "stage", op: "eq", value: "wip" },
      { propertyId: "prio", op: "lt", value: 9 },
    ]);
  });

  it("infers numbers and booleans for keys the catalog does not declare", () => {
    expect(build("where: year = 2026\nwhere: archived = false").where).toEqual([
      { propertyId: "year", op: "eq", value: 2026 },
      { propertyId: "archived", op: "eq", value: false },
    ]);
  });

  it("passes an absolute date through to the index (which owns the grammar)", () => {
    expect(build("where: created >= 2026-01-01").where).toEqual([
      { propertyId: "created", op: "gte", value: "2026-01-01" },
    ]);
  });

  it("resolves relative dates at run time, in local days", () => {
    const today = { from: local(2026, 9, 29), to: local(2026, 9, 30) };
    expect(build("where: created = today").where).toEqual([
      { propertyId: "created", op: "gte", value: today.from },
      { propertyId: "created", op: "lt", value: today.to },
    ]);
    expect(build("where: modified >= last 30 days").where).toEqual([
      { propertyId: "modified", op: "gte", value: local(2026, 8, 31) },
    ]);
    expect(build("where: modified < this week").where).toEqual([
      { propertyId: "modified", op: "lt", value: local(2026, 9, 28) },
    ]);
    expect(build("where: created > yesterday").where).toEqual([
      { propertyId: "created", op: "gte", value: today.from },
    ]);
    // The same spec a day later means a different day: nothing was frozen.
    const later = build("where: created = today", catalog, new Date(2026, 8, 30, 9));
    expect(later.where[0]!.value).toBe(local(2026, 9, 30));
  });

  it("resolves relative dates on a date PROPERTY to plain dates", () => {
    expect(build("where: due = this week", custom).where).toEqual([
      { propertyId: "due", op: "gte", value: "2026-09-28" },
      { propertyId: "due", op: "lt", value: "2026-10-05" },
    ]);
  });

  it("maps a tag filter to the tags property", () => {
    expect(build("where: tag = #meeting").where).toEqual([{ propertyId: "tags", op: "eq", value: "meeting" }]);
  });

  it("turns a relationship filter into a traverse target, not a predicate", () => {
    const built = build("where: people has [[Paul]]\nwhere: type = conversation");
    expect(built.where).toEqual([{ propertyId: "type", op: "eq", value: "conversation" }]);
    expect(built.relationship).toEqual({ relationshipId: "people", target: "Paul" });
    // By display name too, through a custom catalog.
    expect(build("where: Owner = [[People/Ada|Ada]]", custom).relationship).toEqual({
      relationshipId: "owner",
      target: "People/Ada",
    });
  });

  describe("blocks instead of widening", () => {
    it.each([
      ["a second relationship", "where: people has [[Paul]]\nwhere: people has [[Anna]]"],
      ["a relationship without a link", "where: people has Paul"],
      ["a relationship compared with <", "where: people < [[Paul]]"],
      ["a name filter", "where: name = Paul"],
      ["a relative date on an untyped key", "where: due >= today"],
      ["contains on a number", "where: year contains 2"],
      ["a bad tag", "where: tag = two words"],
    ])("%s", (_label, text) => {
      const built = build(text);
      expect(built.blocked).toBe(true);
      expect(built.issues.some((i) => i.blocking)).toBe(true);
    });

    it("a checkbox compared with a word", () => {
      expect(build("where: done = maybe", custom).blocked).toBe(true);
    });
  });

  it("sort keys resolve through the catalog; a relationship cannot be sorted", () => {
    expect(build("sort: name").sort).toEqual({ key: "name", direction: "asc" });
    expect(build("sort: created").sort).toEqual({ key: "created", direction: "desc" });
    expect(build("sort: priority desc", custom).sort).toEqual({ key: { propertyId: "prio" }, direction: "desc" });
    const bad = build("sort: people");
    expect(bad.sort).toEqual({ key: "modified", direction: "desc" });
    expect(bad.issues.map((i) => i.code)).toEqual(["bad-sort"]);
    expect(bad.blocked).toBe(false);
  });
});

describe("resolveRelative", () => {
  it("names local half-open ranges", () => {
    const r = (p: string) => {
      const range = resolveRelative(p, NOW)!;
      return [range.from.getTime(), range.to.getTime()];
    };
    expect(r("this month")).toEqual([local(2026, 9, 1), local(2026, 10, 1)]);
    expect(r("last month")).toEqual([local(2026, 8, 1), local(2026, 9, 1)]);
    expect(r("last week")).toEqual([local(2026, 9, 21), local(2026, 9, 28)]);
    expect(r("past 2 weeks")).toEqual([local(2026, 9, 16), local(2026, 9, 30)]);
    expect(resolveRelative("this week", NOW, 0)!.from.getTime()).toBe(local(2026, 9, 27));
    expect(resolveRelative("next week", NOW)).toBeNull();
  });
});

describe("wikilinkTarget", () => {
  it("reads one link", () => {
    expect(wikilinkTarget("[[Paul]]")).toBe("Paul");
    expect(wikilinkTarget("[[People/Paul#Notes|P]]")).toBe("People/Paul");
    expect(wikilinkTarget("Paul")).toBeNull();
    expect(wikilinkTarget("[[]]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const entry = (n: number, extra: Partial<NoteEntry> = {}): NoteEntry => ({
  kind: "noteEntry",
  noteId: `id-${n}`,
  path: `Notes/N${n}.md`,
  name: `N${n}`,
  created: null,
  createdSource: null,
  modified: 1_000 + n,
  ...extra,
});
const card = (n: number, extra: Partial<NoteCardRow> = {}): NoteCardRow => ({
  docId: `id-${n}`,
  path: `Notes/N${n}.md`,
  name: `N${n}`,
  excerpt: `excerpt ${n}`,
  firstImage: null,
  empty: false,
  properties: [],
  relationships: [],
  ...extra,
});

/** A fake index of `total` notes, paged with a numeric cursor like the real one. */
function fakeDeps(total: number, over: Partial<ViewDeps> = {}) {
  const deps: ViewDeps = {
    queryNotes: vi.fn(async (_query, page) => {
      const start = page.cursor ? Number(page.cursor) : 0;
      const items = Array.from({ length: Math.max(0, Math.min(page.limit, total - start)) }, (_, i) => entry(start + i));
      const end = start + items.length;
      return { items, nextCursor: end < total ? String(end) : null };
    }),
    resolveWikilink: vi.fn(async (name: string) => (name === "Paul" ? { id: "paul-id", path: "People/Paul.md" } : null)),
    listNoteCards: vi.fn(async (ids: string[]) => ids.map((id) => card(Number(id.slice(3))))),
    ...over,
  };
  return deps;
}

describe("runView", () => {
  it("pages the index up to the limit and reports more", async () => {
    const deps = fakeDeps(130);
    const run = await runView(build("limit: 120"), 120, deps);
    expect(run.rows).toHaveLength(120);
    expect(run.nextCursor).toBe("120");
    // Pages of at most 50 (Rust MAX_PAGE_SIZE).
    expect(vi.mocked(deps.queryNotes).mock.calls.map(([, page]) => page.limit)).toEqual([50, 50, 20]);
    expect(run.rows[3]!.card?.excerpt).toBe("excerpt 3");

    const more = await runView(build("limit: 120"), 120, deps, run.nextCursor);
    expect(more.rows.map((r) => r.entry.noteId)).toEqual(Array.from({ length: 10 }, (_, i) => `id-${120 + i}`));
    expect(more.nextCursor).toBeNull();
  });

  it("hands the built where + sort to queryNotes unchanged", async () => {
    const deps = fakeDeps(3);
    await runView(build("where: type = conversation\nsort: name"), 24, deps);
    expect(deps.queryNotes).toHaveBeenCalledWith(
      {
        where: [{ propertyId: "type", op: "eq", value: "conversation" }],
        sort: { key: "name", direction: "asc" },
        traverse: null,
      },
      { limit: 24, cursor: null },
    );
  });

  it("resolves [[Paul]] with the index resolver and traverses incoming over the relationship", async () => {
    const deps = fakeDeps(2);
    await runView(build("where: people has [[Paul]]"), 24, deps);
    expect(deps.resolveWikilink).toHaveBeenCalledWith("Paul");
    expect(vi.mocked(deps.queryNotes).mock.calls[0]![0].traverse).toEqual({
      fromDocId: "paul-id",
      relationshipIds: ["people"],
      direction: "incoming",
      maxDepth: 1,
    });
  });

  it("a link to a note that does not exist matches nothing, and says why", async () => {
    const deps = fakeDeps(5);
    const run = await runView(build("where: people has [[Nobody]]"), 24, deps);
    expect(run.rows).toEqual([]);
    expect(run.issues.map((i) => i.code)).toEqual(["missing-note"]);
    expect(deps.queryNotes).not.toHaveBeenCalled();
  });

  it("never runs a blocked view", async () => {
    const deps = fakeDeps(5);
    const run = await runView(build("where: type != x"), 24, deps);
    expect(run.rows).toEqual([]);
    expect(deps.queryNotes).not.toHaveBeenCalled();
  });
});

describe("table values", () => {
  const spec = parseView("view: table\ncolumns: type, people, modified, stage");
  const row = {
    entry: entry(1, { modified: 5_000 }),
    card: card(1, {
      properties: [
        { propertyId: "type", text: "conversation" },
        { propertyId: "stage", text: "wip" },
      ],
      relationships: [
        { relationshipId: "people", targetNoteId: "p", targetPath: "People/Paul.md" },
        { relationshipId: "people", targetNoteId: null, targetPath: null },
      ],
    }),
  };

  it("resolves columns with name first, deduplicated", () => {
    const columns = resolveColumns(spec, custom);
    expect(columns.map((c) => [c.kind, c.label])).toEqual([
      ["name", "Name"],
      ["property", "Type"],
      ["relationship", "People"],
      ["modified", "Modified"],
      ["property", "Stage"],
    ]);
    expect(resolveColumns(parseView("view: table"), catalog).map((c) => c.kind)).toEqual(["name", "modified"]);
  });

  it("renders values as text, links as note links, dates as dates", () => {
    const columns = resolveColumns(spec, custom);
    const labelName = (id: string) => (id === "wip" ? "In progress" : id);
    expect(cellValue(row, columns[1]!)).toEqual({ kind: "text", text: "conversation" });
    expect(cellValue(row, columns[2]!)).toEqual({
      kind: "links",
      links: [
        { label: "Paul", path: "People/Paul.md" },
        { label: "missing note", path: null },
      ],
    });
    expect(cellValue(row, columns[3]!)).toEqual({ kind: "date", ms: 5_000 });
    expect(cellValue(row, columns[4]!, labelName)).toEqual({ kind: "text", text: "In progress" });
  });

  it("re-sorts in memory with missing values last", () => {
    const rows = [
      { entry: entry(1), card: card(1, { properties: [{ propertyId: "type", text: "b" }] }) },
      { entry: entry(2), card: card(2) },
      { entry: entry(3), card: card(3, { properties: [{ propertyId: "type", text: "a" }] }) },
    ];
    const type = resolveColumns(spec, custom)[1]!;
    expect(sortRows(rows, type, "asc").map((r) => r.entry.name)).toEqual(["N3", "N1", "N2"]);
    expect(sortRows(rows, type, "desc").map((r) => r.entry.name)).toEqual(["N1", "N3", "N2"]);
  });
});
