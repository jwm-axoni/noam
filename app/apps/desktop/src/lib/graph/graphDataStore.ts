import type { UnlistenFn } from "@tauri-apps/api/event";
import { onFilesChanged, type FileChanged } from "../ipc";
import {
  applyGraphDelta,
  buildGraph,
  fetchGraphDelta,
  type Graph,
  type GraphDelta,
} from "./buildGraph";

export const GRAPH_REBUILD_DEBOUNCE_MS = 250;

export interface GraphDataScope {
  vaultKey: string;
  vaultEpoch: number;
}

export interface GraphDataSnapshot {
  graph: Graph | null;
  loading: boolean;
  error: string | null;
}

export interface GraphDataDependencies {
  build: (epoch: number) => Promise<Graph>;
  delta: (paths: string[], epoch: number) => Promise<GraphDelta | null>;
  listen: (handler: (changes: FileChanged[]) => void) => Promise<UnlistenFn>;
  setTimer: (handler: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

interface Entry {
  scope: GraphDataScope;
  snapshot: GraphDataSnapshot;
  listeners: Set<() => void>;
  noteCount: number | null;
  requestId: number;
  inFlight: boolean;
  pendingPaths: Set<string> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const defaultDependencies: GraphDataDependencies = {
  build: buildGraph,
  delta: fetchGraphDelta,
  listen: onFilesChanged,
  setTimer: (handler, delay) => setTimeout(handler, delay),
  clearTimer: (timer) => clearTimeout(timer),
};

const keyOf = ({ vaultKey, vaultEpoch }: GraphDataScope) => `${vaultEpoch}:${vaultKey}`;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One cache and one watcher subscription for every mounted graph view. */
export function createGraphDataStore(deps: GraphDataDependencies = defaultDependencies) {
  const entries = new Map<string, Entry>();
  let liveSubscribers = 0;
  let listenGeneration = 0;
  let unlisten: UnlistenFn | null = null;

  const entryFor = (scope: GraphDataScope): Entry => {
    const key = keyOf(scope);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        scope: { ...scope },
        snapshot: { graph: null, loading: true, error: null },
        listeners: new Set(),
        noteCount: null,
        requestId: 0,
        inFlight: false,
        pendingPaths: new Set(),
        timer: null,
      };
      entries.set(key, entry);
    }
    return entry;
  };

  const notify = (entry: Entry) => {
    for (const listener of entry.listeners) listener();
  };
  const update = (entry: Entry, patch: Partial<GraphDataSnapshot>) => {
    entry.snapshot = { ...entry.snapshot, ...patch };
    notify(entry);
  };

  const fullBuild = async (entry: Entry, showLoading: boolean) => {
    const requestId = ++entry.requestId;
    entry.inFlight = true;
    if (showLoading) update(entry, { loading: true });
    try {
      const graph = await deps.build(entry.scope.vaultEpoch);
      if (requestId !== entry.requestId) return;
      entry.inFlight = false;
      update(entry, { graph, loading: false, error: null });
    } catch (error) {
      if (requestId !== entry.requestId) return;
      entry.inFlight = false;
      update(entry, { loading: false, error: messageOf(error) });
    }
  };

  const flush = async (entry: Entry) => {
    entry.timer = null;
    const paths = entry.pendingPaths;
    entry.pendingPaths = new Set();
    if (!paths || paths.size === 0 || !entry.snapshot.graph) {
      await fullBuild(entry, false);
      return;
    }
    const requestId = ++entry.requestId;
    entry.inFlight = true;
    try {
      const delta = await deps.delta([...paths], entry.scope.vaultEpoch);
      if (requestId !== entry.requestId) return;
      if (!delta) {
        entry.inFlight = false;
        await fullBuild(entry, false);
        return;
      }
      const next = applyGraphDelta(entry.snapshot.graph, delta);
      if (!next) {
        entry.inFlight = false;
        await fullBuild(entry, false);
        return;
      }
      entry.inFlight = false;
      update(entry, { graph: next, loading: false, error: null });
    } catch {
      if (requestId !== entry.requestId) return;
      entry.inFlight = false;
      await fullBuild(entry, false);
    }
  };

  const collect = (entry: Entry, changes: FileChanged[]) => {
    const pending = entry.pendingPaths;
    if (pending) {
      for (const change of changes) {
        if (change.kind !== "modified" || !change.path.toLowerCase().endsWith(".md")) {
          entry.pendingPaths = null;
          break;
        }
        pending.add(change.path);
      }
    }
    if (entry.timer) deps.clearTimer(entry.timer);
    entry.timer = deps.setTimer(() => void flush(entry), GRAPH_REBUILD_DEBOUNCE_MS);
  };

  const startListening = () => {
    const generation = ++listenGeneration;
    void deps.listen((changes) => {
      if (generation !== listenGeneration || changes.length === 0) return;
      for (const entry of entries.values()) {
        if (entry.listeners.size > 0) collect(entry, changes);
      }
    }).then((stop) => {
      if (generation !== listenGeneration || liveSubscribers === 0) stop();
      else unlisten = stop;
    });
  };

  return {
    getSnapshot(scope: GraphDataScope): GraphDataSnapshot {
      return entryFor(scope).snapshot;
    },
    subscribe(scope: GraphDataScope, listener: () => void): () => void {
      const entry = entryFor(scope);
      entry.listeners.add(listener);
      liveSubscribers += 1;
      if (liveSubscribers === 1) startListening();
      return () => {
        if (!entry.listeners.delete(listener)) return;
        liveSubscribers -= 1;
        if (entry.listeners.size === 0) {
          entry.requestId += 1;
          entry.inFlight = false;
          if (entry.timer) deps.clearTimer(entry.timer);
          entry.timer = null;
          entry.pendingPaths = new Set();
        }
        if (liveSubscribers === 0) {
          listenGeneration += 1;
          unlisten?.();
          unlisten = null;
        }
      };
    },
    ensure(scope: GraphDataScope, noteCount: number): void {
      const entry = entryFor(scope);
      const changed = entry.noteCount !== noteCount;
      entry.noteCount = noteCount;
      if ((entry.snapshot.graph == null || changed) && !entry.inFlight) {
        void fullBuild(entry, entry.snapshot.graph == null);
      }
    },
    refresh(scope: GraphDataScope): void {
      void fullBuild(entryFor(scope), true);
    },
    dispose(): void {
      listenGeneration += 1;
      unlisten?.();
      unlisten = null;
      for (const entry of entries.values()) {
        entry.requestId += 1;
        if (entry.timer) deps.clearTimer(entry.timer);
      }
      entries.clear();
      liveSubscribers = 0;
    },
  };
}

export const graphDataStore = createGraphDataStore();
