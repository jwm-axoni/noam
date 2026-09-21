// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const style = document.createElement("style");

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

describe("theme CSS behavior", () => {
  beforeAll(() => {
    style.textContent = ["tokens.css", "theme-presets.css"]
      .map((name) => readFileSync(join(here, "..", name), "utf8"))
      .join("\n");
    document.head.append(style);
  });

  afterAll(() => {
    style.remove();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-preset");
    document.documentElement.removeAttribute("data-theme-accent");
    document.documentElement.removeAttribute("data-heading-color");
  });

  it("changes palette without erasing an independent accent", () => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    root.dataset.themePreset = "noam";
    root.dataset.themeAccent = "blue";
    expect(token("--bg-app")).toBe("#ececf0");
    expect(token("--accent")).toBe("#2563a8");

    root.dataset.theme = "dark";
    root.dataset.themePreset = "black";
    expect(token("--bg-app")).toBe("#000000");
    expect(token("--accent")).toBe("#78b7ee");
  });

  it("keeps Plain headings above palette-specific heading ink", () => {
    const root = document.documentElement;
    root.dataset.theme = "dark";
    root.dataset.themePreset = "minimal";
    root.dataset.headingColor = "themed";
    expect(token("--heading-2-color")).toBe("#c4b9aa");

    root.dataset.headingColor = "plain";
    expect(token("--heading-2-color")).toBe("var(--text-primary)");
  });
});
