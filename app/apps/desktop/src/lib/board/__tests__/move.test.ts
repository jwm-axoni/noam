// The riskiest write path in the release. A move is planned against the LIVE
// text, never against the snapshot the view was painted from, so:
//   - a teammate editing ANOTHER card between paint and drop must not disturb
//     the move, and their edit must survive it;
//   - an edit to the MOVED card's own line must REFUSE, because the thing the
//     user grabbed is not the thing that is there now.

import { describe, expect, it, vi } from "vitest";
import { planMove, planMoveLive } from "../move";
import { applyChanges } from "../serialize";
import { parseBoard } from "../parse";

const BOARD = [
  "---",
  "",
  "kanban-plugin: basic",
  "",
  "---",
  "",
  "## Todo",
  "",
  "- [ ] Alpha ^t-aaaaaaaaaa",
  "- [ ] Beta",
  "  a note under beta",
  "- [ ] Gamma",
  "",
  "## Doing",
  "",
  "- [ ] Delta",
  "",
  "## Empty",
  "",
  "***",
  "",
  "## Archive",
  "",
  "- [x] Old",
  "",
].join("\n");

const refAlpha = {
  docId: "d1",
  taskId: "t-aaaaaaaaaa",
  lineHint: 8,
  sourceText: "- [ ] Alpha ^t-aaaaaaaaaa",
};
const refBeta = { docId: "d1", lineHint: 9, sourceText: "- [ ] Beta" };
const refGamma = { docId: "d1", lineHint: 11, sourceText: "- [ ] Gamma" };

const lanes = (text: string) =>
  Object.fromEntries(
    parseBoard(text).lanes.map((l) => [l.title, l.cards.map((c) => c.task.text)]),
  );

describe("planMove", () => {
  it("survives a concurrent edit inside another card", () => {
    const live = BOARD.replace("- [ ] Delta", "- [ ] Delta, rescheduled 📅 2026-10-01");
    const plan = planMove({ cardRef: refAlpha, toLane: "Doing", toIndex: 1 }, live);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const next = applyChanges(live, plan.changes);
    expect(lanes(next)).toMatchObject({
      Todo: ["Beta", "Gamma"],
      Doing: ["Delta, rescheduled 📅 2026-10-01", "Alpha"],
    });
    expect(next).toContain("- [ ] Delta, rescheduled 📅 2026-10-01");
  });

  it("refuses when the moved card's own line was edited", () => {
    const live = BOARD.replace("- [ ] Alpha ^t-aaaaaaaaaa", "- [ ] Alpha the second ^t-aaaaaaaaaa");
    const plan = planMove({ cardRef: refAlpha, toLane: "Doing", toIndex: 0 }, live);
    expect(plan).toMatchObject({ ok: false, kind: "stale-target" });
    expect(plan).not.toHaveProperty("changes");
  });

  it("refuses when an id-less card's line was edited", () => {
    const live = BOARD.replace("- [ ] Beta", "- [ ] Beta (renamed)");
    expect(planMove({ cardRef: refBeta, toLane: "Doing", toIndex: 0 }, live)).toMatchObject({
      ok: false,
      kind: "stale-target",
    });
  });

  // The finding this anchor exists for: `toIndex` counts the board the UI
  // painted, so a card inserted above the destination between paint and drop
  // used to push the move one slot out of place.
  it("lands where the user saw it after a concurrent insert above the destination", () => {
    const live = BOARD.replace("- [ ] Delta", "- [ ] Zeta\n- [ ] Delta");
    // The user dropped Alpha BELOW Delta — index 1 of the lane they painted.
    const plan = planMove(
      {
        cardRef: refAlpha,
        toLane: "Doing",
        toIndex: 1,
        beforeCardRef: null,
      },
      live,
    );
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    expect(lanes(applyChanges(live, plan.changes)).Doing).toEqual(["Zeta", "Delta", "Alpha"]);
  });

  it("follows the anchor card when a concurrent insert shifts it down", () => {
    const live = BOARD.replace("- [ ] Delta", "- [ ] Zeta\n- [ ] Delta");
    // The user dropped Alpha ABOVE Delta — index 0 of the lane they painted,
    // which now holds Zeta.
    const plan = planMove(
      {
        cardRef: refAlpha,
        toLane: "Doing",
        toIndex: 0,
        beforeCardRef: { docId: "d1", lineHint: 15, sourceText: "- [ ] Delta" },
      },
      live,
    );
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    expect(lanes(applyChanges(live, plan.changes)).Doing).toEqual(["Zeta", "Alpha", "Delta"]);
  });

  it("falls back to the index and reports it when the anchor is gone", () => {
    const live = BOARD.replace("- [ ] Delta\n", "");
    const plan = planMove(
      {
        cardRef: refAlpha,
        toLane: "Doing",
        toIndex: 0,
        beforeCardRef: { docId: "d1", lineHint: 15, sourceText: "- [ ] Delta" },
      },
      live,
    );
    expect(plan).toMatchObject({ ok: true, anchorMissing: true });
    if (!plan.ok) return;
    expect(lanes(applyChanges(live, plan.changes)).Doing).toEqual(["Alpha"]);
  });

  it("reorders inside one lane", () => {
    const plan = planMove({ cardRef: refGamma, toLane: "Todo", toIndex: 0 }, BOARD);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(lanes(applyChanges(BOARD, plan.changes)).Todo).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("moves into an empty lane, under the heading", () => {
    const plan = planMove({ cardRef: refAlpha, toLane: "Empty", toIndex: 0 }, BOARD);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const next = applyChanges(BOARD, plan.changes);
    expect(next).toContain("## Empty\n\n- [ ] Alpha ^t-aaaaaaaaaa\n");
    expect(lanes(next)).toMatchObject({ Todo: ["Beta", "Gamma"], Empty: ["Alpha"] });
  });

  it("moves into the archive lane", () => {
    const plan = planMove({ cardRef: refAlpha, toLane: "Archive", toIndex: 1 }, BOARD);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const next = applyChanges(BOARD, plan.changes);
    expect(lanes(next).Archive).toEqual(["Old", "Alpha"]);
    expect(next).toContain("***");
  });

  it("takes the body lines with the card", () => {
    const plan = planMove({ cardRef: refBeta, toLane: "Doing", toIndex: 0 }, BOARD);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const next = applyChanges(BOARD, plan.changes);
    expect(next).toContain("## Doing\n\n- [ ] Beta\n  a note under beta\n- [ ] Delta\n");
    expect(next).not.toContain("- [ ] Gamma\n  a note under beta");
    const moved = parseBoard(next).lanes[1].cards[0];
    expect(moved.body).toEqual(["  a note under beta"]);
  });

  it("refuses a duplicated id", () => {
    const live = BOARD.replace("- [ ] Delta", "- [ ] Delta ^t-aaaaaaaaaa");
    expect(planMove({ cardRef: refAlpha, toLane: "Doing", toIndex: 0 }, live)).toMatchObject({
      ok: false,
      kind: "ambiguous-target",
    });
  });

  it("refuses a duplicated source text when there is no id", () => {
    const live = BOARD.replace("- [ ] Delta", "- [ ] Beta");
    expect(planMove({ cardRef: refBeta, toLane: "Doing", toIndex: 0 }, live)).toMatchObject({
      ok: false,
      kind: "ambiguous-target",
    });
  });

  it("reports a missing card and a missing lane", () => {
    const gone = BOARD.replace("- [ ] Alpha ^t-aaaaaaaaaa\n", "");
    expect(planMove({ cardRef: refAlpha, toLane: "Doing", toIndex: 0 }, gone)).toMatchObject({
      ok: false,
      kind: "missing-target",
    });
    expect(planMove({ cardRef: refAlpha, toLane: "Nowhere", toIndex: 0 }, BOARD)).toMatchObject({
      ok: false,
      kind: "missing-lane",
    });
  });

  it("plans no change for a move to where the card already is", () => {
    const plan = planMove({ cardRef: refAlpha, toLane: "Todo", toIndex: 0 }, BOARD);
    expect(plan).toEqual({ ok: true, changes: [] });
  });

  it("leaves every byte outside the two spans untouched", () => {
    const plan = planMove({ cardRef: refAlpha, toLane: "Doing", toIndex: 0 }, BOARD);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const next = applyChanges(BOARD, plan.changes);
    expect(next.length).toBe(BOARD.length);
    expect(parseBoard(next).settings.kanbanPlugin).toBe("basic");
  });
});

describe("planMoveLive", () => {
  const resolved = (sourceText: string) => ({
    ok: true as const,
    resolved: {
      path: "Boards/B.md",
      docId: "d1",
      from: 0,
      to: sourceText.length,
      sourceText,
      task: parseBoard(BOARD).lanes[0].cards[0].task,
      revision: "sha-live",
    },
  });

  it("plans against the text the host calls live and reports its revision", async () => {
    const host = {
      resolve: vi.fn(async () => resolved("- [ ] Alpha ^t-aaaaaaaaaa")),
      liveText: vi.fn(async () => BOARD),
    };
    const plan = await planMoveLive({ cardRef: refAlpha, toLane: "Doing", toIndex: 0 }, host);
    expect(plan).toMatchObject({ ok: true, path: "Boards/B.md", revision: "sha-live" });
    expect(host.liveText).toHaveBeenCalledWith("Boards/B.md");
    if (!plan.ok) return;
    expect(lanes(applyChanges(BOARD, plan.changes)).Doing).toEqual(["Alpha", "Delta"]);
  });

  it("never reads the note when the adapter refuses", async () => {
    const liveText = vi.fn(async () => BOARD);
    const plan = await planMoveLive({ cardRef: refAlpha, toLane: "Doing", toIndex: 0 }, {
      resolve: async () => ({ ok: false as const, kind: "read-only" as const, message: "Shared read-only" }),
      liveText,
    });
    expect(plan).toEqual({ ok: false, kind: "read-only", message: "Shared read-only" });
    expect(liveText).not.toHaveBeenCalled();
  });
});
