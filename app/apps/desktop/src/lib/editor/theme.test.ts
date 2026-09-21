// @vitest-environment jsdom

import { tags as t } from "@lezer/highlight";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { THEME_PRESETS } from "../theme";
import {
  computedToken,
  installThemeCss,
  resetThemeAttributes,
  resolvedToken,
} from "../../styles/__tests__/themeCssHarness";
import { hashtagTag, highlightTag } from "./ofm/tags";
import { editorThemeSpec, markdownHighlightSpec } from "./theme";

const tagsOf = (s: { tag: unknown }): unknown[] => (Array.isArray(s.tag) ? s.tag : [s.tag]);
const ruleFor = (tag: unknown) => markdownHighlightSpec.find((s) => tagsOf(s).includes(tag));

describe("editor tokens", () => {
  let style: HTMLStyleElement;

  beforeAll(() => {
    style = installThemeCss();
  });

  afterEach(resetThemeAttributes);
  afterAll(() => style.remove());

  it("applies editor tokens across every preset and display mode", () => {
    const root = document.documentElement;
    for (const preset of THEME_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        root.dataset.theme = mode;
        root.dataset.themePreset = preset.id;
        for (const name of [
          "--text-faint",
          "--highlight-bg",
          "--callout-tint",
          "--editor-fold-gutter",
          "--indent-guide",
          "--indent-guide-active",
        ]) {
          expect(computedToken(name), `${preset.id} ${mode} ${name}`).not.toBe("");
        }
        for (let level = 1; level <= 6; level += 1) {
          expect(resolvedToken(`--heading-${level}-color`), `${preset.id} ${mode} heading ${level}`).not.toBe("");
        }
      }
    }
  });

  it("applies Plain heading ink above every preset", () => {
    const root = document.documentElement;
    for (const preset of THEME_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        root.dataset.theme = mode;
        root.dataset.themePreset = preset.id;
        root.dataset.headingColor = "plain";
        const text = resolvedToken("--text-primary");
        for (let level = 1; level <= 6; level += 1) {
          expect(resolvedToken(`--heading-${level}-color`)).toBe(text);
        }
      }
    }
  });
});

describe("editor theme tiers", () => {
  it("maps each heading level to its own theme token", () => {
    for (const [level, tag] of [
      [1, t.heading1],
      [2, t.heading2],
      [3, t.heading3],
      [4, t.heading4],
      [5, t.heading5],
      [6, t.heading6],
    ] as const) {
      expect(ruleFor(tag)?.color).toBe(`var(--heading-${level}-color)`);
    }
  });

  it("keeps heading ink plain in Source mode", () => {
    const source = editorThemeSpec["&.cm-source"];
    for (let level = 1; level <= 6; level += 1) {
      expect(source[`--heading-${level}-color`]).toBe("var(--text-primary)");
    }
  });

  it("puts the bullet and the gutter on the faint tier", () => {
    expect(editorThemeSpec[".cm-bullet"].color).toBe("var(--text-faint)");
    expect(editorThemeSpec[".cm-gutters"].color).toBe("var(--text-faint)");
  });

  it("styles comments faint and italic so they read as an aside", () => {
    expect(ruleFor(t.comment)?.color).toBe("var(--text-faint)");
    expect(ruleFor(t.comment)?.fontStyle).toBe("italic");
  });

  it("washes ==highlight== rather than recolouring it", () => {
    const rule = ruleFor(highlightTag);
    expect(rule?.background).toBe("var(--highlight-bg)");
    expect(rule?.color).toBeUndefined();
  });

  it("tints #tags with the accent", () => {
    expect(ruleFor(hashtagTag)?.color).toBe("var(--accent)");
  });

  it("maps code tokens onto the existing palette", () => {
    expect(ruleFor(t.keyword)?.color).toBe("var(--accent)");
    expect(ruleFor(t.string)?.color).toBe("var(--success)");
    expect(ruleFor(t.number)?.color).toBe("var(--warning)");
    expect(ruleFor(t.function(t.variableName))?.color).toBe("var(--link)");
  });
});
