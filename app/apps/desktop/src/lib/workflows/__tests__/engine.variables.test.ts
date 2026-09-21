// Variable expansion is the only place a workflow turns user data into text, so
// it is also the only place that can leak something. Every case here is either
// a supported expansion or a refusal — there is no third outcome where an
// unknown name silently becomes "".

import { describe, expect, it } from "vitest";
import { DATE_FORMAT_TOKENS } from "../contracts";
import { expand, formatDate, scanVariableRefs, type VariableScope } from "../engine/variables";

const AT = new Date(2026, 2, 9, 14, 3, 7); // Mon 9 Mar 2026, 14:03:07 local

function scope(over: Partial<VariableScope> = {}): VariableScope {
  return {
    values: {},
    declared: new Set<string>(),
    now: AT,
    currentPath: "Projects/Road map.md",
    ...over,
  };
}

describe("formatDate", () => {
  it("supports every declared token and nothing else", () => {
    expect(formatDate(AT, "YYYY")).toBe("2026");
    expect(formatDate(AT, "YY")).toBe("26");
    expect(formatDate(AT, "MM")).toBe("03");
    expect(formatDate(AT, "DD")).toBe("09");
    expect(formatDate(AT, "HH")).toBe("14");
    expect(formatDate(AT, "mm")).toBe("03");
    expect(formatDate(AT, "ss")).toBe("07");
    expect(formatDate(AT, "ddd")).toBe("Mon");
    expect(formatDate(AT, "MMM")).toBe("Mar");
    expect(formatDate(AT, "GGGG")).toBe("2026");
    expect(formatDate(AT, "WW")).toBe("11");
    // The exported list is the contract; nothing may be added silently.
    expect([...DATE_FORMAT_TOKENS]).toEqual([
      "YYYY", "YY", "MM", "DD", "HH", "mm", "ss", "ddd", "MMM", "GGGG", "WW",
    ]);
  });

  it("prefers the longest token so MMM is not MM + M", () => {
    expect(formatDate(AT, "YYYY-MM-DD")).toBe("2026-03-09");
    expect(formatDate(AT, "ddd, DD MMM YYYY")).toBe("Mon, 09 Mar 2026");
  });

  it("leaves anything it does not know as literal text", () => {
    // A single `W` is not the `WW` token, so both of these stay literal.
    expect(formatDate(AT, "Q [week] W")).toBe("Q [week] W");
    expect(formatDate(AT, "YYYY/Www")).toBe("2026/Www");
  });
});

// The ISO week-year is the reason `GGGG` exists: for a few days around every
// New Year it disagrees with `YYYY`, and a weekly note filed under the wrong
// one is a note the calendar can never find again.
describe("formatDate — ISO week-year boundaries", () => {
  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

  it("gives a 53-week year its 53rd week", () => {
    // 31 Dec 2026 is a Thursday, so its own week is the last week of 2026.
    expect(at(2026, 12, 31).getDay()).toBe(4);
    expect(formatDate(at(2026, 12, 31), "GGGG-[W]WW")).toBe("2026-[W]53");
  });

  it("keeps early January in the previous week-year", () => {
    expect(formatDate(at(2027, 1, 1), "GGGG-WW")).toBe("2026-53");
    expect(formatDate(at(2027, 1, 3), "GGGG-WW")).toBe("2026-53"); // Sunday
    expect(formatDate(at(2027, 1, 4), "GGGG-WW")).toBe("2027-01"); // Monday
  });

  it("pulls late December into the next week-year", () => {
    expect(formatDate(at(2024, 12, 29), "GGGG-WW")).toBe("2024-52"); // Sunday
    expect(formatDate(at(2024, 12, 30), "GGGG-WW")).toBe("2025-01"); // Monday
    expect(formatDate(at(2025, 1, 1), "GGGG-WW")).toBe("2025-01");
  });

  it("starts week 1 on the Monday of the week holding the first Thursday", () => {
    expect(formatDate(at(2026, 1, 1), "GGGG-WW")).toBe("2026-01"); // Thursday
    expect(formatDate(at(2025, 12, 29), "GGGG-WW")).toBe("2026-01"); // Monday before
    expect(formatDate(at(2025, 12, 28), "GGGG-WW")).toBe("2025-52"); // Sunday before
  });

  it("disagrees with YYYY exactly where it should and nowhere else", () => {
    expect(formatDate(at(2026, 6, 15), "YYYY GGGG WW")).toBe("2026 2026 25");
    expect(formatDate(at(2024, 12, 30), "YYYY GGGG")).toBe("2024 2025");
  });
});

describe("expand — built-ins", () => {
  it("expands date and time with defaults and with a format", () => {
    expect(expand("{{date}}", scope()).text).toBe("2026-03-09");
    expect(expand("{{time}}", scope()).text).toBe("14:03");
    expect(expand("{{date:DD MMM YYYY}} at {{time:HH:mm:ss}}", scope()).text).toBe(
      "09 Mar 2026 at 14:03:07",
    );
  });

  it("describes the current note with title, path and folder", () => {
    const r = expand("{{title}}|{{path}}|{{folder}}", scope());
    expect(r.text).toBe("Road map|Projects/Road map.md|Projects");
    expect(r.issues).toEqual([]);
  });

  it("gives empty strings for the current note when none is open", () => {
    const r = expand("[{{title}}][{{path}}][{{folder}}]", scope({ currentPath: null }));
    expect(r.text).toBe("[][][]");
    expect(r.issues).toEqual([]);
  });

  it("uses an empty folder for a note at the vault root", () => {
    expect(expand("{{folder}}", scope({ currentPath: "Inbox.md" })).text).toBe("");
  });

  it("expands selection, empty when there is none", () => {
    expect(expand("{{selection}}", scope({ selection: "picked" })).text).toBe("picked");
    expect(expand("{{selection}}", scope()).text).toBe("");
  });

  it("renders a link relative to the vault root and percent-encodes spaces", () => {
    const r = expand("{{link:Projects/Road map.md}}", scope());
    expect(r.text).toBe("[Road map](Projects/Road%20map.md)");
    expect(r.issues).toEqual([]);
  });

  it("refuses a link with no path", () => {
    const r = expand("{{link}}", scope());
    expect(r.issues.map((i) => i.code)).toEqual(["bad-builtin-arg"]);
  });
});

describe("expand — clipboard is explicit", () => {
  it("expands only from the scope, including an explicitly empty capture", () => {
    expect(expand("{{clipboard}}", scope({ clipboard: "pasted" })).text).toBe("pasted");
    const empty = expand("[{{clipboard}}]", scope({ clipboard: "" }));
    expect(empty.text).toBe("[]");
    expect(empty.issues).toEqual([]);
  });

  it("reports an issue rather than inventing a value when nothing was captured", () => {
    const r = expand("{{clipboard}}", scope());
    expect(r.issues.map((i) => i.code)).toEqual(["missing-clipboard"]);
    expect(r.issues[0]!.severity).toBe("error");
  });

  it("never touches navigator.clipboard", () => {
    const g = globalThis as Record<string, unknown>;
    const had = "navigator" in g;
    const original = g.navigator;
    let touched = false;
    Object.defineProperty(g, "navigator", {
      configurable: true,
      get() {
        touched = true;
        throw new Error("the engine read navigator");
      },
    });
    try {
      expect(expand("{{clipboard}}", scope({ clipboard: "x" })).text).toBe("x");
      expect(expand("{{clipboard}}", scope()).issues).toHaveLength(1);
    } finally {
      delete g.navigator;
      if (had) g.navigator = original;
    }
    expect(touched).toBe(false);
  });
});

describe("expand — user variables", () => {
  it("expands a declared variable that has a value", () => {
    const s = scope({ declared: new Set(["topic"]), values: { topic: "Kelp" } });
    expect(expand("# {{topic}}", s).text).toBe("# Kelp");
  });

  it("reports a declared variable with no value instead of emitting nothing", () => {
    const s = scope({ declared: new Set(["topic"]) });
    const r = expand("# {{topic}}", s);
    expect(r.issues.map((i) => i.code)).toEqual(["missing-value"]);
    expect(r.text).toBe("# {{topic}}");
  });

  it("reports an undeclared name even when a value was smuggled in", () => {
    const s = scope({ values: { topic: "Kelp" } });
    const r = expand("{{topic}}", s);
    expect(r.issues.map((i) => i.code)).toEqual(["unknown-variable"]);
    expect(r.text).toBe("{{topic}}");
  });

  it("reports an unknown built-in used in the colon form", () => {
    const r = expand("{{shell:rm -rf /}}", scope());
    expect(r.issues.map((i) => i.code)).toEqual(["unknown-builtin"]);
    expect(r.text).toBe("{{shell:rm -rf /}}");
  });

  it("leaves an unterminated token alone", () => {
    const r = expand("{{date", scope());
    expect(r.text).toBe("{{date");
    expect(r.issues).toEqual([]);
  });

  it("never re-expands a value that itself looks like a token", () => {
    const s = scope({ declared: new Set(["topic"]), values: { topic: "{{date}}" } });
    expect(expand("{{topic}}", s).text).toBe("{{date}}");
  });
});

describe("scanVariableRefs", () => {
  it("lists every reference with its argument", () => {
    expect(scanVariableRefs("{{date:YYYY}} {{topic}} {{link:A/B.md}}")).toEqual([
      { name: "date", arg: "YYYY" },
      { name: "topic", arg: null },
      { name: "link", arg: "A/B.md" },
    ]);
  });
});
