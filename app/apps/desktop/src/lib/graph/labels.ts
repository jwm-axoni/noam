// Which node names get a persistent label, decided in SCREEN space.
//
// Names are readable at rest, not only on hover — but a vault with thousands of
// notes cannot show thousands of words, so the set is thinned by what actually
// COLLIDES on screen at the current zoom, never by note order. Zooming in
// spreads the nodes apart in screen pixels, so more labels survive the same
// test: that is the whole "more labels as you zoom in" behaviour, for free.
//
// Priority, highest first:
//   1. the open note        2. the hovered node       3. search matches
//   4. higher degree (better connected)               5. node id (stable)
// The first three are PINNED: they keep their label even where it overlaps, so
// the note you are reading and the notes you searched for never vanish into a
// dense region. Everything else yields to whatever ranks above it.
//
// Pure and deterministic: same nodes + same transform + same measurer ⇒ same
// set, regardless of the order the nodes arrive in.

export interface LabelNode {
  id: string;
  /** World (simulation) coordinates. */
  x: number;
  y: number;
  /** Connectivity — the tiebreak below the pinned ranks. */
  degree: number;
  /** World radius the node is DRAWN at (renderer scale already applied). */
  radius: number;
  title: string;
}

/** The camera the renderer paints with: screen_px = size/2 + pan + world·k. */
export interface LabelTransform {
  k: number;
  x: number;
  y: number;
  /** Viewport size in CSS px. */
  width: number;
  height: number;
}

export interface SelectLabelsOptions {
  transform: LabelTransform;
  /** Label width in SCREEN px. Renderers pass a cached ctx.measureText. */
  measure: (node: LabelNode) => number;
  /** Label line box height in screen px. */
  lineHeight?: number;
  /** Breathing room required around each label, screen px. */
  gap?: number;
  /** The open note: highest priority, never removed. */
  openId?: string | null;
  /** The hovered node: never removed (it is what the pointer is asking about). */
  hoveredId?: string | null;
  /** Current search matches: never removed. */
  searchMatchIds?: ReadonlySet<string> | null;
  /** Ceiling on UNPINNED labels, so a huge graph cannot flood the frame. 0
   *  leaves only the pinned ones (the graph's "labels off" setting). */
  maxLabels?: number;
  /** Ceiling on how many nodes are sorted + collision-tested per call. */
  maxCandidates?: number;
}

const DEFAULT_LINE_HEIGHT = 13;
const DEFAULT_GAP = 4;
const DEFAULT_MAX_LABELS = 600;
const DEFAULT_MAX_CANDIDATES = 1200;
/** Slack outside the viewport before a label is culled, screen px. */
const CULL_MARGIN = 32;
/** Uniform grid cell for the collision sweep, screen px. */
const CELL = 96;
/** Gap between a node's edge and the top of its label, screen px. */
const LABEL_OFFSET = 3;

interface Candidate {
  node: LabelNode;
  /** 0 open · 1 hovered · 2 search match · 3 everything else. */
  rank: number;
  sx: number;
  sy: number;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

export function selectLabels(
  nodes: readonly LabelNode[],
  options: SelectLabelsOptions,
): Set<string> {
  const chosen = new Set<string>();
  const { transform, measure } = options;
  const { k, width, height } = transform;
  if (nodes.length === 0 || k <= 0 || width <= 0 || height <= 0) return chosen;

  const lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const gap = options.gap ?? DEFAULT_GAP;
  const maxLabels = options.maxLabels ?? DEFAULT_MAX_LABELS;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const openId = options.openId ?? null;
  const hoveredId = options.hoveredId ?? null;
  const searchMatchIds = options.searchMatchIds ?? null;

  // ---- 1. Cull to the viewport and rank what is left. ----
  const candidates: Candidate[] = [];
  let pinnedCount = 0;
  const degreeCounts = new Map<number, number>();
  for (const node of nodes) {
    if (node.title === "") continue;
    const sx = width / 2 + transform.x + node.x * k;
    const sy = height / 2 + transform.y + node.y * k;
    if (
      sx < -CULL_MARGIN ||
      sx > width + CULL_MARGIN ||
      sy < -CULL_MARGIN ||
      sy > height + CULL_MARGIN
    ) {
      continue;
    }
    const rank =
      node.id === openId
        ? 0
        : node.id === hoveredId
          ? 1
          : searchMatchIds?.has(node.id)
            ? 2
            : 3;
    if (rank < 3) pinnedCount += 1;
    else degreeCounts.set(node.degree, (degreeCounts.get(node.degree) ?? 0) + 1);
    candidates.push({ node, rank, sx, sy });
  }

  // ---- 2. Dense graph: keep the pinned labels plus the best-connected slice.
  // A degree histogram finds the cut in one pass, so a 50k-node vault never
  // sorts (or measures) 50k candidates on a frame the user is panning. ----
  let pool = candidates;
  if (pool.length > maxCandidates) {
    const budget = maxCandidates - pinnedCount;
    let threshold = Number.POSITIVE_INFINITY;
    if (budget > 0) {
      const degrees = [...degreeCounts.keys()].sort((a, b) => b - a);
      let kept = 0;
      for (const degree of degrees) {
        threshold = degree;
        kept += degreeCounts.get(degree) ?? 0;
        if (kept >= budget) break;
      }
    }
    pool = pool.filter((c) => c.rank < 3 || c.node.degree >= threshold);
  }

  // ---- 3. Deterministic priority order. ----
  pool.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.node.degree - a.node.degree ||
      (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
  );

  // ---- 4. Grid sweep: first come (highest priority) keeps its space. ----
  const grid = new Map<string, Rect[]>();
  const place = (rect: Rect) => {
    const x0 = Math.floor(rect.left / CELL);
    const x1 = Math.floor(rect.right / CELL);
    const y0 = Math.floor(rect.top / CELL);
    const y1 = Math.floor(rect.bottom / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx},${cy}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(rect);
        else grid.set(key, [rect]);
      }
    }
  };
  const collides = (rect: Rect) => {
    const x0 = Math.floor(rect.left / CELL);
    const x1 = Math.floor(rect.right / CELL);
    const y0 = Math.floor(rect.top / CELL);
    const y1 = Math.floor(rect.bottom / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = grid.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const other of bucket) if (overlaps(rect, other)) return true;
      }
    }
    return false;
  };

  for (const candidate of pool) {
    // Pinned labels sort first and are never budgeted away: the note you are
    // reading and the notes you searched for stay named at any density.
    if (candidate.rank === 3 && chosen.size >= maxLabels) break;
    const half = measure(candidate.node) / 2 + gap / 2;
    const top = candidate.sy + candidate.node.radius * k + LABEL_OFFSET;
    const rect: Rect = {
      left: candidate.sx - half,
      right: candidate.sx + half,
      top,
      bottom: top + lineHeight + gap,
    };
    if (candidate.rank < 3) {
      // Pinned: claims its space whatever is already there.
      place(rect);
      chosen.add(candidate.node.id);
      continue;
    }
    if (collides(rect)) continue;
    place(rect);
    chosen.add(candidate.node.id);
  }

  return chosen;
}
