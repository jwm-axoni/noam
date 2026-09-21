// What a board IS, byte for byte. Every other file in `lib/board` plans edits
// against these spans, so a span that is off by one is a write in the wrong
// place — which is why the assertions here compare slices of the SOURCE with
// the parsed values rather than comparing parsed values with each other.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isBoardDocument, parseBoard } from "../parse";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.md`, import.meta.url), "utf8");

const BASIC = fixture("basic");
const ARCHIVE = fixture("archive");
const WHITESPACE = fixture("whitespace");

describe("isBoardDocument", () => {
  it("recognises an Obsidian Kanban board", () => {
    expect(isBoardDocument(BASIC)).toBe(true);
  });

  it("recognises a Noam-native board", () => {
    expect(isBoardDocument("---\nnoam_kind: board\n---\n\n## Todo\n")).toBe(true);
  });

  it("is not fooled by the marker in the body", () => {
    expect(isBoardDocument("# Notes\n\nkanban-plugin: basic\n")).toBe(false);
    expect(isBoardDocument("---\ntitle: Notes\n---\n\n## Todo\n")).toBe(false);
  });
});

describe("parseBoard", () => {
  it("reads lanes and cards", () => {
    const doc = parseBoard(BASIC, { path: "Boards/Release.md", docId: "d1" });
    expect(doc.lanes.map((l) => l.title)).toEqual(["Backlog", "In progress", "Done"]);
    expect(doc.lanes.map((l) => l.cards.length)).toEqual([2, 1, 1]);
    expect(doc.lanes.every((l) => !l.archive)).toBe(true);
    expect(doc.lanes[0].cards[0].task.text).toBe("Draft the release notes");
    expect(doc.lanes[2].cards[0].task.status).toBe("done");
    expect(doc.lanes[0].cards[0].task.section).toEqual(["Backlog"]);
    expect(doc.path).toBe("Boards/Release.md");
    expect(doc.docId).toBe("d1");
  });

  it("gives every card a span that slices back to its source", () => {
    const doc = parseBoard(ARCHIVE);
    for (const lane of doc.lanes) {
      expect(ARCHIVE.slice(lane.from, lane.to)).toBe(lane.heading + lane.blocks.map((b) => (b.kind === "card" ? b.card.raw : b.text)).join(""));
      for (const card of lane.cards) {
        expect(ARCHIVE.slice(card.from, card.to)).toBe(card.raw);
        expect(ARCHIVE.slice(card.task.from, card.task.to)).toBe(card.task.sourceText);
      }
    }
  });

  it("keeps nested lines as the card body", () => {
    const doc = parseBoard(ARCHIVE);
    const card = doc.lanes[0].cards[0];
    expect(card.task.text).toBe("Call the notary 📅 2026-09-22");
    expect(card.body).toEqual([
      "  Bring the signed copy and the passport.",
      "  - [ ] photocopy the passport",
    ]);
    expect(doc.lanes[0].cards).toHaveLength(2);
  });

  it("reads the block id and leaves it out of the text", () => {
    const doc = parseBoard(ARCHIVE);
    const card = doc.lanes[1].cards[0];
    expect(card.task.id).toBe("t-k3x9f2a0b1");
    expect(card.task.text).toBe("Invoice #2219");
    expect(card.task.sourceText).toBe("- [ ] Invoice #2219 ^t-k3x9f2a0b1");
  });

  it("flags the lane after the *** rule as the archive", () => {
    const doc = parseBoard(ARCHIVE);
    expect(doc.lanes.map((l) => l.archive)).toEqual([false, false, true]);
    expect(doc.lanes[2].title).toBe("Archive");
  });

  it("keeps the settings JSON verbatim with a span that slices back", () => {
    const doc = parseBoard(ARCHIVE);
    const { raw, span } = doc.settings;
    expect(raw).not.toBeNull();
    expect(span).not.toBeNull();
    expect(ARCHIVE.slice(span!.from, span!.to)).toBe(raw);
    expect(raw).toContain('"archive-with-date":true');
    expect(doc.settings.kanbanPlugin).toBe("basic");
    expect(doc.settings.laneWidth).toBe(272);
    expect(doc.settings.showCheckboxes).toBe(true);
  });

  it("has no settings for a board that never had a block", () => {
    const doc = parseBoard(BASIC);
    expect(doc.settings.raw).toBeNull();
    expect(doc.settings.span).toBeNull();
    expect(doc.settings.laneWidth).toBeUndefined();
  });

  it("keeps an empty lane and blank filler lines", () => {
    const doc = parseBoard(WHITESPACE);
    expect(doc.lanes.map((l) => l.title)).toEqual(["Inbox", "Empty lane", "Later"]);
    expect(doc.lanes[1].cards).toHaveLength(0);
    expect(doc.lanes[0].cards[0].task.sourceText).toBe("- [ ] One thing ");
  });
});
