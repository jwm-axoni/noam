// Scene-level entrance for the graph view.
//
// ONE progress value drives the whole opening: the renderer asks this module
// where a node should be drawn *this frame* and interpolates the RENDERED scene
// from the graph's visual centre out to the settled layout. Nothing here
// touches the simulation — no reheat, no seeded positions, no camera change —
// so reopening a graph can never scramble a layout that already settled, and
// the auto-fit camera (which measures the settled positions) is unaffected.
//
// The renderer owns the clock: it passes the same `performance.now()` it draws
// the frame with, which is what keeps this module pure and unit-testable.

export interface EntranceOptions {
  /** Timestamp the entrance starts at, on the renderer's clock. */
  now: number;
  /** Total length of the bloom. Restrained by design — see ENTRANCE_MS. */
  durationMs?: number;
  /**
   * `prefers-reduced-motion: reduce`. The entrance then does nothing at all:
   * the settled graph is shown immediately, with no centre-out movement and no
   * fade. Every accessor returns its resting value from the first frame.
   */
  reducedMotion?: boolean;
}

export interface Entrance {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly reducedMotion: boolean;
  /** Eased 0..1. Clamped outside [startedAt, startedAt + durationMs]. */
  progress(t: number): number;
  /**
   * How far along the centre→settled path the scene is drawn, 0..1. Exposed
   * separately from `positionFor` so the hot renderer loops (tens of thousands
   * of nodes) can compute one scalar per frame instead of one object per node.
   */
  factor(t: number): number;
  /** A node's drawn position, interpolated from `center` toward its settled one. */
  positionFor(
    node: { x: number; y: number },
    center: { x: number; y: number },
    t: number,
  ): { x: number; y: number };
  /** Opacity multiplier for node bodies. */
  nodeAlpha(t: number): number;
  /** Radius multiplier for node bodies (nodes scale up as they bloom). */
  nodeScale(t: number): number;
  /** Opacity multiplier for edges — deliberately lags `nodeAlpha`. */
  edgeAlpha(t: number): number;
  /** True once the scene is fully settled and the renderer can drop the entrance. */
  done(t: number): boolean;
}

/** Restrained centre-out bloom: long enough to read as deliberate, short
 *  enough that it never becomes something to wait through. */
export const ENTRANCE_MS = 340;

/** Nodes start this far along their path, not stacked on the exact centre —
 *  a pile of coincident dots reads as a blob, not as a graph about to open. */
const START_FRACTION = 0.14;
/** Node bodies reach full opacity this far into the (raw) timeline. */
const NODE_FADE_AT = 0.55;
/** Edges do not begin to appear until this far in — they follow the nodes. */
const EDGE_LAG = 0.35;
/** Node radius multiplier at the very start of the bloom. */
const NODE_SCALE_START = 0.6;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Decelerating ease: quick expansion, soft arrival. Monotonic on [0,1]. */
function easeOutCubic(p: number): number {
  const inv = 1 - p;
  return 1 - inv * inv * inv;
}

export function createEntrance(options: EntranceOptions): Entrance {
  const startedAt = options.now;
  const durationMs = Math.max(1, options.durationMs ?? ENTRANCE_MS);
  const reducedMotion = options.reducedMotion === true;

  const raw = (t: number) => clamp01((t - startedAt) / durationMs);
  const progress = (t: number) => (reducedMotion ? 1 : easeOutCubic(raw(t)));
  const factor = (t: number) =>
    reducedMotion ? 1 : START_FRACTION + (1 - START_FRACTION) * progress(t);
  const done = (t: number) => reducedMotion || t - startedAt >= durationMs;

  return {
    startedAt,
    durationMs,
    reducedMotion,
    progress,
    factor,
    positionFor(node, center, t) {
      // Exact settled coordinates once we are done — `c + (n - c) * 1` is not
      // bit-for-bit `n` in floating point, and a graph that rests a hair off
      // its layout would make every later frame disagree with hit-testing.
      if (done(t)) return { x: node.x, y: node.y };
      const f = factor(t);
      return {
        x: center.x + (node.x - center.x) * f,
        y: center.y + (node.y - center.y) * f,
      };
    },
    nodeAlpha(t) {
      if (reducedMotion) return 1;
      return easeOutCubic(clamp01(raw(t) / NODE_FADE_AT));
    },
    nodeScale(t) {
      if (reducedMotion) return 1;
      return NODE_SCALE_START + (1 - NODE_SCALE_START) * progress(t);
    },
    edgeAlpha(t) {
      if (reducedMotion) return 1;
      return easeOutCubic(clamp01((raw(t) - EDGE_LAG) / (1 - EDGE_LAG)));
    },
    done,
  };
}
