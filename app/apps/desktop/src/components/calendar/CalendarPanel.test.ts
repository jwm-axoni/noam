// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CalendarPanel, { type CalendarPanelProps } from "./CalendarPanel";
import { DEFAULT_CALENDAR_SETTINGS, dailyNotePath } from "../../lib/calendar";
import type { PlainDate } from "../../lib/tasks/contracts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CalendarPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(props: CalendarPanelProps = {}) {
    root = createRoot(container);
    act(() => {
      root.render(createElement(CalendarPanel, props));
    });
  }

  function cell(date: PlainDate): HTMLElement {
    return container.querySelector(`[data-date="${date}"]`) as HTMLElement;
  }

  function keydown(el: HTMLElement, key: string) {
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders with no props at all and no marks", () => {
    render();
    expect(container.querySelector(".calendar-panel")).not.toBeNull();
    expect(container.querySelectorAll(".calendar-day")).toHaveLength(42);
    expect(container.querySelector(".calendar-day-has-note")).toBeNull();
  });

  it("focuses the initial date and moves with arrow keys", () => {
    render({ initialDate: "2026-09-15" });
    const start = cell("2026-09-15");
    start.focus();
    expect(start.getAttribute("tabindex")).toBe("0");

    keydown(start, "ArrowRight");
    expect(cell("2026-09-16").getAttribute("tabindex")).toBe("0");
    expect(cell("2026-09-15").getAttribute("tabindex")).toBe("-1");

    keydown(cell("2026-09-16"), "ArrowDown");
    expect(cell("2026-09-23").getAttribute("tabindex")).toBe("0");

    keydown(cell("2026-09-23"), "ArrowLeft");
    expect(cell("2026-09-22").getAttribute("tabindex")).toBe("0");

    keydown(cell("2026-09-22"), "ArrowUp");
    expect(cell("2026-09-15").getAttribute("tabindex")).toBe("0");
  });

  it("PageDown/PageUp move a month, keeping the day-of-month focused", () => {
    render({ initialDate: "2026-09-15" });
    const start = cell("2026-09-15");
    start.focus();

    keydown(start, "PageDown");
    expect(container.querySelector(".calendar-panel-title")!.textContent).toBe("October 2026");
    expect(cell("2026-10-15").getAttribute("tabindex")).toBe("0");

    keydown(cell("2026-10-15"), "PageUp");
    expect(container.querySelector(".calendar-panel-title")!.textContent).toBe("September 2026");
    expect(cell("2026-09-15").getAttribute("tabindex")).toBe("0");
  });

  it("t jumps back to today after navigating away", () => {
    const today = new Date();
    const todayPlain = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate(),
    ).padStart(2, "0")}`;
    render({ initialDate: "2026-01-01" });
    const start = cell("2026-01-01");
    start.focus();
    keydown(start, "ArrowRight");
    keydown(container.querySelector('[tabindex="0"]') as HTMLElement, "t");
    expect(container.querySelector(`[data-date="${todayPlain}"]`)!.getAttribute("tabindex")).toBe("0");
  });

  it("Enter calls onOpenDay with the focused PlainDate", () => {
    const onOpenDay = vi.fn();
    render({ initialDate: "2026-09-15", onOpenDay });
    const start = cell("2026-09-15");
    start.focus();
    keydown(start, "ArrowRight");
    keydown(cell("2026-09-16"), "Enter");
    expect(onOpenDay).toHaveBeenCalledWith("2026-09-16");
  });

  it("w calls onOpenWeek with the focused PlainDate", () => {
    const onOpenWeek = vi.fn();
    render({ initialDate: "2026-09-15", onOpenWeek });
    const start = cell("2026-09-15");
    start.focus();
    keydown(start, "w");
    expect(onOpenWeek).toHaveBeenCalledWith("2026-09-15");
  });

  it("clicking a day calls onOpenDay too", () => {
    const onOpenDay = vi.fn();
    render({ initialDate: "2026-09-15", onOpenDay });
    act(() => {
      cell("2026-09-20").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenDay).toHaveBeenCalledWith("2026-09-20");
  });

  it("marks days via noteExists, resolved through settings' daily path template", () => {
    const marked = dailyNotePath(DEFAULT_CALENDAR_SETTINGS, "2026-09-10");
    const noteExists = (path: string) => path === marked;
    render({ initialDate: "2026-09-15", noteExists });
    expect(cell("2026-09-10").className).toContain("calendar-day-has-note");
    expect(cell("2026-09-11").className).not.toContain("calendar-day-has-note");
  });

  it("renders a due-count badge from the dueCounts map", () => {
    const dueCounts = new Map<PlainDate, number>([["2026-09-12", 3]]);
    render({ initialDate: "2026-09-15", dueCounts });
    expect(cell("2026-09-12").querySelector(".calendar-day-count")!.textContent).toBe("3");
    expect(cell("2026-09-13").querySelector(".calendar-day-count")).toBeNull();
  });
});
