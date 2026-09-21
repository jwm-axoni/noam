// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { THEME_PRESETS } from "../../lib/theme";
import { computedToken, installThemeCss, resetThemeAttributes, resolvedToken } from "./themeCssHarness";

const REQUIRED_TOKENS = [
  "--bg-app",
  "--bg-surface",
  "--bg-subtle",
  "--text-primary",
  "--text-faint",
  "--accent",
  "--link",
  "--heading-1-color",
  "--heading-6-color",
  "--graph-node",
  "--graph-link-rest",
];

function channel(value: string): number {
  const normalized = Number.parseInt(value, 16) / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  return 0.2126 * channel(value.slice(0, 2))
    + 0.7152 * channel(value.slice(2, 4))
    + 0.0722 * channel(value.slice(4, 6));
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("theme preset stylesheet behavior", () => {
  let style: HTMLStyleElement;

  beforeAll(() => {
    style = installThemeCss();
  });

  afterEach(resetThemeAttributes);
  afterAll(() => style.remove());

  it("applies every preset in both display modes", () => {
    const root = document.documentElement;
    for (const preset of THEME_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        root.dataset.theme = mode;
        root.dataset.themePreset = preset.id;
        for (const token of REQUIRED_TOKENS) {
          expect(computedToken(token), `${preset.id} ${mode} ${token}`).not.toBe("");
        }
        const surface = resolvedToken("--bg-surface");
        const text = resolvedToken("--text-primary");
        expect(surface, `${preset.id} ${mode} surface`).toMatch(/^#[0-9a-f]{6}$/i);
        expect(text, `${preset.id} ${mode} text`).toMatch(/^#[0-9a-f]{6}$/i);
        expect(
          contrast(text, surface),
          `${preset.label} ${mode} document contrast`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps every independent accent readable in both display modes", () => {
    const root = document.documentElement;
    for (const accent of ["violet", "blue", "green", "rose", "amber"]) {
      for (const mode of ["light", "dark"] as const) {
        root.dataset.theme = mode;
        root.dataset.themePreset = "paper-ink";
        root.dataset.themeAccent = accent;
        const color = resolvedToken("--accent");
        const onColor = resolvedToken("--text-on-accent");
        expect(
          contrast(color, onColor),
          `${accent} ${mode} accent contrast`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps brand colors independent from the selected preset", () => {
    const root = document.documentElement;
    root.dataset.theme = "dark";
    const brand = [resolvedToken("--brand-ink"), resolvedToken("--brand-pencil")];
    for (const preset of THEME_PRESETS) {
      root.dataset.themePreset = preset.id;
      expect([resolvedToken("--brand-ink"), resolvedToken("--brand-pencil")]).toEqual(brand);
    }
  });
});
