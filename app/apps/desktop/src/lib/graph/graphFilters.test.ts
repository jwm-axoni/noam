import { afterEach, describe, expect, it } from "vitest";
import type { Graph } from "./buildGraph";
import {
  filterGraphNodes,
  localGraphEmptyReason,
  shouldShowGraphEmptyState,
} from "./graphFilters";
import { loadSettings, SETTINGS_STORAGE_KEY } from "./graphSettings";
import { selectLocalSubgraph } from "./localSubgraph";

const graph: Graph = {
  nodes: [
    { id: "a", path: "Notes/A.md", title: "A", type: null, linkCount: 1 },
    { id: "b", path: "Notes/B.md", title: "B", type: null, linkCount: 2 },
    { id: "c", path: "Notes/C.md", title: "C", type: null, linkCount: 2 },
    { id: "d", path: "Notes/D.md", title: "D", type: null, linkCount: 1 },
    {
      id: "orphan",
      path: "Notes/Orphan.md",
      title: "Orphan",
      type: null,
      linkCount: 0,
    },
  ],
  edges: [
    { source: "a", target: "b" },
    { source: "c", target: "b" },
    { source: "c", target: "d" },
  ],
};

const degreeFiveHub: Graph = {
  nodes: [
    { id: "hub", path: "Notes/Hub.md", title: "Hub", type: null, linkCount: 5 },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `leaf-${index + 1}`,
      path: `Notes/Leaf ${index + 1}.md`,
      title: `Leaf ${index + 1}`,
      type: null,
      linkCount: 1,
    })),
  ],
  edges: Array.from({ length: 5 }, (_, index) => ({
    source: "hub",
    target: `leaf-${index + 1}`,
  })),
};

function storage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  });
}

afterEach(() => Reflect.deleteProperty(globalThis, "localStorage"));

describe("graph scope filters", () => {
  it("bounds current-note candidates by depth before applying Min links", () => {
    const local = selectLocalSubgraph(graph, "Notes/B.md", 1)!;

    expect(
      filterGraphNodes(local.nodes, { minDegree: 2, hideOrphans: false }).map(
        (node) => node.id,
      ),
    ).toEqual(["b", "c"]);
  });

  it("applies Hide unlinked to an orphan in Current note scope", () => {
    const local = selectLocalSubgraph(graph, "Notes/Orphan.md", 1)!;

    expect(
      filterGraphNodes(local.nodes, { minDegree: 0, hideOrphans: true }),
    ).toEqual([]);
  });

  it("shows the existing empty state when filters remove every local candidate", () => {
    const local = selectLocalSubgraph(graph, "Notes/B.md", 1)!;
    const visible = filterGraphNodes(local.nodes, { minDegree: 3, hideOrphans: false });

    expect(visible).toEqual([]);
    expect(
      shouldShowGraphEmptyState({
        loading: false,
        error: null,
        graphLoaded: true,
        retryingEmpty: false,
        scope: "local",
        nodeCount: visible.length,
        edgeCount: 0,
      }),
    ).toBe(true);
  });

  it("explains a linked hub reduced to one node by Min links", () => {
    const local = selectLocalSubgraph(degreeFiveHub, "Notes/Hub.md", 1)!;
    const visible = filterGraphNodes(local.nodes, {
      minDegree: 2,
      hideOrphans: false,
    });
    const visibleIds = new Set(visible.map((node) => node.id));
    const visibleEdges = local.edges.filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    );

    expect(visible.map((node) => node.id)).toEqual(["hub"]);
    expect(visibleEdges).toEqual([]);
    expect(
      localGraphEmptyReason({
        hasOpenNote: true,
        currentNoteFound: true,
        preFilterEdgeCount: local.edges.length,
        nodeCount: visible.length,
        edgeCount: visibleEdges.length,
      }),
    ).toBe("filtered");
  });

  it("keeps a genuinely unlinked current note distinct", () => {
    const local = selectLocalSubgraph(graph, "Notes/Orphan.md", 1)!;

    expect(
      localGraphEmptyReason({
        hasOpenNote: true,
        currentNoteFound: true,
        preFilterEdgeCount: local.edges.length,
        nodeCount: local.nodes.length,
        edgeCount: local.edges.length,
      }),
    ).toBe("unlinked");
  });

  it("keeps the zero-node filtered state", () => {
    expect(
      localGraphEmptyReason({
        hasOpenNote: true,
        currentNoteFound: true,
        preFilterEdgeCount: 3,
        nodeCount: 0,
        edgeCount: 0,
      }),
    ).toBe("filtered");
  });

  it("keeps the missing-note state", () => {
    expect(
      localGraphEmptyReason({
        hasOpenNote: true,
        currentNoteFound: false,
        preFilterEdgeCount: 0,
        nodeCount: 0,
        edgeCount: 0,
      }),
    ).toBe("missing");
  });

  it("keeps the no-note state", () => {
    expect(
      localGraphEmptyReason({
        hasOpenNote: false,
        currentNoteFound: false,
        preFilterEdgeCount: 0,
        nodeCount: 0,
        edgeCount: 0,
      }),
    ).toBe("no-note");
  });

  it("applies reloaded local-scope preferences", () => {
    storage({
      [`${SETTINGS_STORAGE_KEY}:panel:graph`]: JSON.stringify({
        scope: "local",
        localDepth: 2,
        minDegree: 2,
        hideOrphans: true,
      }),
    });
    const settings = loadSettings("panel:graph");
    const local = selectLocalSubgraph(graph, "Notes/B.md", settings.localDepth)!;

    expect(settings).toMatchObject({
      scope: "local",
      localDepth: 2,
      minDegree: 2,
      hideOrphans: true,
    });
    expect(filterGraphNodes(local.nodes, settings).map((node) => node.id)).toEqual([
      "b",
      "c",
    ]);
  });

  it("keeps Vault scope's degree and orphan semantics unchanged", () => {
    expect(
      filterGraphNodes(graph.nodes, { minDegree: 2, hideOrphans: false }).map(
        (node) => node.id,
      ),
    ).toEqual(["b", "c"]);
    expect(
      filterGraphNodes(graph.nodes, { minDegree: 0, hideOrphans: true }).map(
        (node) => node.id,
      ),
    ).toEqual(["a", "b", "c", "d"]);
    expect(
      shouldShowGraphEmptyState({
        loading: false,
        error: null,
        graphLoaded: true,
        retryingEmpty: false,
        scope: "global",
        nodeCount: 1,
        edgeCount: 0,
      }),
    ).toBe(false);
  });
});
