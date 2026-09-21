// App-wide shortcuts must not consume a MODIFIED variant of themselves — ⌘⇧N
// belongs to whatever wants it, not to New note. The action picker is the one
// exception, because Shift is part of its combination.

import { describe, expect, it } from "vitest";
import { matchGlobalShortcut } from "./globalShortcuts";

const press = (
  key: string,
  over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe("matchGlobalShortcut", () => {
  it("matches the unmodified primaries", () => {
    expect(matchGlobalShortcut(press("n", { metaKey: true }))).toBe("new-note");
    expect(matchGlobalShortcut(press("g", { ctrlKey: true }))).toBe("graph");
  });

  it("refuses a modified variant of them", () => {
    expect(matchGlobalShortcut(press("n", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(matchGlobalShortcut(press("g", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchGlobalShortcut(press("n", { metaKey: true, ctrlKey: true }))).toBeNull();
    expect(matchGlobalShortcut(press("n"))).toBeNull();
  });

  it("matches the action picker on either primary modifier, with Shift", () => {
    expect(matchGlobalShortcut(press("P", { metaKey: true, shiftKey: true }))).toBe("action-picker");
    expect(matchGlobalShortcut(press("p", { ctrlKey: true, shiftKey: true }))).toBe("action-picker");
  });

  it("does not claim ⌘P, ⌥⌘⇧P or a bare ⇧P", () => {
    expect(matchGlobalShortcut(press("p", { metaKey: true }))).toBeNull();
    expect(matchGlobalShortcut(press("p", { metaKey: true, shiftKey: true, altKey: true }))).toBeNull();
    expect(matchGlobalShortcut(press("P", { shiftKey: true }))).toBeNull();
    expect(matchGlobalShortcut(press("p", { metaKey: true, ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});
