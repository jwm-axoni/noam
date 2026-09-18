import { describe, expect, it } from "vitest";
import { applyLayoutOperation, findPanelTab } from "./operations";
import { loadLayout, saveLayout } from "./persistence";
import type { StorageLike } from "./persistence";
import { CENTER_NOTE_GROUP_ID, createDefaultLayout } from "./types";

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

/** Right dock with Outline above Graph (stacked in one group). */
function stackedRightDock() {
  let layout = applyLayoutOperation(createDefaultLayout(), {
    type: "open-panel",
    panelType: "backlinks",
    zone: "right",
  });
  layout = applyLayoutOperation(layout, {
    type: "open-panel",
    panelType: "outline",
    zone: "right",
  });
  return layout;
}

describe("phase 2 drag operations", () => {
  it("moves a tab between groups (drop-to-merge), activating it in the target", () => {
    const layout = stackedRightDock();
    // Outline opened second; make them share separate groups first via split.
    const outline = findPanelTab(layout, "outline")!;
    const split = applyLayoutOperation(layout, {
      type: "split-tab",
      zone: "right",
      targetGroupId: outline.groupId,
      fromGroupId: outline.groupId,
      tabId: outline.tab.id,
      axis: "y",
      availableSize: 800,
    });
    expect(split.zones.right.groupIds).toHaveLength(2);
    const outlineAfter = findPanelTab(split, "outline")!;
    const backlinksAfter = findPanelTab(split, "backlinks")!;
    expect(outlineAfter.groupId).not.toBe(backlinksAfter.groupId);
    const moved = applyLayoutOperation(split, {
      type: "move-tab",
      tabId: outlineAfter.tab.id,
      fromGroupId: outlineAfter.groupId,
      toGroupId: backlinksAfter.groupId,
    });
    const target = moved.groups[backlinksAfter.groupId]!;
    expect(target.tabs.map((t) => t.id)).toContain(outlineAfter.tab.id);
    expect(target.activeTabId).toBe(outlineAfter.tab.id);
    // Source group emptied and removed.
    expect(moved.groups[outlineAfter.groupId]).toBeUndefined();
    expect(moved.zones.right.groupIds).toHaveLength(1);
  });

  it("rejects moving a note tab outside the center zone", () => {
    const layout = createDefaultLayout();
    layout.groups[CENTER_NOTE_GROUP_ID]!.tabs.push({
      id: "tab:note",
      kind: "note",
      path: "a.md",
    });
    const right = applyLayoutOperation(stackedRightDock(), {
      type: "open-panel",
      panelType: "backlinks",
      zone: "right",
    });
    const backlinks = findPanelTab(right, "backlinks")!;
    expect(
      applyLayoutOperation(right, {
        type: "move-tab",
        tabId: "tab:note",
        fromGroupId: CENTER_NOTE_GROUP_ID,
        toGroupId: backlinks.groupId,
      }),
    ).toBe(right);
  });

  it("splits a tab to an edge, creating the zone's second group", () => {
    const layout = stackedRightDock();
    const backlinks = findPanelTab(layout, "backlinks")!;
    const split = applyLayoutOperation(layout, {
      type: "split-tab",
      zone: "right",
      targetGroupId: backlinks.groupId,
      fromGroupId: backlinks.groupId,
      tabId: backlinks.tab.id,
      axis: "y",
      availableSize: 800,
    });
    expect(split.zones.right.groupIds).toHaveLength(2);
    expect(split.zones.right.axis).toBe("y");
    expect(findPanelTab(split, "backlinks")).toBeDefined();
    expect(findPanelTab(split, "outline")).toBeDefined();
  });

  it("rejects an edge-drop beside an existing second group", () => {
    const layout = stackedRightDock();
    const backlinks = findPanelTab(layout, "backlinks")!;
    const split = applyLayoutOperation(layout, {
      type: "split-tab",
      zone: "right",
      targetGroupId: backlinks.groupId,
      fromGroupId: backlinks.groupId,
      tabId: backlinks.tab.id,
      axis: "y",
      availableSize: 800,
    });
    const outline = findPanelTab(split, "outline")!;
    const again = applyLayoutOperation(split, {
      type: "split-tab",
      zone: "right",
      targetGroupId: outline.groupId,
      fromGroupId: outline.groupId,
      tabId: outline.tab.id,
      axis: "y",
      availableSize: 800,
    });
    expect(again).toBe(split);
    expect(again.zones.right.groupIds).toHaveLength(2);
  });

  it("rejects splitting a group's sole tab beside itself", () => {
    const layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "backlinks",
      zone: "right",
    });
    const backlinks = findPanelTab(layout, "backlinks")!;
    expect(layout.groups[backlinks.groupId]!.tabs).toHaveLength(1);
    const split = applyLayoutOperation(layout, {
      type: "split-tab",
      zone: "right",
      targetGroupId: backlinks.groupId,
      fromGroupId: backlinks.groupId,
      tabId: backlinks.tab.id,
      axis: "y",
      availableSize: 800,
    });
    expect(split).toBe(layout);
  });

  it("joins a split zone back into one group", () => {
    const layout = stackedRightDock();
    const backlinks = findPanelTab(layout, "backlinks")!;
    const split = applyLayoutOperation(layout, {
      type: "split-tab",
      zone: "right",
      targetGroupId: backlinks.groupId,
      fromGroupId: backlinks.groupId,
      tabId: backlinks.tab.id,
      axis: "y",
      availableSize: 800,
    });
    const joined = applyLayoutOperation(split, { type: "join-zone", zone: "right" });
    expect(joined.zones.right.groupIds).toHaveLength(1);
    expect(findPanelTab(joined, "backlinks")).toBeDefined();
    expect(findPanelTab(joined, "outline")).toBeDefined();
  });

  it("moves a tab into an empty zone, and rejects when the zone is occupied", () => {
    const withRight = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "backlinks",
      zone: "right",
    });
    const withLeft = applyLayoutOperation(withRight, {
      type: "open-panel",
      panelType: "outline",
      zone: "left",
    });
    const outline = findPanelTab(withLeft, "outline")!;
    // Left already has the files group → occupied.
    expect(
      applyLayoutOperation(withLeft, {
        type: "move-tab-to-zone",
        tabId: outline.tab.id,
        fromGroupId: outline.groupId,
        zone: "right",
      }),
    ).toBe(withLeft);
  });

  it("reorders tabs within a group", () => {
    const layout = stackedRightDock();
    const backlinks = findPanelTab(layout, "backlinks")!;
    const outline = findPanelTab(layout, "outline")!;
    expect(backlinks.groupId).toBe(outline.groupId);
    const groupId = backlinks.groupId;
    const reordered = applyLayoutOperation(layout, {
      type: "reorder-tab",
      groupId,
      tabId: outline.tab.id,
      toIndex: 0,
    });
    expect(reordered.groups[groupId]!.tabs[0]!.id).toBe(outline.tab.id);
  });

  it("round-trips a split right dock through storage", () => {
    const layout = stackedRightDock();
    const backlinks = findPanelTab(layout, "backlinks")!;
    const split = applyLayoutOperation(layout, {
      type: "split-tab",
      zone: "right",
      targetGroupId: backlinks.groupId,
      fromGroupId: backlinks.groupId,
      tabId: backlinks.tab.id,
      axis: "y",
      availableSize: 800,
    });
    const resized = applyLayoutOperation(split, {
      type: "resize-zone",
      zone: "right",
      width: 400,
    });
    const storage = new MemoryStorage();
    saveLayout("/vault", resized, storage);
    const restored = loadLayout("/vault", storage);
    expect(restored.zones.right.groupIds).toHaveLength(2);
    expect(restored.zones.right.preferredWidth).toBe(400);
    expect(findPanelTab(restored, "backlinks")).toBeDefined();
    expect(findPanelTab(restored, "outline")).toBeDefined();
  });
});
