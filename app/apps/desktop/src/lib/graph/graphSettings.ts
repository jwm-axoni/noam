// Shared contract for the Graph View's tunable settings. Every graph module
// imports the types + defaults from here so the simulation, renderer, color
// assignment, and controls panel all agree on one shape.
//
// Settings persist to localStorage under SETTINGS_STORAGE_KEY so a user's tuned
// physics/visual preferences survive app restarts.

/** How node fill colors are derived. */
export type ColorMode = "type" | "folder" | "degree" | "uniform";

/** What the graph draws: the whole vault or the open note's neighborhood. */
export type GraphScope = "local" | "global";

export interface GraphSettings {
  // ---- Scope ----
  /** Draw the open note's local neighborhood, or the whole vault. */
  scope: GraphScope;
  /** Number of link hops shown in local scope. */
  localDepth: number;

  // ---- Forces (physics) ----
  /** Many-body repulsion. More negative = stronger push-apart. */
  charge: number;
  /** Rest length of link springs, in world units. */
  linkDistance: number;
  /** Link spring stiffness, 0..1. */
  linkStrength: number;
  /** Pull toward the center of gravity, 0..0.5. Higher = tighter circle. */
  gravity: number;

  // ---- Visual ----
  /** Multiplier on every node's base radius. */
  nodeSize: number;
  /** Multiplier on edge line width. */
  edgeThickness: number;
  /**
   * Label density, 0..2. Names are visible at rest and thinned by screen-space
   * collisions (see lib/graph/labels.ts); this sets how much clear space each
   * one demands, so turning it up packs more names in. 0 keeps only the pinned
   * labels — the open note, the hovered node and search matches.
   */
  labelScale: number;
  /** Node fill color strategy. */
  colorMode: ColorMode;

  // ---- Filter ----
  /** Case-insensitive title substring; non-matches are dimmed (empty = no filter). */
  search: string;
  /** Hide nodes whose degree (linkCount) is below this. */
  minDegree: number;
  /** Hide nodes with zero links. */
  hideOrphans: boolean;
}

// Tuned by hand against a real ~3.4k-note vault rather than derived: long links
// with a soft spring and light gravity let the hubs separate into distinct
// clusters instead of packing into one ball, and small nodes with `minDegree: 1`
// keep the field readable at that size. These are the values the graph is
// actually designed to look right at, so they are the defaults.
export const DEFAULT_SETTINGS: GraphSettings = {
  scope: "global",
  localDepth: 1,
  charge: -24,
  linkDistance: 337,
  linkStrength: 0.44,
  gravity: 0.21,
  nodeSize: 0.4,
  edgeThickness: 1.3,
  labelScale: 0.25,
  colorMode: "type",
  search: "",
  minDegree: 0,
  hideOrphans: false,
};

/** Inclusive slider ranges + step for the numeric controls, keyed by setting. */
export const SETTING_RANGES = {
  charge: { min: -1500, max: -1, step: 0.2 },
  linkDistance: { min: 1, max: 400, step: 0.5 },
  linkStrength: { min: 0, max: 1, step: 0.02 },
  gravity: { min: 0, max: 1, step: 0.01 },
  nodeSize: { min: 0.4, max: 4, step: 0.1 },
  edgeThickness: { min: 0.4, max: 4, step: 0.1 },
  labelScale: { min: 0, max: 2, step: 0.05 },
  minDegree: { min: 0, max: 20, step: 1 },
} as const;

// v7 migrates only the old default repulsion; custom tuning and filters survive.
export const SETTINGS_STORAGE_KEY = "context.graph.settings.v7";
const LEGACY_SETTINGS_STORAGE_KEYS = ["context.graph.settings.v6", "context.graph.settings.v5", "context.graph.settings.v4"];
const PRIMARY_GRAPH_INSTANCE_ID = "panel:graph";

function validColorMode(value: unknown): value is ColorMode {
  return value === "type" || value === "folder" || value === "degree" || value === "uniform";
}

function validScope(value: unknown): value is GraphScope {
  return value === "global" || value === "local";
}

/** Load persisted settings, merged over defaults (tolerant of missing/old keys). */
export function loadSettings(instanceId?: string): GraphSettings {
  try {
    const key = instanceId ? `${SETTINGS_STORAGE_KEY}:${instanceId}` : SETTINGS_STORAGE_KEY;
    let raw = localStorage.getItem(key);
    let migrated = false;
    if (!raw && instanceId) {
      raw = localStorage.getItem(`context.graph.settings.v6:${instanceId}`);
      migrated = raw != null;
    }
    // The pre-Phase-3 graph was a singleton. Migrate that preference blob only
    // into the primary instance; a deliberately-created second graph is new and
    // therefore starts with the new type-color/orphan-visible defaults.
    if (!raw && (instanceId == null || instanceId === PRIMARY_GRAPH_INSTANCE_ID)) {
      const migrationKeys = instanceId == null
        ? LEGACY_SETTINGS_STORAGE_KEYS
        : [SETTINGS_STORAGE_KEY, ...LEGACY_SETTINGS_STORAGE_KEYS];
      for (const legacyKey of migrationKeys) {
        raw = localStorage.getItem(legacyKey);
        if (raw) { migrated = legacyKey !== SETTINGS_STORAGE_KEY; break; }
      }
    }
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GraphSettings>;
    if (migrated && parsed.charge === -10.8) parsed.charge = DEFAULT_SETTINGS.charge;
    const settings: GraphSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      colorMode: validColorMode(parsed.colorMode) ? parsed.colorMode : DEFAULT_SETTINGS.colorMode,
      scope: validScope(parsed.scope) ? parsed.scope : DEFAULT_SETTINGS.scope,
      localDepth: parsed.localDepth === 2 ? 2 : 1,
    };
    if (migrated) saveSettings(settings, instanceId);
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist settings (best-effort; ignores quota/serialization errors). */
export function saveSettings(settings: GraphSettings, instanceId?: string): void {
  try {
    const key = instanceId ? `${SETTINGS_STORAGE_KEY}:${instanceId}` : SETTINGS_STORAGE_KEY;
    localStorage.setItem(key, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
