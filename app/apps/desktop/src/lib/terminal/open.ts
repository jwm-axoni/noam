// Opening terminals from shortcuts and buttons.
//
// T1 opens a new terminal as a tab in the center strip (full size, next to the
// notes). It can be dragged to the right dock like any center-capable panel.

import { useLayoutStore } from "../../layout/store";
import { CENTER_NOTE_GROUP_ID, PANEL_MULTIPLICITY, ZONE_IDS, type LayoutV1 } from "../../layout/types";
import { newTerminalInstanceId, requestSpawn } from "./lifecycle";

/** Terminal panels in the layout, with the group and zone showing each. */
function terminalTabs(layout: LayoutV1) {
  const out: Array<{ panelId: string; groupId: string; tabId: string; zone: (typeof ZONE_IDS)[number] }> = [];
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

/** Open a brand-new terminal tab. Returns false at the panel limit. */
export function newTerminal(): boolean {
  const store = useLayoutStore.getState();
  if (terminalTabs(store.layout).length >= PANEL_MULTIPLICITY.terminal) return false;
  const instanceId = newTerminalInstanceId();
  // Mark the spawn BEFORE the panel exists: its first mount consumes this.
  requestSpawn(instanceId);
  store.dispatch({
    type: "open-panel",
    panelType: "terminal",
    zone: "center",
    groupId: CENTER_NOTE_GROUP_ID,
    instanceId,
  });
  if (!useLayoutStore.getState().layout.panels[instanceId]) return false;
  focusTerminal(instanceId);
  return true;
}

/** Ctrl+`: show and focus the focused group's terminal (else the first one),
 *  or open a new one when there is none. */
export function openOrFocusTerminal(): void {
  const { layout, dispatch } = useLayoutStore.getState();
  const tabs = terminalTabs(layout);
  if (tabs.length === 0) {
    newTerminal();
    return;
  }
  const target = tabs.find((t) => t.groupId === layout.focusedGroupId) ?? tabs[0]!;
  dispatch({ type: "activate-tab", groupId: target.groupId, tabId: target.tabId });
  if (target.zone === "left" || target.zone === "right") {
    dispatch({ type: "set-zone-collapsed", zone: target.zone, collapsed: false });
  }
  focusTerminal(target.panelId);
}
