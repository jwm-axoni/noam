import { describe, expect, it } from "vitest";
import { selectLabels, type LabelNode, type LabelTransform } from "./labels";

// 7px per character keeps the arithmetic in these tests readable: a 6-char
// title is 42px wide, so with the default 4px gap it claims 46px of screen.
const measure = (node: LabelNode) => node.title.length * 7;

const view: LabelTransform = { k: 1, x: 0, y: 0, width: 800, height: 600 };

function node(partial: Partial<LabelNode> & { id: string }): LabelNode {
  return {
    x: 0,
    y: 0,
    degree: 1,
    radius: 2,
    title: partial.title ?? `Note ${partial.id}`,
    ...partial,
  };
}

/** `count` nodes on a grid loose enough that nothing collides at k=1, with
 *  degree == index so the priority order is unambiguous. */
function grid(count: number): LabelNode[] {
  return Array.from({ length: count }, (_, i) =>
    node({
      id: `n${i}`,
      x: (i % 5) * 150 - 300,
      y: Math.floor(i / 5) * 50 - 125,
      degree: i,
    }),
  );
}

// A row 20 world-units apart: at k=1 the labels overlap, at k=6 they do not.
const row: LabelNode[] = [
  node({ id: "a", x: -40, degree: 5, title: "Note A" }),
  node({ id: "b", x: -20, degree: 4, title: "Note B" }),
  node({ id: "c", x: 0, degree: 3, title: "Note C" }),
  node({ id: "d", x: 20, degree: 2, title: "Note D" }),
  node({ id: "e", x: 40, degree: 1, title: "Note E" }),
];

describe("selectLabels", () => {
  it("shows every label that fits when nothing collides", () => {
    const ids = selectLabels(row, { transform: { ...view, k: 6 }, measure });

    expect([...ids].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("drops colliding labels and keeps the better-connected node", () => {
    const ids = selectLabels(row, { transform: view, measure });

    // "a" (degree 5) claims its space first; "b" and "c" overlap it and go.
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(false);
    expect(ids.has("c")).toBe(false);
    expect(ids.has("d")).toBe(true);
    expect(ids.has("e")).toBe(false);
  });

  it("reveals more labels as the user zooms in", () => {
    const near = selectLabels(row, { transform: view, measure });
    const far = selectLabels(row, { transform: { ...view, k: 6 }, measure });

    expect(far.size).toBeGreaterThan(near.size);
    for (const id of near) expect(far.has(id)).toBe(true);
  });

  it("ranks the open note above every degree", () => {
    const stacked = [
      node({ id: "hub", degree: 40, title: "Hub" }),
      node({ id: "open", degree: 0, title: "Open" }),
    ];

    const ids = selectLabels(stacked, {
      transform: view,
      measure,
      openId: "open",
    });

    expect(ids.has("open")).toBe(true);
    expect(ids.has("hub")).toBe(false);
  });

  it("never removes the open note, the hovered node or a search match", () => {
    const stacked = [
      node({ id: "hub", degree: 90, title: "Hub" }),
      node({ id: "open", degree: 0, title: "Open" }),
      node({ id: "hover", degree: 0, title: "Hovered" }),
      node({ id: "hit1", degree: 0, title: "Match one" }),
      node({ id: "hit2", degree: 0, title: "Match two" }),
    ];

    const ids = selectLabels(stacked, {
      transform: view,
      measure,
      openId: "open",
      hoveredId: "hover",
      searchMatchIds: new Set(["hit1", "hit2"]),
    });

    // All four pinned labels sit on the exact same point and all survive; the
    // unpinned hub is the only one the collision sweep may remove.
    expect([...ids].sort()).toEqual(["hit1", "hit2", "hover", "open"]);
  });

  it("is deterministic across calls and input order", () => {
    const first = selectLabels(row, { transform: view, measure });
    const again = selectLabels(row, { transform: view, measure });
    const shuffled = selectLabels([row[3], row[0], row[4], row[2], row[1]], {
      transform: view,
      measure,
    });

    expect([...again].sort()).toEqual([...first].sort());
    expect([...shuffled].sort()).toEqual([...first].sort());
  });

  it("breaks degree ties on node id, not on arrival order", () => {
    const tied = [
      node({ id: "zz", degree: 3, title: "Zed" }),
      node({ id: "aa", degree: 3, title: "Aye" }),
    ];

    expect([...selectLabels(tied, { transform: view, measure })]).toEqual(["aa"]);
    expect([
      ...selectLabels([tied[1], tied[0]], { transform: view, measure }),
    ]).toEqual(["aa"]);
  });

  it("culls labels outside the viewport", () => {
    const offscreen = [
      node({ id: "far", x: 5_000, degree: 9 }),
      node({ id: "near", x: 0, degree: 1 }),
    ];

    const ids = selectLabels(offscreen, { transform: view, measure });

    expect([...ids]).toEqual(["near"]);
  });

  it("honours the label budget, spending it on the best-connected nodes", () => {
    const ids = selectLabels(grid(20), {
      transform: view,
      measure,
      maxLabels: 3,
    });

    expect(ids.size).toBe(3);
    expect([...ids].sort()).toEqual(["n17", "n18", "n19"]);
  });

  it("keeps pinned labels when the candidate pool is capped", () => {
    const ids = selectLabels(grid(50), {
      transform: view,
      measure,
      openId: "n0",
      searchMatchIds: new Set(["n1"]),
      maxCandidates: 5,
      maxLabels: 5,
    });

    expect(ids.has("n0")).toBe(true);
    expect(ids.has("n1")).toBe(true);
    expect(ids.size).toBe(5);
  });

  it("keeps only the pinned labels when the budget is zero", () => {
    const ids = selectLabels(grid(20), {
      transform: view,
      measure,
      openId: "n3",
      searchMatchIds: new Set(["n7"]),
      maxLabels: 0,
    });

    expect([...ids].sort()).toEqual(["n3", "n7"]);
  });

  it("returns nothing for a degenerate viewport", () => {
    expect(
      selectLabels(row, { transform: { ...view, width: 0 }, measure }).size,
    ).toBe(0);
    expect(selectLabels([], { transform: view, measure }).size).toBe(0);
  });
});
