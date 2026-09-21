import { describe, expect, it } from "vitest";
import { applyLayoutOperation, findPanelTab, isPanelVisible } from "./operations";
import { CENTER_NOTE_GROUP_ID, createDefaultLayout } from "./types";

describe("layout operations", () => {
  it("opens one dockable Properties inspector and reuses it", () => {
    const opened = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "properties",
      zone: "right",
    });
    const found = findPanelTab(opened, "properties");
    expect(found?.groupId).toBe("group:right:properties");
    expect(opened.zones.right.userCollapsed).toBe(false);

    const reopened = applyLayoutOperation(opened, {
      type: "open-panel",
      panelType: "properties",
      zone: "right",
    });
    expect(Object.values(reopened.panels).filter((panel) => panel.type === "properties"))
      .toHaveLength(1);
  });

  it("opens history in a reserved right-zone group and reuses the singleton", () => {
    const opened = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "history",
      zone: "right",
    });
    const found = findPanelTab(opened, "history");
    expect(found?.groupId).toBe("group:right:history");
    expect(opened.zones.right.userCollapsed).toBe(false);

    const reopened = applyLayoutOperation(opened, {
      type: "open-panel",
      panelType: "history",
      zone: "right",
    });
    expect(Object.values(reopened.panels).filter((panel) => panel.type === "history")).toHaveLength(1);
  });

  it("temporarily relocates an existing side tool into the center note group", () => {
    const opened = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "history",
      zone: "right",
    });
    const relocated = applyLayoutOperation(opened, {
      type: "open-panel",
      panelType: "history",
      zone: "center",
    });
    expect(relocated.zones.right.groupIds).toEqual([]);
    expect(findPanelTab(relocated, "history")?.groupId).toBe(CENTER_NOTE_GROUP_ID);
    expect(relocated.groups[CENTER_NOTE_GROUP_ID]?.activeTabId).toContain("history");
  });

  it("opens the first graph in a lower right group when an upper group exists", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "history",
      zone: "right",
    });
    layout = applyLayoutOperation(layout, {
      type: "open-panel",
      panelType: "graph",
      zone: "right",
    });
    expect(layout.zones.right.groupIds).toHaveLength(2);
    expect(findPanelTab(layout, "graph")?.groupId).not.toBe(findPanelTab(layout, "history")?.groupId);
  });

  it("reveals an existing graph by default and permits only an explicit second instance", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "graph",
      zone: "center",
      groupId: CENTER_NOTE_GROUP_ID,
    });
    layout = applyLayoutOperation(layout, {
      type: "open-panel",
      panelType: "graph",
      zone: "right",
    });
    expect(Object.values(layout.panels).filter((panel) => panel.type === "graph")).toHaveLength(1);
    expect(findPanelTab(layout, "graph")?.groupId).toBe(layout.zones.right.groupIds[0]);

    layout = applyLayoutOperation(layout, {
      type: "open-panel",
      panelType: "graph",
      zone: "center",
      groupId: CENTER_NOTE_GROUP_ID,
      instanceId: "panel:graph:second",
    });
    expect(Object.values(layout.panels).filter((panel) => panel.type === "graph")).toHaveLength(2);
    expect(applyLayoutOperation(layout, {
      type: "open-panel",
      panelType: "graph",
      zone: "center",
      groupId: CENTER_NOTE_GROUP_ID,
      instanceId: "panel:graph:third",
    })).toBe(layout);
  });

  it("removes empty tool groups but never the permanent note group", () => {
    const opened = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "history",
      zone: "right",
    });
    const found = findPanelTab(opened, "history")!;
    const closed = applyLayoutOperation(opened, {
      type: "close-tab",
      groupId: found.groupId,
      tabId: found.tab.id,
    });
    expect(closed.zones.right.groupIds).toEqual([]);
    expect(closed.zones.right.userCollapsed).toBe(true);
    expect(closed.groups[CENTER_NOTE_GROUP_ID]?.permanent).toBe(true);
  });

  it("rejects unsupported destinations and duplicate identifiers", () => {
    const layout = createDefaultLayout();
    expect(applyLayoutOperation(layout, {
      type: "open-panel",
      panelType: "files",
      zone: "center",
    })).toBe(layout);
    expect(applyLayoutOperation(layout, {
      type: "open-panel",
      panelType: "history",
      zone: "right",
      instanceId: "panel:files",
    })).toBe(layout);
  });

  it("rejects a third group and splits that cannot meet both minimums", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "history",
      zone: "right",
    });
    const history = findPanelTab(layout, "history")!;
    expect(applyLayoutOperation(layout, {
      type: "split-group",
      zone: "right",
      groupId: history.groupId,
      tabId: history.tab.id,
      axis: "x",
      availableSize: 400,
    })).toBe(layout);

    layout = applyLayoutOperation(layout, {
      type: "open-panel",
      panelType: "outline",
      zone: "right",
    });
    const outline = findPanelTab(layout, "outline")!;
    layout = applyLayoutOperation(layout, {
      type: "split-group",
      zone: "right",
      groupId: outline.groupId,
      tabId: outline.tab.id,
      axis: "x",
      availableSize: 500,
    });
    expect(layout.zones.right.groupIds).toHaveLength(2);
    const rejectedThird = applyLayoutOperation(layout, {
      type: "split-group",
      zone: "right",
      groupId: history.groupId,
      tabId: history.tab.id,
      axis: "y",
      availableSize: 500,
    });
    expect(rejectedThird).toBe(layout);
  });

  it("cancellation is an identity-preserving no-op", () => {
    const layout = createDefaultLayout();
    expect(applyLayoutOperation(layout, { type: "cancel" })).toBe(layout);
  });

  it("clamps committed side widths without touching center geometry", () => {
    const layout = createDefaultLayout();
    const left = applyLayoutOperation(layout, { type: "resize-zone", zone: "left", width: 10 });
    const right = applyLayoutOperation(left, { type: "resize-zone", zone: "right", width: 900 });
    expect(right.zones.left.preferredWidth).toBe(220);
    expect(right.zones.right.preferredWidth).toBe(560);
    expect(right.zones.center.preferredWidth).toBe(0);
  });
});

// The ActivityBar rail buttons are toggles: open when closed, collapse when
// open+active, switch when open+other-active. That decision needs to know
// not just "is this tab active in its own group" but "is that group actually
// the one on screen" — a left/right zone can hold two groups without room to
// render them side by side, in which case only the zone's `focusedGroupId`
// group is visible (see `DockZone`'s `is-temporarily-hidden`).
describe("isPanelVisible (rail toggle visibility)", () => {
  it("is false before the panel has ever been opened", () => {
    expect(isPanelVisible(createDefaultLayout(), "properties")).toBe(false);
  });

  it("is true once opened and it is the sole occupant of its zone", () => {
    const opened = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "properties",
      zone: "right",
    });
    expect(isPanelVisible(opened, "properties")).toBe(true);
  });

  it("is false for a panel whose tab is buried behind another active tab in the same group", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "properties",
      zone: "right",
    });
    // Opening a second right-dock panel with no existing split joins it as a
    // new tab in the same group and makes IT the active tab.
    layout = applyLayoutOperation(layout, {
      type: "open-panel",
      panelType: "backlinks",
      zone: "right",
    });
    expect(isPanelVisible(layout, "properties")).toBe(false);
    expect(isPanelVisible(layout, "backlinks")).toBe(true);
  });

  it("is false for a panel that is tab-active in its own group when that group is the unfocused half of an unsplit zone", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "history",
      zone: "right",
    });
    const history = findPanelTab(layout, "history")!;
    layout = applyLayoutOperation(layout, {
      type: "open-panel",
      panelType: "outline",
      zone: "right",
    });
    const outline = findPanelTab(layout, "outline")!;
    layout = applyLayoutOperation(layout, {
      type: "split-group",
      zone: "right",
      groupId: outline.groupId,
      tabId: outline.tab.id,
      axis: "x",
      availableSize: 500,
    });
    expect(layout.zones.right.groupIds).toHaveLength(2);
    // The split leaves `history` the sole (and therefore active) tab of the
    // original group, but focus moved to the newly split-off outline group.
    expect(layout.focusedGroupId).not.toBe(history.groupId);
    expect(isPanelVisible(layout, "history")).toBe(false);
    expect(isPanelVisible(layout, "outline")).toBe(true);
  });
});

describe("set-zone-collapsed (right-dock rail toggle)", () => {
  it("collapses an open zone and reopens it", () => {
    const opened = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "properties",
      zone: "right",
    });
    expect(opened.zones.right.userCollapsed).toBe(false);

    const collapsed = applyLayoutOperation(opened, {
      type: "set-zone-collapsed",
      zone: "right",
      collapsed: true,
    });
    expect(collapsed.zones.right.userCollapsed).toBe(true);
    // The panel is untouched — collapsing hides the dock, not the tab state.
    expect(isPanelVisible(collapsed, "properties")).toBe(true);

    const reopened = applyLayoutOperation(collapsed, {
      type: "set-zone-collapsed",
      zone: "right",
      collapsed: false,
    });
    expect(reopened.zones.right.userCollapsed).toBe(false);
  });

  it("is a no-op on an empty zone (nothing to collapse)", () => {
    const layout = createDefaultLayout();
    expect(applyLayoutOperation(layout, {
      type: "set-zone-collapsed",
      zone: "right",
      collapsed: true,
    })).toBe(layout);
  });

  it("switching to another tab in the same group re-opens a collapsed zone", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "properties",
      zone: "right",
    });
    layout = applyLayoutOperation(layout, {
      type: "open-panel",
      panelType: "backlinks",
      zone: "right",
    });
    layout = applyLayoutOperation(layout, {
      type: "set-zone-collapsed",
      zone: "right",
      collapsed: true,
    });
    const properties = findPanelTab(layout, "properties")!;
    layout = applyLayoutOperation(layout, {
      type: "activate-tab",
      groupId: properties.groupId,
      tabId: properties.tab.id,
    });
    // Mirrors ActivityBar's own explicit set-zone-collapsed(false) on switch;
    // activate-tab alone already clears it too (belt and suspenders).
    expect(layout.zones.right.userCollapsed).toBe(false);
    expect(isPanelVisible(layout, "properties")).toBe(true);
  });
});
