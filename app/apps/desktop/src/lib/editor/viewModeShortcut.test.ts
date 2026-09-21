// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewMode } from "./viewMode";
import { createViewModeShortcutHandler } from "./viewModeShortcut";

afterEach(() => {
  document.body.replaceChildren();
});

describe("view mode shortcut", () => {
  it.each([
    ["live", "source"],
    ["source", "reading"],
    ["reading", "live"],
  ] as const)("cycles %s to %s", (viewMode, expected) => {
    const setViewMode = vi.fn();
    const event = new KeyboardEvent("keydown", {
      key: "e",
      metaKey: true,
      cancelable: true,
    });

    createViewModeShortcutHandler(() => ({
      openNotePath: "Notes/Plan.MD",
      activeCenterSurfaceKind: "note",
      modalOpen: false,
      viewMode,
      setViewMode,
    }))(event);

    expect(event.defaultPrevented).toBe(true);
    expect(setViewMode).toHaveBeenCalledWith(expected);
  });

  it("cycles in capture phase with the editor focused", () => {
    const setViewMode = vi.fn();
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const content = document.createElement("div");
    content.className = "cm-content";
    content.setAttribute("contenteditable", "true");
    editor.append(content);
    document.body.append(editor);
    content.addEventListener("keydown", (event) => event.stopPropagation());
    const handler = createViewModeShortcutHandler(() => ({
      openNotePath: "Plan.md",
      activeCenterSurfaceKind: "note",
      modalOpen: false,
      viewMode: "live",
      setViewMode,
    }));
    window.addEventListener("keydown", handler, true);

    content.dispatchEvent(new KeyboardEvent("keydown", {
      key: "e",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));

    window.removeEventListener("keydown", handler, true);
    expect(setViewMode).toHaveBeenCalledWith("source");
  });

  it("passes Command-E through when Graph is the active centre surface", () => {
    const setViewMode = vi.fn();
    const graph = document.createElement("button");
    const received = vi.fn();
    graph.addEventListener("keydown", received);
    document.body.append(graph);
    const handler = createViewModeShortcutHandler(() => ({
      openNotePath: "Plan.md",
      activeCenterSurfaceKind: "panel",
      modalOpen: false,
      viewMode: "reading",
      setViewMode,
    }));
    window.addEventListener("keydown", handler, true);
    const event = new KeyboardEvent("keydown", {
      key: "e",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    graph.dispatchEvent(event);

    window.removeEventListener("keydown", handler, true);
    expect(event.defaultPrevented).toBe(false);
    expect(received).toHaveBeenCalledOnce();
    expect(setViewMode).not.toHaveBeenCalled();
  });

  it("passes Command-E through when Settings search is focused", () => {
    const setViewMode = vi.fn();
    const dialog = document.createElement("div");
    dialog.className = "modal-backdrop settings-backdrop";
    dialog.setAttribute("role", "dialog");
    const search = document.createElement("input");
    search.setAttribute("aria-label", "Search settings");
    const received = vi.fn();
    search.addEventListener("keydown", received);
    dialog.append(search);
    document.body.append(dialog);
    search.focus();
    const handler = createViewModeShortcutHandler(() => ({
      openNotePath: "Plan.md",
      activeCenterSurfaceKind: "note",
      modalOpen: true,
      viewMode: "source",
      setViewMode,
    }));
    window.addEventListener("keydown", handler, true);
    const event = new KeyboardEvent("keydown", {
      key: "e",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    search.dispatchEvent(event);

    window.removeEventListener("keydown", handler, true);
    expect(document.activeElement).toBe(search);
    expect(event.defaultPrevented).toBe(false);
    expect(received).toHaveBeenCalledOnce();
    expect(setViewMode).not.toHaveBeenCalled();
  });

  it.each(["textarea", "contenteditable"] as const)(
    "passes Command-E through when a non-editor %s owns focus",
    (kind) => {
      const setViewMode = vi.fn();
      const target = kind === "textarea"
        ? document.createElement("textarea")
        : document.createElement("div");
      if (kind === "contenteditable") target.setAttribute("contenteditable", "true");
      document.body.append(target);
      const handler = createViewModeShortcutHandler(() => ({
        openNotePath: "Plan.md",
        activeCenterSurfaceKind: "note",
        modalOpen: false,
        viewMode: "source",
        setViewMode,
      }));
      window.addEventListener("keydown", handler, true);
      const event = new KeyboardEvent("keydown", {
        key: "e",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });

      target.dispatchEvent(event);

      window.removeEventListener("keydown", handler, true);
      expect(event.defaultPrevented).toBe(false);
      expect(setViewMode).not.toHaveBeenCalled();
    },
  );

  it.each([
    { path: "Page.html", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
    { path: "Plan.md", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
    { path: "Plan.md", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
    { path: "Plan.md", metaKey: true, ctrlKey: false, shiftKey: false, altKey: true },
  ])("ignores non-view-mode keys and files %#", (input) => {
    const setViewMode = vi.fn<(mode: ViewMode) => void>();
    const event = new KeyboardEvent("keydown", {
      key: "e",
      metaKey: input.metaKey,
      ctrlKey: input.ctrlKey,
      shiftKey: input.shiftKey,
      altKey: input.altKey,
      cancelable: true,
    });

    createViewModeShortcutHandler(() => ({
      openNotePath: input.path,
      activeCenterSurfaceKind: "note",
      modalOpen: false,
      viewMode: "live",
      setViewMode,
    }))(event);

    expect(event.defaultPrevented).toBe(false);
    expect(setViewMode).not.toHaveBeenCalled();
  });
});
