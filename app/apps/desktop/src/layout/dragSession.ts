import type { SplitAxis, ZoneId } from "./types";

export type WorkspaceDragKind = "panel" | "file";

export interface DockDragSource {
  tabId: string;
  groupId: string;
  label: string;
}

export type DockDropTarget =
  | { kind: "tabs"; zone: ZoneId; groupId: string; index: number }
  | {
      kind: "split";
      zone: ZoneId;
      groupId: string;
      axis: SplitAxis;
      after: boolean;
      edge: "top" | "right" | "bottom" | "left";
      availableSize: number;
    }
  | { kind: "zone"; zone: "left" | "right" };

export interface DockDragSnapshot {
  source: DockDragSource | null;
  target: DockDropTarget | null;
  clientX: number;
  clientY: number;
}

const EMPTY: DockDragSnapshot = {
  source: null,
  target: null,
  clientX: 0,
  clientY: 0,
};

let snapshot = EMPTY;
let activeKind: WorkspaceDragKind | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Shared with the file tree and Tauri drop bridge so pointer drags cannot mix. */
export function getWorkspaceDragKind(): WorkspaceDragKind | null {
  return activeKind;
}

export function claimWorkspaceDrag(kind: WorkspaceDragKind): boolean {
  if (activeKind != null && activeKind !== kind) return false;
  activeKind = kind;
  return true;
}

export function releaseWorkspaceDrag(kind: WorkspaceDragKind): void {
  if (activeKind === kind) activeKind = null;
  if (kind === "panel" && snapshot.source) {
    snapshot = EMPTY;
    emit();
  }
}

export function beginDockDrag(source: DockDragSource, clientX: number, clientY: number): boolean {
  if (!claimWorkspaceDrag("panel")) return false;
  snapshot = { source, target: null, clientX, clientY };
  emit();
  return true;
}

export function updateDockDrag(
  clientX: number,
  clientY: number,
  target: DockDropTarget | null,
): void {
  if (!snapshot.source) return;
  snapshot = { ...snapshot, clientX, clientY, target };
  emit();
}

export function finishDockDrag(): DockDragSnapshot {
  const finished = snapshot;
  snapshot = EMPTY;
  if (activeKind === "panel") activeKind = null;
  emit();
  return finished;
}

export function cancelDockDrag(): void {
  snapshot = EMPTY;
  if (activeKind === "panel") activeKind = null;
  emit();
}

export function subscribeDockDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDockDragSnapshot(): DockDragSnapshot {
  return snapshot;
}

