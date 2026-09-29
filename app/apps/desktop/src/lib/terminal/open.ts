// Opening, showing and hiding terminals from shortcuts and buttons.
//
// A new terminal opens in the bottom dock, under the note. From there it can
// be dragged into the center tab strip (full size) or the right dock; wherever
// it sits, these actions find it.

import { zoneForGroup } from "../../layout/operations";
import { useLayoutStore } from "../../layout/store";
import { PANEL_MULTIPLICITY, ZONE_IDS, type LayoutV1, type ZoneId } from "../../layout/types";
import { isTerminalTarget } from "./keys";
import { newTerminalInstanceId, requestSpawn } from "./lifecycle";

interface TerminalTab {
  panelId: string;
  groupId: string;
  tabId: string;
  zone: ZoneId;
}

/** Terminal panels in the layout, with the group and zone showing each. */
export function terminalTabs(layout: LayoutV1): TerminalTab[] {
  const out: TerminalTab[] = [];
  for (const zone of ZONE_IDS) {
    for (const groupId of layout.zones[zone].groupIds) {
      for (const tab of layout.groups[groupId]?.tabs ?? []) {
        if (tab.kind === "panel" && layout.panels[tab.panelId]?.type === "terminal") {
          out.push({ panelId: tab.panelId, groupId, tabId: tab.id, zone });
        }
      }
    }
  }
  return out;
}

export function focusTerminal(panelId: string): void {
  window.requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(`[data-terminal-id="${CSS.escape(panelId)}"] textarea`)
      ?.focus();
  });
}

function focusEditor(): void {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(".editor-host .cm-content")?.focus();
  });
}

/** Open a brand-new terminal in the bottom dock. Returns false at the panel limit. */
export function newTerminal(): boolean {
  const store = useLayoutStore.getState();
  if (terminalTabs(store.layout).length >= PANEL_MULTIPLICITY.terminal) return false;
  const instanceId = newTerminalInstanceId();
  // Mark the spawn BEFORE the panel exists: its first mount consumes this.
  requestSpawn(instanceId);
  store.dispatch({
    type: "open-panel",
    panelType: "terminal",
    zone: "bottom",
    groupId: store.layout.zones.bottom.groupIds[0],
    instanceId,
  });
  if (!useLayoutStore.getState().layout.panels[instanceId]) return false;
  focusTerminal(instanceId);
  return true;
}

/** Bring one terminal tab to the front of its group and focus it. */
function reveal(target: TerminalTab): void {
  const { dispatch } = useLayoutStore.getState();
  dispatch({ type: "activate-tab", groupId: target.groupId, tabId: target.tabId });
  if (target.zone !== "center") {
    dispatch({ type: "set-zone-collapsed", zone: target.zone, collapsed: false });
  }
  focusTerminal(target.panelId);
}

/**
 * Ctrl+` — the terminal toggle:
 *  - no terminal yet → open one in the bottom dock;
 *  - focus is in a terminal that sits in the bottom dock → hide the dock (the
 *    shell keeps running) and hand focus back to the note;
 *  - otherwise → show and focus a terminal, preferring the bottom dock's.
 */
export function toggleTerminal(focusTarget: EventTarget | null = document.activeElement): void {
  const { layout, dispatch } = useLayoutStore.getState();
  const tabs = terminalTabs(layout);
  if (tabs.length === 0) {
    newTerminal();
    return;
  }
  const bottom = layout.zones.bottom;
  const bottomShowing = bottom.groupIds.length > 0 && !bottom.userCollapsed;
  if (bottomShowing && isTerminalTarget(focusTarget) && focusedZone(focusTarget) === "bottom") {
    dispatch({ type: "set-zone-collapsed", zone: "bottom", collapsed: true });
    focusEditor();
    return;
  }
  const activeIn = (t: TerminalTab) => layout.groups[t.groupId]?.activeTabId === t.tabId;
  const target = tabs.find((t) => t.zone === "bottom" && activeIn(t)) ??
    tabs.find((t) => t.zone === "bottom") ??
    tabs.find((t) => t.groupId === layout.focusedGroupId) ??
    tabs[0]!;
  reveal(target);
}

/** The dock zone containing a focused element, read from the DOM. */
function focusedZone(target: EventTarget | null): ZoneId | null {
  const el = target as { closest?: (selector: string) => Element | null } | null;
  const host = typeof el?.closest === "function" ? el.closest("[data-dock-group-id]") : null;
  const groupId = host?.getAttribute("data-dock-group-id");
  return groupId ? zoneForGroup(useLayoutStore.getState().layout, groupId) : null;
}

/** Show the terminal the user had (the activity button), or start one. */
export function openOrFocusTerminal(): void {
  const { layout } = useLayoutStore.getState();
  const tabs = terminalTabs(layout);
  if (tabs.length === 0) {
    newTerminal();
    return;
  }
  const target = tabs.find((t) => t.zone === "bottom") ??
    tabs.find((t) => t.groupId === layout.focusedGroupId) ??
    tabs[0]!;
  reveal(target);
}
