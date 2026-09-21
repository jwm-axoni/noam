// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ACCENT_THEMES, DEFAULT_ACCENT_THEME } from "../../lib/prefs";
import { computedToken, installThemeCss, resetThemeAttributes, resolvedToken } from "./themeCssHarness";

const REQUIRED_TOKENS = [
  "--bg-app",
  "--bg-surface",
  "--text-primary",
  "--text-faint",
  "--text-on-accent",
  "--accent",
  "--accent-hover",
  "--link",
  "--heading-1-color",
  "--heading-6-color",
  "--graph-node",
  "--graph-link-rest",
  "--focus-ring",
];

const expectedAccent: Record<string, { light: string; dark: string }> = {
  ink: { light: "#2b2724", dark: "#ebe4d6" },
  violet: { light: "#6558f5", dark: "#8f84ff" },
  sea: { light: "#0d747e", dark: "#56cad2" },
  terracotta: { light: "#b3432a", dark: "#ef8a66" },
  moss: { light: "#2e5b3c", dark: "#a9d68c" },
};

describe("accent stylesheet behavior", () => {
  let style: HTMLStyleElement;

  beforeAll(() => {
    style = installThemeCss(["tokens.css"]);
  });

  afterEach(resetThemeAttributes);
  afterAll(() => style.remove());

  it("applies every accent world in light and dark mode", () => {
    const root = document.documentElement;
    for (const { id } of ACCENT_THEMES) {
      for (const mode of ["light", "dark"] as const) {
        root.dataset.theme = mode;
        root.dataset.accent = id;
        for (const token of REQUIRED_TOKENS) expect(computedToken(token), `${id} ${mode} ${token}`).not.toBe("");
        expect(resolvedToken("--accent"), `${id} ${mode}`).toBe(expectedAccent[id]![mode]);
      }
    }
  });

  it("uses the default accent before preferences hydrate", () => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    const light = resolvedToken("--accent");
    root.dataset.accent = DEFAULT_ACCENT_THEME;
    expect(resolvedToken("--accent")).toBe(light);

    root.removeAttribute("data-accent");
    root.dataset.theme = "dark";
    const dark = resolvedToken("--accent");
    root.dataset.accent = DEFAULT_ACCENT_THEME;
    expect(resolvedToken("--accent")).toBe(dark);
  });

  it("lets a dark-mode swatch preview its own accent", () => {
    const root = document.documentElement;
    root.dataset.theme = "dark";
    const swatch = document.createElement("div");
    swatch.dataset.accent = "violet";
    root.append(swatch);
    expect(resolvedToken("--accent", swatch)).toBe(expectedAccent.violet.dark);
    swatch.remove();
  });
});
