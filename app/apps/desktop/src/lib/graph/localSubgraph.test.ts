import { describe, expect, it } from "vitest";
import type { Graph } from "./buildGraph";
import { selectLocalSubgraph } from "./localSubgraph";

const graph: Graph = {
  nodes: [
    { id: "a", path: "Notes/A.md", title: "A", type: null, linkCount: 1 },
    { id: "b", path: "Notes/B.md", title: "B", type: null, linkCount: 2 },
    { id: "c", path: "Notes/C.md", title: "C", type: null, linkCount: 2 },
    { id: "d", path: "Notes/D.md", title: "D", type: null, linkCount: 1 },
    { id: "orphan", path: "Notes/Orphan.md", title: "Orphan", type: null, linkCount: 0 },
  ],
  edges: [
    { source: "a", target: "b" },
    { source: "c", target: "b" },
    { source: "c", target: "d" },
  ],
};

describe("selectLocalSubgraph", () => {
  it("includes links and backlinks at depth one", () => {
    const local = selectLocalSubgraph(graph, "notes/b.md", 1);

    expect(local?.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(local?.edges).toEqual([
      { source: "a", target: "b" },
      { source: "c", target: "b" },
    ]);
  });

  it("expands through the first neighborhood at depth two", () => {
    const local = selectLocalSubgraph(graph, "Notes/B.md", 2);

    expect(local?.nodes.map((node) => node.id)).toEqual(["a", "b", "c", "d"]);
    expect(local?.edges).toEqual([
      { source: "a", target: "b" },
      { source: "c", target: "b" },
      { source: "c", target: "d" },
    ]);
  });

  it("returns the current note alone when it has no links", () => {
    expect(selectLocalSubgraph(graph, "Notes/Orphan.md", 1)).toEqual({
      nodes: [graph.nodes[4]],
      edges: [],
    });
  });

  it("returns null when the current note is not in the graph", () => {
    expect(selectLocalSubgraph(graph, "Notes/Missing.md", 1)).toBeNull();
  });
});
