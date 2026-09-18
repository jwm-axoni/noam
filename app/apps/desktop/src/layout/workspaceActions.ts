import { applyLayoutOperation } from "./operations";
import { useLayoutStore } from "./store";
import {
  CENTER_NOTE_GROUP_ID,
  type LayoutTab,
  type LayoutV1,
  type SplitAxis,
} from "./types";
import { navigationHistory } from "./navigationHistory";

export interface CloseTabsResult {
  closedNotePaths: string[];
  nextTab: LayoutTab | null;
}

export function documentTabs(layout: LayoutV1 = useLayoutStore.getState().layout) {
  return (layout.groups[CENTER_NOTE_GROUP_ID]?.tabs ?? []).filter(
    (tab): tab is Extract<LayoutTab, { kind: "note" }> => tab.kind === "note",
  );
}

export function commitSuccessfulNoteOpen(path: string): void {
  useLayoutStore.getState().dispatch({ type: "open-note", path });
  navigationHistory.commit(path);
}

function closeTabs(groupId: string, tabIds: string[]): CloseTabsResult {
  const store = useLayoutStore.getState();
  const group = store.layout.groups[groupId];
  if (!group || tabIds.length === 0) return { closedNotePaths: [], nextTab: null };
  const targets = new Set(tabIds);
  const closedNotePaths = group.tabs.flatMap((tab) =>
    targets.has(tab.id) && tab.kind === "note" ? [tab.path] : [],
  );
  const first = Math.min(...group.tabs.flatMap((tab, index) => targets.has(tab.id) ? [index] : []));
  const next = applyLayoutOperation(store.layout, { type: "close-tabs", groupId, tabIds });
  store.replace(next);
  const nextGroup = next.groups[groupId];
  const nextTab = nextGroup?.tabs.find((tab) => tab.id === nextGroup.activeTabId)
    ?? nextGroup?.tabs[Math.min(first, Math.max(0, nextGroup.tabs.length - 1))]
    ?? null;
  return { closedNotePaths, nextTab };
}

export function closeNoteTab(path: string): CloseTabsResult {
  const layout = useLayoutStore.getState().layout;
  for (const group of Object.values(layout.groups)) {
    const tab = group.tabs.find((candidate) => candidate.kind === "note" && candidate.path === path);
    if (tab) return closeTabs(group.id, [tab.id]);
  }
  return { closedNotePaths: [], nextTab: null };
}

export function closeOtherTabs(groupId: string, tabId: string): CloseTabsResult {
  const group = useLayoutStore.getState().layout.groups[groupId];
  return closeTabs(groupId, group?.tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id) ?? []);
}

export function closeTabsToRight(groupId: string, tabId: string): CloseTabsResult {
  const group = useLayoutStore.getState().layout.groups[groupId];
  const index = group?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
  return closeTabs(groupId, index < 0 ? [] : group!.tabs.slice(index + 1).map((tab) => tab.id));
}

export function closeAllTabs(groupId: string): CloseTabsResult {
  const group = useLayoutStore.getState().layout.groups[groupId];
  return closeTabs(groupId, group?.tabs.map((tab) => tab.id) ?? []);
}

export function pruneDocumentTabs(paths: string[]): void {
  useLayoutStore.getState().dispatch({ type: "prune-note-tabs", paths });
  navigationHistory.prune(paths);
}

export function remapDocumentTabs(from: string, to: string): void {
  useLayoutStore.getState().dispatch({ type: "remap-note-tabs", from, to });
  navigationHistory.remap(from, to);
}

export function resetDocumentTabs(): void {
  useLayoutStore.getState().dispatch({ type: "clear-note-tabs" });
  navigationHistory.reset();
}

/** Collapse a side track first, keeping its content mounted but inert until the
 * grid reports that the animated track reached zero. */
export function closePanelTab(groupId: string, tabId: string): Promise<void> {
  const store = useLayoutStore.getState();
  const layout = store.layout;
  const zone = (["left", "center", "right"] as const).find((candidate) =>
    layout.zones[candidate].groupIds.includes(groupId),
  );
  const group = layout.groups[groupId];
  const isLastSideContent = (zone === "left" || zone === "right") &&
    layout.zones[zone].groupIds.length === 1 && group?.tabs.length === 1;
  if (!isLastSideContent || !zone) {
    store.dispatch({ type: "close-tab", groupId, tabId });
    return Promise.resolve();
  }

  const panel = document.querySelector<HTMLElement>(`[data-dock-group-id="${CSS.escape(groupId)}"]`);
  if (panel) {
    panel.inert = true;
    panel.dataset.closing = "true";
  }
  const shell = panel?.closest<HTMLElement>(".workspace-shell") ?? null;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  return new Promise((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      shell?.removeEventListener("transitionend", onTransitionEnd);
      useLayoutStore.getState().dispatch({ type: "close-tab", groupId, tabId });
      resolve();
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName === "grid-template-columns") finish();
    };
    shell?.addEventListener("transitionend", onTransitionEnd);
    store.dispatch({ type: "set-zone-collapsed", zone, collapsed: true });
    if (reduceMotion || !shell) queueMicrotask(finish);
    else timer = setTimeout(finish, 240);
  });
}

export type TilingAction = "single" | "split-right" | "split-below" | "swap" | "join";

export interface TilingAvailability {
  action: TilingAction;
  enabled: boolean;
  reason?: string;
}

export const NOTE_SPLIT_LIMIT = "Two notes cannot occupy separate live editor groups in this release.";

export function tilingAvailability(layout: LayoutV1): TilingAvailability[] {
  const zone = layout.zones.center;
  const focusedId = zone.groupIds.includes(layout.focusedGroupId)
    ? layout.focusedGroupId
    : CENTER_NOTE_GROUP_ID;
  const group = layout.groups[focusedId];
  const active = group?.tabs.find((tab) => tab.id === group.activeTabId);
  const canSplit = zone.groupIds.length === 1 && active?.kind === "panel";
  const noteReason = active?.kind === "note" ? NOTE_SPLIT_LIMIT : "Select a tool tab to split.";
  return [
    { action: "single", enabled: zone.groupIds.length === 2 },
    { action: "split-right", enabled: canSplit, reason: canSplit ? undefined : noteReason },
    { action: "split-below", enabled: canSplit, reason: canSplit ? undefined : noteReason },
    { action: "swap", enabled: zone.groupIds.length === 2 },
    { action: "join", enabled: zone.groupIds.length === 2 },
  ];
}

export function applyTilingAction(
  action: TilingAction,
  availableSize: number,
  layout: LayoutV1 = useLayoutStore.getState().layout,
): LayoutV1 {
  const zone = layout.zones.center;
  const focusedId = zone.groupIds.includes(layout.focusedGroupId)
    ? layout.focusedGroupId
    : CENTER_NOTE_GROUP_ID;
  const group = layout.groups[focusedId];
  const active = group?.tabs.find((tab) => tab.id === group.activeTabId);
  if (action === "single" || action === "join") {
    return applyLayoutOperation(layout, { type: "join-zone", zone: "center" });
  }
  if (action === "swap") {
    return applyLayoutOperation(layout, { type: "swap-zone-groups", zone: "center" });
  }
  if (!active || active.kind !== "panel" || zone.groupIds.length !== 1) return layout;
  const axis: SplitAxis = action === "split-right" ? "x" : "y";
  return applyLayoutOperation(layout, {
    type: "split-group",
    zone: "center",
    groupId: group.id,
    tabId: active.id,
    axis,
    after: true,
    availableSize,
  });
}
