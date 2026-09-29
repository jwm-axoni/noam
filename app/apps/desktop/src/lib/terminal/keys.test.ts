import { describe, expect, it } from "vitest";
import { appKeepsKey, isTerminalTarget, matchTerminalShortcut } from "./keys";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("terminal shortcuts", () => {
  it("Ctrl+` focuses or opens, Ctrl+Shift+` opens a new one", () => {
    expect(matchTerminalShortcut(key("`", { ctrlKey: true }))).toBe("terminal");
    expect(matchTerminalShortcut(key("~", { ctrlKey: true, shiftKey: true }))).toBe("new-terminal");
    expect(matchTerminalShortcut(key("`", { ctrlKey: true, shiftKey: true }))).toBe("new-terminal");
  });

  it("does not claim ⌘` (macOS window cycling) or a bare backtick", () => {
    expect(matchTerminalShortcut(key("`", { metaKey: true }))).toBeNull();
    expect(matchTerminalShortcut(key("`"))).toBeNull();
    expect(matchTerminalShortcut(key("`", { ctrlKey: true, altKey: true }))).toBeNull();
  });
});

describe("keyboard passthrough while a terminal has focus", () => {
  it("hands shell keys to the shell on every platform", () => {
    for (const k of ["f", "r", "w", "n", "c", "d", "l"]) {
      expect(appKeepsKey(key(k, { ctrlKey: true }), false)).toBe(false);
      expect(appKeepsKey(key(k, { ctrlKey: true }), true)).toBe(false);
    }
    expect(appKeepsKey(key("a"), false)).toBe(false);
    expect(appKeepsKey(key("Escape"), true)).toBe(false);
  });

  it("keeps ⌘ shortcuts on macOS only", () => {
    expect(appKeepsKey(key("w", { metaKey: true }), true)).toBe(true);
    expect(appKeepsKey(key("w", { metaKey: true }), false)).toBe(false);
  });

  it("keeps the terminal toggle and tab walking", () => {
    expect(appKeepsKey(key("`", { ctrlKey: true }), false)).toBe(true);
    expect(appKeepsKey(key("Tab", { ctrlKey: true }), false)).toBe(true);
    expect(appKeepsKey(key("Tab", { ctrlKey: true, shiftKey: true }), true)).toBe(true);
  });

  it("recognises targets inside the terminal host", () => {
    const inside = { closest: (s: string) => (s === ".terminal-host" ? {} : null) };
    const outside = { closest: () => null };
    expect(isTerminalTarget(inside as unknown as EventTarget)).toBe(true);
    expect(isTerminalTarget(outside as unknown as EventTarget)).toBe(false);
    expect(isTerminalTarget(null)).toBe(false);
  });
});
