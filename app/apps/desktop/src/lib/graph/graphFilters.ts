import type { GraphScope } from "./graphSettings";

export interface GraphFilterSettings {
  minDegree: number;
  hideOrphans: boolean;
}

/** Apply the graph's degree filters to any scope's candidate node set. */
export function filterGraphNodes<T extends { linkCount: number }>(
  candidates: readonly T[],
  settings: GraphFilterSettings,
): T[] {
  return candidates.filter(
    (node) =>
      !(settings.hideOrphans && node.linkCount === 0) &&
      node.linkCount >= settings.minDegree,
  );
}

interface EmptyStateInput {
  loading: boolean;
  error: string | null;
  graphLoaded: boolean;
  retryingEmpty: boolean;
  scope: GraphScope;
  nodeCount: number;
  edgeCount: number;
}

/** Whether the existing graph empty state should cover the canvas. */
export function shouldShowGraphEmptyState(input: EmptyStateInput): boolean {
  return (
    !input.loading &&
    !input.error &&
    input.graphLoaded &&
    !input.retryingEmpty &&
    (input.nodeCount === 0 ||
      (input.scope === "local" && input.nodeCount === 1 && input.edgeCount === 0))
  );
}

export type LocalGraphEmptyReason =
  | "no-note"
  | "missing"
  | "filtered"
  | "unlinked"
  | null;

interface LocalEmptyReasonInput {
  hasOpenNote: boolean;
  currentNoteFound: boolean;
  /** Local edges before filters remove either endpoint. */
  preFilterEdgeCount: number;
  nodeCount: number;
  edgeCount: number;
}

/** Explain why Current note scope has no connected graph to draw. */
export function localGraphEmptyReason(
  input: LocalEmptyReasonInput,
): LocalGraphEmptyReason {
  if (!input.hasOpenNote) return "no-note";
  if (input.nodeCount === 0) {
    return input.currentNoteFound ? "filtered" : "missing";
  }
  if (input.nodeCount === 1 && input.edgeCount === 0) {
    return input.preFilterEdgeCount > 0 ? "filtered" : "unlinked";
  }
  return null;
}
