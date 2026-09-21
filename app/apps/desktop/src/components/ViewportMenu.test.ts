// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewportMenu } from "./ViewportMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ViewportMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("ResizeObserver", undefined);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clamps the account popover inside a narrow viewport and prefers above", async () => {
    const anchor = document.createElement("button");
    anchor.getBoundingClientRect = () => ({
      x: 4,
      y: 640,
      left: 4,
      top: 640,
      right: 204,
      bottom: 680,
      width: 200,
      height: 40,
      toJSON: () => ({}),
    });
    container.append(anchor);
    const menuRef = createRef<HTMLDivElement>();
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(348);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);

    await act(async () => {
      root.render(
        createElement(ViewportMenu, {
          anchorRef: { current: anchor },
          menuRef,
          className: "account-popover",
          role: "menu",
          align: "start",
          side: "up",
          children: "Account menu",
        }),
      );
    });

    expect(menuRef.current?.style.position).toBe("fixed");
    expect(menuRef.current?.style.left).toBe("8px");
    expect(menuRef.current?.style.top).toBe("334px");
    expect(menuRef.current?.style.getPropertyValue("--viewport-menu-max-height")).toBe("684px");
  });
});
