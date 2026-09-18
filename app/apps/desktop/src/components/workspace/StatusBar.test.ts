// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusBar } from "./StatusBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StatusBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it("renders mocked document statistics", async () => {
    await act(async () => {
      root.render(createElement(StatusBar, {
        stats: { words: 24, characters: 140, backlinks: 2, properties: 1 },
      }));
    });

    expect(container.querySelector('[data-stat="words"]')?.textContent).toBe("24 words");
    expect(container.querySelector('[data-stat="characters"]')?.textContent).toBe("140 characters");
    expect(container.querySelector('[data-stat="backlinks"]')?.textContent).toBe("2 backlinks");
    expect(container.querySelector('[data-stat="properties"]')?.textContent).toBe("1 property");
  });

  it("pluralizes irregular nouns", async () => {
    await act(async () => {
      root.render(createElement(StatusBar, {
        stats: { words: 2, characters: 3, backlinks: 1, properties: 2 },
      }));
    });

    expect(container.querySelector('[data-stat="words"]')?.textContent).toBe("2 words");
    expect(container.querySelector('[data-stat="backlinks"]')?.textContent).toBe("1 backlink");
    expect(container.querySelector('[data-stat="properties"]')?.textContent).toBe("2 properties");
  });

  it("keeps the bar mounted while values are pending", async () => {
    await act(async () => root.render(createElement(StatusBar, { stats: null })));
    expect(container.querySelector(".workspace-status-bar")).not.toBeNull();
    expect(container.querySelector(".workspace-status-values")).toBeNull();
  });
});
