import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function installThemeCss(names = ["tokens.css", "theme-presets.css"]): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = names.map((name) => readFileSync(join(here, "..", name), "utf8")).join("\n");
  document.head.append(style);
  return style;
}

export function computedToken(name: string, element: Element = document.documentElement): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

export function resolvedToken(name: string, element: Element = document.documentElement): string {
  let value = computedToken(name, element);
  const seen = new Set<string>();
  while (/^var\(--[\w-]+\)$/.test(value)) {
    if (seen.has(value)) throw new Error(`cyclic token ${value}`);
    seen.add(value);
    value = computedToken(value.slice(4, -1), element);
  }
  return value;
}

export function resetThemeAttributes(): void {
  for (const name of [
    "data-theme",
    "data-accent",
    "data-theme-preset",
    "data-theme-accent",
    "data-heading-color",
  ]) {
    document.documentElement.removeAttribute(name);
  }
}
