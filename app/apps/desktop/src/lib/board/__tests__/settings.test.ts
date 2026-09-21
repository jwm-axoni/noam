// A settings change is a minimal span edit of the JSON. The test that matters
// is not "the value changed" but "nothing else did": unknown keys, key order
// and every byte outside the JSON survive, because we never reserialize the
// object Obsidian Kanban wrote.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBoard } from "../parse";
import { applyChanges } from "../serialize";
import { planUpdateSettings, readSettings } from "../settings";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.md`, import.meta.url), "utf8");

const ARCHIVE = fixture("archive");
const BASIC = fixture("basic");

describe("readSettings", () => {
  it("reads only the subset we understand", () => {
    const settings = readSettings(parseBoard(ARCHIVE));
    expect(settings).toEqual({
      kanbanPlugin: "basic",
      laneWidth: 272,
      showCheckboxes: true,
    });
  });

  it("reports nothing for a board with no settings block", () => {
    expect(readSettings(parseBoard(BASIC))).toEqual({ kanbanPlugin: "basic" });
  });
});

describe("planUpdateSettings", () => {
  it("edits one value and leaves every other byte alone", () => {
    const doc = parseBoard(ARCHIVE);
    const changes = planUpdateSettings(doc, { laneWidth: 320 });
    expect(changes).toHaveLength(1);
    const next = applyChanges(ARCHIVE, changes);
    expect(next).toBe(ARCHIVE.replace('"lane-width":272', '"lane-width":320'));
    expect(parseBoard(next).settings.laneWidth).toBe(320);
  });

  it("keeps unknown keys and key order when it appends a new one", () => {
    const doc = parseBoard(ARCHIVE);
    const next = applyChanges(ARCHIVE, planUpdateSettings(doc, { archiveLaneTitle: "Done" }));
    const raw = parseBoard(next).settings.raw!;
    expect(raw).toBe(
      '{"kanban-plugin":"basic","lane-width":272,"show-checkboxes":true,' +
        '"date-trigger":"@","archive-with-date":true,"archive-lane-title":"Done"}',
    );
    expect(next.slice(0, next.indexOf("{"))).toBe(ARCHIVE.slice(0, ARCHIVE.indexOf("{")));
  });

  it("changes two values in one plan", () => {
    const doc = parseBoard(ARCHIVE);
    const next = applyChanges(
      ARCHIVE,
      planUpdateSettings(doc, { laneWidth: 300, showCheckboxes: false }),
    );
    expect(parseBoard(next).settings.laneWidth).toBe(300);
    expect(parseBoard(next).settings.showCheckboxes).toBe(false);
    expect(parseBoard(next).settings.raw).toContain('"date-trigger":"@"');
  });

  it("appends a whole block when the board has none", () => {
    const doc = parseBoard(BASIC);
    const changes = planUpdateSettings(doc, { laneWidth: 260 });
    expect(changes).toHaveLength(1);
    expect(changes[0].from).toBe(BASIC.length);
    const next = applyChanges(BASIC, changes);
    expect(next.startsWith(BASIC)).toBe(true);
    const reparsed = parseBoard(next);
    expect(reparsed.settings.laneWidth).toBe(260);
    expect(reparsed.lanes.map((l) => l.title)).toEqual(["Backlog", "In progress", "Done"]);
  });

  it("plans nothing for an empty patch", () => {
    expect(planUpdateSettings(parseBoard(ARCHIVE), {})).toEqual([]);
  });
});
