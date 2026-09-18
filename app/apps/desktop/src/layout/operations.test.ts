import { describe, expect, it } from "vitest";
import { applyLayoutOperation, findPanelTab } from "./operations";
import { CENTER_NOTE_GROUP_ID, createDefaultLayout } from "./types";

describe("layout operations", () => {
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
