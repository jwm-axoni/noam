// The task contracts are on-disk format: a regex that widens turns a line
// nobody meant as a task into something Noam will rewrite, and a marker glyph
// that moves rewrites every file in every vault that already uses it. So this
// suite is a corpus pinned against the constants, not a test of behaviour —
// there is no behaviour in `contracts.ts` to test.

import { describe, expect, it } from "vitest";
import { DATE_FORMAT_TOKENS } from "../../workflows/contracts";
import {
  CHECKBOX_STATUS,
  MARKERS,
  MAX_QUERY_LIMIT,
  PLAIN_DATE_RE,
  PRIORITY_MARKERS,
  PRIORITY_ORDER,
  SERIES_ID_RE,
  STATUS_CHECKBOX,
  TASK_ID_RE,
  TASK_ID_SUFFIX_RE,
  TASK_LINE_RE,
  type TaskStatus,
} from "../contracts";

interface Match {
  indent: string;
  bullet: string;
  checkbox: string;
  rest: string;
}

function match(line: string): Match | null {
  const m = TASK_LINE_RE.exec(line);
  return m ? { indent: m[1]!, bullet: m[2]!, checkbox: m[3]!, rest: m[4]! } : null;
}

describe("TASK_LINE_RE — what is a task", () => {
  it("recognises every checkbox state and maps it to a status", () => {
    const corpus: Array<[string, string, TaskStatus]> = [
      ["- [ ] write the spec", " ", "todo"],
      ["- [x] write the spec", "x", "done"],
      ["- [X] write the spec", "X", "done"],
      ["- [/] write the spec", "/", "in-progress"],
      ["- [-] write the spec", "-", "cancelled"],
    ];
    for (const [line, checkbox, status] of corpus) {
      const m = match(line);
      expect(m, line).not.toBeNull();
      expect(m!.checkbox).toBe(checkbox);
      expect(CHECKBOX_STATUS[m!.checkbox]).toBe(status);
      expect(m!.rest).toBe("write the spec");
    }
  });

  it("accepts every list bullet Markdown allows", () => {
    for (const bullet of ["-", "*", "+"]) {
      const m = match(`${bullet} [ ] buy milk`);
      expect(m, bullet).not.toBeNull();
      expect(m!.bullet).toBe(bullet);
      expect(m!.indent).toBe("");
    }
  });

  it("captures indentation verbatim, spaces or tabs", () => {
    expect(match("    - [ ] nested")!.indent).toBe("    ");
    expect(match("\t\t* [x] nested")!.indent).toBe("\t\t");
    // More than one space after the bullet is legal Markdown and stays legal.
    expect(match("-   [ ] loose")!.rest).toBe("loose");
    // The one separator after `]` is `\s`, so a tab-aligned line is a task.
    expect(match("  - [ ]\ttabbed")!.rest).toBe("tabbed");
  });

  it("keeps markers, tags and the id suffix in the captured rest", () => {
    const line = "- [ ] Ship v2 #release ⏫ 📅 2026-03-09 🔁 every week ^t-k3x9f2a0b1";
    const m = match(line)!;
    expect(m.rest).toBe("Ship v2 #release ⏫ 📅 2026-03-09 🔁 every week ^t-k3x9f2a0b1");
    expect(TASK_ID_SUFFIX_RE.exec(line)![1]).toBe("t-k3x9f2a0b1");
  });

  it("refuses the near misses", () => {
    const notTasks = [
      "- [ ]x", // no space after the checkbox
      "-[ ] a", // no space after the bullet
      "- [ ]", // nothing after the checkbox at all
      "- [] a", // empty checkbox
      "- [ab] a", // two-character checkbox
      "- [?] a", // unknown checkbox character
      "- just a bullet",
      "[ ] a", // no bullet
      "> - [ ] quoted", // a blockquote is not a list item
    ];
    for (const line of notTasks) expect(match(line), line).toBeNull();
  });

  it("is a task with empty text when a space does follow the checkbox", () => {
    const m = match("- [ ] ");
    expect(m).not.toBeNull();
    expect(m!.rest).toBe("");
  });

  it("is anchored, so only the first line of a block can match", () => {
    expect(match("- [ ] one\n- [ ] two")).toBeNull();
  });
});

describe("identity", () => {
  it("accepts ten lowercase base36 characters after t-", () => {
    for (const id of ["t-0000000000", "t-k3x9f2a0b1", "t-zzzzzzzzzz"]) {
      expect(TASK_ID_RE.test(id), id).toBe(true);
      // A series id is the task id of the series head, so the shapes agree.
      expect(SERIES_ID_RE.test(id), id).toBe(true);
    }
  });

  it("refuses anything else", () => {
    const bad = [
      "t-k3x9f2a0b", // nine
      "t-k3x9f2a0b12", // eleven
      "t-K3X9F2A0B1", // upper case
      "t-k3x9f2a0b!",
      "k3x9f2a0b1", // no prefix
      "^t-k3x9f2a0b1", // the suffix marker is not part of the id
      "s-k3x9f2a0b1",
    ];
    for (const id of bad) {
      expect(TASK_ID_RE.test(id), id).toBe(false);
      expect(SERIES_ID_RE.test(id), id).toBe(false);
    }
  });

  it("finds the block-id suffix only at the end of the line", () => {
    expect(TASK_ID_SUFFIX_RE.test("- [ ] done ^t-k3x9f2a0b1")).toBe(true);
    expect(TASK_ID_SUFFIX_RE.test("- [ ] done ^t-k3x9f2a0b1 and more")).toBe(false);
    expect(TASK_ID_SUFFIX_RE.test("- [ ] done^t-k3x9f2a0b1")).toBe(false); // needs the space
  });

  it("pins the floating date shape", () => {
    expect(PLAIN_DATE_RE.test("2026-03-09")).toBe(true);
    for (const bad of ["2026-3-9", "2026-03-09T00:00:00Z", "09/03/2026", ""]) {
      expect(PLAIN_DATE_RE.test(bad), bad).toBe(false);
    }
  });
});

describe("frozen constants", () => {
  it("pins the marker set, in order, glyph by glyph", () => {
    expect(Object.keys(MARKERS)).toEqual([
      "due",
      "scheduled",
      "start",
      "done",
      "created",
      "cancelled",
      "recurrence",
      "id",
      "dependsOn",
    ]);
    expect(Object.values(MARKERS)).toEqual(["📅", "⏳", "🛫", "✅", "➕", "❌", "🔁", "🆔", "⛔"]);
  });

  it("pins the priority glyphs and their order", () => {
    expect(PRIORITY_ORDER).toEqual(["highest", "high", "medium", "low", "lowest"]);
    expect(PRIORITY_ORDER.map((p) => PRIORITY_MARKERS[p])).toEqual(["⏫", "🔼", "▶", "🔽", "⏬"]);
    // 🔺 is deliberately NOT ours: it must survive a round-trip as unparsed text.
    expect(Object.values(PRIORITY_MARKERS)).not.toContain("🔺");
  });

  it("writes back a checkbox character it can read", () => {
    for (const [status, checkbox] of Object.entries(STATUS_CHECKBOX)) {
      expect(CHECKBOX_STATUS[checkbox]).toBe(status);
      expect(match(`- [${checkbox}] round trip`), checkbox).not.toBeNull();
    }
    expect(STATUS_CHECKBOX.done).toBe("x"); // we read `X`, we write `x`
  });

  it("caps one query at 500 rows", () => {
    expect(MAX_QUERY_LIMIT).toBe(500);
  });

  it("has the ISO week tokens the weekly note template needs", () => {
    expect([...DATE_FORMAT_TOKENS]).toEqual([
      "YYYY", "YY", "MM", "DD", "HH", "mm", "ss", "ddd", "MMM", "GGGG", "WW",
    ]);
  });
});
