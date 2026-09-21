// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.html"),
  "utf8",
);
function readBootScript(): string {
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  if (!script) throw new Error("missing inline theme boot script");
  return script;
}

const bootScript = readBootScript();

function boot(): void {
  Function(bootScript)();
}

describe("pre-render theme boot", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const name of [
      "data-theme",
      "data-theme-preset",
      "data-theme-accent",
      "data-heading-color",
      "data-accent",
    ]) {
      document.documentElement.removeAttribute(name);
    }
  });

  it("paints migrated palette, mode and independent accent before React mounts", () => {
    localStorage.setItem("cbk-theme", "dark");
    localStorage.setItem("context.accentTheme", "moss");
    localStorage.setItem("context.headingColor", "plain");
    localStorage.setItem("noam-theme-accent", "blue");
    document.documentElement.dataset.accent = "moss";

    boot();

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreset).toBe("moss");
    expect(document.documentElement.dataset.themeAccent).toBe("blue");
    expect(document.documentElement.dataset.headingColor).toBe("plain");
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
  });

  it("prefers an explicit new palette over the compatibility preference", () => {
    localStorage.setItem("cbk-theme", "light");
    localStorage.setItem("context.accentTheme", "sea");
    localStorage.setItem("noam-theme-preset", "black");

    boot();

    expect(document.documentElement.dataset.themePreset).toBe("black");
  });
});
