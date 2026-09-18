// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createEditorState } from "./index";
import { extractOutline } from "./outline";

function outlineOf(doc: string) {
  const state = createEditorState({ doc, getTitles: () => [], onNavigate: () => {} });
  return extractOutline(state).map((heading) => ({
    level: heading.level,
    text: heading.text,
  }));
}

describe("outline extractor", () => {
  it("extracts ATX headings with levels", () => {
    expect(
      outlineOf("# Title\n\nSome prose.\n\n## Section\n\n### Deep\n"),
    ).toEqual([
      { level: 1, text: "Title" },
      { level: 2, text: "Section" },
      { level: 3, text: "Deep" },
    ]);
  });

  it("extracts setext headings", () => {
    expect(outlineOf("Title\n=====\n\nSubtitle\n--------\n")).toEqual([
      { level: 1, text: "Title" },
      { level: 2, text: "Subtitle" },
    ]);
  });

  it("ignores hash text inside fenced code blocks", () => {
    expect(outlineOf("# Real\n\n```\n# Not a heading\n## also not\n```\n\n## Also real\n")).toEqual([
      { level: 1, text: "Real" },
      { level: 2, text: "Also real" },
    ]);
  });

  it("strips closing hashes and skips empty headings", () => {
    expect(outlineOf("# Padded ##\n\n#\n\n## Kept\n")).toEqual([
      { level: 1, text: "Padded" },
      { level: 2, text: "Kept" },
    ]);
  });

  it("returns an empty list for prose without headings", () => {
    expect(outlineOf("Just prose.\n\nMore prose.\n")).toEqual([]);
  });
});
