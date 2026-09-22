import { useEffect, useRef, useState } from "react";
import { useLayoutStore } from "../../layout/store";
import { PANEL_ALLOWED_ZONES, canSplitZone, type PanelType, type ZoneId } from "../../layout/types";
import { ViewportMenu } from "../ViewportMenu";

const ZONES: readonly ZoneId[] = ["left", "center", "right"];

function zoneLabel(zone: ZoneId): string {
  return zone === "center" ? "center" : `${zone} dock`;
}

function zoneSize(zone: ZoneId, axis: "x" | "y"): number {
  const element = document.querySelector<HTMLElement>(`.workspace-dock-${zone}`);
  return axis === "x" ? (element?.clientWidth ?? 0) : (element?.clientHeight ?? 0);
}

export function PanelMoveMenu({ groupId, tabId, panelType }: { groupId: string; tabId: string; panelType: PanelType }) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const layout = useLayoutStore((state) => state.layout);
  const sourceZone = ZONES.find((zone) => layout.zones[zone].groupIds.includes(groupId));
  const close = () => {
    detailsRef.current?.removeAttribute("open");
    setOpen(false);
  };
  const refocusSummary = () => summaryRef.current?.focus();
  const dispatch = useLayoutStore.getState().dispatch;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (detailsRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        refocusSummary();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!sourceZone) return null;

  const allowedZones = ZONES.filter((zone) => PANEL_ALLOWED_ZONES[panelType].includes(zone));

  const moveTo = (zone: ZoneId) => {
    const targetId = layout.zones[zone].groupIds[0];
    if (targetId) {
      if (targetId !== groupId) dispatch({
        type: "move-tab",
        tabId,
        fromGroupId: groupId,
        toGroupId: targetId,
      });
    } else if (zone !== "center") {
      dispatch({ type: "move-tab-to-zone", tabId, fromGroupId: groupId, zone });
    }
    close();
    refocusSummary();
  };

  const reorder = (direction: -1 | 1) => {
    const group = layout.groups[groupId];
    const current = group?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
    if (current < 0) return;
    dispatch({ type: "reorder-tab", groupId, tabId, toIndex: current + direction });
    close();
    refocusSummary();
  };

  const splitInto = (zone: ZoneId, edge: "left" | "right" | "top" | "bottom") => {
    const targetGroupId = layout.zones[zone].groupIds.includes(groupId) && (layout.groups[groupId]?.tabs.length ?? 0) > 1
      ? groupId : layout.zones[zone].groupIds[0];
    if (!targetGroupId) return;
    const axis = edge === "left" || edge === "right" ? "x" : "y";
    dispatch({
      type: "split-tab",
      zone,
      targetGroupId,
      fromGroupId: groupId,
      tabId,
      axis,
      after: edge === "right" || edge === "bottom",
      availableSize: zoneSize(zone, axis),
    });
    close();
    refocusSummary();
  };

  const tabs = layout.groups[groupId]?.tabs ?? [];
  const tabIndex = tabs.findIndex((tab) => tab.id === tabId);

  return (
    <>
      <details
        className="panel-move-menu"
        ref={detailsRef}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary
          ref={summaryRef}
          className="icon-btn workspace-panel-menu-button"
          title="Move or split panel"
          aria-label="Move or split panel"
          data-no-dock-drag
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.3" />
            <circle cx="12" cy="12" r="1.3" />
            <circle cx="19" cy="12" r="1.3" />
          </svg>
        </summary>
      </details>
      {open && (
        <ViewportMenu
          anchorRef={summaryRef}
          menuRef={menuRef}
          className="panel-move-popover"
          role="menu"
          aria-label="Move panel"
        >
          {tabs.length > 1 && (
            <>
              <span className="panel-move-heading">Reorder</span>
              <button
                type="button"
                role="menuitem"
                disabled={tabIndex <= 0}
                onClick={() => reorder(-1)}
              >
                Move tab left
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={tabIndex < 0 || tabIndex >= tabs.length - 1}
                onClick={() => reorder(1)}
              >
                Move tab right
              </button>
            </>
          )}
          <span className="panel-move-heading">Move as tab</span>
          {allowedZones.map((zone) => {
            const destination = layout.zones[zone];
            const disabled = zone === "center" && destination.groupIds.length === 0 ||
              (destination.groupIds.length === 1 && destination.groupIds[0] === groupId);
            return (
              <button key={zone} type="button" role="menuitem" disabled={disabled} onClick={() => moveTo(zone)}>
                Move to {zoneLabel(zone)}
              </button>
            );
          })}
          {layout.zones[sourceZone].groupIds.length === 2 && (
            <>
              <span className="panel-move-heading">Groups</span>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  dispatch({ type: "swap-zone-groups", zone: sourceZone });
                  close();
                  refocusSummary();
                }}
              >
                Swap group positions
              </button>
            </>
          )}
          <span className="panel-move-heading">Split into</span>
          {allowedZones.flatMap((zone) => {
            if (layout.zones[zone].groupIds.length === 0) return [];
            return (["left", "right", "top", "bottom"] as const)
              .filter(edge => canSplitZone(zone, layout.zones[zone], edge === "left" || edge === "right" ? "x" : "y"))
              .map((edge) => (
              <button
                key={`${zone}:${edge}`}
                type="button"
                role="menuitem"
                onClick={() => splitInto(zone, edge)}
              >
                {zoneLabel(zone)} — {edge}
              </button>
            ));
          })}
        </ViewportMenu>
      )}
    </>
  );
}
