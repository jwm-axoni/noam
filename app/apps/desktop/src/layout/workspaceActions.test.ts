import { describe, expect, it } from "vitest";
import { applyLayoutOperation, findPanelTab } from "./operations";
import { CENTER_NOTE_GROUP_ID, createDefaultLayout } from "./types";
import { applyTilingAction, NOTE_SPLIT_LIMIT, tilingAvailability } from "./workspaceActions";

describe("Phase 3 workspace tabs", () => {
  it("opens, reorders, and deduplicates typed note tabs", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), { type: "open-note", path: "a.md" });
    layout = applyLayoutOperation(layout, { type: "open-note", path: "b.md" });
    layout = applyLayoutOperation(layout, { type: "open-note", path: "a.md" });
    const group = layout.groups[CENTER_NOTE_GROUP_ID]!;
    expect(group.tabs.map((tab) => tab.kind === "note" ? tab.path : tab.id)).toEqual(["a.md", "b.md"]);
    const b = group.tabs.find((tab) => tab.kind === "note" && tab.path === "b.md")!;
    layout = applyLayoutOperation(layout, {
      type: "reorder-tab",
      groupId: CENTER_NOTE_GROUP_ID,
      tabId: b.id,
      toIndex: 0,
    });
    expect(layout.groups[CENTER_NOTE_GROUP_ID]!.tabs[0]).toMatchObject({ kind: "note", path: "b.md" });
  });

  it("moves a graph tab between the center and a side zone", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel", panelType: "graph", zone: "center", groupId: CENTER_NOTE_GROUP_ID,
    });
    const graph = findPanelTab(layout, "graph")!;
    layout = applyLayoutOperation(layout, {
      type: "move-tab-to-zone",
      tabId: graph.tab.id,
      fromGroupId: graph.groupId,
      zone: "right",
    });
    expect(findPanelTab(layout, "graph")?.groupId).toBe(layout.zones.right.groupIds[0]);
  });
});

describe("top tiling actions", () => {
  it("splits an active graph right/below, swaps, and joins", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel", panelType: "graph", zone: "center", groupId: CENTER_NOTE_GROUP_ID,
    });
    layout = applyTilingAction("split-right", 1000, layout);
    expect(layout.zones.center.groupIds).toHaveLength(2);
    expect(layout.zones.center.axis).toBe("x");
    const before = [...layout.zones.center.groupIds];
    layout = applyTilingAction("swap", 1000, layout);
    expect(layout.zones.center.groupIds).toEqual([before[1], before[0]]);
    const activeBeforeJoin = layout.groups[layout.focusedGroupId]!.activeTabId;
    layout = applyTilingAction("join", 1000, layout);
    expect(layout.zones.center.groupIds).toEqual([CENTER_NOTE_GROUP_ID]);
    expect(layout.groups[CENTER_NOTE_GROUP_ID]!.activeTabId).toBe(activeBeforeJoin);

    const graph = findPanelTab(layout, "graph")!;
    layout = applyLayoutOperation(layout, { type: "activate-tab", groupId: graph.groupId, tabId: graph.tab.id });
    layout = applyTilingAction("split-below", 800, layout);
    expect(layout.zones.center.axis).toBe("y");
  });

  it("disables note splits with the live-editor limit stated", () => {
    const layout = applyLayoutOperation(createDefaultLayout(), { type: "open-note", path: "a.md" });
    const actions = tilingAvailability(layout);
    expect(actions.find((item) => item.action === "split-right")).toEqual({
      action: "split-right",
      enabled: false,
      reason: NOTE_SPLIT_LIMIT,
    });
    expect(applyTilingAction("split-right", 1000, layout)).toBe(layout);
  });
});
