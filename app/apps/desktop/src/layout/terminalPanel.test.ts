// The `terminal` panel type through the layout machinery: it can sit as a full
// center tab (the bottom dock is covered in bottomDock.test.ts), move to the right dock without changing its instance id (the
// key Rust holds its shell under), several can coexist, and a saved layout
// restores the tabs — the shells themselves never come back on their own.

import { beforeEach, describe, expect, it } from "vitest";
import { panelRegistry } from "./panelRegistry";
import { applyLayoutOperation } from "./operations";
import { CENTER_NOTE_GROUP_ID, createDefaultLayout, PANEL_ALLOWED_ZONES, PANEL_MULTIPLICITY, type LayoutV1 } from "./types";
import { serializableLayout, validatePersistedLayout } from "./persistence";
import {
  consumeSpawnRequest,
  newTerminalInstanceId,
  orphanedSessions,
  reapOrphans,
  requestSpawn,
  resetTerminalLifecycle,
  trackSession,
} from "../lib/terminal/lifecycle";

function openTerminal(layout: LayoutV1, instanceId: string): LayoutV1 {
  return applyLayoutOperation(layout, {
    type: "open-panel",
    panelType: "terminal",
    zone: "center",
    groupId: CENTER_NOTE_GROUP_ID,
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

describe("terminal panel registration", () => {
  it("lives in the bottom panel, the center or the right dock, never the navigation column", () => {
    expect(PANEL_ALLOWED_ZONES.terminal).toEqual(["bottom", "center", "right"]);
    expect(panelRegistry.terminal.allowedZones).toEqual(["bottom", "center", "right"]);
    expect(panelRegistry.terminal.defaultZone).toBe("bottom");
    expect(PANEL_MULTIPLICITY.terminal).toBe(panelRegistry.terminal.multiplicity);
  });

  it("persists nothing about the shell", () => {
    const persist: (state: Record<string, unknown>) => Record<string, unknown> =
      panelRegistry.terminal.persistentState;
    expect(persist({ anything: 1 })).toEqual({});
  });
});

describe("terminal panels in the layout", () => {
  it("opens as a tab in the center note group", () => {
    const layout = openTerminal(createDefaultLayout(), "panel:terminal:a");
    expect(tabOf(layout, "panel:terminal:a")?.groupId).toBe(CENTER_NOTE_GROUP_ID);
  });

  it("allows several terminals up to the limit", () => {
    let layout = createDefaultLayout();
    const limit = PANEL_MULTIPLICITY.terminal;
    for (let i = 0; i <= limit; i += 1) layout = openTerminal(layout, `panel:terminal:${i}`);
    const count = Object.values(layout.panels).filter((p) => p.type === "terminal").length;
    expect(count).toBe(limit);
  });

  it("keeps its instance id when moved to the right dock", () => {
    let layout = openTerminal(createDefaultLayout(), "panel:terminal:a");
    const found = tabOf(layout, "panel:terminal:a")!;
    layout = applyLayoutOperation(layout, {
      type: "move-tab-to-zone",
      tabId: found.tab.id,
      fromGroupId: found.groupId,
      zone: "right",
    });
    const moved = tabOf(layout, "panel:terminal:a");
    expect(moved).not.toBeNull();
    expect(layout.zones.right.groupIds).toContain(moved!.groupId);
    expect(layout.panels["panel:terminal:a"]?.type).toBe("terminal");
  });

  it("refuses the left dock", () => {
    let layout = openTerminal(createDefaultLayout(), "panel:terminal:a");
    const found = tabOf(layout, "panel:terminal:a")!;
    layout = applyLayoutOperation(layout, {
      type: "move-tab-to-zone",
      tabId: found.tab.id,
      fromGroupId: found.groupId,
      zone: "left",
    });
    expect(tabOf(layout, "panel:terminal:a")?.groupId).toBe(CENTER_NOTE_GROUP_ID);
  });

  it("restores the tab from a saved layout", () => {
    const layout = openTerminal(createDefaultLayout(), "panel:terminal:a");
    const restored = validatePersistedLayout(JSON.parse(JSON.stringify(serializableLayout(layout))));
    expect(restored?.panels["panel:terminal:a"]?.type).toBe("terminal");
  });
});

describe("terminal lifecycle", () => {
  beforeEach(() => resetTerminalLifecycle());

  it("spawns only for a panel the user just asked for, and only once", () => {
    requestSpawn("panel:terminal:a");
    expect(consumeSpawnRequest("panel:terminal:a")).toBe(true);
    expect(consumeSpawnRequest("panel:terminal:a")).toBe(false);
  });

  it("never spawns for a panel restored from a saved layout", () => {
    expect(consumeSpawnRequest("panel:terminal:restored")).toBe(false);
  });

  it("reaps a session whose panel was closed, and keeps one that moved", () => {
    let layout = openTerminal(createDefaultLayout(), "panel:terminal:a");
    layout = openTerminal(layout, "panel:terminal:b");
    trackSession("panel:terminal:a");
    trackSession("panel:terminal:b");

    const found = tabOf(layout, "panel:terminal:b")!;
    const moved = applyLayoutOperation(layout, {
      type: "move-tab-to-zone",
      tabId: found.tab.id,
      fromGroupId: found.groupId,
      zone: "right",
    });
    expect(reapOrphans(moved.panels)).toEqual([]);

    const a = tabOf(moved, "panel:terminal:a")!;
    const closed = applyLayoutOperation(moved, { type: "close-tab", groupId: a.groupId, tabId: a.tab.id });
    expect(reapOrphans(closed.panels)).toEqual(["panel:terminal:a"]);
    // Reaped once: a later layout change does not report it again.
    expect(reapOrphans(closed.panels)).toEqual([]);
  });

  it("reaps every session when the whole layout is swapped (vault switch)", () => {
    trackSession("panel:terminal:a");
    trackSession("panel:terminal:b");
    expect(reapOrphans(createDefaultLayout().panels).sort()).toEqual([
      "panel:terminal:a",
      "panel:terminal:b",
    ]);
  });

  it("treats a same-id panel of another type as gone", () => {
    const panels = { x: { id: "x", type: "graph" as const, stateVersion: 1, state: {} } };
    expect(orphanedSessions(["x"], panels)).toEqual(["x"]);
  });

  it("mints distinct terminal ids", () => {
    const a = newTerminalInstanceId();
    const b = newTerminalInstanceId();
    expect(a).toMatch(/^panel:terminal:/);
    expect(a).not.toBe(b);
  });
});
