import { describe, expect, it } from "vitest";
import { diffSegments, type DiffSegment } from "./diffSegments";

const side = (segs: DiffSegment[], drop: "ins" | "del") => segs.filter((s) => s.type !== drop).map((s) => s.text).join("");

describe("diffSegments", () => {
  it("diffs the mock's intro sentence at word level", () => {
    const before = "Noam is a notes app with sync.";
    const after = "Launch is six weeks out. The build is stable, the site is live, and the only thing left is telling the story right.";
    const segs = diffSegments(before, after);
    expect(segs).toEqual([
      { type: "del", text: "Noam is a notes app with sync" },
      { type: "ins", text: "Launch is six weeks out. The build is stable, the site is live, and the only thing left is telling the story right" },
      { type: "same", text: "." },
    ]);
    expect(side(segs, "ins")).toBe(before);
    expect(side(segs, "del")).toBe(after);
  });

  it("never splits a word", () => {
    const segs = diffSegments("The quick brown fox jumps.", "The slow brown fox jumps high.");
    expect(segs).toEqual([
      { type: "same", text: "The " },
      { type: "del", text: "quick" },
      { type: "ins", text: "slow" },
      { type: "same", text: " brown fox jumps" },
      { type: "ins", text: " high" },
      { type: "same", text: "." },
    ]);
  });

  it("a pure insert is one ins segment", () => {
    expect(diffSegments("", "Publish the migration guide")).toEqual([{ type: "ins", text: "Publish the migration guide" }]);
  });

  it("a pure delete is one del segment", () => {
    expect(diffSegments("Drop this line", "")).toEqual([{ type: "del", text: "Drop this line" }]);
  });

  it("identical strings are one same segment (or nothing when empty)", () => {
    expect(diffSegments("Same text.", "Same text.")).toEqual([{ type: "same", text: "Same text." }]);
    expect(diffSegments("", "")).toEqual([]);
  });

  it("round-trips unicode and markup-looking text", () => {
    const before = "Café <b>naïve</b> 🚀 plan";
    const after = "Café <i>naïve</i> 🚀 plans";
    const segs = diffSegments(before, after);
    expect(side(segs, "ins")).toBe(before);
    expect(side(segs, "del")).toBe(after);
  });
});
