import { panelRegistry } from "../../layout/panelRegistry";
import { findPanelTab, isPanelVisible } from "../../layout/operations";
import { useLayoutStore } from "../../layout/store";
import type { PanelType } from "../../layout/types";
import { requestSearchInputFocus } from "../searchFocus";
import { VaultFooter } from "./VaultFooter";

interface ActivityBarProps {
  side: "left" | "right";
  historyAvailable?: boolean;
  onNewNote?: () => void;
  onPanelOpen?: (type: PanelType) => void;
}

const icon = (type: PanelType) => panelRegistry[type].icon;

export function ActivityBar({ side, historyAvailable = false, onNewNote, onPanelOpen }: ActivityBarProps) {
  const layout = useLayoutStore((state) => state.layout);
  const types: PanelType[] = side === "left"
    ? ["files", "search", "workflows", "tasks", "calendar"]
    : ["properties", "backlinks", "outline", "graph", ...(historyAvailable ? ["history" as const] : [])];

  const activate = (type: PanelType, button: HTMLButtonElement) => {
    const current = useLayoutStore.getState().layout;
    const found = findPanelTab(current, type);
    if (found) {
      const zone = (["left", "center", "right"] as const).find((id) =>
        current.zones[id].groupIds.includes(found.groupId));
      const active = isPanelVisible(current, type);
      if ((zone === "left" || zone === "right") && active && !current.zones[zone].userCollapsed) {
        useLayoutStore.getState().dispatch({ type: "set-zone-collapsed", zone, collapsed: true });
        button.focus();
        return;
      }
      useLayoutStore.getState().dispatch({ type: "activate-tab", groupId: found.groupId, tabId: found.tab.id });
      if (zone === "left" || zone === "right") {
        useLayoutStore.getState().dispatch({ type: "set-zone-collapsed", zone, collapsed: false });
      }
    } else {
      const registration = panelRegistry[type];
      useLayoutStore.getState().dispatch({ type: "open-panel", panelType: type, zone: registration.defaultZone });
    }
    onPanelOpen?.(type);
    if (type === "search") requestSearchInputFocus();
    window.requestAnimationFrame(() => {
      const selector = type === "search"
        ? '[data-panel-type="search"] .search-box'
        : `[data-panel-type="${type}"][data-panel-visible="true"]`;
      document.querySelector<HTMLElement>(selector)?.focus();
    });
  };

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
          const zone = found && (["left", "center", "right"] as const).find((id) => layout.zones[id].groupIds.includes(found.groupId));
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
      </div>
      {side === "left" && <VaultFooter />}
    </nav>
  );
}
