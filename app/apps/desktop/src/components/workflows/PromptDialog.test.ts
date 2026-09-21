// @vitest-environment jsdom
//
// The two rules this dialog exists to enforce:
//
//   THE CLIPBOARD IS A BUTTON. Nothing reads it until the user presses Paste —
//   asserted by counting calls, not by reading the code.
//   NOTHING TYPED IS DISCARDED. A failure keeps the answers, names the step and
//   field, and shows the content the engine could not write plus where it was
//   parked.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionResult,
  RegisteredWorkflow,
  WorkflowVariable,
} from "../../lib/workflows";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  readClipboardText: vi.fn(),
  copyText: vi.fn(),
  toast: vi.fn(),
  variables: [] as WorkflowVariable[],
}));

vi.mock("./clipboard", () => ({ readClipboardText: mocks.readClipboardText }));
vi.mock("../../lib/clipboard", () => ({ copyText: mocks.copyText }));
vi.mock("../../lib/toast", () => ({ toast: mocks.toast }));
vi.mock("./service", () => ({
  getWorkflowService: () => ({
    get: (id: string): RegisteredWorkflow => ({
      id,
      path: `Workflows/${id}.md`,
      definition: {
        version: 1,
        id,
        name: "Capture task",
        description: "Adds a line to the inbox",
        steps: [],
      } as never,
      issues: [],
      runnable: true,
    }),
    promptsFor: () => mocks.variables,
    run: mocks.run,
  }),
}));

import { PromptDialog, validatePromptValues } from "./PromptDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const request = {
  id: "capture-task",
  ctx: {},
  token: 1,
  returnFocus: null as HTMLElement | null,
};

const success: ExecutionResult = {
  ok: true,
  workflowId: "capture-task",
  effects: [{ kind: "appended", path: "Inbox.md", heading: "## Inbox", bytes: 24 }],
  warnings: [],
};

const failure: ExecutionResult = {
  ok: false,
  workflowId: "capture-task",
  kind: "read-only",
  message: '"Inbox.md" is read-only.',
  step: 0,
  field: "steps.0.target.path",
  completed: [],
  recovery: {
    retryable: false,
    pendingContent: "- [ ] buy milk",
    preservedAt: "Captures/Unsaved capture 2026-09-20 10-00-00.md",
  },
};

describe("validatePromptValues", () => {
  it("names every empty required field and accepts optional ones", () => {
    const variables: WorkflowVariable[] = [
      { name: "task", label: "Task" },
      { name: "note", label: "Note", required: false },
      { name: "clip", label: "Clip", type: "clipboard" },
      { name: "size", type: "choice", choices: ["S", "M"] },
    ];
    const errors = validatePromptValues(variables, { task: "  ", note: "", clip: "", size: "XL" });
    expect(errors.task).toContain("required");
    expect(errors.note).toBeUndefined();
    expect(errors.clip).toContain("Paste from clipboard");
    expect(errors.size).toContain("S, M");
    expect(validatePromptValues(variables, { task: "x", clip: "y", size: "M" })).toEqual({});
  });
});

describe("PromptDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();

  const field = (name: string) =>
    container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#workflow-field-${name}`)!;
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );

  const typeInto = (name: string, value: string) =>
    act(() => {
      const element = field(name);
      const proto =
        element.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });

  const submit = () =>
    act(() => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

  const render = () => {
    root = createRoot(container);
    act(() => root.render(createElement(PromptDialog, { request, onClose })));
  };

  beforeEach(() => {
    mocks.run.mockReset();
    mocks.readClipboardText.mockReset();
    mocks.copyText.mockReset().mockResolvedValue(true);
    mocks.toast.mockReset();
    onClose.mockReset();
    document.body.replaceChildren();
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => act(() => root.unmount()));

  it("refuses to run until every required field has a value", async () => {
    mocks.variables = [
      { name: "task", label: "Task", type: "text" },
      { name: "note", label: "Note", type: "multiline", required: false },
    ];
    mocks.run.mockResolvedValue(success);
    render();

    submit();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(container.querySelector(".workflow-field-error")?.textContent).toContain(
      "Task is required.",
    );
    expect(document.activeElement).toBe(field("task"));

    typeInto("task", "buy milk");
    expect(container.querySelector(".workflow-field-error")).toBeNull();
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.run).toHaveBeenCalledWith("capture-task", { task: "buy milk", note: "" }, {});
    expect(onClose).toHaveBeenCalled();
    expect(mocks.toast.mock.calls[0][0]).toContain("Appended to ## Inbox in Inbox.md");
  });

  it("never touches the clipboard until Paste is pressed", async () => {
    mocks.variables = [{ name: "clip", label: "Clipboard", type: "clipboard" }];
    mocks.run.mockResolvedValue(success);
    mocks.readClipboardText.mockResolvedValue("pasted text");
    render();

    expect(mocks.readClipboardText).not.toHaveBeenCalled();
    submit();
    expect(mocks.readClipboardText).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(container.querySelector(".workflow-field-error")?.textContent).toContain(
      "Paste from clipboard",
    );

    await act(async () => {
      button("Paste from clipboard")!.click();
    });
    expect(mocks.readClipboardText).toHaveBeenCalledTimes(1);
    expect(field("clip").value).toBe("pasted text");
    expect(field("clip").readOnly).toBe(true);

    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.run).toHaveBeenCalledWith("capture-task", { clip: "pasted text" }, {});
  });

  it("shows the failure, the unsaved text and where it was preserved", async () => {
    mocks.variables = [{ name: "task", label: "Task" }];
    mocks.run.mockResolvedValue(failure);
    render();

    typeInto("task", "buy milk");
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const result = container.querySelector(".workflow-result")!;
    expect(result.getAttribute("data-failure-kind")).toBe("read-only");
    expect(result.textContent).toContain("Read-only");
    expect(result.textContent).toContain('"Inbox.md" is read-only.');
    expect(result.textContent).toContain("Step 1");
    expect(result.textContent).toContain("steps.0.target.path");
    expect(container.querySelector(".workflow-pending")?.textContent).toBe("- [ ] buy milk");
    expect(result.textContent).toContain("Captures/Unsaved capture");
    // Not retryable: no Retry button, and the answer is still in the field.
    expect(button("Retry")).toBeUndefined();
    expect(field("task").value).toBe("buy milk");
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      button("Copy")!.click();
    });
    expect(mocks.copyText).toHaveBeenCalledWith("- [ ] buy milk");
  });

  it("offers Retry when the engine says the same call could succeed", async () => {
    mocks.variables = [{ name: "task", label: "Task" }];
    mocks.run.mockResolvedValue({
      ...failure,
      kind: "stale-target",
      recovery: { retryable: true, pendingContent: "- [ ] buy milk" },
    });
    render();
    typeInto("task", "buy milk");
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(button("Retry")).toBeDefined();
    mocks.run.mockResolvedValue(success);
    await act(async () => {
      button("Retry")!.click();
    });
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalled();
  });

  // Cancelling the dialog cannot cancel the engine, so while a run is in
  // flight the dialog refuses to go away — otherwise the writes carry on
  // behind a UI that said they had been called off.
  it("cannot be closed, and cannot be re-run, while a run is in flight", async () => {
    mocks.variables = [{ name: "task", label: "Task", type: "text" }];
    let settle: (result: ExecutionResult) => void = () => {};
    mocks.run.mockImplementation(
      () =>
        new Promise<ExecutionResult>((resolve) => {
          settle = resolve;
        }),
    );
    render();
    typeInto("task", "buy milk");
    submit();
    expect(mocks.run).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      container
        .querySelector(".modal-backdrop")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(button("Cancel")!.disabled).toBe(true);
    expect(button("Running…")).toBeDefined();

    // And a second Enter starts nothing.
    submit();
    expect(mocks.run).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle(success);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("runs straight away and stays invisible when there is nothing to ask", async () => {
    mocks.variables = [];
    mocks.run.mockResolvedValue(success);
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(PromptDialog, { request, onClose }));
    });
    expect(mocks.run).toHaveBeenCalledWith("capture-task", {}, {});
    expect(container.querySelector(".modal")).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it("gives focus back to whatever opened it", () => {
    mocks.variables = [{ name: "task", label: "Task" }];
    mocks.run.mockResolvedValue(success);
    const opener = document.createElement("button");
    document.body.append(opener);
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(PromptDialog, { request: { ...request, returnFocus: opener }, onClose }),
      ),
    );
    expect(document.activeElement).toBe(field("task"));
    act(() => root.unmount());
    expect(document.activeElement).toBe(opener);
    root = createRoot(container);
  });
});
