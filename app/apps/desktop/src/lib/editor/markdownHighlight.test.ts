// The markdown highlight spec's text tiers. A `HighlightStyle` does not expose
// the specs it was built from, which is why `markdownHighlightSpec` is exported.
import { tags as t } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { markdownHighlightSpec } from "./theme";

const tagsOf = (s: { tag: unknown }): unknown[] => (Array.isArray(s.tag) ? s.tag : [s.tag]);
const ruleFor = (tag: unknown) => markdownHighlightSpec.find((s) => tagsOf(s).includes(tag));

describe("markdownHighlight", () => {
  it("never colours t.list — lezer inherits it to the whole item's text", () => {
    // @lezer/markdown maps `"OrderedList/... BulletList/..."` to tags.list, and
    // the `/...` hands the tag to every descendant. Colouring t.list therefore
    // paints the item TEXT accent-purple, not the marker (the list colour bug).
    // GFM `Task` is tags.list as well, so this covers task items too.
    expect(markdownHighlightSpec.some((s) => tagsOf(s).includes(t.list))).toBe(false);
  });

  it("dims markdown markers to the faint tier", () => {
    // ListMark / HeaderMark / QuoteMark / LinkMark / EmphasisMark / CodeMark.
    // `--text-faint`, not `--text-tertiary`: the markers sit one tier below the
    // quietest TEXT so a line of prose reads as prose (Stage 3a).
    expect(ruleFor(t.processingInstruction)?.color).toBe("var(--text-faint)");
    expect(ruleFor(t.contentSeparator)?.color).toBe("var(--text-faint)");
    expect(ruleFor(t.meta)?.color).toBe("var(--text-faint)");
    expect(ruleFor(t.labelName)?.color).toBe("var(--text-faint)");
  });

  it("keeps quoted text on the muted tier, so a list inside a quote inherits it", () => {
    expect(ruleFor(t.quote)?.color).toBe("var(--text-secondary)");
  });

  it("never colours t.content — it is markdown's Paragraph tag too", () => {
    // YAML values are t.content; they inherit --text-primary from the line.
    // A rule here would override a quote's muted text.
    expect(markdownHighlightSpec.some((s) => tagsOf(s).includes(t.content))).toBe(false);
  });

  it("gives code keys a tint and code punctuation the tertiary tier", () => {
    // YAML keys are definition(propertyName); JSON keys are propertyName.
    const key = ruleFor(t.definition(t.propertyName))?.color;
    expect(key).toContain("var(--link)");
    expect(ruleFor(t.propertyName)?.color).toBe(key);
    for (const tag of [t.separator, t.bracket, t.punctuation]) {
      expect(ruleFor(tag)?.color).toBe("var(--text-tertiary)");
    }
    expect(ruleFor(t.null)?.color).toBe("var(--warning)");
  });

  it("keeps body-weight text on the primary tier", () => {
    expect(ruleFor(t.strong)?.color).toBe("var(--text-primary)");
  });
});
