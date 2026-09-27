import { describe, expect, it } from "vitest";
import { DEFAULT_ZOOM, ZOOM_LEVELS, stepZoom, zoomActionForKey } from "./zoom";

const key = (
  key: string,
  mods: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {},
) => ({ key, altKey: false, ctrlKey: false, metaKey: true, shiftKey: false, ...mods });

describe("stepZoom", () => {
  it("walks the ladder one rung at a time from the default", () => {
    expect(stepZoom(DEFAULT_ZOOM, 1)).toBe(1.1);
    expect(stepZoom(DEFAULT_ZOOM, -1)).toBe(0.9);
  });

  it("clamps at both ends", () => {
    expect(stepZoom(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], 1)).toBe(2);
    expect(stepZoom(ZOOM_LEVELS[0], -1)).toBe(0.5);
  });

  it("snaps an off-ladder level to its nearest rung before stepping", () => {
    expect(stepZoom(1.02, 1)).toBe(1.1);
    expect(stepZoom(1.3, -1)).toBe(1.1);
  });

  it("round-trips: in then out returns to the start", () => {
    for (const level of ZOOM_LEVELS.slice(1, -1)) {
      expect(stepZoom(stepZoom(level, 1), -1)).toBe(level);
    }
  });
});

describe("zoomActionForKey", () => {
  it("maps ⌘= and ⌘+ to zoom in, ⌘- to zoom out, ⌘0 to reset", () => {
    expect(zoomActionForKey(key("="))).toBe("view.zoom-in");
    expect(zoomActionForKey(key("+", { shiftKey: true }))).toBe("view.zoom-in");
    expect(zoomActionForKey(key("-"))).toBe("view.zoom-out");
    expect(zoomActionForKey(key("0"))).toBe("view.zoom-reset");
  });

  it("accepts Ctrl as the primary modifier off macOS", () => {
    expect(zoomActionForKey(key("=", { metaKey: false, ctrlKey: true }))).toBe("view.zoom-in");
  });

  it("ignores bare keys, Alt chords and both modifiers together", () => {
    expect(zoomActionForKey(key("=", { metaKey: false }))).toBeNull();
    expect(zoomActionForKey(key("=", { altKey: true }))).toBeNull();
    expect(zoomActionForKey(key("=", { ctrlKey: true }))).toBeNull();
    expect(zoomActionForKey(key("0", { shiftKey: true }))).toBeNull();
    expect(zoomActionForKey(key("n"))).toBeNull();
  });
});
