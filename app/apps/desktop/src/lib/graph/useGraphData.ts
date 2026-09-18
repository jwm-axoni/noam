import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useStore } from "../../store";
import { graphDataStore, type GraphDataSnapshot } from "./graphDataStore";

export interface GraphDataState extends GraphDataSnapshot {
  refresh: () => void;
}

/**
 * Loads the note link-graph and keeps it live. It rebuilds on three triggers:
 *  1. mount,
 *  2. the open vault or its indexed note count changing — so the graph reflects
 *     the current vault even if this hook mounted before the index was ready
 *     (e.g. right after a vault switch or an app reload; otherwise the first,
 *     empty build would stick, since a view-only session fires no edits), and
 *  3. `file-changed` from the Rust watcher, debounced, for live edits — as a
 *     DELTA when the batch only modified notes the graph already has (#83):
 *     re-query those notes' titles + edges and patch them in, instead of
 *     re-reading every title and every edge in the vault per keystroke egest.
 *     Removals, structural changes and unknown notes still take the full build.
 */
export function useGraphData(): GraphDataState {
  const vaultKey = useStore((s) => s.vault?.path ?? "");
  const vaultEpoch = useStore((s) => s.vault?.epoch ?? 0);
  const noteCount = useStore((s) => s.titles.length);
  const scope = useMemo(() => ({ vaultKey, vaultEpoch }), [vaultKey, vaultEpoch]);
  const subscribe = useCallback(
    (listener: () => void) => graphDataStore.subscribe(scope, listener),
    [scope],
  );
  const getSnapshot = useCallback(() => graphDataStore.getSnapshot(scope), [scope]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    graphDataStore.ensure(scope, noteCount);
  }, [scope, noteCount]);
  const refresh = useCallback(() => graphDataStore.refresh(scope), [scope]);
  return { ...snapshot, refresh };
}
