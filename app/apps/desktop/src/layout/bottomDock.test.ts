// The bottom dock (terminal T2): a zone under the center column. What must
// hold: old saved layouts still load, it only splits side by side, its height
// is a clamped preference that fitting never overwrites, a terminal moves
// between it and the center/right without changing instance id, and Ctrl+`
// opens, hides and re-shows it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLayoutOperation, zoneForGroup } from "./operations";
import { serializableLayout, validatePersistedLayout } from "./persistence";
import {
  BOTTOM_DOCK_MAX,
  BOTTOM_DOCK_MIN,
  CENTER_HEIGHT_MIN,
  PANE_SEPARATOR_SIZE,
  bottomResizeBounds,
  fitBottomDock,
} from "./geometry";
import { useLayoutStore } from "./store";
import {
  CENTER_NOTE_GROUP_ID,
  DEFAULT_BOTTOM_HEIGHT,
  canSplitZone,
  createDefaultLayout,
  type LayoutV1,
} from "./types";
import { resetTerminalLifecycle } from "../lib/terminal/lifecycle";
import { newTerminal, terminalTabs, toggleTerminal } from "../lib/terminal/open";

function openBottomTerminal(layout: LayoutV1, instanceId: string): LayoutV1 {
  return applyLayoutOperation(layout, {
    type: "open-panel",
    panelType: "terminal",
    zone: "bottom",
    groupId: layout.zones.bottom.groupIds[0],
    instanceId,
  });
}

function tabOf(layout: LayoutV1, panelId: string) {
  for (const group of Object.values(layout.groups)) {
    const tab = group.tabs.find((t) => t.kind === "panel" && t.panelId === panelId);
    if (tab) return { groupId: group.id, tab };
  }
  return null;
}

describe("bottom dock model", () => {
  it("starts empty and collapsed", () => {
    const { bottom } = createDefaultLayout().zones;
    expect(bottom.groupIds).toEqual([]);
    expect(bottom.userCollapsed).toBe(true);
    expect(bottom.preferredHeight).toBe(DEFAULT_BOTTOM_HEIGHT);
  });

  it("opens a terminal into its own group and un-collapses", () => {
    const layout = openBottomTerminal(createDefaultLayout(), "panel:terminal:a");
    const found = tabOf(layout, "panel:terminal:a")!;
    expect(zoneForGroup(layout, found.groupId)).toBe("bottom");
    expect(layout.zones.bottom.userCollapsed).toBe(false);
  });

  it("puts a second terminal in the same group as a tab", () => {
    let layout = openBottomTerminal(createDefaultLayout(), "panel:terminal:a");
    layout = openBottomTerminal(layout, "panel:terminal:b");
    expect(layout.zones.bottom.groupIds).toHaveLength(1);
    expect(layout.groups[layout.zones.bottom.groupIds[0]!]!.tabs).toHaveLength(2);
  });

  it("refuses panels that are not allowed there", () => {
    const layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel", panelType: "search", zone: "bottom",
    });
    expect(layout.zones.bottom.groupIds).toEqual([]);
  });

  it("only splits side by side", () => {
    const layout = openBottomTerminal(createDefaultLayout(), "panel:terminal:a");
    expect(canSplitZone("bottom", layout.zones.bottom, "x")).toBe(true);
    expect(canSplitZone("bottom", layout.zones.bottom, "y")).toBe(false);
  });

  it("collapses (keeping its tabs) and re-opens", () => {
    let layout = openBottomTerminal(createDefaultLayout(), "panel:terminal:a");
    layout = applyLayoutOperation(layout, { type: "set-zone-collapsed", zone: "bottom", collapsed: true });
    expect(layout.zones.bottom.userCollapsed).toBe(true);
    expect(layout.panels["panel:terminal:a"]).toBeDefined();
    const found = tabOf(layout, "panel:terminal:a")!;
    layout = applyLayoutOperation(layout, { type: "activate-tab", groupId: found.groupId, tabId: found.tab.id });
    expect(layout.zones.bottom.userCollapsed).toBe(false);
  });

  it("collapses itself when its last tab closes", () => {
    let layout = openBottomTerminal(createDefaultLayout(), "panel:terminal:a");
    const found = tabOf(layout, "panel:terminal:a")!;
    layout = applyLayoutOperation(layout, { type: "close-tab", groupId: found.groupId, tabId: found.tab.id });
    expect(layout.zones.bottom.groupIds).toEqual([]);
    expect(layout.zones.bottom.userCollapsed).toBe(true);
  });

  it("clamps the resized height", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), { type: "resize-bottom", height: 10 });
    expect(layout.zones.bottom.preferredHeight).toBe(BOTTOM_DOCK_MIN);
    layout = applyLayoutOperation(layout, { type: "resize-bottom", height: 99_999 });
    expect(layout.zones.bottom.preferredHeight).toBe(BOTTOM_DOCK_MAX);
  });
});

describe("moving a terminal between the bottom dock and the rest", () => {
  it("drags into the center tab strip (full screen) and back, keeping its id", () => {
    let layout = openBottomTerminal(createDefaultLayout(), "panel:terminal:a");
    const bottom = tabOf(layout, "panel:terminal:a")!;
    layout = applyLayoutOperation(layout, {
      type: "move-tab", tabId: bottom.tab.id, fromGroupId: bottom.groupId, toGroupId: CENTER_NOTE_GROUP_ID,
    });
    expect(tabOf(layout, "panel:terminal:a")?.groupId).toBe(CENTER_NOTE_GROUP_ID);
    expect(layout.zones.bottom.groupIds).toEqual([]);

    const center = tabOf(layout, "panel:terminal:a")!;
    layout = applyLayoutOperation(layout, {
      type: "move-tab-to-zone", tabId: center.tab.id, fromGroupId: center.groupId, zone: "bottom",
    });
    const back = tabOf(layout, "panel:terminal:a")!;
    expect(zoneForGroup(layout, back.groupId)).toBe("bottom");
    expect(layout.zones.bottom.userCollapsed).toBe(false);
    expect(layout.panels["panel:terminal:a"]?.type).toBe("terminal");
  });

  it("never takes a note tab", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), { type: "open-note", path: "a.md" });
    const note = layout.groups[CENTER_NOTE_GROUP_ID]!.tabs[0]!;
    layout = applyLayoutOperation(layout, {
      type: "move-tab-to-zone", tabId: note.id, fromGroupId: CENTER_NOTE_GROUP_ID, zone: "bottom",
    });
    expect(layout.zones.bottom.groupIds).toEqual([]);
  });
});

describe("bottom dock persistence", () => {
  it("round-trips its tabs and height", () => {
    let layout = openBottomTerminal(createDefaultLayout(), "panel:terminal:a");
    layout = applyLayoutOperation(layout, { type: "resize-bottom", height: 333 });
    const restored = validatePersistedLayout(JSON.parse(JSON.stringify(serializableLayout(layout))))!;
    expect(restored.zones.bottom.preferredHeight).toBe(333);
    expect(zoneForGroup(restored, tabOf(restored, "panel:terminal:a")!.groupId)).toBe("bottom");
  });

  it("still loads a layout saved before the bottom dock existed", () => {
    const saved = JSON.parse(JSON.stringify(serializableLayout(createDefaultLayout(300))));
    delete saved.zones.bottom;
    const restored = validatePersistedLayout(saved);
    expect(restored).not.toBeNull();
    expect(restored!.zones.left.preferredWidth).toBe(300);
    expect(restored!.zones.bottom.groupIds).toEqual([]);
    expect(restored!.zones.bottom.userCollapsed).toBe(true);
  });

  it("rejects a bottom dock stacked vertically", () => {
    const saved = JSON.parse(JSON.stringify(serializableLayout(createDefaultLayout())));
    saved.zones.bottom.axis = "y";
    expect(validatePersistedLayout(saved)).toBeNull();
  });

  it("repairs an empty-but-open bottom dock to collapsed", () => {
    const saved = JSON.parse(JSON.stringify(serializableLayout(createDefaultLayout())));
    saved.zones.bottom.userCollapsed = false;
    expect(validatePersistedLayout(saved)!.zones.bottom.userCollapsed).toBe(true);
  });

  it("drops a saved tool that is not allowed at the bottom", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), { type: "open-panel", panelType: "search", zone: "left" });
    const saved = JSON.parse(JSON.stringify(serializableLayout(layout)));
    const searchGroup = saved.zones.left.groupIds[0];
    saved.zones.left.groupIds = [];
    saved.zones.bottom.groupIds = [searchGroup];
    layout = validatePersistedLayout(saved)!;
    expect(layout.zones.bottom.groupIds).toEqual([]);
  });
});

describe("bottom dock geometry", () => {
  it("is 0 while closed", () => {
    expect(fitBottomDock({ columnHeight: 900, open: false, preferredHeight: 300 })).toBe(0);
  });

  it("uses the preferred height when it fits", () => {
    expect(fitBottomDock({ columnHeight: 900, open: true, preferredHeight: 300 })).toBe(300);
  });

  it("shrinks rather than squeeze the note below its minimum", () => {
    const column = 600;
    const fitted = fitBottomDock({ columnHeight: column, open: true, preferredHeight: 800 });
    expect(fitted).toBe(column - PANE_SEPARATOR_SIZE - CENTER_HEIGHT_MIN);
  });

  it("collapses when even its minimum does not fit", () => {
    const column = CENTER_HEIGHT_MIN + PANE_SEPARATOR_SIZE + BOTTOM_DOCK_MIN - 1;
    expect(fitBottomDock({ columnHeight: column, open: true, preferredHeight: 300 })).toBe(0);
  });

  it("bounds resizing by the note's minimum", () => {
    const { min, max } = bottomResizeBounds(700);
    expect(min).toBe(BOTTOM_DOCK_MIN);
    expect(max).toBe(700 - PANE_SEPARATOR_SIZE - CENTER_HEIGHT_MIN);
  });
});

describe("Ctrl+` toggle", () => {
  const frames: Array<() => void> = [];
  beforeEach(() => {
    resetTerminalLifecycle();
    useLayoutStore.getState().hydrate("/vault", createDefaultLayout());
    vi.stubGlobal("window", { requestAnimationFrame: (cb: () => void) => frames.push(cb) });
    vi.stubGlobal("document", { activeElement: null, querySelector: () => null });
  });
  afterEach(() => {
    frames.length = 0;
    vi.unstubAllGlobals();
  });

  // A focused element inside the terminal host of the given dock group.
  const inTerminal = (groupId: string) => ({
    closest: (selector: string) => {
      if (selector === ".terminal-host") return {};
      if (selector === "[data-dock-group-id]") return { getAttribute: () => groupId };
      return null;
    },
  });

  it("opens a first terminal in the bottom dock", () => {
    toggleTerminal(null);
    const layout = useLayoutStore.getState().layout;
    expect(terminalTabs(layout).map((t) => t.zone)).toEqual(["bottom"]);
    expect(layout.zones.bottom.userCollapsed).toBe(false);
  });

  it("hides the bottom dock when pressed from inside its terminal, and shows it again", () => {
    newTerminal();
    const groupId = useLayoutStore.getState().layout.zones.bottom.groupIds[0]!;
    toggleTerminal(inTerminal(groupId) as unknown as EventTarget);
    let layout = useLayoutStore.getState().layout;
    expect(layout.zones.bottom.userCollapsed).toBe(true);
    // Hidden, not closed: the terminal is still there.
    expect(terminalTabs(layout)).toHaveLength(1);

    toggleTerminal(null);
    layout = useLayoutStore.getState().layout;
    expect(layout.zones.bottom.userCollapsed).toBe(false);
    expect(terminalTabs(layout)).toHaveLength(1);
  });

  it("from outside a terminal, reveals rather than hides", () => {
    newTerminal();
    toggleTerminal(null);
    expect(useLayoutStore.getState().layout.zones.bottom.userCollapsed).toBe(false);
  });

  it("finds a terminal that was moved to the center", () => {
    newTerminal();
    let layout = useLayoutStore.getState().layout;
    const [t] = terminalTabs(layout);
    useLayoutStore.getState().dispatch({
      type: "move-tab", tabId: t!.tabId, fromGroupId: t!.groupId, toGroupId: CENTER_NOTE_GROUP_ID,
    });
    toggleTerminal(null);
    layout = useLayoutStore.getState().layout;
    expect(terminalTabs(layout).map((x) => x.zone)).toEqual(["center"]);
    expect(layout.groups[CENTER_NOTE_GROUP_ID]!.activeTabId).toBe(terminalTabs(layout)[0]!.tabId);
  });
});
