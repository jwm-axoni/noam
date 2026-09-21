import type { Graph } from "./buildGraph";

const adjacencyCache = new WeakMap<Graph, Map<string, string[]>>();

function adjacencyOf(graph: Graph): Map<string, string[]> {
  const cached = adjacencyCache.get(graph);
  if (cached) return cached;

  const adjacency = new Map<string, string[]>();
  const connect = (from: string, to: string) => {
    const neighbors = adjacency.get(from);
    if (neighbors) neighbors.push(to);
    else adjacency.set(from, [to]);
  };
  for (const edge of graph.edges) {
    connect(edge.source, edge.target);
    connect(edge.target, edge.source);
  }
  adjacencyCache.set(graph, adjacency);
  return adjacency;
}

/** Node ids within `depth` link hops, following links and backlinks. */
export function neighborhoodIds(
  graph: Graph,
  startId: string,
  depth: number,
): Set<string> {
  const adjacency = adjacencyOf(graph);
  const selected = new Set<string>([startId]);
  let frontier = [startId];
  const hops = Math.max(1, Math.min(2, Math.trunc(depth)));
  for (let hop = 0; hop < hops && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (selected.has(neighbor)) continue;
        selected.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return selected;
}

/**
 * Select the current note and every note within `depth` link hops.
 * Wikilinks are directional in storage, but the graph neighborhood follows
 * both links and backlinks.
 */
export function selectLocalSubgraph(
  graph: Graph,
  currentPath: string,
  depth: number,
): Graph | null {
  const current = graph.nodes.find(
    (node) => node.path.toLowerCase() === currentPath.toLowerCase(),
  );
  if (!current) return null;

  const selected = neighborhoodIds(graph, current.id, depth);

  return {
    nodes: graph.nodes.filter((node) => selected.has(node.id)),
    edges: graph.edges.filter(
      (edge) => selected.has(edge.source) && selected.has(edge.target),
    ),
  };
}
