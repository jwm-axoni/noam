// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Appearance palette controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    localStorage.clear();
    document.body.replaceChildren();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(AppearanceSettings)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it("uses roving focus and arrow keys to choose a palette", async () => {
    const paper = container.querySelector<HTMLButtonElement>(
      '[data-theme-preset-id="paper-ink"]',
    );
    const sea = container.querySelector<HTMLButtonElement>('[data-theme-preset-id="sea"]');
    expect(paper?.tabIndex).toBe(0);
    expect(sea?.tabIndex).toBe(-1);

    paper?.focus();
    await act(async () => {
      paper?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(localStorage.getItem("noam-theme-preset")).toBe("sea");
    expect(sea?.getAttribute("aria-checked")).toBe("true");
    expect(sea?.tabIndex).toBe(0);
    expect(document.activeElement).toBe(sea);
  });

  it("changes accent by keyboard without changing palette or mode", async () => {
    localStorage.setItem("cbk-theme", "dark");
    const graphite = container.querySelector<HTMLButtonElement>(
      '[data-theme-preset-id="graphite"]',
    );
    await act(async () => graphite?.click());

    const paletteAccent = container.querySelector<HTMLButtonElement>(
      '[data-theme-accent-id="default"]',
    );
    const violet = container.querySelector<HTMLButtonElement>(
      '[data-theme-accent-id="violet"]',
    );
    paletteAccent?.focus();
    await act(async () => {
      paletteAccent?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });

    expect(localStorage.getItem("noam-theme-accent")).toBe("violet");
    expect(localStorage.getItem("noam-theme-preset")).toBe("graphite");
    expect(localStorage.getItem("cbk-theme")).toBe("dark");
    expect(violet?.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(violet);
  });

  it("keeps one accent control and the Plain heading preference", () => {
    expect(container.querySelectorAll('[aria-label="Theme accent"]')).toHaveLength(1);
    expect(container.querySelector('[data-setting-id="accent"]')).toBeNull();
    expect(container.querySelector('[data-setting-id="heading-color"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Heading colour"]')).not.toBeNull();
  });
});
