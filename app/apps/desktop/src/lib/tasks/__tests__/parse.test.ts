// The parser and the serializer are one contract: whatever the parser takes
// apart, the serializer has to put back byte for byte. The corpus below is the
// pin — it includes lines we only half understand, because those are the ones
// a round-trip loses.

import { describe, expect, it } from "vitest";
import { parseTaskLine, parseTasks, scanTaskLine } from "../parse";
import { serializeTask } from "../serialize";
import type { Task } from "../contracts";

const ctx = { docId: "doc-1", path: "Notes/Tasks.md", line: 0, from: 0 };
const parse = (line: string): Task => {
  const task = parseTaskLine(line, ctx);
  if (!task) throw new Error(`not a task line: ${JSON.stringify(line)}`);
  return task;
};

/** Every line here must survive `serialize(parse(line)) === line`. */
const CORPUS: string[] = [
  "- [ ] ",
  "- [ ] Buy milk",
  "- [x] Buy milk",
  "- [X] Buy milk",
  "- [/] Half done",
  "- [-] Cancelled",
  "* [ ] Star bullet",
  "+ [ ] Plus bullet",
  "\t- [ ] Tab indented",
  "    - [ ] Four spaces",
  "-   [ ] Wide bullet gap",
  "- [ ]\tTab separator",
  "- [ ] Trailing space ",
  "- [ ] Has an id ^t-k3x9f2a0b1",
  "- [ ] Priority highest ⏫",
  "- [ ] Priority high 🔼",
  "- [ ] Priority medium ▶",
  "- [ ] Priority medium emoji ▶️",
  "- [ ] Priority low 🔽",
  "- [ ] Priority lowest ⏬",
  "- [ ] Every marker 🔁 every week ➕ 2026-01-01 🛫 2026-01-02 ⏳ 2026-01-03 📅 2026-01-04 ❌ 2026-01-05 ✅ 2026-01-06",
  "- [x] Full line ⏫ 🔁 every day 📅 2026-03-09 ✅ 2026-03-08 🆔 abc123 ⛔ def456 ^t-0000000001",
  "- [ ] Tags #work #home/chores 📅 2026-03-09",
  "- [ ] Obsidian highest 🔺",
  "- [ ] On completion 🏁 delete",
  "- [ ] No space before date 📅2026-03-09",
  "- [ ] Malformed date 📅 next friday",
  "- [ ] Malformed date at end 📅",
  "- [ ] Two due dates 📅 2026-03-09 📅 2026-04-09",
  "- [ ] Unsupported recurrence 🔁 every third blue moon 📅 2026-03-09",
  "- [ ]   Extra leading space",
  "- [ ] Words after a marker 📅 2026-03-09 and then some words",
  "- [ ] Double  space  inside the description",
  "- [ ] Weird gap 📅  2026-03-09",
  "- [x] Done with id and trailing gap 📅 2026-03-09  ^t-zzzzzzzzzz",
];

describe("round trip", () => {
  it.each(CORPUS)("serialize(parse(%j)) is byte-identical", (line) => {
    expect(serializeTask(parse(line))).toBe(line);
  });

  it("round-trips CRLF content by parsing the line without its terminator", () => {
    const tasks = parseTasks("- [ ] One\r\n- [x] Two\r\n", "d", "p");
    expect(tasks.map((t) => t.sourceText)).toEqual(["- [ ] One", "- [x] Two"]);
    expect(tasks.map(serializeTask)).toEqual(["- [ ] One", "- [x] Two"]);
  });
});

describe("parseTaskLine", () => {
  it("rejects everything that is not a task line", () => {
    for (const line of [
      "- [ ]", // no separator after the checkbox
      "-[ ] no space after the bullet",
      "- [] empty checkbox",
      "- [ab] two characters",
      "- [?] unknown checkbox",
      "text - [ ] not at the line start",
      "# Heading",
      "",
    ]) {
      expect(parseTaskLine(line, ctx), line).toBeNull();
    }
  });

  it("reads every status", () => {
    expect(parse("- [ ] a").status).toBe("todo");
    expect(parse("- [x] a").status).toBe("done");
    expect(parse("- [X] a").status).toBe("done");
    expect(parse("- [/] a").status).toBe("in-progress");
    expect(parse("- [-] a").status).toBe("cancelled");
  });

  it("reads every marker into its own field", () => {
    const task = parse(
      "- [x] Ship it 🔁 every week ➕ 2026-01-01 🛫 2026-01-02 ⏳ 2026-01-03 📅 2026-01-04 ❌ 2026-01-05 ✅ 2026-01-06",
    );
    expect(task.text).toBe("Ship it");
    expect(task.created).toBe("2026-01-01");
    expect(task.start).toBe("2026-01-02");
    expect(task.scheduled).toBe("2026-01-03");
    expect(task.due).toBe("2026-01-04");
    expect(task.cancelled).toBe("2026-01-05");
    expect(task.done).toBe("2026-01-06");
    expect(task.recurrence).toEqual({
      raw: "every week",
      rule: { unit: "week", interval: 1 },
      whenDone: false,
    });
    expect(task.unparsed).toEqual([]);
  });

  it("accepts ▶️ with its variation selector and reads it as medium", () => {
    expect(parse("- [ ] a ▶️").priority).toBe("medium");
    expect(parse("- [ ] a ▶").priority).toBe("medium");
    expect(parse("- [ ] a ⏫").priority).toBe("highest");
    expect(parse("- [ ] a ⏬").priority).toBe("lowest");
  });

  it("preserves unknown tokens verbatim and in order", () => {
    const task = parse("- [ ] a 🔺 🆔 abc ⛔ def 📅 nope 🏁 delete");
    expect(task.unparsed).toEqual(["🔺", "🆔 abc", "⛔ def", "📅 nope", "🏁 delete"]);
    expect(task.priority).toBeNull();
    expect(task.due).toBeNull();
    expect(task.text).toBe("a");
  });

  it("keeps the id out of the text and off the fields", () => {
    const task = parse("- [ ] a 📅 2026-03-09 ^t-k3x9f2a0b1");
    expect(task.id).toBe("t-k3x9f2a0b1");
    expect(task.text).toBe("a");
    expect(task.due).toBe("2026-03-09");
    expect(parse("- [ ] a").id).toBeNull();
  });

  it("collects tags without the hash, deduplicated, in source order", () => {
    expect(parse("- [ ] #b work #a and #b again 📅 2026-03-09 #c").tags).toEqual(["b", "a", "c"]);
  });

  it("records the indent verbatim and the line span", () => {
    const task = parseTaskLine("\t  - [ ] nested", { ...ctx, from: 42 })!;
    expect(task.indent).toBe("\t  ");
    expect(task.from).toBe(42);
    expect(task.to).toBe(42 + "\t  - [ ] nested".length);
  });

  it("heads its own series only when the line recurs", () => {
    expect(parse("- [ ] a 🔁 every day ^t-k3x9f2a0b1").seriesId).toBe("t-k3x9f2a0b1");
    expect(parse("- [ ] a ^t-k3x9f2a0b1").seriesId).toBeNull();
  });
});

describe("scanTaskLine", () => {
  it("places every span inside the line", () => {
    const line = "- [ ] a 📅 2026-03-09 ^t-k3x9f2a0b1";
    const scan = scanTaskLine(line)!;
    expect(line.slice(scan.checkboxAt, scan.checkboxAt + 1)).toBe(" ");
    expect(line.slice(scan.descriptionFrom, scan.descriptionTo)).toBe("a");
    const due = scan.segments[0]!;
    expect(line.slice(due.from, due.to)).toBe("📅 2026-03-09");
    expect(line.slice(due.valueFrom!, due.valueTo!)).toBe("2026-03-09");
    expect(due.gap).toBe(" ");
  });
});

describe("parseTasks", () => {
  const note = [
    "---",
    "title: Notes",
    "tags: [a]",
    "---",
    "- [ ] Above any heading",
    "",
    "# Project",
    "",
    "- [ ] Under project",
    "",
    "## Today",
    "- [x] Under today",
    "  - [ ] Nested under today",
    "",
    "```md",
    "- [ ] Inside a fence is documentation, not a task",
    "```",
    "",
    "~~~",
    "- [ ] Tilde fence too",
    "~~~",
    "",
    "# Other",
    "- [ ] Under other",
  ].join("\n");

  it("skips frontmatter and fenced code, and tracks the heading trail", () => {
    const tasks = parseTasks(note, "doc-1", "Notes/Tasks.md");
    expect(tasks.map((t) => t.text)).toEqual([
      "Above any heading",
      "Under project",
      "Under today",
      "Nested under today",
      "Under other",
    ]);
    expect(tasks[0]!.section).toEqual([]);
    expect(tasks[1]!.section).toEqual(["Project"]);
    expect(tasks[2]!.section).toEqual(["Project", "Today"]);
    expect(tasks[4]!.section).toEqual(["Other"]);
    expect(tasks[3]!.indent).toBe("  ");
  });

  it("reports hint offsets that actually contain the line", () => {
    const tasks = parseTasks(note, "doc-1", "Notes/Tasks.md");
    for (const task of tasks) {
      expect(note.slice(task.from, task.to)).toBe(task.sourceText);
      expect(note.split("\n")[task.line]).toBe(task.sourceText);
    }
  });

  it("treats a leading --- as frontmatter but a later one as a rule", () => {
    const tasks = parseTasks("---\nkey: value\n---\n- [ ] one\n\n---\n- [ ] two\n", "d", "p");
    expect(tasks.map((t) => t.text)).toEqual(["one", "two"]);
  });
});
