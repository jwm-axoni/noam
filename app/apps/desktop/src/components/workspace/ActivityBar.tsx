import { panelRegistry } from "../../layout/panelRegistry";
import { findPanelTab, isPanelVisible, zoneForGroup } from "../../layout/operations";
import { useLayoutStore } from "../../layout/store";
import type { PanelType } from "../../layout/types";
import { presenceV1Enabled } from "../../lib/presence/flag";
import { openOrFocusTerminal } from "../../lib/terminal/open";
import { requestSearchInputFocus } from "../searchFocus";
import { VaultFooter } from "./VaultFooter";

interface ActivityBarProps {
  side: "left" | "right";
  historyAvailable?: boolean;
  onNewNote?: () => void;
  onPanelOpen?: (type: PanelType) => void;
}

const icon = (type: PanelType) => panelRegistry[type].icon;

/**
 * Toggle a dock panel the way its activity button does: collapse its dock when
 * it is already showing there, otherwise reveal (or open) it and focus it.
 * Shared with keyboard shortcuts, which have no button to hand focus back to.
 */
export function togglePanel(
  type: PanelType,
  opts: { button?: HTMLElement | null; onPanelOpen?: (type: PanelType) => void } = {},
): void {
  const current = useLayoutStore.getState().layout;
  const found = findPanelTab(current, type);
  if (found) {
    const zone = zoneForGroup(current, found.groupId);
    const active = isPanelVisible(current, type);
    if (zone && zone !== "center" && active && !current.zones[zone].userCollapsed) {
      useLayoutStore.getState().dispatch({ type: "set-zone-collapsed", zone, collapsed: true });
      opts.button?.focus();
      return;
    }
    useLayoutStore.getState().dispatch({ type: "activate-tab", groupId: found.groupId, tabId: found.tab.id });
    if (zone && zone !== "center") {
      useLayoutStore.getState().dispatch({ type: "set-zone-collapsed", zone, collapsed: false });
    }
  } else {
    const registration = panelRegistry[type];
    useLayoutStore.getState().dispatch({ type: "open-panel", panelType: type, zone: registration.defaultZone });
  }
  opts.onPanelOpen?.(type);
  if (type === "search") requestSearchInputFocus();
  window.requestAnimationFrame(() => {
    const selector = type === "search"
      ? '[data-panel-type="search"] .search-box'
      : `[data-panel-type="${type}"][data-panel-visible="true"]`;
    document.querySelector<HTMLElement>(selector)?.focus();
  });
}

export function ActivityBar({ side, historyAvailable = false, onNewNote, onPanelOpen }: ActivityBarProps) {
  const layout = useLayoutStore((state) => state.layout);
  const types: PanelType[] = side === "left"
    ? ["files", "search", "workflows", "tasks", "calendar"]
    : [
        "properties", "backlinks", "outline", "graph",
        ...(presenceV1Enabled() ? ["presence" as const] : []),
        ...(historyAvailable ? ["history" as const] : []),
      ];

  const activate = (type: PanelType, button: HTMLButtonElement) =>
    togglePanel(type, { button, onPanelOpen });

  return (
    <nav
      className={`workspace-activity workspace-activity-${side}`}
      aria-label={`${side === "left" ? "Primary" : "Secondary"} tools`}
      data-empty-zone={layout.zones[side].groupIds.length === 0 ? side : undefined}
      data-tauri-drag-region
    >
      <div className="activity-tools">
        {side === "left" && (
          <button type="button" className="activity-button" title="New note" aria-label="New note" onClick={onNewNote}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h10l4 4v14H5Z" /><path d="M15 3v5h5M12 11v6M9 14h6" /></svg>
          </button>
        )}
        {types.map((type) => {
          const found = findPanelTab(layout, type);
          const zone = found && zoneForGroup(layout, found.groupId);
          const active = isPanelVisible(layout, type) &&
            (zone === "center" || (zone != null && !layout.zones[zone].userCollapsed));
          return (
            <button
              key={type}
              type="button"
              className={`activity-button${active ? " active" : ""}`}
              title={panelRegistry[type].label}
              aria-label={panelRegistry[type].label}
              aria-pressed={active}
              data-activity-panel={type}
              onClick={(event) => activate(type, event.currentTarget)}
            >
              {icon(type)}
            </button>
          );
        })}
        {side === "right" && (() => {
          // Shows the terminal you had (or starts one) rather than toggling:
          // hiding the bottom dock is its own chevron and Ctrl+`.
          const active = Object.entries(layout.groups).some(([groupId, group]) => {
            const tab = group.tabs.find((t) => t.id === group.activeTabId);
            if (tab?.kind !== "panel" || layout.panels[tab.panelId]?.type !== "terminal") return false;
            const zone = zoneForGroup(layout, groupId);
            return zone === "center" || (zone != null && !layout.zones[zone].userCollapsed);
          });
          return (
            <button
              type="button"
              className={`activity-button${active ? " active" : ""}`}
              title="Terminal (Ctrl+`)"
              aria-label="Terminal"
              data-activity-panel="terminal"
              onClick={() => openOrFocusTerminal()}
            >
              {icon("terminal")}
            </button>
          );
        })()}
      </div>
      {side === "left" && <VaultFooter />}
    </nav>
  );
}
