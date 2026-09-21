// A template is an ordinary note, so the interesting cases are the ones where
// an expansion could damage the file rather than fill it in.

import { describe, expect, it } from "vitest";
import { renderTemplate } from "../engine/template";
import type { VariableScope } from "../engine/variables";

const AT = new Date(2026, 2, 9, 14, 3, 7);

function scope(over: Partial<VariableScope> = {}): VariableScope {
  return { values: {}, declared: new Set<string>(), now: AT, currentPath: "Inbox.md", ...over };
}

describe("renderTemplate", () => {
  it("expands a body with no frontmatter", () => {
    const r = renderTemplate("# {{date}}\n\nNotes for {{title}}.\n", scope());
    expect(r.text).toBe("# 2026-03-09\n\nNotes for Inbox.\n");
    expect(r.issues).toEqual([]);
  });

  it("preserves frontmatter and expands its values", () => {
    const md = "---\ncreated: {{date}}\ntags: [journal, {{topic}}]\n---\n\nBody {{date}}\n";
    const s = scope({ declared: new Set(["topic"]), values: { topic: "kelp" } });
    const r = renderTemplate(md, s);
    expect(r.text).toBe("---\ncreated: 2026-03-09\ntags: [journal, kelp]\n---\n\nBody 2026-03-09\n");
    expect(r.issues).toEqual([]);
  });

  it("never expands a frontmatter key", () => {
    const md = "---\n\"{{topic}}\": value\n---\nbody\n";
    const s = scope({ declared: new Set(["topic"]), values: { topic: "kelp" } });
    expect(renderTemplate(md, s).text).toContain('"{{topic}}": value');
  });

  it("quotes a value whose expansion would break the YAML", () => {
    const md = "---\nnote: {{entry}}\n---\nbody\n";
    const s = scope({ declared: new Set(["entry"]), values: { entry: "line one\nline two: really" } });
    const r = renderTemplate(md, s);
    expect(r.text).toBe('---\nnote: "line one\\nline two: really"\n---\nbody\n');
    // Still one frontmatter block, still four lines before the body.
    expect(r.text.split("\n").filter((l) => l === "---")).toHaveLength(2);
  });

  it("leaves frontmatter it cannot parse alone, and says so", () => {
    const md = "---\nnested:\n  deep: 1\n---\n\n{{date}}\n";
    const r = renderTemplate(md, scope());
    expect(r.text).toBe("---\nnested:\n  deep: 1\n---\n\n2026-03-09\n");
    expect(r.issues.map((i) => i.code)).toEqual(["frontmatter-unparsed"]);
    expect(r.issues[0]!.severity).toBe("warning");
  });

  it("reports an undeclared variable found in the frontmatter", () => {
    const r = renderTemplate("---\na: {{nope}}\n---\nbody\n", scope());
    expect(r.issues.map((i) => i.code)).toEqual(["unknown-variable"]);
  });

  it("leaves a value with no variables byte-identical", () => {
    const md = "---\ntags: [a, b]\nn: 007\ndone: false\n---\n\nbody\n";
    expect(renderTemplate(md, scope()).text).toBe(md);
  });
});
