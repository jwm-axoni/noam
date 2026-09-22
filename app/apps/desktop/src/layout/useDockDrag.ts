import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  beginDockDrag,
  cancelDockDrag,
  finishDockDrag,
  getWorkspaceDragKind,
  updateDockDrag,
  type DockDragSource,
  type DockDropTarget,
} from "./dragSession";
import { useLayoutStore } from "./store";
import { canSplitZone, type ZoneId } from "./types";

const DRAG_THRESHOLD = 6;

interface Probe {
  pointerId: number;
  clientX: number;
  clientY: number;
  source: DockDragSource;
  started: boolean;
}

function zoneId(value: string | undefined): ZoneId | null {
  return value === "left" || value === "center" || value === "right" ? value : null;
}

function targetAt(clientX: number, clientY: number, source: DockDragSource): DockDropTarget | null {
  const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  const empty = hit?.closest<HTMLElement>("[data-empty-zone]");
  const emptyZone = empty?.dataset.emptyZone;
  if (emptyZone === "left" || emptyZone === "right") {
    return { kind: "zone", zone: emptyZone };
  }

  const host = hit?.closest<HTMLElement>("[data-dock-group-id]");
  const groupId = host?.dataset.dockGroupId;
  const zone = zoneId(host?.closest<HTMLElement>("[data-zone]")?.dataset.zone);
  if (!host || !groupId || !zone) return null;

  const layout = useLayoutStore.getState().layout;
  const sourceTab = layout.groups[source.groupId]?.tabs.find((tab) => tab.id === source.tabId);
  const rect = host.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const edgeX = Math.min(44, rect.width * 0.22);
  const edgeY = Math.min(44, rect.height * 0.22);
  let edge: "top" | "right" | "bottom" | "left" | null = null;
  if (clientX - rect.left < edgeX) edge = "left";
  else if (rect.right - clientX < edgeX) edge = "right";
  else if (clientY - rect.top < edgeY) edge = "top";
  else if (rect.bottom - clientY < edgeY) edge = "bottom";

  if (edge) {
    if (sourceTab?.kind === "note") return null;
    const axis = edge === "left" || edge === "right" ? "x" : "y";
    if (!canSplitZone(zone, layout.zones[zone], axis)) return null;
    return {
      kind: "split",
      zone,
      groupId,
      axis: edge === "left" || edge === "right" ? "x" : "y",
      after: edge === "right" || edge === "bottom",
      edge,
      availableSize: axis === "y" && zone === "right"
        ? (host.closest<HTMLElement>("[data-zone]")?.clientHeight ?? rect.height)
        : axis === "x" ? rect.width : rect.height,
    };
  }

  const tabs = Array.from(host.querySelectorAll<HTMLElement>("[data-dock-tab-id]"));
  let index = tabs.length;
  for (let i = 0; i < tabs.length; i += 1) {
    const box = tabs[i]!.getBoundingClientRect();
    if (clientX < box.left + box.width / 2) {
      index = i;
      break;
    }
  }
  if (groupId === source.groupId) {
    const current = layout.groups[groupId]?.tabs.findIndex((tab) => tab.id === source.tabId) ?? -1;
    if (current >= 0 && index > current) index -= 1;
  }
  return { kind: "tabs", zone, groupId, index };
}

function commitDrop(source: DockDragSource, target: DockDropTarget | null): void {
  if (!target) return;
  const dispatch = useLayoutStore.getState().dispatch;
  if (target.kind === "tabs") {
    dispatch(target.groupId === source.groupId
      ? { type: "reorder-tab", groupId: source.groupId, tabId: source.tabId, toIndex: target.index }
      : {
          type: "move-tab",
          tabId: source.tabId,
          fromGroupId: source.groupId,
          toGroupId: target.groupId,
          toIndex: target.index,
        });
  } else if (target.kind === "split") {
    dispatch({
      type: "split-tab",
      zone: target.zone,
      targetGroupId: target.groupId,
      fromGroupId: source.groupId,
      tabId: source.tabId,
      axis: target.axis,
      after: target.after,
      availableSize: target.availableSize,
    });
  } else {
    dispatch({
      type: "move-tab-to-zone",
      zone: target.zone,
      fromGroupId: source.groupId,
      tabId: source.tabId,
    });
  }
}

export function useDockDrag(source: DockDragSource) {
  const probeRef = useRef<Probe | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const probe = probeRef.current;
      if (!probe || probe.pointerId !== event.pointerId) return;
      if (!probe.started) {
        if (Math.hypot(event.clientX - probe.clientX, event.clientY - probe.clientY) < DRAG_THRESHOLD) return;
        if (!beginDockDrag(probe.source, event.clientX, event.clientY)) {
          probeRef.current = null;
          return;
        }
        probe.started = true;
        document.body.setAttribute("data-panel-dragging", "true");
      }
      updateDockDrag(event.clientX, event.clientY, targetAt(event.clientX, event.clientY, probe.source));
    };
    const stop = (commit: boolean) => (event?: PointerEvent) => {
      const probe = probeRef.current;
      if (!probe || (event && probe.pointerId !== event.pointerId)) return;
      probeRef.current = null;
      document.body.removeAttribute("data-panel-dragging");
      if (!probe.started) return;
      if (commit) {
        const finished = finishDockDrag();
        commitDrop(probe.source, finished.target);
      } else cancelDockDrag();
    };
    const finishPointer = stop(true);
    const cancelPointer = stop(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && probeRef.current?.started) {
        event.preventDefault();
        cancelPointer();
      }
    };
    const onBlur = () => cancelPointer();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      if (probeRef.current?.started) cancelDockDrag();
      document.body.removeAttribute("data-panel-dragging");
    };
  }, [source.groupId, source.tabId, source.label]);

  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 || getWorkspaceDragKind() != null) return;
      if ((event.target as HTMLElement).closest("button[data-no-dock-drag], input, textarea")) return;
      probeRef.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        source,
        started: false,
      };
    },
  };
}
