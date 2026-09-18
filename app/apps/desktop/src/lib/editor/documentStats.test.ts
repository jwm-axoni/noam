import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { documentStats } from "./documentStats";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./__fixtures__/document-stats/${name}.md`, import.meta.url)),
    "utf8",
  );
}

describe("documentStats", () => {
  it("counts Unicode words and characters from the current buffer", () => {
    expect(documentStats(fixture("plain"), 3)).toEqual({
      words: 5,
      characters: 36,
      backlinks: 3,
      properties: 0,
    });
  });

  it("counts parsed properties and preserves the indexed backlink count", () => {
    const source = fixture("properties");
    expect(documentStats(source, 1)).toEqual({
      words: 1,
      characters: source.length,
      backlinks: 1,
      properties: 2,
    });
  });

  it("excludes frontmatter keys and values from the word count", () => {
    const source = "---\ntitle: Quarterly Planning Notes\nattendees:\n  - alice\n---\n\nHello world";
    expect(documentStats(source, 0).words).toBe(2);
  });

  it("counts the whole buffer when the frontmatter fence never closes", () => {
    const source = "---\ntitle: oops\nbody words here";
    // No closing fence: findFrontmatter treats the whole file as body.
    expect(documentStats(source, 0).words).toBe(5);
  });

  it("does not claim properties for frontmatter the editor refuses to parse", () => {
    const source = "---\nnested:\n  key: value\n---\nbody";
    expect(documentStats(source, 0).properties).toBe(0);
  });
});
