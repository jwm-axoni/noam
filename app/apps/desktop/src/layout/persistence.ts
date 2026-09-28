import { useEffect, useState } from "react";
import { readSidebarWidth } from "../lib/prefs";
import { presenceV1Enabled } from "../lib/presence/flag";
import { panelRegistry } from "./panelRegistry";
import {
  CENTER_NOTE_GROUP_ID,
  ZONE_IDS,
  createDefaultLayout,
  isPanelType,
  type LayoutGroup,
  type LayoutTab,
  type LayoutV1,
  type LayoutZone,
  type ZoneId,
  type PanelInstance,
} from "./types";
import { useLayoutStore } from "./store";
import { clampPreferredDockWidth } from "./geometry";
import { applyLayoutOperation } from "./operations";

export const LAYOUT_STORAGE_PREFIX = "noam.workspace.layout.v1:";
export const LAYOUT_PERSIST_DEBOUNCE_MS = 250;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

export function layoutStorageKey(vaultPath: string): string {
  return `${LAYOUT_STORAGE_PREFIX}${encodeURIComponent(vaultPath)}`;
}

/** Strip session-only note tabs and focus before device-local persistence. */
export function serializableLayout(layout: LayoutV1): LayoutV1 {
  let source = layout;
  for (const panel of Object.values(layout.panels)) {
    const returnZone = panel.state.__temporaryReturnZone;
    if (returnZone === "left" || returnZone === "right") {
      source = applyLayoutOperation(source, {
        type: "open-panel",
        panelType: panel.type,
        zone: returnZone,
      });
    }
  }
  const groups: Record<string, LayoutGroup> = {};
  for (const [id, group] of Object.entries(source.groups)) {
    const tabs = group.tabs.filter((tab) => tab.kind === "panel");
    groups[id] = {
      ...group,
      tabs,
      activeTabId: tabs.some((tab) => tab.id === group.activeTabId)
        ? group.activeTabId
        : (tabs[0]?.id ?? null),
    };
  }
  const panels = Object.fromEntries(Object.entries(source.panels).map(([id, panel]) => [
    id,
    { ...panel, state: panelRegistry[panel.type].persistentState(panel.state) },
  ]));
  return {
    ...source,
    zones: {
      ...source.zones,
      center: { ...source.zones.center, preferredWidth: 0 },
    },
    groups,
    panels,
    focusedGroupId: CENTER_NOTE_GROUP_ID,
  };
}

function parseZone(value: unknown, zoneId: ZoneId): LayoutZone | null {
  if (!record(value)) return null;
  const { groupIds, axis, ratio, preferredWidth, userCollapsed } = value;
  if (
    !Array.isArray(groupIds) || groupIds.length > (zoneId === "right" && axis === "y" ? 12 : 2) ||
    !groupIds.every((id) => typeof id === "string") ||
    (axis !== "x" && axis !== "y") ||
    typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1 ||
    typeof preferredWidth !== "number" || !Number.isFinite(preferredWidth) ||
    typeof userCollapsed !== "boolean"
  ) return null;
  return {
    groupIds: [...new Set(groupIds)],
    ...(record(value.groupSizes) ? { groupSizes: Object.fromEntries(
      Object.entries(value.groupSizes).filter(([id, size]) =>
        groupIds.includes(id) && typeof size === "number" && Number.isFinite(size) && size > 0),
    ) as Record<string, number> } : {}),
    axis,
    ratio,
    preferredWidth,
    userCollapsed,
  };
}

function parsePanel(value: unknown): PanelInstance | null {
  if (!record(value)) return null;
  const { id, type, stateVersion, state } = value;
  if (
    typeof id !== "string" || !isPanelType(type) ||
    !Number.isInteger(stateVersion) || !panelRegistry[type].validateState(state)
  ) return null;
  // The presenceV1 kill switch hides the People button, its shortcut and the
  // auto-open, but a panel saved in the layout while the flag was on would
  // otherwise come straight back on hydrate. Treat it like an unknown panel
  // so the repair below drops its tab and fixes the active reference.
  if (type === "presence" && !presenceV1Enabled()) return null;
  return { id, type, stateVersion: stateVersion as number, state };
}

function parseGroup(value: unknown): LayoutGroup | null {
  if (!record(value) || typeof value.id !== "string" || !Array.isArray(value.tabs)) return null;
  const tabs: LayoutTab[] = [];
  for (const candidate of value.tabs.slice(0, 64)) {
    if (!record(candidate) || typeof candidate.id !== "string") continue;
    if (candidate.kind === "panel" && typeof candidate.panelId === "string") {
      tabs.push({ id: candidate.id, kind: "panel", panelId: candidate.panelId });
    }
    // Note tabs are deliberately not restored, even if an older or hand-edited
    // value contains one.
  }
  return {
    id: value.id,
    tabs,
    activeTabId: typeof value.activeTabId === "string" ? value.activeTabId : null,
    permanent: value.id === CENTER_NOTE_GROUP_ID,
  };
}

export function validatePersistedLayout(value: unknown): LayoutV1 | null {
  if (!record(value) || value.version !== 1 || !record(value.zones) || !record(value.groups) || !record(value.panels)) {
    return null;
  }
  const zones = {} as LayoutV1["zones"];
  for (const zoneId of ZONE_IDS) {
    const zone = parseZone(value.zones[zoneId], zoneId);
    if (!zone) return null;
    zones[zoneId] = zone;
  }
  zones.left.preferredWidth = clampPreferredDockWidth("left", zones.left.preferredWidth);
  zones.right.preferredWidth = clampPreferredDockWidth("right", zones.right.preferredWidth);
  zones.center.preferredWidth = 0;

  const panels: Record<string, PanelInstance> = {};
  const typeCounts = new Map<string, number>();
  for (const candidate of Object.values(value.panels)) {
    const panel = parsePanel(candidate);
    if (!panel || panel.id in panels) continue;
    const count = typeCounts.get(panel.type) ?? 0;
    if (count >= panelRegistry[panel.type].multiplicity) continue;
    panels[panel.id] = panel;
    typeCounts.set(panel.type, count + 1);
  }

  const groups: Record<string, LayoutGroup> = {};
  const placedGroups = new Set<string>();
  const placedPanels = new Set<string>();
  const placedTabs = new Set<string>();
  for (const zoneId of ZONE_IDS) {
    const repairedIds: string[] = [];
    for (const id of zones[zoneId].groupIds) {
      if (id === CENTER_NOTE_GROUP_ID && zoneId !== "center") continue;
      if (placedGroups.has(id)) continue;
      const group = parseGroup(value.groups[id]);
      if (!group || group.id !== id) continue;
      group.tabs = group.tabs.filter((tab) => {
        if (tab.kind !== "panel" || placedPanels.has(tab.panelId) || placedTabs.has(tab.id)) return false;
        const panel = panels[tab.panelId];
        if (!panel || !(panelRegistry[panel.type].allowedZones as readonly string[]).includes(zoneId)) return false;
        placedPanels.add(tab.panelId);
        placedTabs.add(tab.id);
        return true;
      });
      group.activeTabId = group.tabs.some((tab) => tab.id === group.activeTabId)
        ? group.activeTabId
        : (group.tabs[0]?.id ?? null);
      if (group.tabs.length === 0 && id !== CENTER_NOTE_GROUP_ID) continue;
      groups[id] = group;
      repairedIds.push(id);
      placedGroups.add(id);
    }
    zones[zoneId].groupIds = repairedIds;
  }

  // The one note host is structural state, not persisted session content.
  const restoredNoteTools = groups[CENTER_NOTE_GROUP_ID]?.tabs ?? [];
  const restoredNoteActive = groups[CENTER_NOTE_GROUP_ID]?.activeTabId ?? null;
  const existingCenterTools = zones.center.groupIds.filter((id) => id !== CENTER_NOTE_GROUP_ID);
  groups[CENTER_NOTE_GROUP_ID] = {
    id: CENTER_NOTE_GROUP_ID,
    tabs: restoredNoteTools,
    activeTabId: restoredNoteTools.some((tab) => tab.id === restoredNoteActive)
      ? restoredNoteActive
      : (restoredNoteTools[0]?.id ?? null),
    permanent: true,
  };
  zones.center.groupIds = [CENTER_NOTE_GROUP_ID, ...existingCenterTools].slice(0, 2);
  zones.center.userCollapsed = false;
  for (const zoneId of ["left", "right"] as const) {
    if (zones[zoneId].groupIds.length === 0) zones[zoneId].userCollapsed = true;
  }
  for (const id of Object.keys(panels)) if (!placedPanels.has(id)) delete panels[id];

  const focused = typeof value.focusedGroupId === "string" && groups[value.focusedGroupId]
    ? value.focusedGroupId
    : CENTER_NOTE_GROUP_ID;
  return { version: 1, zones, groups, panels, focusedGroupId: focused };
}

function browserStorage(): StorageLike | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function loadLayout(
  vaultPath: string,
  storage: StorageLike | null = browserStorage(),
  legacyLeftWidth?: number,
): LayoutV1 {
  if (!storage) return createDefaultLayout(legacyLeftWidth);
  try {
    const raw = storage.getItem(layoutStorageKey(vaultPath));
    if (raw == null) return createDefaultLayout(legacyLeftWidth ?? readSidebarWidth());
    return validatePersistedLayout(JSON.parse(raw)) ?? createDefaultLayout(legacyLeftWidth);
  } catch {
    return createDefaultLayout(legacyLeftWidth);
  }
}

export function saveLayout(
  vaultPath: string,
  layout: LayoutV1,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(layoutStorageKey(vaultPath), JSON.stringify(serializableLayout(layout)));
  } catch {
    // Quota/security failures leave the in-memory workspace fully usable.
  }
}

export function createLayoutPersistence(
  vaultPath: string,
  storage: StorageLike | null = browserStorage(),
  debounceMs = LAYOUT_PERSIST_DEBOUNCE_MS,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: LayoutV1 | null = null;
  const flush = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    if (pending) saveLayout(vaultPath, pending, storage);
    pending = null;
  };
  return {
    schedule(layout: LayoutV1) {
      pending = layout;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    flush,
    cancel() {
      if (timer != null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/** Hydrate before tool bodies mount, debounce changes, and flush the old vault. */
export function useLayoutPersistence(vaultPath: string): boolean {
  const [hydratedPath, setHydratedPath] = useState<string | null>(null);
  useEffect(() => {
    const hydratedLayout = loadLayout(vaultPath);
    useLayoutStore.getState().hydrate(vaultPath, hydratedLayout);
    setHydratedPath(vaultPath);
    const writer = createLayoutPersistence(vaultPath);
    // Materialize the v1 key even before the first user edit. That makes the
    // legacy sidebar-width import genuinely one-time.
    writer.schedule(hydratedLayout);
    const unsubscribe = useLayoutStore.subscribe((state, previous) => {
      if (state.vaultKey === vaultPath && state.layout !== previous.layout) {
        writer.schedule(state.layout);
      }
    });
    const flush = () => writer.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      writer.schedule(useLayoutStore.getState().layout);
      writer.flush();
      useLayoutStore.getState().cancelInteraction();
    };
  }, [vaultPath]);
  return hydratedPath === vaultPath;
}
