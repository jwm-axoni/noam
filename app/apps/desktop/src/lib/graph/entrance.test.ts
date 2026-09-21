import { describe, expect, it } from "vitest";
import { createEntrance, ENTRANCE_MS } from "./entrance";

const START = 1_000;
const center = { x: 100, y: -40 };
const node = { x: 520.25, y: 133.5 };

describe("createEntrance", () => {
  it("clamps progress outside the window", () => {
    const e = createEntrance({ now: START });

    expect(e.progress(START - 500)).toBe(0);
    expect(e.progress(START)).toBe(0);
    expect(e.progress(START + ENTRANCE_MS)).toBe(1);
    expect(e.progress(START + 10_000)).toBe(1);
  });

  it("eases monotonically from 0 to 1", () => {
    const e = createEntrance({ now: START, durationMs: 400 });

    let previous = -1;
    for (let step = 0; step <= 40; step++) {
      const p = e.progress(START + step * 10);
      expect(p).toBeGreaterThanOrEqual(previous);
      previous = p;
    }
    expect(previous).toBe(1);
    // Decelerating: more than half the distance is covered in the first half.
    expect(e.progress(START + 200)).toBeGreaterThan(0.5);
  });

  it("starts nodes near the centre and expands them outward", () => {
    const e = createEntrance({ now: START, durationMs: 400 });

    const first = e.positionFor(node, center, START);
    const mid = e.positionFor(node, center, START + 200);
    const distance = (p: { x: number; y: number }) =>
      Math.hypot(p.x - center.x, p.y - center.y);
    const settled = Math.hypot(node.x - center.x, node.y - center.y);

    expect(distance(first)).toBeGreaterThan(0);
    expect(distance(first)).toBeLessThan(settled * 0.25);
    expect(distance(mid)).toBeGreaterThan(distance(first));
    expect(distance(mid)).toBeLessThan(settled);
  });

  it("converges exactly on the settled position at t = 1", () => {
    const e = createEntrance({ now: START, durationMs: 400 });

    expect(e.positionFor(node, center, START + 400)).toEqual(node);
    expect(e.positionFor(node, center, START + 5_000)).toEqual(node);
    expect(e.factor(START + 400)).toBe(1);
    expect(e.nodeScale(START + 400)).toBe(1);
    expect(e.done(START + 400)).toBe(true);
    expect(e.done(START + 399)).toBe(false);
  });

  it("lags edge alpha behind node alpha", () => {
    const e = createEntrance({ now: START, durationMs: 400 });

    for (let step = 1; step < 40; step++) {
      const t = START + step * 10;
      expect(e.edgeAlpha(t)).toBeLessThan(e.nodeAlpha(t));
    }
    // Edges are still invisible while the nodes are already reading clearly.
    expect(e.edgeAlpha(START + 100)).toBe(0);
    expect(e.nodeAlpha(START + 100)).toBeGreaterThan(0.5);
    // Both land together.
    expect(e.nodeAlpha(START + 400)).toBe(1);
    expect(e.edgeAlpha(START + 400)).toBe(1);
  });

  it("scales node bodies up into place", () => {
    const e = createEntrance({ now: START, durationMs: 400 });

    expect(e.nodeScale(START)).toBeGreaterThan(0);
    expect(e.nodeScale(START)).toBeLessThan(1);
    expect(e.nodeScale(START + 200)).toBeGreaterThan(e.nodeScale(START));
  });

  it("shows the settled graph immediately under reduced motion", () => {
    const e = createEntrance({ now: START, reducedMotion: true });

    expect(e.done(START)).toBe(true);
    expect(e.progress(START)).toBe(1);
    expect(e.factor(START)).toBe(1);
    // No centre-out movement at all, and no fade to sit through.
    expect(e.positionFor(node, center, START)).toEqual(node);
    expect(e.nodeAlpha(START)).toBe(1);
    expect(e.edgeAlpha(START)).toBe(1);
    expect(e.nodeScale(START)).toBe(1);
  });
});
