// @vitest-environment jsdom
//
// The three rules workflow shortcuts live by: `mod` is one key per platform,
// built-ins win, and typing in a text field is not a command.

import { describe, expect, it } from "vitest";
import type { RegisteredWorkflow, WorkflowDefinition } from "../../lib/workflows";
import {
  allowsShortcutTarget,
  canonicalShortcut,
  findShortcutWorkflow,
  isReservedShortcut,
  matchesShortcut,
  parseShortcut,
  shortcutLabel,
  type ShortcutEventLike,
} from "./shortcuts";

const key = (over: Partial<ShortcutEventLike> & { key: string }): ShortcutEventLike => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

function workflow(over: Partial<WorkflowDefinition> & { id: string }): RegisteredWorkflow {
  const definition = {
    version: 1,
    name: over.id,
    steps: [{ type: "open-note", path: "A.md" }],
    ...over,
  } as WorkflowDefinition;
  return { id: over.id, path: `Workflows/${over.id}.md`, definition, issues: [], runnable: true };
}

describe("parseShortcut", () => {
  it("parses modifiers in any order", () => {
    expect(parseShortcut("mod+shift+m")).toEqual({ mod: true, shift: true, alt: false, ctrl: false, key: "m" });
    expect(parseShortcut("Shift+Mod+M")).toEqual({ mod: true, shift: true, alt: false, ctrl: false, key: "m" });
    expect(parseShortcut("cmd+alt+enter")).toEqual({ mod: true, shift: false, alt: true, ctrl: false, key: "enter" });
  });

  it("refuses anything that would swallow ordinary typing or is ambiguous", () => {
    expect(parseShortcut("m")).toBeNull(); // bare key
    expect(parseShortcut("shift+m")).toBeNull(); // shift alone is typing
    expect(parseShortcut("mod+a+b")).toBeNull(); // chord
    expect(parseShortcut("mod+")).toBeNull();
    expect(parseShortcut("mod+mod+a")).toBeNull();
    expect(parseShortcut(undefined)).toBeNull();
    expect(parseShortcut(7)).toBeNull();
  });

  it("canonicalises aliases so reserved comparison is exact", () => {
    expect(canonicalShortcut("Cmd+Shift+P")).toBe("mod+shift+p");
    expect(canonicalShortcut("shift+command+p")).toBe("mod+shift+p");
    expect(isReservedShortcut("Cmd+S")).toBe(true);
    expect(isReservedShortcut("mod+shift+s")).toBe(false);
  });
});

describe("matchesShortcut", () => {
  const modShiftM = parseShortcut("mod+shift+m")!;

  it("maps mod to Command on macOS and Control elsewhere", () => {
    expect(matchesShortcut(key({ key: "M", metaKey: true, shiftKey: true }), modShiftM, true)).toBe(true);
    expect(matchesShortcut(key({ key: "M", ctrlKey: true, shiftKey: true }), modShiftM, true)).toBe(false);
    expect(matchesShortcut(key({ key: "M", ctrlKey: true, shiftKey: true }), modShiftM, false)).toBe(true);
    expect(matchesShortcut(key({ key: "M", metaKey: true, shiftKey: true }), modShiftM, false)).toBe(false);
  });

  it("refuses extra modifiers", () => {
    expect(
      matchesShortcut(key({ key: "m", metaKey: true, shiftKey: true, altKey: true }), modShiftM, true),
    ).toBe(false);
    expect(
      matchesShortcut(key({ key: "m", metaKey: true, shiftKey: true, ctrlKey: true }), modShiftM, true),
    ).toBe(false);
  });

  it("treats an explicit ctrl as its own modifier on macOS", () => {
    const ctrlK = parseShortcut("ctrl+k")!;
    expect(matchesShortcut(key({ key: "k", ctrlKey: true }), ctrlK, true)).toBe(true);
    expect(matchesShortcut(key({ key: "k", metaKey: true }), ctrlK, true)).toBe(false);
  });
});

describe("findShortcutWorkflow", () => {
  const list = [
    workflow({ id: "meeting", shortcut: "mod+shift+m" }),
    workflow({ id: "save-thing", shortcut: "mod+s" }), // reserved: built-in wins
    { ...workflow({ id: "broken", shortcut: "mod+shift+b" }), runnable: false },
    workflow({ id: "no-shortcut" }),
  ];

  it("finds a runnable workflow by its shortcut", () => {
    const hit = findShortcutWorkflow(list, key({ key: "M", metaKey: true, shiftKey: true }), true);
    expect(hit?.id).toBe("meeting");
  });

  it("never binds a reserved combination", () => {
    expect(findShortcutWorkflow(list, key({ key: "s", metaKey: true }), true)).toBeNull();
  });

  it("never binds a non-runnable workflow", () => {
    expect(findShortcutWorkflow(list, key({ key: "b", metaKey: true, shiftKey: true }), true)).toBeNull();
  });

  it("returns null when nothing claims the key", () => {
    expect(findShortcutWorkflow(list, key({ key: "j", metaKey: true }), true)).toBeNull();
  });
});

describe("allowsShortcutTarget", () => {
  it("fires in the CodeMirror content but not in an ordinary text field", () => {
    document.body.innerHTML = `
      <div class="cm-editor"><div class="cm-content" contenteditable="true" id="cm"></div></div>
      <input id="box" />
      <textarea id="area"></textarea>
      <div id="plain"></div>
      <div contenteditable="true" id="rich"></div>`;
    const at = (id: string) => document.getElementById(id);
    expect(allowsShortcutTarget(at("cm"))).toBe(true);
    expect(allowsShortcutTarget(at("box"))).toBe(false);
    expect(allowsShortcutTarget(at("area"))).toBe(false);
    expect(allowsShortcutTarget(at("rich"))).toBe(false);
    expect(allowsShortcutTarget(at("plain"))).toBe(true);
    expect(allowsShortcutTarget(null)).toBe(true);
  });
});

describe("shortcutLabel", () => {
  it("renders per platform", () => {
    expect(shortcutLabel("mod+shift+m", true)).toBe("⇧⌘M");
    expect(shortcutLabel("mod+shift+m", false)).toBe("Ctrl+Shift+M");
    expect(shortcutLabel("nonsense", true)).toBe("");
  });
});
