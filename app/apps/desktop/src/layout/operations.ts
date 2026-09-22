import {
  CENTER_NOTE_GROUP_ID,
  PANEL_ALLOWED_ZONES,
  PANEL_MULTIPLICITY,
  createDefaultLayout,
  canSplitZone,
  type LayoutGroup,
  type LayoutTab,
  type LayoutV1,
  type PanelType,
  type SplitAxis,
  type ZoneId,
} from "./types";
import {
  CENTER_NOTE_MIN,
  GRAPH_GROUP_MIN,
  GROUP_HEIGHT_MIN,
  TOOL_GROUP_MIN,
  clampPreferredDockWidth,
  clampSplitRatio,
  stackGroupSizes,
} from "./geometry";

export type LayoutOperation =
  | {
      type: "open-panel";
      panelType: PanelType;
      zone: ZoneId;
      groupId?: string;
      instanceId?: string;
      temporaryReturnZone?: "left" | "right";
    }
  | { type: "activate-tab"; groupId: string; tabId: string }
  | { type: "open-note"; path: string }
  | { type: "close-tab"; groupId: string; tabId: string }
  | { type: "close-tabs"; groupId: string; tabIds: string[] }
  | { type: "prune-note-tabs"; paths: string[] }
  | { type: "remap-note-tabs"; from: string; to: string }
  | { type: "clear-note-tabs" }
  | { type: "reorder-tab"; groupId: string; tabId: string; toIndex: number }
  | { type: "move-tab"; tabId: string; fromGroupId: string; toGroupId: string; toIndex?: number }
  | { type: "move-tab-to-zone"; tabId: string; fromGroupId: string; zone: "left" | "right" }
  | {
      type: "split-tab";
      zone: ZoneId;
      targetGroupId: string;
      fromGroupId: string;
      tabId: string;
      axis: SplitAxis;
      after?: boolean;
      availableSize: number;
    }
  | {
      type: "split-group";
      zone: ZoneId;
      groupId: string;
      tabId: string;
      axis: SplitAxis;
      after?: boolean;
      availableSize: number;
    }
  | { type: "join-zone"; zone: ZoneId; targetGroupId?: string }
  | { type: "swap-zone-groups"; zone: ZoneId }
  | { type: "set-zone-collapsed"; zone: "left" | "right"; collapsed: boolean }
  | { type: "resize-zone"; zone: "left" | "right"; width: number }
  | { type: "set-split-ratio"; zone: ZoneId; ratio: number; availableSize: number }
  | { type: "resize-stack-pair"; zone: "right"; index: number; size: number; availableSize: number }
  | { type: "focus-group"; groupId: string }
  | { type: "cancel" }
  | { type: "reset"; legacyLeftWidth?: number };

function copyLayout(layout: LayoutV1): LayoutV1 {
  return {
    ...layout,
    zones: {
      left: { ...layout.zones.left, groupIds: [...layout.zones.left.groupIds] },
      center: { ...layout.zones.center, groupIds: [...layout.zones.center.groupIds] },
      right: { ...layout.zones.right, groupIds: [...layout.zones.right.groupIds], groupSizes: layout.zones.right.groupSizes ? { ...layout.zones.right.groupSizes } : undefined },
    },
    groups: Object.fromEntries(
      Object.entries(layout.groups).map(([id, group]) => [
        id,
        { ...group, tabs: group.tabs.map((tab) => ({ ...tab })) },
      ]),
    ),
    panels: Object.fromEntries(
      Object.entries(layout.panels).map(([id, panel]) => [
        id,
        { ...panel, state: { ...panel.state } },
      ]),
    ),
  };
}

function zoneForGroup(layout: LayoutV1, groupId: string): ZoneId | null {
  if (layout.zones.left.groupIds.includes(groupId)) return "left";
  if (layout.zones.center.groupIds.includes(groupId)) return "center";
  if (layout.zones.right.groupIds.includes(groupId)) return "right";
  return null;
}

function removeEmptyGroup(layout: LayoutV1, group: LayoutGroup): void {
  if (group.permanent || group.tabs.length > 0) return;
  const zoneId = zoneForGroup(layout, group.id);
  if (!zoneId) return;
  layout.zones[zoneId].groupIds = layout.zones[zoneId].groupIds.filter(
    (id) => id !== group.id,
  );
  delete layout.zones[zoneId].groupSizes?.[group.id];
  if (layout.zones[zoneId].groupIds.length < 2) delete layout.zones[zoneId].groupSizes;
  delete layout.groups[group.id];
  if (zoneId !== "center" && layout.zones[zoneId].groupIds.length === 0) {
    layout.zones[zoneId].userCollapsed = true;
  }
  if (layout.focusedGroupId === group.id) {
    layout.focusedGroupId = layout.zones.center.groupIds[0] ?? CENTER_NOTE_GROUP_ID;
  }
}

function closeTab(layout: LayoutV1, groupId: string, tabId: string): boolean {
  const group = layout.groups[groupId];
  if (!group) return false;
  const index = group.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return false;
  const [removed] = group.tabs.splice(index, 1);
  if (removed?.kind === "panel") delete layout.panels[removed.panelId];
  if (group.activeTabId === tabId) {
    group.activeTabId = group.tabs[Math.min(index, group.tabs.length - 1)]?.id ?? null;
  }
  removeEmptyGroup(layout, group);
  return true;
}

function panelLocation(layout: LayoutV1, panelId: string) {
  for (const [groupId, group] of Object.entries(layout.groups)) {
    const tab = group.tabs.find((candidate) =>
      candidate.kind === "panel" && candidate.panelId === panelId,
    );
    if (tab) return { groupId, tab };
  }
  return null;
}

function uniqueId(base: string, existing: Record<string, unknown>): string {
  if (!(base in existing)) return base;
  let suffix = 2;
  while (`${base}:${suffix}` in existing) suffix += 1;
  return `${base}:${suffix}`;
}

function openPanel(
  layout: LayoutV1,
  panelType: PanelType,
  zoneId: ZoneId,
  requestedGroupId?: string,
  requestedInstanceId?: string,
  temporaryReturnZone?: "left" | "right",
): boolean {
  if (!PANEL_ALLOWED_ZONES[panelType].includes(zoneId)) return false;
  const existing = Object.values(layout.panels).filter((panel) => panel.type === panelType);
  // Ordinary open commands reveal the existing instance wherever it lives.
  // A caller must provide a fresh instance id to deliberately create the
  // graph's permitted second instance; singleton tools can never be cloned.
  const reusable = requestedInstanceId
    ? existing.find((panel) => panel.id === requestedInstanceId)
    : existing[0];
  if (reusable) {
    const location = panelLocation(layout, reusable.id);
    if (!location) return false;
    const actualZone = zoneForGroup(layout, location.groupId);
    if (!actualZone) return false;
    if (temporaryReturnZone) reusable.state.__temporaryReturnZone = temporaryReturnZone;
    else delete reusable.state.__temporaryReturnZone;
    let destinationId = requestedGroupId ?? layout.zones[zoneId].groupIds[0];
    if (actualZone !== zoneId) {
      if (destinationId && !layout.zones[zoneId].groupIds.includes(destinationId)) return false;
      if (!destinationId) {
        if (layout.zones[zoneId].groupIds.length >= 2) return false;
        destinationId = uniqueId(`group:${zoneId}:${panelType}`, layout.groups);
        layout.groups[destinationId] = { id: destinationId, tabs: [], activeTabId: null };
        layout.zones[zoneId].groupIds.push(destinationId);
      }
      const source = layout.groups[location.groupId]!;
      const index = source.tabs.findIndex((tab) => tab.id === location.tab.id);
      source.tabs.splice(index, 1);
      if (source.activeTabId === location.tab.id) {
        source.activeTabId = source.tabs[index]?.id ?? source.tabs[index - 1]?.id ?? null;
      }
      const destination = layout.groups[destinationId]!;
      destination.tabs.push(location.tab);
      destination.activeTabId = location.tab.id;
      removeEmptyGroup(layout, source);
      layout.focusedGroupId = destinationId;
    } else {
      layout.groups[location.groupId]!.activeTabId = location.tab.id;
      layout.focusedGroupId = location.groupId;
    }
    layout.zones[zoneId].userCollapsed = false;
    return true;
  }
  if (existing.length >= PANEL_MULTIPLICITY[panelType]) return false;

  let groupId = requestedGroupId;
  const wantsDefaultGraphGroup = !requestedGroupId && panelType === "graph" &&
    zoneId === "right" && layout.zones.right.groupIds.length === 1;
  if (!groupId && !wantsDefaultGraphGroup) groupId = layout.zones[zoneId].groupIds[0];
  if (groupId && !layout.zones[zoneId].groupIds.includes(groupId)) return false;
  if (!groupId) {
    if (layout.zones[zoneId].groupIds.length >= 2) return false;
    groupId = uniqueId(`group:${zoneId}:${panelType}`, layout.groups);
    layout.groups[groupId] = { id: groupId, tabs: [], activeTabId: null };
    layout.zones[zoneId].groupIds.push(groupId);
  }

  const panelId = requestedInstanceId ?? uniqueId(`panel:${panelType}`, layout.panels);
  if (layout.panels[panelId]) return false;
  const tabId = uniqueId(`tab:${panelId}`, Object.fromEntries(
    Object.values(layout.groups).flatMap((group) => group.tabs.map((tab) => [tab.id, true])),
  ));
  layout.panels[panelId] = {
    id: panelId,
    type: panelType,
    stateVersion: 1,
    state: temporaryReturnZone ? { __temporaryReturnZone: temporaryReturnZone } : {},
  };
  layout.groups[groupId]!.tabs.push({ id: tabId, kind: "panel", panelId });
  layout.groups[groupId]!.activeTabId = tabId;
  layout.zones[zoneId].userCollapsed = false;
  layout.focusedGroupId = groupId;
  return true;
}

function tabMinimum(layout: LayoutV1, tab: LayoutTab, axis: SplitAxis): number {
  if (axis === "y") return GROUP_HEIGHT_MIN;
  if (tab.kind === "note") return CENTER_NOTE_MIN;
  return layout.panels[tab.panelId]?.type === "graph" ? GRAPH_GROUP_MIN : TOOL_GROUP_MIN;
}

function groupMinimum(layout: LayoutV1, groupId: string, axis: SplitAxis): number {
  if (axis === "y") return GROUP_HEIGHT_MIN;
  if (groupId === CENTER_NOTE_GROUP_ID) return CENTER_NOTE_MIN;
  const group = layout.groups[groupId];
  return Math.max(
    TOOL_GROUP_MIN,
    ...(group?.tabs.map((tab) => tabMinimum(layout, tab, axis)) ?? []),
  );
}

function detachTab(layout: LayoutV1, group: LayoutGroup, tabId: string): LayoutTab | null {
  const index = group.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return null;
  const [tab] = group.tabs.splice(index, 1);
  if (!tab) return null;
  if (group.activeTabId === tab.id) {
    group.activeTabId = group.tabs[index]?.id ?? group.tabs[index - 1]?.id ?? null;
  }
  removeEmptyGroup(layout, group);
  return tab;
}

function canMoveTabToZone(layout: LayoutV1, tab: LayoutTab, zone: ZoneId): boolean {
  if (tab.kind === "note") return zone === "center";
  const panel = layout.panels[tab.panelId];
  return panel != null && PANEL_ALLOWED_ZONES[panel.type].includes(zone);
}

export function applyLayoutOperation(layout: LayoutV1, operation: LayoutOperation): LayoutV1 {
  if (operation.type === "cancel") return layout;
  if (operation.type === "reset") return createDefaultLayout(operation.legacyLeftWidth);
  const next = copyLayout(layout);
  let changed = false;

  switch (operation.type) {
    case "open-panel":
      changed = openPanel(
        next,
        operation.panelType,
        operation.zone,
        operation.groupId,
        operation.instanceId,
        operation.temporaryReturnZone,
      );
      break;
    case "activate-tab": {
      const group = next.groups[operation.groupId];
      if (group?.tabs.some((tab) => tab.id === operation.tabId)) {
        group.activeTabId = operation.tabId;
        next.focusedGroupId = group.id;
        const zone = zoneForGroup(next, group.id);
        if (zone) next.zones[zone].userCollapsed = false;
        changed = true;
      }
      break;
    }
    case "open-note": {
      const group = next.groups[CENTER_NOTE_GROUP_ID];
      if (!group || !operation.path) break;
      let tab = group.tabs.find(
        (candidate) => candidate.kind === "note" && candidate.path === operation.path,
      );
      if (!tab) {
        const ids = Object.fromEntries(
          Object.values(next.groups).flatMap((candidate) => candidate.tabs.map((item) => [item.id, true])),
        );
        tab = {
          id: uniqueId(`tab:note:${encodeURIComponent(operation.path)}`, ids),
          kind: "note",
          path: operation.path,
        };
        group.tabs.push(tab);
      }
      group.activeTabId = tab.id;
      next.focusedGroupId = group.id;
      changed = true;
      break;
    }
    case "close-tab":
      changed = closeTab(next, operation.groupId, operation.tabId);
      break;
    case "close-tabs": {
      const group = next.groups[operation.groupId];
      if (!group) break;
      const targets = new Set(operation.tabIds);
      const ordered = group.tabs.filter((tab) => targets.has(tab.id));
      for (const tab of ordered) closeTab(next, operation.groupId, tab.id);
      changed = ordered.length > 0;
      break;
    }
    case "prune-note-tabs": {
      const gone = (path: string) => operation.paths.some(
        (root) => path === root || path.startsWith(`${root}/`),
      );
      for (const group of Object.values(next.groups)) {
        for (const tab of [...group.tabs]) {
          if (tab.kind === "note" && gone(tab.path)) {
            closeTab(next, group.id, tab.id);
            changed = true;
          }
        }
      }
      break;
    }
    case "remap-note-tabs": {
      const remap = (path: string) => path === operation.from
        ? operation.to
        : path.startsWith(`${operation.from}/`)
          ? operation.to + path.slice(operation.from.length)
          : path;
      for (const group of Object.values(next.groups)) {
        const seen = new Set<string>();
        const tabs: LayoutTab[] = [];
        for (const tab of group.tabs) {
          if (tab.kind !== "note") {
            tabs.push(tab);
            continue;
          }
          const path = remap(tab.path);
          if (seen.has(path)) {
            if (group.activeTabId === tab.id) {
              group.activeTabId = tabs.find(
                (candidate) => candidate.kind === "note" && candidate.path === path,
              )?.id ?? group.activeTabId;
            }
            changed = true;
            continue;
          }
          seen.add(path);
          if (path !== tab.path) changed = true;
          tabs.push(path === tab.path ? tab : { ...tab, path });
        }
        group.tabs = tabs;
      }
      break;
    }
    case "clear-note-tabs": {
      for (const group of Object.values(next.groups)) {
        const noteIds = group.tabs.filter((tab) => tab.kind === "note").map((tab) => tab.id);
        for (const tabId of noteIds) closeTab(next, group.id, tabId);
        changed ||= noteIds.length > 0;
      }
      break;
    }
    case "reorder-tab": {
      const group = next.groups[operation.groupId];
      const from = group?.tabs.findIndex((tab) => tab.id === operation.tabId) ?? -1;
      if (group && from >= 0 && Number.isInteger(operation.toIndex)) {
        const to = Math.max(0, Math.min(group.tabs.length - 1, operation.toIndex));
        const [tab] = group.tabs.splice(from, 1);
        if (tab) group.tabs.splice(to, 0, tab);
        changed = from !== to;
      }
      break;
    }
    case "move-tab": {
      const from = next.groups[operation.fromGroupId];
      const to = next.groups[operation.toGroupId];
      const fromZone = zoneForGroup(next, operation.fromGroupId);
      const toZone = zoneForGroup(next, operation.toGroupId);
      const index = from?.tabs.findIndex((tab) => tab.id === operation.tabId) ?? -1;
      const tab = index >= 0 ? from?.tabs[index] : undefined;
      const panel = tab?.kind === "panel" ? next.panels[tab.panelId] : null;
      if (
        from && to && tab && from !== to && fromZone && toZone &&
        (tab.kind !== "note" || to.id === CENTER_NOTE_GROUP_ID) &&
        (!panel || PANEL_ALLOWED_ZONES[panel.type].includes(toZone)) &&
        !to.tabs.some((candidate) => candidate.id === tab.id)
      ) {
        from.tabs.splice(index, 1);
        const toIndex = Math.max(0, Math.min(to.tabs.length, operation.toIndex ?? to.tabs.length));
        to.tabs.splice(toIndex, 0, tab);
        to.activeTabId = tab.id;
        if (toZone === "left" || toZone === "right") next.zones[toZone].userCollapsed = false;
        if (from.activeTabId === tab.id) from.activeTabId = from.tabs[index]?.id ?? from.tabs[index - 1]?.id ?? null;
        removeEmptyGroup(next, from);
        next.focusedGroupId = to.id;
        changed = true;
      }
      break;
    }
    case "move-tab-to-zone": {
      const from = next.groups[operation.fromGroupId];
      const tab = from?.tabs.find((candidate) => candidate.id === operation.tabId);
      const zone = next.zones[operation.zone];
      if (from && tab && zone.groupIds.length === 0 && canMoveTabToZone(next, tab, operation.zone)) {
        const detached = detachTab(next, from, tab.id);
        if (!detached) break;
        const newId = uniqueId(`group:${operation.zone}:moved`, next.groups);
        next.groups[newId] = { id: newId, tabs: [detached], activeTabId: detached.id };
        zone.groupIds = [newId];
        zone.userCollapsed = false;
        next.focusedGroupId = newId;
        changed = true;
      }
      break;
    }
    case "split-tab": {
      const zone = next.zones[operation.zone];
      const target = next.groups[operation.targetGroupId];
      const from = next.groups[operation.fromGroupId];
      const tab = from?.tabs.find((candidate) => candidate.id === operation.tabId);
      if (!target || !from || !tab || !zone.groupIds.includes(target.id) ||
          tab.kind !== "panel" || !canSplitZone(operation.zone, zone, operation.axis) ||
          !canMoveTabToZone(next, tab, operation.zone)) break;
      // Moving a group's sole tab beside itself would manufacture an empty group.
      if (target === from && !from.permanent && from.tabs.length === 1) break;
      const movingMinimum = tabMinimum(next, tab, operation.axis);
      const targetMinimum = groupMinimum(next, target.id, operation.axis);
      const ratio = clampSplitRatio(
        operation.availableSize,
        0.5,
        operation.after === false ? movingMinimum : targetMinimum,
        operation.after === false ? targetMinimum : movingMinimum,
      );
      if (ratio == null) break;
      const heights = operation.zone === "right" && operation.axis === "y"
        ? Object.fromEntries(zone.groupIds.map((id, i) => [id, stackGroupSizes(zone, operation.availableSize)[i]!]))
        : undefined;
      const detached = detachTab(next, from, tab.id);
      if (!detached) break;
      const newId = uniqueId(`group:${operation.zone}:split`, next.groups);
      next.groups[newId] = { id: newId, tabs: [detached], activeTabId: detached.id };
      const targetIndex = zone.groupIds.indexOf(target.id);
      zone.groupIds.splice(operation.after === false ? targetIndex : targetIndex + 1, 0, newId);
      if (heights) {
        heights[newId] = heights[target.id]! / 2;
        heights[target.id] = heights[newId]!;
        zone.groupSizes = heights;
      }
      zone.axis = operation.axis;
      zone.ratio = ratio;
      zone.userCollapsed = false;
      next.focusedGroupId = newId;
      changed = true;
      break;
    }
    case "split-group":
      return applyLayoutOperation(layout, {
        ...operation, type: "split-tab", fromGroupId: operation.groupId, targetGroupId: operation.groupId,
      });
    case "join-zone": {
      const zone = next.zones[operation.zone];
      if (zone.groupIds.length < 2) break;
      const requested = operation.zone === "center" ? CENTER_NOTE_GROUP_ID : operation.targetGroupId;
      const targetId = requested && zone.groupIds.includes(requested) ? requested : zone.groupIds[0]!;
      const target = next.groups[targetId]!;
      for (const sourceId of zone.groupIds.filter(id => id !== targetId)) {
        const source = next.groups[sourceId]!;
        target.tabs.push(...source.tabs);
        if (next.focusedGroupId === sourceId) {
          target.activeTabId = source.activeTabId;
          next.focusedGroupId = targetId;
        }
        delete next.groups[sourceId];
      }
      zone.groupIds = [targetId];
      delete zone.groupSizes;
      changed = true;
      break;
    }
    case "swap-zone-groups": {
      const zone = next.zones[operation.zone];
      if (zone.groupIds.length === 2) {
        zone.groupIds = [zone.groupIds[1]!, zone.groupIds[0]!];
        zone.ratio = 1 - zone.ratio;
        changed = true;
      }
      break;
    }
    case "set-zone-collapsed":
      if (next.zones[operation.zone].groupIds.length > 0) {
        next.zones[operation.zone].userCollapsed = operation.collapsed;
        changed = true;
      }
      break;
    case "resize-zone":
      next.zones[operation.zone].preferredWidth = clampPreferredDockWidth(
        operation.zone,
        operation.width,
      );
      changed = next.zones[operation.zone].preferredWidth !== layout.zones[operation.zone].preferredWidth;
      break;
    case "set-split-ratio": {
      const zone = next.zones[operation.zone];
      if (zone.groupIds.length === 2) {
        const ratio = clampSplitRatio(
          operation.availableSize,
          operation.ratio,
          groupMinimum(next, zone.groupIds[0]!, zone.axis),
          groupMinimum(next, zone.groupIds[1]!, zone.axis),
        );
        if (ratio != null) {
          zone.ratio = ratio;
          changed = true;
        }
      }
      break;
    }
    case "resize-stack-pair": {
      const zone = next.zones.right;
      const index = operation.index;
      if (zone.axis !== "y" || !Number.isInteger(index) || index < 0 || index >= zone.groupIds.length - 1 || !Number.isFinite(operation.size)) break;
      const sizes = stackGroupSizes(zone, operation.availableSize);
      const pair = sizes[index]! + sizes[index + 1]!;
      sizes[index] = Math.min(pair - GROUP_HEIGHT_MIN, Math.max(GROUP_HEIGHT_MIN, operation.size));
      sizes[index + 1] = pair - sizes[index]!;
      zone.groupSizes = Object.fromEntries(zone.groupIds.map((id, i) => [id, sizes[i]!]));
      changed = true;
      break;
    }
    case "focus-group":
      if (next.groups[operation.groupId] && next.focusedGroupId !== operation.groupId) {
        next.focusedGroupId = operation.groupId;
        changed = true;
      }
      break;
  }

  return changed ? next : layout;
}

export function findPanelTab(layout: LayoutV1, type: PanelType) {
  const panel = Object.values(layout.panels).find((candidate) => candidate.type === type);
  if (!panel) return null;
  const location = panelLocation(layout, panel.id);
  return location ? { ...location, panel } : null;
}

/**
 * Whether a panel is not just its group's active tab but actually the one
 * on screen right now. A left/right zone can hold two groups without room to
 * split them side by side (`DockZone`'s `is-temporarily-hidden`), in which
 * case only the zone's `focusedGroupId` group renders — a panel can be
 * "active" within its own (hidden) group while a sibling group is what the
 * user actually sees. The rail (`ActivityBar`) needs this distinction: a
 * tab-active-but-hidden panel must be brought to front on click, not treated
 * as already open and collapsed.
 */
export function isPanelVisible(layout: LayoutV1, type: PanelType): boolean {
  const found = findPanelTab(layout, type);
  if (!found) return false;
  const group = layout.groups[found.groupId];
  if (group?.activeTabId !== found.tab.id) return false;
  const zoneId = zoneForGroup(layout, found.groupId);
  if (!zoneId) return false;
  const siblings = layout.zones[zoneId].groupIds;
  return (zoneId === "right" && layout.zones.right.axis === "y") ||
    siblings.length <= 1 || layout.focusedGroupId === found.groupId;
}
