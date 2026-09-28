import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLayoutPersistence,
  layoutStorageKey,
  loadLayout,
  saveLayout,
  serializableLayout,
  validatePersistedLayout,
  type StorageLike,
} from "./persistence";
import { applyLayoutOperation, findPanelTab } from "./operations";
import { CENTER_NOTE_GROUP_ID, createDefaultLayout } from "./types";

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

afterEach(() => vi.useRealTimers());

describe("layout persistence", () => {
  it("uses a vault-path-scoped, encoded key", () => {
    expect(layoutStorageKey("/vaults/A vault")).toBe(
      "noam.workspace.layout.v1:%2Fvaults%2FA%20vault",
    );
  });

  it("falls back to defaults for malformed or unsupported data", () => {
    const storage = new MemoryStorage();
    storage.setItem(layoutStorageKey("/vault"), "{bad json");
    expect(loadLayout("/vault", storage).zones.left.preferredWidth).toBe(264);
    storage.setItem(layoutStorageKey("/vault"), JSON.stringify({ version: 2 }));
    expect(loadLayout("/vault", storage).groups[CENTER_NOTE_GROUP_ID]?.permanent).toBe(true);
  });

  it("imports the legacy sidebar width only when no layout exists", () => {
    const storage = new MemoryStorage();
    expect(loadLayout("/vault", storage, 412).zones.left.preferredWidth).toBe(412);
    saveLayout("/vault", createDefaultLayout(300), storage);
    expect(loadLayout("/vault", storage, 412).zones.left.preferredWidth).toBe(300);
  });

  it("excludes note tabs and transient note focus", () => {
    const layout = createDefaultLayout();
    layout.groups[CENTER_NOTE_GROUP_ID]!.tabs.push({
      id: "tab:note",
      kind: "note",
      path: "Meetings/private.md",
    });
    layout.groups[CENTER_NOTE_GROUP_ID]!.activeTabId = "tab:note";
    layout.focusedGroupId = "some-transient-group";
    const persisted = serializableLayout(layout);
    expect(persisted.groups[CENTER_NOTE_GROUP_ID]?.tabs).toEqual([]);
    expect(persisted.focusedGroupId).toBe(CENTER_NOTE_GROUP_ID);
  });

  it("round-trips a collapsed right dock (rail toggle survives reload)", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "properties",
      zone: "right",
    });
    layout = applyLayoutOperation(layout, {
      type: "set-zone-collapsed",
      zone: "right",
      collapsed: true,
    });
    expect(layout.zones.right.userCollapsed).toBe(true);

    const restored = validatePersistedLayout(serializableLayout(layout));
    // The panel/tab survives collapse — restoring must not silently re-expand
    // the dock (a stale "expanded" restore would defeat the rail's memory).
    expect(restored?.zones.right.userCollapsed).toBe(true);
    expect(findPanelTab(restored!, "properties")).not.toBeNull();
  });

  it("persists durable graph preferences but not search or camera state", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "graph",
      zone: "right",
    });
    const graph = Object.values(layout.panels).find((panel) => panel.type === "graph")!;
    layout = {
      ...layout,
      panels: {
        ...layout.panels,
        [graph.id]: {
          ...graph,
          state: { nodeSize: 1.4, hideOrphans: false, search: "secret", camera: { x: 1 } },
        },
      },
    };
    expect(serializableLayout(layout).panels[graph.id]?.state).toEqual({
      nodeSize: 1.4,
      hideOrphans: false,
    });
  });

  it("does not overwrite preferred placement with a temporary viewport fallback", () => {
    let layout = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "history",
      zone: "right",
    });
    layout = applyLayoutOperation(layout, {
      type: "open-panel",
      panelType: "history",
      zone: "center",
      temporaryReturnZone: "right",
    });
    expect(findPanelTab(layout, "history")?.groupId).toBe(CENTER_NOTE_GROUP_ID);
    const persisted = serializableLayout(layout);
    expect(persisted.zones.right.groupIds).toContain(findPanelTab(persisted, "history")?.groupId);
    expect(persisted.panels[findPanelTab(persisted, "history")!.panel.id]?.state).toEqual({});
  });

  it("drops unknown panels, repairs active references, and recreates the note host", () => {
    const raw = createDefaultLayout() as unknown as Record<string, unknown>;
    const zones = raw.zones as Record<string, { groupIds: string[] }>;
    const groups = raw.groups as Record<string, unknown>;
    const panels = raw.panels as Record<string, unknown>;
    delete groups[CENTER_NOTE_GROUP_ID];
    zones.center!.groupIds = [];
    zones.right!.groupIds = ["group:bad"];
    groups["group:bad"] = {
      id: "group:bad",
      tabs: [{ id: "tab:bad", kind: "panel", panelId: "panel:bad" }],
      activeTabId: "missing",
    };
    panels["panel:bad"] = { id: "panel:bad", type: "plugin-panel", stateVersion: 1, state: {} };
    const repaired = validatePersistedLayout(raw)!;
    expect(repaired.groups[CENTER_NOTE_GROUP_ID]?.permanent).toBe(true);
    expect(repaired.zones.right.groupIds).toEqual([]);
    expect(repaired.panels["panel:bad"]).toBeUndefined();
  });

  it("drops a persisted People panel while the presenceV1 kill switch is off", () => {
    // Saved while the flag was on (the panel auto-opens for multi-member orgs).
    const withPanel = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel", panelType: "presence", zone: "right",
    });
    const raw = JSON.parse(JSON.stringify(serializableLayout(withPanel)));
    expect(findPanelTab(withPanel, "presence")).not.toBeNull();

    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "noam.flags.presenceV1" ? "off" : null) });
    try {
      const hydrated = validatePersistedLayout(raw)!;
      expect(findPanelTab(hydrated, "presence")).toBeNull();
      expect(Object.values(hydrated.panels).some((p) => p.type === "presence")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    // Flag on (or unset): the same value restores the panel.
    expect(findPanelTab(validatePersistedLayout(raw)!, "presence")).not.toBeNull();
  });

  it("debounces writes and flushes the latest committed layout", () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const writer = createLayoutPersistence("/vault", storage);
    writer.schedule(createDefaultLayout(300));
    writer.schedule(applyLayoutOperation(createDefaultLayout(300), {
      type: "resize-zone",
      zone: "left",
      width: 440,
    }));
    expect(storage.getItem(layoutStorageKey("/vault"))).toBeNull();
    vi.advanceTimersByTime(249);
    expect(storage.getItem(layoutStorageKey("/vault"))).toBeNull();
    vi.advanceTimersByTime(1);
    expect(loadLayout("/vault", storage).zones.left.preferredWidth).toBe(440);
  });

  it("can cancel an uncommitted debounced write", () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const writer = createLayoutPersistence("/vault", storage);
    writer.schedule(createDefaultLayout(400));
    writer.cancel();
    vi.runAllTimers();
    expect(storage.getItem(layoutStorageKey("/vault"))).toBeNull();
  });
});
