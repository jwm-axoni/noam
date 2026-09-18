import { describe, expect, it } from "vitest";
import {
  CENTER_NOTE_MIN,
  GROUP_HEIGHT_MIN,
  LEFT_DOCK_MIN,
  PANE_SEPARATOR_SIZE,
  RIGHT_DOCK_MIN,
  clampSplitRatio,
  dockResizeBounds,
  fitWorkspace,
  fitZoneSplit,
} from "./geometry";

describe("workspace geometry", () => {
  it("keeps both preferred docks when the viewport fits them", () => {
    const fit = fitWorkspace({
      viewportWidth: 1440,
      leftOpen: true,
      rightOpen: true,
      preferredLeft: 264,
      preferredRight: 320,
    });
    expect(fit).toMatchObject({ leftWidth: 264, rightWidth: 320 });
    expect(fit.centerWidth).toBeGreaterThanOrEqual(CENTER_NOTE_MIN);
  });

  it("shrinks to minimums before collapsing a dock", () => {
    const exact = 80 + LEFT_DOCK_MIN + RIGHT_DOCK_MIN + CENTER_NOTE_MIN + PANE_SEPARATOR_SIZE * 2;
    const fit = fitWorkspace({
      viewportWidth: exact,
      leftOpen: true,
      rightOpen: true,
      preferredLeft: 500,
      preferredRight: 500,
    });
    expect(fit).toMatchObject({
      leftWidth: LEFT_DOCK_MIN,
      rightWidth: RIGHT_DOCK_MIN,
      centerWidth: CENTER_NOTE_MIN,
    });
  });

  it("collapses the right dock first on a pressure tie", () => {
    const fit = fitWorkspace({
      viewportWidth: 900,
      leftOpen: true,
      rightOpen: true,
      preferredLeft: 264,
      preferredRight: 320,
    });
    expect(fit.rightCollapsed).toBe(true);
    expect(fit.leftWidth).toBeGreaterThanOrEqual(LEFT_DOCK_MIN);
    expect(fit.centerWidth).toBeGreaterThanOrEqual(CENTER_NOTE_MIN);
  });

  it("keeps a newly focused right dock by collapsing the left first", () => {
    const fit = fitWorkspace({
      viewportWidth: 900,
      leftOpen: true,
      rightOpen: true,
      leastRecentlyUsed: "left",
    });
    expect(fit.leftCollapsed).toBe(true);
    expect(fit.rightWidth).toBeGreaterThanOrEqual(RIGHT_DOCK_MIN);
    expect(fit.centerWidth).toBeGreaterThanOrEqual(CENTER_NOTE_MIN);
  });

  it("collapses both docks below the single-dock threshold", () => {
    const fit = fitWorkspace({ viewportWidth: 700, leftOpen: true, rightOpen: true });
    expect(fit.leftWidth).toBe(0);
    expect(fit.rightWidth).toBe(0);
    expect(fit.centerWidth).toBe(620);
  });

  it("bounds direct resizing so the editor cannot be consumed", () => {
    const bounds = dockResizeBounds("left", 1280, 320);
    expect(bounds.min).toBe(LEFT_DOCK_MIN);
    expect(bounds.max + 320 + CENTER_NOTE_MIN + 80 + PANE_SEPARATOR_SIZE * 2).toBeLessThanOrEqual(1280);
  });

  it("clamps split ratios to child minimums", () => {
    expect(clampSplitRatio(500, 0.05, 220, 220)).toBeCloseTo(220 / 494);
    expect(clampSplitRatio(400, 0.5, 220, 220)).toBeNull();
  });

  it("temporarily presents a short vertical split as tabs", () => {
    expect(fitZoneSplit({ axis: "y", width: 400, height: GROUP_HEIGHT_MIN * 2, ratio: 0.5 }).split).toBe(false);
    expect(fitZoneSplit({ axis: "y", width: 400, height: GROUP_HEIGHT_MIN * 2 + 6, ratio: 0.5 }).split).toBe(true);
  });
});
