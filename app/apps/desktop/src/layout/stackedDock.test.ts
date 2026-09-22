import { describe, expect, it } from "vitest";
import { applyLayoutOperation, findPanelTab, isPanelVisible } from "./operations";
import { createDefaultLayout, type LayoutV1 } from "./types";
import { serializableLayout, validatePersistedLayout } from "./persistence";
import { stackGroupSizes } from "./geometry";

function threePanels(): LayoutV1 {
  let layout = createDefaultLayout();
  for (const panelType of ["calendar", "tasks", "graph"] as const) {
    layout = applyLayoutOperation(layout, { type: "open-panel", zone: "right", panelType });
  }
  const tasks = findPanelTab(layout, "tasks")!;
  return applyLayoutOperation(layout, {
    type: "split-tab", zone: "right", fromGroupId: tasks.groupId,
    targetGroupId: tasks.groupId, tabId: tasks.tab.id, axis: "y", availableSize: 900,
  });
}

describe("stacked right dock", () => {
  it("stacks Calendar, Tasks, and Graph in three separate persistent groups", () => {
    const layout = threePanels();
    expect(layout.zones.right.groupIds).toHaveLength(3);
    const restored = validatePersistedLayout(serializableLayout(layout))!;
    expect(restored.zones.right.groupIds).toEqual(layout.zones.right.groupIds);
    for (const type of ["calendar", "tasks", "graph"] as const) {
      const found = findPanelTab(restored, type)!;
      expect(restored.groups[found.groupId]!.tabs).toHaveLength(1);
      expect(isPanelVisible(restored, type)).toBe(true);
    }
  });

  it("adds a fourth group and restores its order after restart", () => {
    let layout = applyLayoutOperation(threePanels(), { type: "open-panel", zone: "right", panelType: "outline" });
    const outline = findPanelTab(layout, "outline")!;
    layout = applyLayoutOperation(layout, {
      type: "split-group", zone: "right", groupId: outline.groupId, tabId: outline.tab.id,
      axis: "y", availableSize: 1000,
    });
    expect(layout.zones.right.groupIds).toHaveLength(4);
    expect(validatePersistedLayout(serializableLayout(layout))!.zones.right.groupIds).toEqual(layout.zones.right.groupIds);
  });

  it("resizes one adjacent pair without moving the third group and persists the heights", () => {
    const layout = threePanels();
    const before = stackGroupSizes(layout.zones.right, 900);
    const resized = applyLayoutOperation(layout, {
      type: "resize-stack-pair", zone: "right", index: 0, size: before[0]! + 30, availableSize: 900,
    });
    const after = stackGroupSizes(resized.zones.right, 900);
    expect(after[0]).toBeCloseTo(before[0]! + 30);
    expect(after[1]).toBeCloseTo(before[1]! - 30);
    expect(after[2]).toBeCloseTo(before[2]!);
    const restored = validatePersistedLayout(serializableLayout(resized))!;
    expect(stackGroupSizes(restored.zones.right, 900)).toEqual(after);
    // A short window keeps every panel reachable through dock scrolling.
    expect(stackGroupSizes(restored.zones.right, 300).every(size => size >= 180)).toBe(true);
  });

  it("can join all groups and close the middle panel without losing the others", () => {
    const layout = threePanels();
    const joined = applyLayoutOperation(layout, { type: "join-zone", zone: "right" });
    expect(joined.zones.right.groupIds).toHaveLength(1);
    expect(joined.groups[joined.zones.right.groupIds[0]!]!.tabs).toHaveLength(3);
    const tasks = findPanelTab(layout, "tasks")!;
    const closed = applyLayoutOperation(layout, { type: "close-tab", groupId: tasks.groupId, tabId: tasks.tab.id });
    expect(closed.zones.right.groupIds).toHaveLength(2);
    expect(findPanelTab(closed, "calendar")).not.toBeNull();
    expect(findPanelTab(closed, "graph")).not.toBeNull();
  });
});
