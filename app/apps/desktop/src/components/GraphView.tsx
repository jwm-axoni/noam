import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Simulation, ForceLink } from "d3-force";
import type { Graph } from "../lib/graph/buildGraph";
import {
  createSimulation,
  configureForces,
  nodeRadius,
  centerWeight,
  layoutScale,
  DRAG_ALPHA,
  REARRANGE_ALPHA,
  type FlowForce,
  type SimNode,
  type SimLink,
} from "../lib/graph/simulation";
import { assignColors, type LegendEntry } from "../lib/graph/graphColor";
import { createEntrance, type Entrance } from "../lib/graph/entrance";
import {
  graphLabel,
  labelZoomAlpha,
  selectLabels,
  type LabelNode,
} from "../lib/graph/labels";
import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  type GraphSettings,
} from "../lib/graph/graphSettings";
import { useGraphData } from "../lib/graph/useGraphData";
import { WebGLGraphRenderer, type RenderNode } from "../lib/graph/webglRenderer";
import { SimClient } from "../lib/graph/simClient";
import {
  neighborhoodIds,
  selectLocalSubgraph,
} from "../lib/graph/localSubgraph";
import {
  filterGraphNodes,
  localGraphEmptyReason,
  shouldShowGraphEmptyState,
} from "../lib/graph/graphFilters";
import { useStore } from "../store";
import { observeThemeChanges } from "../lib/theme";
import { GraphControls } from "./GraphControls";
import { Spinner } from "./Spinner";
import "./graph.css";

// ---------------------------------------------------------------------------
// Immersive, physics-driven note graph. Physics is d3-force (see simulation.ts),
// but we own the clock: the sim's internal timer is stopped and we call
// sim.tick() ourselves inside a requestAnimationFrame loop so painting and
// physics share one frame. React owns only React-y things — data loading, the
// settings panel, header counts. Camera / hover / drag / positions all live in
// refs so interaction never triggers a reconciliation pass.
// ---------------------------------------------------------------------------

const MIN_SCALE = 0.08;
const MAX_SCALE = 6;
const CLICK_DRAG_THRESHOLD = 4; // px moved before a pointerdown counts as a drag
const DEFAULT_FONT_FAMILY = "sans-serif";
const FALLBACK_ACCENT = "#7f73ff";

// Main-thread settling is sliced across animation frames. Each slice stays
// below one frame's work budget so a mid-sized graph cannot freeze dock/tab
// interaction while it arranges itself.
const PRESETTLE_SLICE_MS = 8;
const PRESETTLE_MAX_TICKS = 700;
const PRESETTLE_TARGET_ALPHA = 0.04;

// Below this alpha the layout is done moving into place, so the auto-fit camera
// locks — a couple of seconds after open, or immediately after a refresh. Without the lock the ambient drift keeps nudging the
// bounding box and the whole viewport breathes its zoom by a percent or two,
// which reads as the picture wobbling rather than the nodes drifting.
const FIT_LOCK_ALPHA = 0.02;

// How hard a *data refresh* re-energizes the layout. The first build needs real
// energy to find a shape from seeded positions; later rebuilds already have a
// settled layout and only need to absorb what changed, so they get a small warm
// nudge. Reheating those to 1 was what made the graph appear to "reset": every
// `file-changed` event (a whole storm of them while a vault syncs) threw the
// entire layout back to maximum energy and it visibly flew apart and re-settled.
const REHEAT_FIRST = 1;
const REHEAT_REFRESH = 0.1;

// Smallest a node may be drawn on screen, in CSS px of radius. Applied in
// quadrature by the shader (see webglRenderer's VERT), so it is a lift for the
// leaves rather than a ceiling everything piles up against.
const MIN_NODE_PX = 2.1;
// Fallback cap for the global scope on the 2D canvas, which only stays smooth
// up to a few hundred nodes. The GPU (WebGL) renderer draws the whole vault, so
// this cap only applies when WebGL is unavailable.
const GLOBAL_2D_CAP = 600;
const WEBGL_ENABLED = true;

// Above this node count, the global graph runs its force layout in a Web Worker
// (see simWorker.ts) so a huge vault (50k+) can settle without freezing the UI
// thread. At or below it, the sim runs inline — proven smooth up to ~5.5k and it
// keeps drag/interaction latency zero. If the Worker API is unavailable, the
// global sim is capped to this size so the main thread can never lock up.
const WORKER_THRESHOLD = 8000;


// ---- Labels ----------------------------------------------------------------
// Like Obsidian, names fade in with zoom (labelZoomAlpha): the fit view of a
// real vault is text-free, and the hovered node and search matches are the only
// names that ignore the fade. Which names survive once visible is decided in
// screen space by lib/graph/labels.ts: priority (open note > hovered > search
// match > degree > id) with collision removal, so a dense field thins itself.
const LABEL_FONT_PX = 11; // on-screen size, identical on both render paths
const LABEL_LINE_PX = 13; // line box used for the collision rects
const LABEL_OFFSET_PX = 3; // gap between a node's rim and its label
// The "Labels" slider is a DENSITY control: it sets how much clear space each
// label demands, so turning it up packs more names in. 0 keeps only the pinned
// ones (open note, hover, search matches), which is what it has always meant.
const LABEL_GAP_MIN = 2;
const LABEL_GAP_MAX = 10;
// Ceiling on drawn labels. Collisions almost always bind first; this only stops
// a heavily zoomed-out vault from paying for thousands of fillText calls.
const LABEL_BUDGET = 500;
// The selection is recomputed when the camera/hover/search changes, and at most
// this often while the layout drifts. Re-running it every frame would put a
// sort + collision sweep of the visible set on the animation budget.
const LABEL_RESELECT_MS = 150;

// Flat-dot node rendering. Nodes are simple solid discs in their type color,
// matching the reference look (Obsidian's graph): no 3D lighting, no baked
// shading sprites, no contact shadows, no ambient glow.

// The WebGL diagnostic stays off unless a developer explicitly opts in from
// DevTools with `localStorage.context.graphDiag = "1"` and reloads the app.
// Keep the dev-build gate so production builds never expose it.
const GRAPH_DIAGNOSTICS_ENABLED =
  import.meta.env.DEV &&
  typeof localStorage !== "undefined" &&
  localStorage.getItem("context.graphDiag") === "1";

/** Parse "#rgb"/"#rrggbb" or "rgb()/rgba()" into [r,g,b] 0–255; grey on failure. */
function parseColor(c: string): [number, number, number] {
  const s = c.trim();
  if (s.startsWith("#")) {
    let h = s.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length >= 6) {
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((v) => parseFloat(v));
    return [p[0] || 0, p[1] || 0, p[2] || 0];
  }
  return [150, 150, 160];
}

type Drag =
  | { type: "pan"; lastX: number; lastY: number; moved: boolean }
  | {
      type: "node";
      node: SimNode;
      startX: number;
      startY: number;
      moved: boolean;
    };

interface Camera {
  x: number;
  y: number;
  k: number;
}

interface Colors {
  edge: string;
  edgeHighlight: string;
  nodeFallback: string;
  accent: string;
  surface: "light" | "dark";
  label: string;
  labelActive: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Read the resolved (var()-free) colors the canvas paints with. */
function readColors(el: Element): Colors {
  const cs = getComputedStyle(el);
  const get = (name: string) => cs.getPropertyValue(name).trim();
  // The backdrop now follows the app theme, so labels must too: light-on-dark
  // tones would vanish on the light surface and vice versa.
  const dark = document.documentElement.dataset.theme === "dark";
  return {
    edge: get("--graph-link-rest") || "rgb(128, 133, 153)",
    edgeHighlight: get("--accent") || FALLBACK_ACCENT,
    nodeFallback: get("--text-tertiary") || "#9a9aa5",
    accent: get("--accent") || FALLBACK_ACCENT,
    surface: dark ? "dark" : "light",
    // Use readable theme text; zoom gating controls label density.
    label: get("--text-primary") || (dark ? "#d1d1d1" : "#20232f"),
    labelActive: get("--text-primary") || (dark ? "#d1d1d1" : "#20232f"),
  };
}

/** Parse a #rrggbb (or #rgb) color into 0..1 floats; null when unparseable. */
function parseHexColor(raw: string): [number, number, number] | null {
  const hex = raw.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Read the backdrop color for the WebGL shader: the theme's --bg-surface, the
 * same flat color the CSS backdrop paints. All three shader stops get it, so the
 * gradient collapses to a flat fill. Falls back to a dark surface when the token
 * is missing or unparseable, so the GPU canvas can never end up transparent.
 */
function readBackdropColors(el: Element): {
  core: [number, number, number];
  mid: [number, number, number];
  rim: [number, number, number];
} {
  const cs = getComputedStyle(el);
  const stop = (
    name: string,
    fallback: [number, number, number],
  ): [number, number, number] =>
    parseHexColor(cs.getPropertyValue(name)) ?? fallback;
  const surface = stop("--bg-surface", [0.106, 0.118, 0.129]);
  return { core: surface, mid: surface, rim: surface };
}

/**
 * Build the full SimNode array for a graph, reusing existing node objects so
 * positions/velocities survive a data refresh. New nodes are seeded on a
 * golden-angle spiral near the origin (never all stacked at 0,0, which would
 * blow up the repulsion force on the first tick).
 */
function buildSimNodes(graph: Graph, previous: Map<string, SimNode>): SimNode[] {
  const n = Math.max(graph.nodes.length, 1);
  const spread = 60 + Math.sqrt(n) * 40;
  const maxDegree = graph.nodes.reduce((m, node) => Math.max(m, node.linkCount), 0);
  return graph.nodes.map((node, i) => {
    // Degree drives BOTH the visual size (bigger = more links) and the centering
    // mass (heavier → stronger pull to the single center point).
    const weight = centerWeight(node.linkCount, maxDegree);
    const prev = previous.get(node.id);
    if (prev) {
      prev.title = node.title;
      prev.path = node.path;
      prev.type = node.type;
      prev.linkCount = node.linkCount;
      prev.radius = nodeRadius(node.linkCount);
      prev.weight = weight;
      return prev;
    }
    // Seed by weight: heavy nodes near the center, light ones farther out (on a
    // golden-angle spoke) so they drift only a little into their resting orbit.
    const angle = i * 2.399963;
    const r = spread * (1 - Math.min(weight, 1)) + 12;
    return {
      id: node.id,
      title: node.title,
      path: node.path,
      type: node.type,
      linkCount: node.linkCount,
      radius: nodeRadius(node.linkCount),
      weight,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    };
  });
}

export interface GraphViewProps {
  instanceId: string;
  visible: boolean;
  showControls: boolean;
  onStatusChange?: (status: GraphViewStatus) => void;
  onOpenNote: (path: string) => void;
}

export interface GraphViewStatus {
  nodes: number;
  edges: number;
  total: number;
}

export interface GraphViewHandle {
  refresh: () => void;
}

const graphCameraCache = new Map<string, Camera>();
function cameraFor(instanceId: string): Camera {
  let camera = graphCameraCache.get(instanceId);
  if (!camera) {
    camera = { x: 0, y: 0, k: 1 };
    graphCameraCache.set(instanceId, camera);
  }
  return camera;
}

export const GraphView = forwardRef<GraphViewHandle, GraphViewProps>(function GraphView({
  instanceId,
  visible,
  showControls,
  onStatusChange,
  onOpenNote,
}, ref) {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Separate GPU canvas for the global scope (a canvas can hold only one context
  // type, so WebGL gets its own; the 2D canvas keeps the local view).
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // 2D overlay stacked on top of the GPU canvas, carrying nothing but the node
  // names. Text on the GPU would mean a glyph atlas for a few hundred strings;
  // a 2D canvas drawn from the same camera is simpler and crisper at any dpr.
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Whether the GPU renderer initialized. Read imperatively by `rebuild` to
  // decide the global fallback; mirrored to state (`webglError`) for the UI.
  const webglOkRef = useRef(false);
  const [webglError, setWebglError] = useState<string | null>(null);
  // On-screen WebGL diagnostic (updated imperatively, sampled to state below).
  const diagRef = useRef("");
  const [diag, setDiag] = useState("");
  // Hover tooltip for the WebGL global view: the hovered note's name + position
  // (canvas-local px). Set only when the hovered node changes.
  const [hoverTip, setHoverTip] = useState<{ title: string; x: number; y: number } | null>(null);
  // Bounded self-heal: the graph can mount before the vault is fully open and
  // come back empty; retry a few times so it fills in instead of getting stuck.
  const emptyRetriesRef = useRef(0);
  // True while a self-heal retry is still pending: the empty-state card stays
  // hidden until the retries are exhausted, so a slow index doesn't make it
  // flash briefly before the data arrives.
  const [retryingEmpty, setRetryingEmpty] = useState(false);
  // One-shot: fit the WebGL camera to the graph on (re)entry, then the user's
  // pan/zoom (shared `S.camera`) takes over.
  const webglNeedsFitRef = useRef(true);
  const localNeedsFitRef = useRef(true);

  const { graph, loading, error, refresh } = useGraphData();
  // Only the Web Worker path (8k+ nodes) can set this. Inline layouts are
  // pre-settled synchronously before their first frame, so there is no window
  // in which they'd need to hide; the worker has one, and this covers it.
  const [settling, setSettling] = useState(false);

  // Settings live in BOTH a ref (read from inside the imperative canvas/sim
  // code, which can't see React state closures) and React state (drives the
  // controls panel). applyPatch keeps them in lockstep.
  const settingsRef = useRef<GraphSettings>(loadSettings(instanceId));
  const [settings, setSettings] = useState<GraphSettings>(settingsRef.current);

  // `prefers-reduced-motion`, read once and kept current by a subscription
  // below. The entrance consults it at the moment it starts.
  const reducedMotionRef = useRef<boolean | null>(null);
  if (reducedMotionRef.current === null) {
    reducedMotionRef.current =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches;
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const [legend, setLegend] = useState<LegendEntry[]>([]);
  const [counts, setCounts] = useState({ nodes: 0, edges: 0, total: 0 });
  const [localCurrentNoteFound, setLocalCurrentNoteFound] = useState(false);
  const [localPreFilterEdgeCount, setLocalPreFilterEdgeCount] = useState(0);

  useEffect(() => onStatusChange?.(counts), [counts, onStatusChange]);
  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  const openNotePath = useStore((s) => s.openNote?.path ?? null);
  const openNotePathRef = useRef(openNotePath);
  openNotePathRef.current = openNotePath;

  // One d3 simulation for the component's whole life (survives re-renders and
  // StrictMode remounts because refs persist). The frame clock is demand-driven:
  // a settled or hidden graph schedules no animation frames (see `loop` and the
  // heartbeat removal), so the sim rests at alphaTarget(0) until an interaction
  // or data change wakes it.
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  if (!simRef.current) {
    simRef.current = createSimulation(settingsRef.current).alphaTarget(0);
  }

  const graphRef = useRef<Graph | null>(null);

  // Mutable, non-reactive state driving the canvas.
  const S = useRef({
    nodesById: new Map<string, SimNode>(),
    visNodes: [] as SimNode[],
    // Same array objects we hand to forceLink().links(): d3 rewrites their
    // source/target from id strings to SimNode refs IN PLACE, so after the call
    // we can read them as resolved links for drawing.
    visEdges: [] as SimLink[],
    // visNodes sorted small→large radius, so bigger ("nearer") orbs paint over
    // smaller ones and depth reads correctly. Order only changes on rebuild.
    drawOrder: [] as SimNode[],
    // One-shot: has the 2D canvas been wiped since the GPU renderer took over?
    cleared2d: false,
    colorById: new Map<string, string>(),
    camera: cameraFor(instanceId),
    hoveredId: null as string | null,
    drag: null as Drag | null,
    rafId: null as number | null,
    needsDraw: true,
    // Large global graphs offload the force sim to a Web Worker so the UI thread
    // never blocks. `useWorker` is set per-rebuild; `workerActive` mirrors the
    // worker's "still settling" state (drives redraws); `workerGen` drops stale
    // position buffers after a rebuild; `indexById` maps a node id to its slot
    // in the position buffer for drag fix/release.
    useWorker: false,
    workerActive: false,
    workerGen: 0,
    indexById: new Map<string, number>(),
    hasBuilt: false,
    inlineSettling: false,
    inlineSettleTicks: 0,
    // The whole entrance is this ONE object: a scene-level progress function
    // the draw code samples with the current frame time. No per-node timers and
    // no React state — it interpolates the RENDERED scene only, so the layout
    // and the camera are exactly what they were before it started.
    entrance: null as Entrance | null,
    // Label selection (see lib/graph/labels.ts). `labelIds` is what the 2D path
    // tests per node; `labelDraw` is the chosen nodes in draw order, so the GPU
    // path's overlay iterates hundreds instead of tens of thousands. `labelPool`
    // is reused across selections to keep this off the GC's plate.
    labelIds: new Set<string>(),
    labelDraw: [] as SimNode[],
    labelPool: [] as LabelNode[],
    labelKey: "",
    labelAt: 0,
    /** Zoom fade for unpinned labels, 0..1 (see labelZoomAlpha). */
    labelAlpha: 0,
    /** Search matches at the last selection; they skip the zoom fade. */
    labelSearchIds: null as Set<string> | null,
    colors: {
      edge: "rgba(120,120,140,0.25)",
      edgeHighlight: FALLBACK_ACCENT,
      nodeFallback: "#9a9aa5",
      accent: FALLBACK_ACCENT,
      surface: "dark",
      label: "rgba(205, 210, 224, 0.6)",
      labelActive: "#f2f4fb",
    } as Colors,
    fontFamily: DEFAULT_FONT_FAMILY,
  }).current;

  // Set by the canvas effect once it defines the real draw scheduler. Starts as
  // a no-op so callers (rebuild, applyPatch) are safe before that effect runs.
  const requestDrawRef = useRef<() => void>(() => {});
  // Recomputes per-node colors from the current visible set + accent, and pushes
  // the legend to React state. Also set by the canvas effect (needs S.accent).
  const recolorRef = useRef<() => void>(() => {});
  // Starts the entrance. Set by the canvas effect (it owns the frame clock).
  const beginEntranceRef = useRef<() => void>(() => {});

  // Force-layout Web Worker for large global graphs. Created once, lives for the
  // component's whole life (like simRef). Its streamed positions are written
  // straight into the current render nodes, so the renderer/edges/hover code all
  // keep reading the same objects — the only difference is the sim math happens
  // off-thread. Created lazily and defensively: if Worker isn't available the
  // ref stays null and rebuild() caps the global sim so the main thread is safe.
  const workerRef = useRef<SimClient | null>(null);
  if (workerRef.current === null && typeof Worker !== "undefined") {
    try {
      workerRef.current = new SimClient(
        (buf, alpha, gen) => {
          if (gen !== S.workerGen) return; // stale layout, ignore
          const vn = S.visNodes;
          if (buf.length !== vn.length * 2) return; // set changed under us
          for (let i = 0; i < vn.length; i++) {
            vn[i].x = buf[i * 2];
            vn[i].y = buf[i * 2 + 1];
          }
          S.workerActive = alpha > 0.005;
          S.needsDraw = true;
          requestDrawRef.current();
        },
        (gen) => {
          if (gen !== S.workerGen) return;
          S.workerActive = false;
          S.needsDraw = true;
          setSettling(false);
          // Same reveal moment as the inline path, one thread later: the big
          // graph was hidden while the worker arranged it, so this is where it
          // gets its entrance.
          beginEntranceRef.current();
        },
      );
    } catch {
      workerRef.current = null;
    }
  }
  // Tear the worker down for good on final unmount.
  useEffect(() => () => {
    workerRef.current?.dispose();
  }, [S]);

  // Recompute visible nodes/edges from the latest graph + filter settings, feed
  // them to the simulation, refresh colors, and reheat. Called on data change
  // and whenever a filter setting changes.
  const rebuild = useCallback(() => {
    const sim = simRef.current;
    const g = graphRef.current;
    if (!sim || !g) return;
    const s = settingsRef.current;

    const all = buildSimNodes(g, S.nodesById);
    S.nodesById = new Map(all.map((n) => [n.id, n]));

    // Local scope: draw only the open note's neighborhood (a handful of nodes,
    // so it stays smooth on any vault and re-centers as you move between notes).
    // With no open note, the local graph stays empty and explains how to enable it.
    const localGraph =
      s.scope === "local" && openNotePathRef.current
        ? selectLocalSubgraph(g, openNotePathRef.current, s.localDepth)
        : null;
    setLocalCurrentNoteFound(s.scope === "local" && localGraph != null);
    setLocalPreFilterEdgeCount(localGraph?.edges.length ?? 0);
    const localIds = localGraph
      ? new Set(localGraph.nodes.map((node) => node.id))
      : null;
    const openNodeId = localGraph?.nodes.find(
      (node) => node.path.toLowerCase() === openNotePathRef.current?.toLowerCase(),
    )?.id;
    const openNode = all.find((node) => node.id === openNodeId);

    const candidates =
      s.scope === "local"
        ? localIds
          ? all.filter((node) => localIds.has(node.id))
          : []
        : all;
    let visNodes = filterGraphNodes(candidates, s);
    if (s.scope === "global") {
      // Global overview: HIDE by degree/orphans (search DIMS at draw-time). With
      // the GPU renderer we draw the whole set; without it (WebGL unavailable) we
      // fall back to the 2D canvas and cap to the most-connected nodes so it
      // stays smooth. The header reports the full total, so the cap is visible.
      if (!webglOkRef.current && visNodes.length > GLOBAL_2D_CAP) {
        visNodes = [...visNodes]
          .sort((a, b) => b.linkCount - a.linkCount)
          .slice(0, GLOBAL_2D_CAP);
      } else if (
        workerRef.current === null &&
        visNodes.length > WORKER_THRESHOLD
      ) {
        // No Web Worker available to offload the layout — cap the live sim so a
        // huge vault can't lock up the main thread. (When the worker exists, the
        // full set goes to it below instead of being capped.)
        visNodes = [...visNodes]
          .sort((a, b) => b.linkCount - a.linkCount)
          .slice(0, WORKER_THRESHOLD);
      }
    }
    const visible = new Set(visNodes.map((n) => n.id));
    const visibleEdges = localGraph?.edges ?? g.edges;
    const links: SimLink[] = visibleEdges
      .filter((e) => visible.has(e.source) && visible.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    // d3 init order: nodes() BEFORE link.links() so the link force resolves
    // {source,target} ids against the current node array.
    sim.nodes(visNodes);
    (sim.force("link") as ForceLink<SimNode, SimLink>).links(links);
    // Re-apply forces now that the node count is known — repulsion scales with
    // it, so a 5k global graph spreads while a small local one stays compact.
    configureForces(sim, s);

    // Only the first build gets a full reheat. After that, warm the layout just
    // enough to absorb the change (and never *cool* one that's already hotter).
    const first = !S.hasBuilt;
    sim.alpha(first ? REHEAT_FIRST : Math.max(sim.alpha(), REHEAT_REFRESH));

    // The first inline layout settles behind the progress state in <=8ms slices
    // from the render clock. The worker path settles off-thread.
    if (first && visNodes.length > 0) {
      const willUseWorker =
        !openNode && workerRef.current !== null && visNodes.length > WORKER_THRESHOLD;
      if (!willUseWorker) {
        S.inlineSettling = true;
        S.inlineSettleTicks = 0;
        setSettling(true);
      }
      S.hasBuilt = true;
    }

    S.visNodes = visNodes;
    S.visEdges = links; // now resolved in place by forceLink
    S.drawOrder = [...visNodes].sort((a, b) => a.radius - b.radius);

    // Size the flow to the layout we just built (its own radius sets both the
    // drift speed and the wavelength) so the motion looks the same whether this
    // vault is 40 notes or 5000. Measured after the pre-settle, when positions
    // mean something.
    (sim.force("flow") as FlowForce).scale(layoutScale(visNodes)).energy(0);

    // Large global graphs: run the force layout in a Web Worker so the UI thread
    // never blocks. The worker owns its own copy and streams positions back into
    // these same node objects (loop() skips the main-thread tick while active).
    const worker = workerRef.current;
    const useWorker =
      !openNode && worker !== null && visNodes.length > WORKER_THRESHOLD;
    const wasUsingWorker = S.useWorker;
    S.useWorker = useWorker;
    if (useWorker && worker) {
      S.indexById = new Map(visNodes.map((n, i) => [n.id, i]));
      const nodeSpec = visNodes.map((n) => ({
        id: n.id,
        radius: n.radius,
        weight: n.weight,
      }));
      const linkSpec = links
        .map((l) => {
          const sid = typeof l.source === "string" ? l.source : l.source.id;
          const tid = typeof l.target === "string" ? l.target : l.target.id;
          return { source: S.indexById.get(sid)!, target: S.indexById.get(tid)! };
        })
        .filter((l) => l.source !== undefined && l.target !== undefined);
      S.workerGen = worker.init(nodeSpec, linkSpec, s, 1200, 800, false);
      S.workerActive = true;
      const bounds = wrapRef.current?.getBoundingClientRect();
      if (
        !visibleRef.current ||
        document.visibilityState === "hidden" ||
        !bounds ||
        bounds.width <= 0 ||
        bounds.height <= 0
      ) worker.stop();
      // A pre-settle is impossible here — blocking the thread for an 8k+ node
      // layout is exactly the freeze the worker exists to avoid. So the reveal
      // waits instead: hold the graph hidden through the FIRST settle and fade
      // it in cool, rather than showing a huge field rearranging itself. Only
      // the first build; later refreshes are small warm nudges (REHEAT_REFRESH)
      // that must not blank a graph the user is already looking at.
      if (first) setSettling(true);
    } else if (worker) {
      // Switched to local or a small enough set: park the worker.
      worker.stop();
      S.workerActive = false;
      if (wasUsingWorker && !S.inlineSettling) setSettling(false);
    }

    const accent = S.colors.accent || FALLBACK_ACCENT;
    const { colorById, legend: lg } = assignColors(
      visNodes,
      s.colorMode,
      accent,
      S.colors.surface,
    );
    S.colorById = colorById;
    setLegend(lg);
    setCounts({ nodes: visNodes.length, edges: links.length, total: g.nodes.length });

    requestDrawRef.current();
  }, [S]);

  // Merge a settings patch: persist, update both mirrors, and apply live with
  // the cheapest reaction the change requires.
  const applyPatch = useCallback(
    (patch: Partial<GraphSettings>) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      saveSettings(next, instanceId);
      setSettings(next);

      const sim = simRef.current;
      if (!sim) return;

      const keys = Object.keys(patch) as (keyof GraphSettings)[];
      const touchesFilter = keys.some(
        (k) =>
          k === "minDegree" ||
          k === "hideOrphans" ||
          k === "scope" ||
          k === "localDepth",
      );
      const touchesForces = keys.some(
        (k) =>
          k === "charge" ||
          k === "linkDistance" ||
          k === "linkStrength" ||
          k === "gravity",
      );

      if (touchesFilter) {
        if (patch.scope === "global") {
          webglNeedsFitRef.current = true;
          S.cleared2d = false;
        }
        if (patch.scope === "local" || patch.localDepth != null) {
          localNeedsFitRef.current = true;
        }
        // Fewer/more nodes: rebuild the sim data and let it re-settle.
        rebuild();
        return;
      }
      if (touchesForces) {
        // Physics changed: re-apply params without disturbing positions, then
        // gently reheat so the layout eases into its new equilibrium.
        if (S.useWorker) {
          // The off-thread sim owns the layout here — hand it the new params.
          workerRef.current?.setSettings(next);
          S.workerActive = true;
        } else {
          configureForces(sim, next);
          sim.alpha(Math.max(sim.alpha(), REARRANGE_ALPHA));
        }
        requestDrawRef.current();
        return;
      }
      // Visual-only (nodeSize / edgeThickness / labelScale / colorMode / search):
      // no reheat — just recolor if needed and repaint one frame.
      if (keys.includes("colorMode")) recolorRef.current();
      requestDrawRef.current();
    },
    [instanceId, rebuild],
  );

  const onReset = useCallback(() => {
    const next = { ...DEFAULT_SETTINGS };
    settingsRef.current = next;
    webglNeedsFitRef.current = true;
    S.cleared2d = false;
    saveSettings(next, instanceId);
    setSettings(next);
    const sim = simRef.current;
    if (sim) {
      configureForces(sim, next);
      rebuild(); // recolors + reheats with the reset filter/appearance
    }
  }, [instanceId, rebuild]);

  // Feed freshly-built graph data into the running simulation.
  useEffect(() => {
    graphRef.current = graph;
    if (graph) {
      if (settingsRef.current.scope === "global") webglNeedsFitRef.current = true;
      else localNeedsFitRef.current = true;
      rebuild();
    }
  }, [graph, rebuild]);

  // Re-fit the WebGL camera each time Global scope is (re)entered.
  useEffect(() => {
    if (settings.scope === "global") webglNeedsFitRef.current = true;
  }, [settings.scope]);

  // Re-center the local graph when the open note changes (no-op in global scope,
  // where the view doesn't depend on which note is open).
  useEffect(() => {
    if (settingsRef.current.scope === "local" && graphRef.current) {
      localNeedsFitRef.current = true;
      rebuild();
    }
  }, [openNotePath, rebuild, S]);

  // Sample the imperative WebGL diagnostic into state a couple times a second
  // (diagnostic HUD only; avoids a per-frame setState).
  useEffect(() => {
    if (!GRAPH_DIAGNOSTICS_ENABLED || !WEBGL_ENABLED || !visible) return;
    const id = setInterval(() => setDiag(diagRef.current), 500);
    return () => clearInterval(id);
  }, [visible]);

  // Self-heal an empty graph: if the data came back with no nodes (the view can
  // mount before the vault's index is ready), retry a few times. A genuinely
  // empty vault just settles after the retries and shows the empty state.
  useEffect(() => {
    if (!visible || loading) {
      setRetryingEmpty(false);
      return;
    }
    if (graph && graph.nodes.length > 0) {
      emptyRetriesRef.current = 0;
      setRetryingEmpty(false);
      return;
    }
    if (graph && graph.nodes.length === 0 && emptyRetriesRef.current < 3) {
      emptyRetriesRef.current += 1;
      setRetryingEmpty(true);
      const id = setTimeout(refresh, 400);
      return () => clearTimeout(id);
    }
    setRetryingEmpty(false);
  }, [graph, loading, refresh, visible]);

  // ---- Canvas setup: runs once; everything else flows through refs. ----
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sim = simRef.current!;

    // Label overlay for the GPU path. Its own 2D context, sized alongside the
    // others in resize().
    const labelCtx = labelCanvasRef.current?.getContext("2d") ?? null;

    // GPU renderer for the global scope (best-effort; if WebGL2 is unavailable
    // we simply never switch to it). Its own canvas — a canvas can hold only one
    // context type.
    let webgl: WebGLGraphRenderer | null = null;
    const webglCanvas = webglCanvasRef.current;
    if (webglCanvas && WEBGL_ENABLED) {
      try {
        webgl = new WebGLGraphRenderer(webglCanvas);
      } catch (e) {
        webgl = null;
        setWebglError(e instanceof Error ? e.message : String(e));
        console.error("[graph] WebGL init failed:", e);
      }
    }
    webglOkRef.current = webgl !== null;

    // Push the theme into the GPU renderer: the backdrop is --bg-surface (the
    // same color the CSS backdrop uses), and the edge
    // tint follows the light/dark mode. Called here at startup and again from
    // the theme observer below, so flipping the theme repaints live.
    function applyThemeToWebgl() {
      if (!webgl) return;
      const bd = readBackdropColors(wrap!);
      webgl.setBackdropColors(bd.core, bd.mid, bd.rim);
      const [edgeR, edgeG, edgeB] = parseColor(readColors(wrap!).edge);
      webgl.setEdgeColor([edgeR / 255, edgeG / 255, edgeB / 255]);
      webgl.setLightMode(
        document.documentElement.dataset.theme !== "dark",
      );
    }
    applyThemeToWebgl();

    const rgbCache = new Map<string, [number, number, number]>();
    const getRgb = (c: string): [number, number, number] => {
      let v = rgbCache.get(c);
      if (!v) {
        v = parseColor(c);
        rgbCache.set(c, v);
      }
      return v;
    };

    let width = 0;
    let height = 0;
    let dpr = window.devicePixelRatio || 1;
    const groupHost = wrap.closest<HTMLElement>("[data-dock-group-id]");
    let hostClosing = groupHost?.dataset.closing === "true";

    // Declared up here (not next to `loop`) because `resize()` runs
    // synchronously during setup and reaches it via the hoisted
    // `requestDraw` — a `const` declared below would still be in TDZ.
    const canRender = () => visibleRef.current && !hostClosing &&
      document.visibilityState !== "hidden" && width > 0 && height > 0;

    S.colors = readColors(wrap);
    S.fontFamily =
      getComputedStyle(wrap).getPropertyValue("--font-body").trim() ||
      DEFAULT_FONT_FAMILY;

    function resize() {
      const rect = wrap!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      if (width <= 0 || height <= 0) {
        if (S.rafId != null) cancelAnimationFrame(S.rafId);
        S.rafId = null;
        workerRef.current?.stop();
        return;
      }
      dpr = window.devicePixelRatio || 1;
      canvas!.width = Math.max(1, Math.floor(width * dpr));
      canvas!.height = Math.max(1, Math.floor(height * dpr));
      const labelCanvas = labelCanvasRef.current;
      if (labelCanvas) {
        labelCanvas.width = canvas!.width;
        labelCanvas.height = canvas!.height;
      }
      if (webgl) webgl.resize(width, height, dpr);
      if (visibleRef.current) workerRef.current?.resume();
      requestDraw();
    }

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    // Recompute per-node colors + legend. Registered so applyPatch/theme changes
    // can trigger it (degree/uniform palettes depend on the live accent color).
    function recolor() {
      const s = settingsRef.current;
      const accent = S.colors.accent || FALLBACK_ACCENT;
      const { colorById, legend: lg } = assignColors(
        S.visNodes,
        s.colorMode,
        accent,
        S.colors.surface,
      );
      S.colorById = colorById;
      setLegend(lg);
    }
    recolorRef.current = recolor;

    // Re-read colors when the display mode, palette, or accent changes, then
    // recolor (accent-derived palettes must follow the theme). The GPU backdrop
    // and edge tint follow too, so the whole canvas repaints into the new theme.
    const stopObservingTheme = observeThemeChanges(() => {
      S.colors = readColors(wrap!);
      applyThemeToWebgl();
      recolor();
      requestDraw();
    });

    function screenToWorld(sx: number, sy: number) {
      return {
        x: (sx - width / 2 - S.camera.x) / S.camera.k,
        y: (sy - height / 2 - S.camera.y) / S.camera.k,
      };
    }

    function nodeAt(sx: number, sy: number): SimNode | null {
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      const nodeScale = settingsRef.current.nodeSize;
      let best: SimNode | null = null;
      let bestDist = Infinity;
      for (const node of S.visNodes) {
        const dx = node.x - wx;
        const dy = node.y - wy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const hitRadius = node.radius * nodeScale + 4 / S.camera.k;
        if (d <= hitRadius && d < bestDist) {
          best = node;
          bestDist = d;
        }
      }
      return best;
    }

    // ---- Entrance --------------------------------------------------------
    // One clock for the whole frame: `loop` stamps it, both draw paths sample
    // the same value, so nodes, edges and labels agree on how far along the
    // bloom is. Hit-testing deliberately ignores it and keeps using the settled
    // positions — the layout never moved, only the painting of it, and a
    // 340ms-long disagreement between the cursor and the dots is a worse bug
    // than the one it would fix. Any pan/zoom/press ends the entrance outright.
    let frameNow = 0;

    function makeEntrance(now: number) {
      if (S.visNodes.length === 0) return;
      S.entrance = createEntrance({
        now,
        reducedMotion: reducedMotionRef.current === true,
      });
    }

    /** Start the entrance from OUTSIDE the frame loop (never from inside it —
     *  requestDraw would schedule a second, parallel rAF chain). */
    function beginEntrance() {
      makeEntrance(performance.now());
      requestDraw();
    }
    beginEntranceRef.current = beginEntrance;

    /** World point the entrance blooms out of: the centre of what is on screen,
     *  which the auto-fit has already parked on the centre of the graph. */
    function entranceCenter() {
      const k = S.camera.k || 1;
      return { x: -S.camera.x / k, y: -S.camera.y / k };
    }

    // ---- Labels ----------------------------------------------------------
    // Text metrics in SCREEN px (labels are drawn at a constant on-screen size
    // on both paths, so one measurement per distinct title lasts for the life
    // of the view).
    const labelWidths = new Map<string, number>();
    const labelTexts = new Map<string, string>();
    function labelText(title: string): string {
      let text = labelTexts.get(title);
      if (text === undefined) {
        text = graphLabel(title);
        labelTexts.set(title, text);
      }
      return text;
    }
    function measureLabel(node: LabelNode): number {
      let w = labelWidths.get(node.title);
      if (w === undefined) {
        ctx!.font = `${LABEL_FONT_PX}px ${S.fontFamily}`;
        w = ctx!.measureText(node.title).width;
        labelWidths.set(node.title, w);
      }
      return w;
    }

    /**
     * Refresh which nodes are labelled. Cheap to call every frame: it re-runs
     * only when something that changes the answer changed (camera, hover,
     * search, density, node count) or the layout has drifted for a while.
     * `radiusScale` is the path's own multiplier on a node's world radius, so
     * the label clears the disc it belongs to at whatever size it is drawn.
     */
    function refreshLabels(radiusScale: number) {
      const s = settingsRef.current;
      const cam = S.camera;
      const key =
        `${cam.k}|${cam.x}|${cam.y}|${width}|${height}|${S.hoveredId ?? ""}|` +
        `${s.search}|${s.labelScale}|${radiusScale}|${S.visNodes.length}`;
      if (key === S.labelKey && frameNow - S.labelAt < LABEL_RESELECT_MS) return;
      S.labelKey = key;
      S.labelAt = frameNow;

      const search = s.search.trim().toLowerCase();
      const matchIds = search === "" ? null : new Set<string>();
      const pool = S.labelPool;
      pool.length = S.visNodes.length;
      let openId: string | null = null;
      for (let i = 0; i < S.visNodes.length; i++) {
        const n = S.visNodes[i];
        let entry = pool[i];
        if (!entry) {
          entry = { id: "", x: 0, y: 0, degree: 0, radius: 0, title: "" };
          pool[i] = entry;
        }
        entry.id = n.id;
        entry.x = n.x;
        entry.y = n.y;
        entry.degree = n.linkCount;
        entry.radius = n.radius * radiusScale;
        entry.title = labelText(n.title);
        if (n.path === openNotePathRef.current) openId = n.id;
        if (matchIds && n.title.toLowerCase().includes(search)) matchIds.add(n.id);
      }

      const density = clamp(s.labelScale, 0, 1);
      const transform = { k: cam.k, x: cam.x, y: cam.y, width, height };
      // Independent of the saved labelScale on purpose: installs that tuned the
      // density up still get a text-free fit view without resetting anything.
      S.labelAlpha = labelZoomAlpha(pool, transform);
      S.labelSearchIds = matchIds;
      const ids = selectLabels(pool, {
        transform,
        measure: measureLabel,
        lineHeight: LABEL_LINE_PX,
        gap: LABEL_GAP_MAX - (LABEL_GAP_MAX - LABEL_GAP_MIN) * density,
        openId,
        hoveredId: S.hoveredId,
        searchMatchIds: matchIds,
        maxLabels: s.labelScale <= 0 || S.labelAlpha <= 0 ? 0 : LABEL_BUDGET,
      });
      S.labelIds = ids;
      S.labelDraw.length = 0;
      for (const n of S.visNodes) if (ids.has(n.id)) S.labelDraw.push(n);
    }

    // ---- Drawing ----
    function draw() {
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, width, height); // transparent → CSS backdrop shows through
      const scope = settingsRef.current.scope;
      const needsFit =
        (scope === "local" && localNeedsFitRef.current) ||
        (scope === "global" && webgl === null && webglNeedsFitRef.current);
      if (needsFit && S.visNodes.length > 0) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const node of S.visNodes) {
          minX = Math.min(minX, node.x);
          minY = Math.min(minY, node.y);
          maxX = Math.max(maxX, node.x);
          maxY = Math.max(maxY, node.y);
        }
        const boundsWidth = Math.max(40, maxX - minX);
        const boundsHeight = Math.max(40, maxY - minY);
        S.camera.k = clamp(
          Math.min((width - 80) / boundsWidth, (height - 80) / boundsHeight),
          MIN_SCALE,
          2.4,
        );
        S.camera.x = -((minX + maxX) / 2) * S.camera.k;
        S.camera.y = -((minY + maxY) / 2) * S.camera.k;
      }
      ctx!.save();
      ctx!.translate(width / 2 + S.camera.x, height / 2 + S.camera.y);
      ctx!.scale(S.camera.k, S.camera.k);

      const s = settingsRef.current;
      const colors = S.colors;
      const k = S.camera.k;

      const hovered = S.hoveredId
        ? S.nodesById.get(S.hoveredId) ?? null
        : null;
      const neighbors = new Set<string>();
      if (hovered) {
        neighbors.add(hovered.id);
        for (const e of S.visEdges) {
          const src = e.source as SimNode;
          const tgt = e.target as SimNode;
          if (src.id === hovered.id) neighbors.add(tgt.id);
          if (tgt.id === hovered.id) neighbors.add(src.id);
        }
      }

      const search = s.search.trim().toLowerCase();
      const matches = (n: SimNode) =>
        search === "" || n.title.toLowerCase().includes(search);

      const nodeScale = s.nodeSize;
      refreshLabels(nodeScale);

      // Entrance: the scene is painted somewhere between the visual centre and
      // the settled layout. `rendered` is the identity once it is over (and
      // while there is no entrance at all), so the steady state allocates
      // nothing and the settled frame is bit-for-bit what it always was.
      const entrance = S.entrance;
      const center = entranceCenter();
      const nodeAlpha = entrance ? entrance.nodeAlpha(frameNow) : 1;
      const edgeAlpha = entrance ? entrance.edgeAlpha(frameNow) : 1;
      const entranceScale = entrance ? entrance.nodeScale(frameNow) : 1;
      const rendered = (n: SimNode): { x: number; y: number } =>
        entrance ? entrance.positionFor(n, center, frameNow) : n;

      const drawNodes = S.drawOrder;
      // ---- Edges: quiet connective threads (source-over, batched) ----
      ctx!.globalCompositeOperation = "source-over";
      const edgeWidth = s.edgeThickness / k;
      ctx!.strokeStyle = colors.edge;
      // Close to the GPU path's resting edge alpha so the WebGL-unavailable
      // fallback doesn't look like a different, dimmer product.
      ctx!.globalAlpha = (hovered ? 0.06 : 0.16) * edgeAlpha;
      ctx!.lineWidth = edgeWidth;
      ctx!.beginPath();
      for (const e of S.visEdges) {
        const src = e.source as SimNode;
        const tgt = e.target as SimNode;
        if (hovered && (src.id === hovered.id || tgt.id === hovered.id)) continue;
        const a = rendered(src);
        const b = rendered(tgt);
        ctx!.moveTo(a.x, a.y);
        ctx!.lineTo(b.x, b.y);
      }
      ctx!.stroke();
      if (hovered) {
        // The hovered node's own links light up with the accent, drawn on top.
        ctx!.strokeStyle = colors.edgeHighlight;
        ctx!.globalAlpha = 0.85 * edgeAlpha;
        ctx!.lineWidth = edgeWidth * 1.8;
        ctx!.beginPath();
        for (const e of S.visEdges) {
          const src = e.source as SimNode;
          const tgt = e.target as SimNode;
          if (src.id !== hovered.id && tgt.id !== hovered.id) continue;
          const a = rendered(src);
          const b = rendered(tgt);
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
        }
        ctx!.stroke();
      }

      // ---- Node bodies: flat solid discs in the type color ----
      ctx!.globalCompositeOperation = "source-over";
      for (const node of drawNodes) {
        const isOpen = node.path === openNotePathRef.current;
        const isHovered = hovered?.id === node.id;
        const dimByHover = hovered != null && !neighbors.has(node.id);
        const dimBySearch = !matches(node);
        const dimmed = dimByHover || dimBySearch;

        const base = node.radius * nodeScale * entranceScale;
        const r = isHovered ? base * 1.32 : base;
        const color = isOpen
          ? colors.accent
          : S.colorById.get(node.id) ?? colors.nodeFallback;
        const at = rendered(node);

        // Flat solid disc in the node's color — no shading, no gloss.
        ctx!.globalAlpha = (dimmed ? 0.24 : 1) * nodeAlpha;
        ctx!.fillStyle = color;
        ctx!.beginPath();
        ctx!.arc(at.x, at.y, r, 0, Math.PI * 2);
        ctx!.fill();

        // The open note gets an accent ring so it's findable at a glance; the
        // hovered node gets a subtler one.
        if (isOpen || isHovered) {
          ctx!.lineWidth = (isOpen ? 2 : 1.25) / k;
          ctx!.strokeStyle = colors.accent;
          ctx!.globalAlpha = (dimmed ? 0.4 : isOpen ? 1 : 0.6) * nodeAlpha;
          ctx!.beginPath();
          ctx!.arc(at.x, at.y, r + 3 / k, 0, Math.PI * 2);
          ctx!.stroke();
        }

        // Labels: whatever selectLabels chose (in screen space) plus the hovered
        // node. Only the hovered node and search matches skip the zoom fade;
        // the open note fades like the rest so the fit view stays text-free.
        // During the entrance they arrive with the edges, after the nodes.
        const wantLabel = isHovered || S.labelIds.has(node.id);
        const pinned = isHovered || (S.labelSearchIds?.has(node.id) ?? false);
        const text = wantLabel ? labelText(node.title) : "";
        if (text !== "") {
          let alpha = edgeAlpha * (pinned ? 1 : S.labelAlpha);
          if (dimBySearch && !isHovered) alpha *= 0.2;
          else if (dimByHover) alpha *= 0.25;
          if (alpha > 0.01) {
            ctx!.globalAlpha = alpha;
            ctx!.fillStyle = isOpen || isHovered ? colors.labelActive : colors.label;
            ctx!.font = `${LABEL_FONT_PX / k}px ${S.fontFamily}`;
            ctx!.textAlign = "center";
            ctx!.textBaseline = "top";
            ctx!.fillText(text, at.x, at.y + r + LABEL_OFFSET_PX / k);
          }
        }
      }
      ctx!.globalAlpha = 1;
      ctx!.globalCompositeOperation = "source-over";
      ctx!.restore();
    }

    /**
     * Persistent names for the GPU path, painted on a 2D canvas stacked over
     * the WebGL one and driven by the SAME camera, so the two layers cannot
     * drift apart. Only the nodes `selectLabels` chose are visited (hundreds at
     * most), so this stays a rounding error next to the GPU passes even on a
     * 50k-node vault. `factor` interpolates around the screen centre during the
     * entrance — the affine equivalent of moving the nodes in world space.
     */
    function drawLabelOverlay(factor: number, alpha: number, radiusScale: number) {
      if (!labelCtx) return;
      labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      labelCtx.clearRect(0, 0, width, height);
      if (alpha <= 0.01 || S.labelDraw.length === 0) return;
      const cam = S.camera;
      labelCtx.font = `${LABEL_FONT_PX}px ${S.fontFamily}`;
      labelCtx.textAlign = "center";
      labelCtx.textBaseline = "top";
      // A soft counter-shadow in the backdrop's own direction is what keeps a
      // name legible where it crosses a bright node or a knot of links, in
      // either theme, without boxing every label in a plate.
      labelCtx.shadowColor =
        S.colors.surface === "dark" ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.75)";
      labelCtx.shadowBlur = 3;
      for (const n of S.labelDraw) {
        const active = n.path === openNotePathRef.current || n.id === S.hoveredId;
        const pinned = n.id === S.hoveredId || (S.labelSearchIds?.has(n.id) ?? false);
        const fade = pinned ? 1 : S.labelAlpha;
        if (fade <= 0.01) continue;
        labelCtx.globalAlpha = alpha * fade;
        let sx = width / 2 + cam.x + n.x * cam.k;
        let sy = height / 2 + cam.y + n.y * cam.k;
        if (factor !== 1) {
          sx = width / 2 + (sx - width / 2) * factor;
          sy = height / 2 + (sy - height / 2) * factor;
        }
        labelCtx.fillStyle = active ? S.colors.labelActive : S.colors.label;
        labelCtx.fillText(
          labelText(n.title),
          sx,
          sy + n.radius * radiusScale * cam.k + LABEL_OFFSET_PX,
        );
      }
      labelCtx.shadowBlur = 0;
      labelCtx.globalAlpha = 1;
    }

    // Global scope: draw every node on the GPU. The instance buffer is rebuilt
    // every frame (the layout is always drifting), so the RenderNode wrappers
    // are POOLED and mutated in place — allocating a few thousand objects plus
    // their color arrays 60 times a second would hand the GC a steady diet for
    // as long as the graph is open.
    const webglNodes: RenderNode[] = [];
    let edgePositions = new Float32Array(0);
    function drawWebGL() {
      if (!webgl || !webglCanvas) return;
      // Wipe the 2D canvas the first time the GPU renderer paints. Both canvases
      // are stacked in the same box and the 2D one is never cleared once WebGL
      // owns the frame, so whatever it last drew just sits there underneath — and
      // any gap in the GPU layer (the entrance pulse briefly scaling under 1, a
      // dpr change, a lost context) reveals a stale graph behind the live one.
      // A canvas resize clears itself, so once is genuinely enough.
      if (!S.cleared2d && ctx) {
        ctx.clearRect(0, 0, canvas!.width, canvas!.height);
        S.cleared2d = true;
      }
      const fallback = S.colors.nodeFallback;
      const nodeScale = settingsRef.current.nodeSize;
      // Shrink nodes as the graph grows so a bigger vault reads as "smaller
      // dots, more space" rather than a compacted pile. The layout also spreads
      // (repulsion scales with n), so together the graph expands and keeps
      // breathing room. The constant is generous — it used to kick in at a few
      // hundred notes and stack on top of the on-screen minimum, which between
      // them squashed every node in a mid-size vault to the same floor size and
      // erased the hub-vs-leaf hierarchy entirely.
      const countScale = Math.min(1, 60 / Math.sqrt(Math.max(1, S.visNodes.length)));
      // Hover: light up the hovered node + its direct neighbors, dim the rest,
      // so you can see a note's connections at a glance.
      const hoveredId = S.hoveredId;
      const hlSet =
        hoveredId && graphRef.current
          ? neighborhoodIds(graphRef.current, hoveredId, 1)
          : null;
      webglNodes.length = S.visNodes.length;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < S.visNodes.length; i++) {
        const n = S.visNodes[i];
        const c = getRgb(S.colorById.get(n.id) ?? fallback);
        const dim = hlSet && !hlSet.has(n.id) ? 0.16 : 1;
        const big =
          n.id === hoveredId ? 2.4 : hlSet && hlSet.has(n.id) ? 1.8 : 1;
        let rn = webglNodes[i];
        if (!rn) {
          rn = { x: 0, y: 0, r: 0, color: [0, 0, 0] };
          webglNodes[i] = rn;
        }
        rn.x = n.x;
        rn.y = n.y;
        rn.r = n.radius * nodeScale * countScale * big;
        rn.color[0] = (c[0] / 255) * dim;
        rn.color[1] = (c[1] / 255) * dim;
        rn.color[2] = (c[2] / 255) * dim;
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
      }

      // One-shot: fit the shared camera to the graph. After that the user's
      // pan/zoom (which mutates S.camera via the 2D handlers) drives the view.
      // Measured on the SETTLED bounds above, before the entrance touches
      // anything, so the bloom can never move the camera.
      if (webglNeedsFitRef.current && webglNodes.length > 0) {
        // Keep the graph framed as the layout expands during settle; the flag is
        // cleared the moment the user pans/zooms (in the interaction handlers).
        const bw = Math.max(1, maxX - minX);
        const bh = Math.max(1, maxY - minY);
        S.camera.k = Math.min((width - 80) / bw, (height - 80) / bh);
        S.camera.x = -((minX + maxX) / 2) * S.camera.k;
        S.camera.y = -((minY + maxY) / 2) * S.camera.k;
      }

      // Entrance: one scalar for the whole scene. `factor` is 1 once the bloom
      // is over, and then this second pass is skipped entirely.
      const entrance = S.entrance;
      const factor = entrance ? entrance.factor(frameNow) : 1;
      const edgeAlpha = entrance ? entrance.edgeAlpha(frameNow) : 1;
      const center = entranceCenter();
      if (factor !== 1) {
        const entranceScale = entrance!.nodeScale(frameNow);
        for (let i = 0; i < webglNodes.length; i++) {
          const rn = webglNodes[i];
          rn.x = center.x + (rn.x - center.x) * factor;
          rn.y = center.y + (rn.y - center.y) * factor;
          rn.r *= entranceScale;
        }
      }
      webgl.setNodes(webglNodes);
      // Edges: two world-space vertices per link (source → target), read from
      // the sim nodes forceLink resolved in place.
      const edges = S.visEdges;
      if (edgePositions.length < edges.length * 4) {
        edgePositions = new Float32Array(edges.length * 4);
      }
      for (let i = 0; i < edges.length; i++) {
        const src = edges[i].source as SimNode;
        const tgt = edges[i].target as SimNode;
        const o = i * 4;
        if (factor === 1) {
          edgePositions[o] = src.x;
          edgePositions[o + 1] = src.y;
          edgePositions[o + 2] = tgt.x;
          edgePositions[o + 3] = tgt.y;
        } else {
          edgePositions[o] = center.x + (src.x - center.x) * factor;
          edgePositions[o + 1] = center.y + (src.y - center.y) * factor;
          edgePositions[o + 2] = center.x + (tgt.x - center.x) * factor;
          edgePositions[o + 3] = center.y + (tgt.y - center.y) * factor;
        }
      }
      webgl.setEdgeAlphaScale(edgeAlpha);
      webgl.setEdges(edgePositions.subarray(0, edges.length * 4));
      // Hover: bright rays from the hovered node to each of its neighbors, so
      // connections are traceable even in a huge cloud.
      if (hoveredId) {
        const hl: number[] = [];
        for (let i = 0; i < edges.length; i++) {
          const s = edges[i].source as SimNode;
          const t = edges[i].target as SimNode;
          if (s.id === hoveredId || t.id === hoveredId) {
            hl.push(s.x, s.y, t.x, t.y);
          }
        }
        webgl.setHighlightEdges(new Float32Array(hl));
      } else {
        webgl.setHighlightEdges(new Float32Array(0));
      }
      // Same transform as the 2D path: screen_css = width/2 + cam.x + world·cam.k,
      // then scaled by dpr into the device-pixel drawing buffer.
      const cam = S.camera;
      webgl.draw(
        cam.k * dpr,
        (width / 2 + cam.x) * dpr,
        (height / 2 + cam.y) * dpr,
        // Floor on a node's on-screen radius. The shader applies it in
        // quadrature, not as a hard clamp, so this lifts the leaves to a
        // legible dot without flattening the hubs down onto them.
        MIN_NODE_PX * dpr,
        dpr,
      );
      refreshLabels(nodeScale * countScale);
      drawLabelOverlay(factor, edgeAlpha, nodeScale * countScale);
      diagRef.current =
        `webgl ✓ · nodes ${webglNodes.length} · buf ${webglCanvas.width}×${webglCanvas.height} · ` +
        `k ${cam.k.toFixed(3)} · cam ${Math.round(cam.x)},${Math.round(cam.y)} · ` +
        `bounds ${Math.round(minX)},${Math.round(minY)}..${Math.round(maxX)},${Math.round(maxY)} · ` +
        `gl ${webgl.glError()}`;
    }

    // Demand-driven frame clock. A settled or hidden dock graph schedules no
    // animation frames; interactions and data changes explicitly wake it.
    // (`canRender` is declared near the top of the effect — see the TDZ note.)
    function loop() {
      S.rafId = null;
      if (!canRender()) return;
      frameNow = performance.now();
      // When the Web Worker owns the layout (big global graph) we NEVER tick the
      // main-thread sim — that's the whole point, it would freeze the UI. The
      // worker streams positions in and flips S.workerActive; we just repaint.
      let active: boolean;
      if (S.useWorker) {
        active = S.workerActive;
      } else {
        if (S.inlineSettling) {
          const deadline = performance.now() + PRESETTLE_SLICE_MS;
          do {
            sim.tick();
            S.inlineSettleTicks += 1;
          } while (
            S.inlineSettleTicks < PRESETTLE_MAX_TICKS &&
            sim.alpha() > PRESETTLE_TARGET_ALPHA &&
            performance.now() < deadline
          );
          if (
            S.inlineSettleTicks >= PRESETTLE_MAX_TICKS ||
            sim.alpha() <= PRESETTLE_TARGET_ALPHA
          ) {
            S.inlineSettling = false;
            setSettling(false);
            // Arm the entrance HERE, not from the effect that watches
            // `settling`: the frame this call is part of is the one React then
            // reveals, so the first thing the eye sees is the bloom's opening
            // frame rather than the settled graph for a beat before it.
            makeEntrance(frameNow);
          }
        } else if (sim.alpha() > sim.alphaMin() || S.drag != null) {
          sim.tick();
        }
        active = S.inlineSettling || sim.alpha() > sim.alphaMin() || S.drag != null;
        // Once the layout stops visibly moving into place, stop chasing it with
        // the camera — otherwise the drift breathes the bounding box and the
        // auto-fit turns that into a wobble of the whole view.
        if (webglNeedsFitRef.current && sim.alpha() <= FIT_LOCK_ALPHA) {
          webglNeedsFitRef.current = false;
        }
        if (
          settingsRef.current.scope === "local" &&
          localNeedsFitRef.current &&
          sim.alpha() <= FIT_LOCK_ALPHA
        ) {
          localNeedsFitRef.current = false;
        }
      }
      // The entrance keeps the clock running on its own — a settled layout with
      // a bloom still in flight must not rest until the bloom has landed.
      if (S.entrance != null) active = true;
      if (settingsRef.current.scope === "global" && webgl) {
        // Only rebuild + re-upload + redraw while the layout is moving (or on an
        // explicit request). Once settled the last frame stands, so idle cost is
        // ~zero — this is what keeps the app responsive instead of re-uploading
        // every node every frame forever.
        if (active || S.needsDraw) drawWebGL();
      } else if (active || S.needsDraw) {
        draw();
      }
      // Drop the entrance only after the frame that drew it at rest, so the
      // scene it leaves behind is the settled one.
      if (S.entrance && S.entrance.done(frameNow)) S.entrance = null;
      S.needsDraw = false;
      if (active) S.rafId = requestAnimationFrame(loop);
    }

    function requestDraw() {
      S.needsDraw = true;
      if (canRender() && S.rafId == null) S.rafId = requestAnimationFrame(loop);
    }
    requestDrawRef.current = requestDraw;

    // ---- Interaction ----
    function clientToLocal(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      webglNeedsFitRef.current = false; // user is driving the camera now
      localNeedsFitRef.current = false;
      S.entrance = null; // the user is here; stop animating the arrival
      const rect = canvas!.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = screenToWorld(sx, sy);
      const zoomFactor = Math.exp(-e.deltaY * 0.0015);
      const newK = clamp(S.camera.k * zoomFactor, MIN_SCALE, MAX_SCALE);
      S.camera.k = newK;
      S.camera.x = sx - width / 2 - before.x * newK;
      S.camera.y = sy - height / 2 - before.y * newK;
      requestDraw();
    }

    function handlePointerDown(e: PointerEvent) {
      webglNeedsFitRef.current = false; // user is driving the camera now
      localNeedsFitRef.current = false;
      // Hit-testing reads the SETTLED positions, so a press mid-entrance would
      // otherwise grab a node that is not yet drawn where it is. Landing the
      // bloom immediately is both simpler and what the user just asked for.
      S.entrance = null;
      const { x: sx, y: sy } = clientToLocal(e);
      const hit = nodeAt(sx, sy);
      canvas!.setPointerCapture(e.pointerId);
      canvas!.classList.add("is-dragging");
      if (hit) {
        // Pin the grabbed node and keep the sim warm so neighbors react live.
        hit.fx = hit.x;
        hit.fy = hit.y;
        if (S.useWorker) {
          const i = S.indexById.get(hit.id);
          if (i !== undefined) workerRef.current?.fix(i, hit.x, hit.y);
        } else {
          sim.alpha(Math.max(sim.alpha(), DRAG_ALPHA)).alphaTarget(DRAG_ALPHA);
        }
        S.drag = {
          type: "node",
          node: hit,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        };
        requestDraw();
      } else {
        S.drag = { type: "pan", lastX: e.clientX, lastY: e.clientY, moved: false };
      }
    }

    function handlePointerMove(e: PointerEvent) {
      const { x: sx, y: sy } = clientToLocal(e);
      const drag = S.drag;
      if (drag) {
        if (drag.type === "pan") {
          const dx = e.clientX - drag.lastX;
          const dy = e.clientY - drag.lastY;
          if (dx !== 0 || dy !== 0) {
            drag.moved =
              drag.moved || Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD;
            S.camera.x += dx;
            S.camera.y += dy;
            drag.lastX = e.clientX;
            drag.lastY = e.clientY;
            requestDraw();
          }
        } else {
          const { x: wx, y: wy } = screenToWorld(sx, sy);
          drag.node.fx = wx;
          drag.node.fy = wy;
          if (S.useWorker) {
            // Move it locally for zero-latency feedback, and pin it in the worker
            // so the off-thread sim keeps the neighbors reacting around it.
            drag.node.x = wx;
            drag.node.y = wy;
            const i = S.indexById.get(drag.node.id);
            if (i !== undefined) workerRef.current?.fix(i, wx, wy);
          }
          if (!drag.moved) {
            const dist = Math.hypot(
              e.clientX - drag.startX,
              e.clientY - drag.startY,
            );
            if (dist > CLICK_DRAG_THRESHOLD) drag.moved = true;
          }
          // Loop is already running (alphaTarget 0.3); nudge in case it stalled.
          requestDraw();
        }
        return;
      }
      const hit = nodeAt(sx, sy);
      const hitId = hit?.id ?? null;
      if (hitId !== S.hoveredId) {
        S.hoveredId = hitId;
        canvas!.classList.toggle("is-hovering-node", hitId != null);
        // Name tooltip near the cursor (canvas-local coords). Only updated on
        // change of hovered node, so mousemove itself stays cheap.
        setHoverTip(hit ? { title: hit.title, x: sx, y: sy } : null);
        requestDraw();
      }
    }

    // The pointer can leave the canvas while hovering a node (fast flicks,
    // drag-release outside). No further pointermove fires, so without this the
    // tooltip and the hovering cursor stay painted over the settling overlay.
    function handlePointerLeave() {
      if (S.hoveredId != null) {
        S.hoveredId = null;
        canvas!.classList.remove("is-hovering-node");
        setHoverTip(null);
        requestDraw();
      }
    }

    function endDrag(e: PointerEvent) {
      const drag = S.drag;
      canvas!.classList.remove("is-dragging");
      S.drag = null;
      if (drag?.type === "node") {
        // Obsidian parity: a dropped node STAYS where you put it. The pin set
        // on grab is kept (both locally and in the worker sim — the move
        // handler already re-pinned it at the final position, so there is
        // nothing to release), and the layout settles around the user's
        // arrangement instead of dragging the node back to the center.
        // Re-grabbing a pinned node just moves the pin.
        if (!S.useWorker) {
          // Stop feeding drag energy and let it cool — but only back down to the
          // idle floor, never to zero: a graph that cools to zero is a graph
          // that stops moving.
          sim.alphaTarget(0);
        }
        if (!drag.moved) {
          // A click, not a drag: open the note.
          const path = drag.node.path;
          onOpenNote(path);
        } else {
          // A real drag: NO reheat. Dropping a node used to kick the layout back
          // up to alpha 0.25, and that reheat was the visible "boing" — the
          // whole neighbourhood re-solving at a step size big enough to
          // overshoot. Cooling straight to the idle floor instead lets the
          // displaced node be carried home by the ambient flow over several
          // seconds, which is the same journey without the buzz.
          requestDrawRef.current();
        }
      }
      try {
        canvas!.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    requestDraw();

    const handleVisibility = () => {
      if (!canRender()) {
        if (S.rafId != null) cancelAnimationFrame(S.rafId);
        S.rafId = null;
        workerRef.current?.stop();
      } else {
        resize();
        workerRef.current?.resume();
        requestDraw();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    const closingObserver = groupHost == null ? null : new MutationObserver(() => {
      hostClosing = groupHost.dataset.closing === "true";
      handleVisibility();
    });
    closingObserver?.observe(groupHost!, {
      attributes: true,
      attributeFilter: ["data-closing"],
    });

    return () => {
      ro.disconnect();
      stopObservingTheme();
      closingObserver?.disconnect();
      if (S.rafId != null) {
        cancelAnimationFrame(S.rafId);
      }
      // CRUCIAL: reset so a stale id doesn't wedge requestDraw's `== null`
      // guard on a StrictMode remount.
      S.rafId = null;
      sim.stop();
      webgl?.dispose();
      S.entrance = null;
      requestDrawRef.current = () => {};
      recolorRef.current = () => {};
      beginEntranceRef.current = () => {};
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!visible) {
      if (S.rafId != null) cancelAnimationFrame(S.rafId);
      S.rafId = null;
      workerRef.current?.stop();
      return;
    }
    workerRef.current?.resume();
    requestDrawRef.current();
  }, [S, visible]);

  // Play the entrance when the graph is (re)shown. The reveal after a settle is
  // armed from the frame loop instead (see `makeEntrance`), so this only covers
  // switching back to an already-built graph. Either way it is purely a way of
  // PAINTING the layout that already exists — no reheat, no reseeding, no
  // camera change — so a reopened graph blooms into exactly the arrangement and
  // framing it had. Declared after the canvas effect, which installs the ref.
  useEffect(() => {
    if (!visible) return;
    beginEntranceRef.current();
  }, [visible]);

  const showEmpty = shouldShowGraphEmptyState({
    loading,
    error,
    graphLoaded: graph != null,
    retryingEmpty,
    scope: settings.scope,
    nodeCount: counts.nodes,
    edgeCount: counts.edges,
  });
  const localEmptyReason = localGraphEmptyReason({
    hasOpenNote: openNotePath != null,
    currentNoteFound: localCurrentNoteFound,
    preFilterEdgeCount: localPreFilterEdgeCount,
    nodeCount: counts.nodes,
    edgeCount: counts.edges,
  });

  return (
    <div className="graph-view" ref={wrapRef}>
      <div
        className={`graph-canvas-wrap${settling ? " is-settling" : ""}`}
      >
        <canvas className="graph-canvas" ref={canvasRef} />
        <canvas
          className="graph-canvas"
          ref={webglCanvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            // Events pass through to the 2D canvas below, which owns the shared
            // pan/zoom + hit-test handlers.
            pointerEvents: "none",
            display:
              WEBGL_ENABLED && settings.scope === "global" && !webglError
                ? "block"
                : "none",
          }}
        />
        {/* Names for the GPU path. Shares the WebGL canvas's visibility rule —
            in local scope the 2D canvas draws its own labels inline. */}
        <canvas
          className="graph-canvas graph-label-layer"
          ref={labelCanvasRef}
          style={{
            display:
              WEBGL_ENABLED && settings.scope === "global" && !webglError
                ? "block"
                : "none",
          }}
        />
        {settings.scope === "global" && webglError && (
          <div
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              maxWidth: "60%",
              padding: "6px 10px",
              borderRadius: 6,
              background: "rgba(180,40,40,0.85)",
              color: "#fff",
              font: "11px/1.4 ui-monospace, monospace",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            WebGL unavailable — showing capped 2D fallback. {webglError}
          </div>
        )}
        {GRAPH_DIAGNOSTICS_ENABLED &&
          WEBGL_ENABLED &&
          settings.scope === "global" &&
          diag &&
          !showControls && <div className="graph-diagnostics">{diag}</div>}
        {settings.scope === "global" && hoverTip && (
          <div
            style={{
              position: "absolute",
              left: hoverTip.x + 12,
              top: hoverTip.y + 12,
              maxWidth: 260,
              padding: "3px 8px",
              borderRadius: 6,
              background: "rgba(18,18,26,0.94)",
              color: "#fff",
              font: "12px/1.3 var(--font-body, ui-sans-serif)",
              border: "1px solid rgba(255,255,255,0.14)",
              pointerEvents: "none",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              zIndex: 6,
            }}
          >
            {hoverTip.title}
          </div>
        )}

        {showControls && (
          <GraphControls
            idPrefix={`graph-${instanceId}`}
            settings={settings}
            onChange={applyPatch}
            onReset={onReset}
            legend={legend}
            hasCurrentNote={openNotePath != null}
          />
        )}

        {loading && (
          <div className="graph-state">
            <div className="graph-state-card">Loading graph…</div>
          </div>
        )}
        {settling && !loading && (
          <div className="graph-state">
            {/* Big-vault path only. The worker is arranging the layout
                off-thread; saying so beats revealing thousands of nodes in
                motion, which is the thing this change exists to remove. */}
            <div className="graph-state-card graph-settling">
              <Spinner size="sm" tone="accent" />
              Arranging {counts.nodes.toLocaleString()} notes…
            </div>
          </div>
        )}
        {error && !loading && (
          <div className="graph-state">
            <div className="graph-state-card">
              <strong>Couldn't load the graph</strong>
              {error}
            </div>
          </div>
        )}
        {showEmpty && (
          <div className="graph-state">
            <div className="graph-state-card graph-empty">
              <div className="graph-empty-glyph" aria-hidden="true">
                <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
                  <line x1="36" y1="36" x2="16" y2="18" className="ge-link" />
                  <line x1="36" y1="36" x2="58" y2="22" className="ge-link" />
                  <line x1="36" y1="36" x2="54" y2="56" className="ge-link" />
                  <circle cx="16" cy="18" r="4" className="ge-node ge-node-dim" />
                  <circle cx="58" cy="22" r="4" className="ge-node" />
                  <circle cx="54" cy="56" r="4" className="ge-node" />
                  <circle cx="36" cy="36" r="7" className="ge-node ge-node-hub" />
                </svg>
              </div>
              <strong>
                {settings.scope === "local"
                  ? localEmptyReason === "filtered"
                    ? "No notes match these filters"
                    : localEmptyReason === "missing"
                      ? "This note is not in the graph"
                      : localEmptyReason === "unlinked"
                        ? "No links from this note"
                        : "Open a note"
                  : "Your graph is empty"}
              </strong>
              <span>
                {settings.scope === "local" ? (
                  localEmptyReason === "filtered" ? (
                    <>Lower Min links or turn off Hide unlinked.</>
                  ) : localEmptyReason === "missing" ? (
                    <>Only Markdown notes appear in the graph.</>
                  ) : localEmptyReason === "unlinked" ? (
                    <>Add a <code>[[wikilink]]</code> to connect it to another note.</>
                  ) : (
                    <>Open a note to see its links and backlinks.</>
                  )
                ) : (
                  <>
                    Write a note, then link notes with <code>[[wikilinks]]</code> to grow a
                    map of your ideas.
                  </>
                )}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
