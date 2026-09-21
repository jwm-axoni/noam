// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarGrid, type CalendarGridProps } from "./CalendarGrid";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const weeks = [
  ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"],
  ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"],
];

describe("CalendarGrid", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(overrides: Partial<CalendarGridProps> = {}) {
    const onFocus = vi.fn();
    const onActivate = vi.fn();
    const props: CalendarGridProps = {
      weeks,
      year: 2026,
      month: 9,
      focused: "2026-09-01",
      today: "2026-09-01",
      weekStart: 1,
      hasNote: (date) => date === "2026-09-02",
      dueCount: (date) => (date === "2026-09-03" ? 2 : 0),
      onFocus,
      onActivate,
      ...overrides,
    };
    root = createRoot(container);
    act(() => {
      root.render(createElement(CalendarGrid, props));
    });
    return { onFocus, onActivate };
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("marks the focused cell with aria-selected and roving tabindex 0, others -1", () => {
    render();
    const focusedCell = container.querySelector('[data-date="2026-09-01"]')!;
    const otherCell = container.querySelector('[data-date="2026-09-02"]')!;
    expect(focusedCell.getAttribute("aria-selected")).toBe("true");
    expect(focusedCell.getAttribute("tabindex")).toBe("0");
    expect(otherCell.getAttribute("aria-selected")).toBe("false");
    expect(otherCell.getAttribute("tabindex")).toBe("-1");
  });

  it("renders a has-note mark only on days the data source flags", () => {
    render();
    expect(container.querySelector('[data-date="2026-09-02"]')!.className).toContain("calendar-day-has-note");
    expect(container.querySelector('[data-date="2026-09-01"]')!.className).not.toContain("calendar-day-has-note");
  });

  it("renders a due-count badge only when the count is positive", () => {
    render();
    expect(container.querySelector('[data-date="2026-09-03"] .calendar-day-count')!.textContent).toBe("2");
    expect(container.querySelector('[data-date="2026-09-01"] .calendar-day-count')).toBeNull();
  });

  it("dims days outside the displayed month", () => {
    render();
    expect(container.querySelector('[data-date="2026-08-31"]')!.className).toContain("calendar-day-outside");
    expect(container.querySelector('[data-date="2026-09-01"]')!.className).not.toContain("calendar-day-outside");
  });

  it("calls onFocus and onActivate on click", () => {
    const { onFocus, onActivate } = render();
    const cell = container.querySelector('[data-date="2026-09-05"]') as HTMLElement;
    act(() => {
      cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onFocus).toHaveBeenCalledWith("2026-09-05");
    expect(onActivate).toHaveBeenCalledWith("2026-09-05");
  });
});
