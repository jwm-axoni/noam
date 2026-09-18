import { panelRegistry } from "../../layout/panelRegistry";
import { useDockDrag } from "../../layout/useDockDrag";
import { useLayoutStore } from "../../layout/store";

export function DockTabBar({ groupId }: { groupId: string }) {
  const group = useLayoutStore((state) => state.layout.groups[groupId]);
  const panels = useLayoutStore((state) => state.layout.panels);
  if (!group) return null;

  return (
    <div className="workspace-dock-tabs" role="tablist" aria-label="Dock panels">
      {group.tabs.map((tab) => {
        if (tab.kind !== "panel") return null;
        const panel = panels[tab.panelId];
        if (!panel) return null;
        return (
          <DockTab
            key={tab.id}
            groupId={groupId}
            tabId={tab.id}
            label={panelRegistry[panel.type].label}
            icon={panelRegistry[panel.type].icon}
            active={group.activeTabId === tab.id}
          />
        );
      })}
    </div>
  );
}

function DockTab({
  groupId,
  tabId,
  label,
  icon,
  active,
}: {
  groupId: string;
  tabId: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
}) {
  const drag = useDockDrag({ groupId, tabId, label });
  return (
    <button
      type="button"
      className={`workspace-dock-tab${active ? " active" : ""}`}
      role="tab"
      aria-selected={active}
      data-dock-tab-id={tabId}
      title={label}
      onPointerDown={drag.onPointerDown}
      onClick={() => useLayoutStore.getState().dispatch({ type: "activate-tab", groupId, tabId })}
    >
      <span className="workspace-dock-tab-icon" aria-hidden="true">{icon}</span>
      <span className="workspace-dock-tab-label">{label}</span>
    </button>
  );
}

