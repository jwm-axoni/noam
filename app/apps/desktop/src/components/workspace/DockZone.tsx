import { Children, Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  CENTER_NOTE_MIN,
  GRAPH_GROUP_MIN,
  GROUP_HEIGHT_MIN,
  PANE_SEPARATOR_SIZE,
  TOOL_GROUP_MIN,
  fitZoneSplit,
  stackGroupSizes,
} from "../../layout/geometry";
import { useLayoutStore } from "../../layout/store";
import { CENTER_NOTE_GROUP_ID } from "../../layout/types";
import { getDockDragSnapshot, subscribeDockDrag } from "../../layout/dragSession";
import { PaneSeparator } from "./PaneSeparator";

export function DockZone({
  zoneId,
  children,
  className = "",
}: {
  zoneId: "left" | "center" | "right";
  children: ReactNode;
  className?: string;
}) {
  const hostRef = useRef<HTMLElement | null>(null);
  const layout = useLayoutStore((state) => state.layout);
  const drag = useSyncExternalStore(subscribeDockDrag, getDockDragSnapshot, getDockDragSnapshot);
  const zone = layout.zones[zoneId];
  const [size, setSize] = useState({ width: 0, height: 0 });
  const items = Children.toArray(children);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const groupMinimum = (groupId: string | undefined) => {
    if (zone.axis === "y") return GROUP_HEIGHT_MIN;
    if (groupId === CENTER_NOTE_GROUP_ID) return CENTER_NOTE_MIN;
    const group = groupId ? layout.groups[groupId] : null;
    const active = group?.tabs.find((tab) => tab.id === group.activeTabId) ?? group?.tabs[0];
    return active?.kind === "panel" && layout.panels[active.panelId]?.type === "graph"
      ? GRAPH_GROUP_MIN
      : TOOL_GROUP_MIN;
  };
  const splitFit = useMemo(() => fitZoneSplit({
    axis: zone.axis,
    width: size.width,
    height: size.height,
    ratio: zone.ratio,
    firstMinimum: groupMinimum(zone.groupIds[0]),
    secondMinimum: groupMinimum(zone.groupIds[1]),
  }), [zone.axis, zone.ratio, zone.groupIds, size.width, size.height, layout.groups, layout.panels]);
  const split = items.length === 2 && splitFit.split;
  const available = zone.axis === "x" ? size.width : size.height;
  const splitSpace = Math.max(0, available - PANE_SEPARATOR_SIZE);
  const firstSize = Math.round(splitSpace * splitFit.ratio);
  const firstMin = groupMinimum(zone.groupIds[0]);
  const secondMin = groupMinimum(zone.groupIds[1]);
  const focusedIndex = zone.groupIds.indexOf(layout.focusedGroupId);
  const visibleIndex = focusedIndex >= 0 ? focusedIndex : 0;
  const preview = (value: number) => {
    hostRef.current?.style.setProperty("--workspace-zone-first-size", `${value}px`);
  };
  if (zoneId === "right" && zone.axis === "y" && items.length > 1) {
    const heights = stackGroupSizes(zone, size.height);
    const style = Object.fromEntries(heights.map((height, i) => [`--workspace-stack-${i}`, `${height}px`])) as React.CSSProperties;
    const previewPair = (index: number, value: number) => {
      hostRef.current?.style.setProperty(`--workspace-stack-${index}`, `${value}px`);
      hostRef.current?.style.setProperty(`--workspace-stack-${index + 1}`, `${heights[index]! + heights[index + 1]! - value}px`);
    };
    return (
      <section ref={hostRef} className={`workspace-dock workspace-dock-right has-stack ${className}`.trim()}
        data-zone="right" style={style}>
        {items.map((item, index) => {
          const groupId = zone.groupIds[index]!;
          const pair = heights[index]! + (heights[index + 1] ?? 0);
          const focus = () => useLayoutStore.getState().dispatch({ type: "focus-group", groupId });
          return <Fragment key={groupId}>
            <div className="workspace-dock-group" data-dock-group-id={groupId}
              style={{ flex: `0 0 var(--workspace-stack-${index})` }}
              onPointerDownCapture={focus} onFocusCapture={focus}>
              {item}
              <DockMarker drag={drag} zoneId="right" groupId={groupId} />
            </div>
            {index < items.length - 1 && <PaneSeparator
              orientation="horizontal" value={heights[index]!} min={GROUP_HEIGHT_MIN}
              max={pair - GROUP_HEIGHT_MIN} defaultValue={pair / 2}
              label={`Resize right dock groups ${index + 1} and ${index + 2}`}
              className="workspace-zone-separator"
              onPreview={value => previewPair(index, value)}
              onCancel={() => previewPair(index, heights[index]!)}
              onCommit={value => useLayoutStore.getState().dispatch({
                type: "resize-stack-pair", zone: "right", index, size: value, availableSize: size.height,
              })} />}
          </Fragment>;
        })}
      </section>
    );
  }
  return (
    <section
      ref={hostRef}
      className={`workspace-dock workspace-dock-${zoneId} workspace-dock-axis-${zone.axis}${split ? " has-split" : ""} ${className}`.trim()}
      data-zone={zoneId}
      style={{ "--workspace-zone-first-size": `${firstSize}px` } as React.CSSProperties}
    >
      {items[0] != null && (
        <div
          className={`workspace-dock-group${!split && visibleIndex !== 0 ? " is-temporarily-hidden" : ""}`}
          key={zone.groupIds[0] ?? 0}
          data-dock-group-id={zone.groupIds[0]}
          onPointerDownCapture={() => {
            const groupId = zone.groupIds[0];
            if (groupId) useLayoutStore.getState().dispatch({ type: "focus-group", groupId });
          }}
          onFocusCapture={() => {
            const groupId = zone.groupIds[0];
            if (groupId) useLayoutStore.getState().dispatch({ type: "focus-group", groupId });
          }}
        >
          {items[0]}
          <DockMarker drag={drag} zoneId={zoneId} groupId={zone.groupIds[0]} />
        </div>
      )}
      {split && (
        <PaneSeparator
          orientation={zone.axis === "x" ? "vertical" : "horizontal"}
          value={firstSize}
          min={firstMin}
          max={Math.max(firstMin, splitSpace - secondMin)}
          defaultValue={Math.round(splitSpace / 2)}
          label={`Resize ${zoneId} dock groups`}
          className="workspace-zone-separator"
          onPreview={preview}
          onCommit={(value) => useLayoutStore.getState().dispatch({
            type: "set-split-ratio",
            zone: zoneId,
            ratio: splitSpace > 0 ? value / splitSpace : 0.5,
            availableSize: available,
          })}
          onCancel={() => preview(firstSize)}
        />
      )}
      {items[1] != null && (
        <div
          className={`workspace-dock-group${!split && visibleIndex !== 1 ? " is-temporarily-hidden" : ""}`}
          key={zone.groupIds[1] ?? 1}
          data-dock-group-id={zone.groupIds[1]}
          onPointerDownCapture={() => {
            const groupId = zone.groupIds[1];
            if (groupId) useLayoutStore.getState().dispatch({ type: "focus-group", groupId });
          }}
          onFocusCapture={() => {
            const groupId = zone.groupIds[1];
            if (groupId) useLayoutStore.getState().dispatch({ type: "focus-group", groupId });
          }}
        >
          {items[1]}
          <DockMarker drag={drag} zoneId={zoneId} groupId={zone.groupIds[1]} />
        </div>
      )}
    </section>
  );
}

function DockMarker({
  drag,
  zoneId,
  groupId,
}: {
  drag: ReturnType<typeof getDockDragSnapshot>;
  zoneId: "left" | "center" | "right";
  groupId: string | undefined;
}) {
  const target = drag.target;
  if (!drag.source || !target || !groupId) return null;
  if (target.kind === "zone" || target.zone !== zoneId || target.groupId !== groupId) return null;
  let insertion: { left: number; top: number; height: number } | null = null;
  if (target.kind === "tabs") {
    insertion = insertionGeometry(groupId, target.index);
  }
  return (
    <div
      className={`dock-drop-marker ${target.kind === "split" ? `edge-${target.edge}` : "merge"}`}
      aria-hidden="true"
    >
      {target.kind === "tabs" && insertion && (
        <span
          className="dock-insertion-marker"
          style={{
            left: `${insertion.left}px`,
            top: `${insertion.top}px`,
            height: `${insertion.height}px`,
          }}
        />
      )}
    </div>
  );
}

/** Geometry (relative to the group host) of the tab insertion bar. */
function insertionGeometry(
  groupId: string,
  index: number,
): { left: number; top: number; height: number } | null {
  if (typeof document === "undefined" || typeof CSS === "undefined") return null;
  const host = document.querySelector<HTMLElement>(
    `[data-dock-group-id="${CSS.escape(groupId)}"]`,
  );
  if (!host) return null;
  const hostRect = host.getBoundingClientRect();
  const tabs = Array.from(host.querySelectorAll<HTMLElement>("[data-dock-tab-id]"));
  const tab = tabs[Math.min(index, tabs.length - 1)];
  if (!tab) return null;
  const rect = tab.getBoundingClientRect();
  // Insert before the tab at `index`, or after the last tab when appending.
  const x = index >= tabs.length ? rect.right : rect.left;
  return {
    left: Math.max(0, x - hostRect.left - 1),
    top: Math.max(0, rect.top - hostRect.top + 2),
    height: Math.max(0, rect.height - 4),
  };
}
