// @vitest-environment jsdom
//
// The picker's three promises: it finds things, it works from the keyboard
// alone, and it gives focus back to whatever opened it. The fourth — that a
// broken workflow EXPLAINS itself rather than pretending to run — is the one
// that keeps a typo'd command findable.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWorkflow, WorkflowDefinition } from "../../lib/workflows";

const mocks = vi.hoisted(() => ({
  workflows: [] as RegisteredWorkflow[],
  requestWorkflowRun: vi.fn(),
}));

vi.mock("./service", () => ({
  useWorkflows: () => mocks.workflows,
}));
vi.mock("./runWorkflow", () => ({
  requestWorkflowRun: mocks.requestWorkflowRun,
}));

import { ActionPicker, filterWorkflows, matchScore } from "./ActionPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout engine; the picker scrolls its cursor into view.
Element.prototype.scrollIntoView = () => {};

function entry(
  id: string,
  over: Partial<WorkflowDefinition> = {},
  runnable = true,
  issues: RegisteredWorkflow["issues"] = [],
): RegisteredWorkflow {
  return {
    id,
    path: `Workflows/${id}.md`,
    definition: {
      version: 1,
      id,
      name: id,
      steps: [{ type: "open-note", path: "A.md" }],
      ...over,
    } as WorkflowDefinition,
    issues,
    runnable,
  };
}

const LIST: RegisteredWorkflow[] = [
  entry("meeting", { name: "Meeting note", description: "From a template" }),
  entry("journal", { name: "Daily journal", description: "Today's meeting log" }),
  entry("broken", { name: "Broken one" }, false, [
    { severity: "error", code: "missing-field", message: "`content` is required.", step: 1, field: "steps.1.content" },
  ]),
];

describe("filterWorkflows", () => {
  it("ranks a name prefix above a substring above the description", () => {
    expect(filterWorkflows(LIST, "mee").map((w) => w.id)).toEqual(["meeting", "journal"]);
    expect(filterWorkflows(LIST, "").map((w) => w.id)).toEqual(["meeting", "journal", "broken"]);
    expect(filterWorkflows(LIST, "zzz")).toEqual([]);
  });

  it("matches the id and a scattered subsequence of the name", () => {
    expect(filterWorkflows(LIST, "journal").map((w) => w.id)).toEqual(["journal"]);
    expect(matchScore(LIST[0], "mtn")).toBe(4);
    expect(matchScore(LIST[0], "qqq")).toBeNull();
  });

  it("keeps broken workflows in the list", () => {
    expect(filterWorkflows(LIST, "broken").map((w) => w.id)).toEqual(["broken"]);
  });
});

describe("ActionPicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let opener: HTMLButtonElement;
  const onClose = vi.fn();

  const input = () => container.querySelector<HTMLInputElement>(".action-picker-input")!;
  const rows = () => [...container.querySelectorAll<HTMLElement>(".action-picker-row")];
  const activeRow = () => container.querySelector<HTMLElement>(".action-picker-row.active");

  const type = (value: string) =>
    act(() => {
      const element = input();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });

  const press = (key: string) =>
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });

  beforeEach(() => {
    mocks.workflows = LIST;
    mocks.requestWorkflowRun.mockClear();
    onClose.mockClear();
    document.body.replaceChildren();
    opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(ActionPicker, { onClose })));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("focuses its input and lists everything", () => {
    expect(document.activeElement).toBe(input());
    expect(rows()).toHaveLength(3);
    expect(activeRow()?.textContent).toContain("Meeting note");
  });

  it("filters as you type and resets the cursor", () => {
    press("ArrowDown");
    expect(activeRow()?.textContent).toContain("Daily journal");
    type("broken");
    expect(rows()).toHaveLength(1);
    expect(activeRow()?.textContent).toContain("Broken one");
  });

  it("walks with the arrow keys and wraps", () => {
    press("ArrowDown");
    press("ArrowDown");
    expect(activeRow()?.textContent).toContain("Broken one");
    press("ArrowDown");
    expect(activeRow()?.textContent).toContain("Meeting note");
    press("ArrowUp");
    expect(activeRow()?.textContent).toContain("Broken one");
  });

  it("runs the highlighted workflow on Enter and hands its opener to the run", () => {
    press("Enter");
    expect(mocks.requestWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mocks.requestWorkflowRun.mock.calls[0][0]).toBe("meeting");
    expect(mocks.requestWorkflowRun.mock.calls[0][2]).toBe(opener);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the issues instead of running a broken workflow", () => {
    type("broken");
    press("Enter");
    expect(mocks.requestWorkflowRun).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const issues = container.querySelector(".action-picker-issues");
    expect(issues?.textContent).toContain("`content` is required.");
    expect(issues?.textContent).toContain("Step 2");
    expect(issues?.textContent).toContain("steps.1.content");
  });

  it("closes on Escape and gives focus back to the opener", () => {
    press("Escape");
    expect(onClose).toHaveBeenCalled();
    act(() => root.unmount());
    expect(document.activeElement).toBe(opener);
    root = createRoot(container); // afterEach unmounts something valid
  });

  it("says so when the vault has no workflows at all", () => {
    act(() => root.unmount());
    mocks.workflows = [];
    root = createRoot(container);
    act(() => root.render(createElement(ActionPicker, { onClose })));
    expect(container.querySelector(".action-picker-empty")?.textContent).toContain(
      "no workflows yet",
    );
  });
});
