import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChanged } from "../ipc";
import type { Graph } from "./buildGraph";
import { createGraphDataStore } from "./graphDataStore";

const graph = (id: string, type: string | null = null): Graph => ({
  nodes: [{ id, path: `${id}.md`, title: id, type, linkCount: 0 }],
  edges: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("graphDataStore", () => {
  beforeEach(() => vi.useFakeTimers());

  it("shares one build, cache, and file subscription across graph instances", async () => {
    let changes: ((batch: FileChanged[]) => void) | null = null;
    const stop = vi.fn();
    const build = vi.fn(async () => graph("a"));
    const store = createGraphDataStore({
      build,
      delta: vi.fn(async () => null),
      listen: vi.fn(async (handler) => { changes = handler; return stop; }),
      setTimer: setTimeout,
      clearTimer: clearTimeout,
    });
    const scope = { vaultKey: "/vault", vaultEpoch: 4 };
    const offA = store.subscribe(scope, vi.fn());
    const offB = store.subscribe(scope, vi.fn());
    store.ensure(scope, 1);
    store.ensure(scope, 1);
    await vi.runAllTimersAsync();

    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(4);
    expect(store.getSnapshot(scope).graph).toEqual(graph("a"));
    expect(changes).not.toBeNull();
    offA();
    expect(stop).not.toHaveBeenCalled();
    offB();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("drops a stale epoch response without contaminating the next vault", async () => {
    const old = deferred<Graph>();
    const build = vi.fn((epoch: number) => epoch === 1 ? old.promise : Promise.resolve(graph("new")));
    const store = createGraphDataStore({
      build,
      delta: vi.fn(async () => null),
      listen: vi.fn(async () => () => {}),
      setTimer: setTimeout,
      clearTimer: clearTimeout,
    });
    const first = { vaultKey: "/vault", vaultEpoch: 1 };
    const second = { vaultKey: "/vault", vaultEpoch: 2 };
    const off = store.subscribe(first, vi.fn());
    store.ensure(first, 1);
    off();
    store.subscribe(second, vi.fn());
    store.ensure(second, 1);
    await Promise.resolve();
    old.resolve(graph("old"));
    await Promise.resolve();

    expect(store.getSnapshot(second).graph).toEqual(graph("new"));
    expect(store.getSnapshot(first).graph).toBeNull();
  });

  it("applies metadata deltas and retains unchanged node types", async () => {
    let changes!: (batch: FileChanged[]) => void;
    const delta = vi.fn(async () => ({
      nodes: [{ id: "a", path: "a.md", title: "A2", type: "meeting" }],
      edges: [],
    }));
    const store = createGraphDataStore({
      build: vi.fn(async () => ({
        nodes: [
          { id: "a", path: "a.md", title: "A", type: "project", linkCount: 0 },
          { id: "b", path: "b.md", title: "B", type: "person", linkCount: 0 },
        ],
        edges: [],
      })),
      delta,
      listen: vi.fn(async (handler) => { changes = handler; return () => {}; }),
      setTimer: setTimeout,
      clearTimer: clearTimeout,
    });
    const scope = { vaultKey: "/vault", vaultEpoch: 3 };
    store.subscribe(scope, vi.fn());
    store.ensure(scope, 2);
    await Promise.resolve();
    changes([{ path: "a.md", kind: "modified" }]);
    await vi.advanceTimersByTimeAsync(250);

    const byId = new Map(store.getSnapshot(scope).graph!.nodes.map((node) => [node.id, node]));
    expect(byId.get("a")?.type).toBe("meeting");
    expect(byId.get("b")?.type).toBe("person");
    expect(delta).toHaveBeenCalledWith(["a.md"], 3);
  });
});
