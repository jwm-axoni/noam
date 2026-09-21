// The invariant the whole feature rests on: a board we parsed and did not edit
// must come back out byte for byte. Anything less and simply OPENING a Kanban
// board would rewrite someone's file.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBoard } from "../parse";
import { serializeBoard } from "../serialize";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.md`, import.meta.url), "utf8");

describe("serializeBoard", () => {
  for (const name of ["basic", "archive", "whitespace"]) {
    it(`round-trips ${name}.md byte for byte`, () => {
      const text = fixture(name);
      expect(serializeBoard(parseBoard(text))).toBe(text);
    });
  }

  it("round-trips a note with no lanes at all", () => {
    const text = "---\nnoam_kind: board\n---\n\nnothing here yet\n";
    expect(serializeBoard(parseBoard(text))).toBe(text);
  });

  it("round-trips CRLF line endings", () => {
    const text = fixture("basic").replace(/\n/g, "\r\n");
    expect(serializeBoard(parseBoard(text))).toBe(text);
  });

  it("round-trips a file with no trailing newline", () => {
    const text = "## Todo\n\n- [ ] last line, no newline";
    expect(serializeBoard(parseBoard(text))).toBe(text);
  });
});
