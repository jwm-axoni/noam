import type { ColorMode } from "./graphSettings";
import type { GraphNode } from "./buildGraph";

/** One row of the legend the panel renders alongside the canvas. */
export interface LegendEntry {
  label: string;
  color: string;
  count: number;
}

/** Result of a coloring pass: a per-node lookup plus a summarizing legend. */
export interface ColorResult {
  colorById: Map<string, string>;
  legend: LegendEntry[];
}

export type GraphSurface = "light" | "dark";

/**
 * Categorical palettes, one per surface: Catppuccin Mocha pastels on dark,
 * their Catppuccin Latte counterparts on light (same hue at the same index, so
 * a folder or custom type keeps its identity across a theme flip). Muted on
 * purpose, matching Obsidian's graph: saturated hues made the field shout.
 * Ordered to alternate warm and cool so neighbouring folders stay apart. The
 * grey Overlay tone is reserved for "unknown type" and never cycles here, so a
 * real category never looks switched off.
 */
export const PALETTES: Record<GraphSurface, readonly string[]> = {
  dark: [
    "#89b4fa", // blue
    "#fab387", // peach
    "#a6e3a1", // green
    "#cba6f7", // mauve
    "#f9e2af", // yellow
    "#94e2d5", // teal
    "#f5c2e7", // pink
    "#b4befe", // lavender
    "#eba0ac", // maroon
    "#74c7ec", // sapphire
    "#f2cdcd", // flamingo
  ],
  light: [
    "#1e66f5", // blue
    "#fe640b", // peach
    "#40a02b", // green
    "#8839ef", // mauve
    "#df8e1d", // yellow
    "#179299", // teal
    "#ea76cb", // pink
    "#7287fd", // lavender
    "#e64553", // maroon
    "#209fb5", // sapphire
    "#dd7878", // flamingo
  ],
};

export const TYPE_COLORS = {
  dark: {
    meeting: "#f9e2af", // yellow
    person: "#f5c2e7", // pink
    project: "#cba6f7", // mauve
    organization: "#94e2d5", // teal
    resource: "#89b4fa", // blue
    system: "#a6e3a1", // green
    unknown: "#9399b2", // overlay
  },
  light: {
    meeting: "#df8e1d",
    person: "#ea76cb",
    project: "#8839ef",
    organization: "#179299",
    resource: "#1e66f5",
    system: "#40a02b",
    unknown: "#7c7f93",
  },
} as const satisfies Record<GraphSurface, Record<string, string>>;

type BuiltInType = keyof (typeof TYPE_COLORS)["dark"];

function hashType(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function assignByType(nodes: GraphNode[], surface: GraphSurface): ColorResult {
  const palette = PALETTES[surface];
  const types = TYPE_COLORS[surface];
  const counts = new Map<string, number>();
  const colors = new Map<string, string>();
  const colorById = new Map<string, string>();
  for (const node of nodes) {
    const value = node.type?.trim().toLowerCase() || "unknown";
    const color = value in types
      ? types[value as BuiltInType]
      : palette[hashType(value) % palette.length]!;
    colors.set(value, color);
    counts.set(value, (counts.get(value) ?? 0) + 1);
    colorById.set(node.id, color);
  }
  const label = (value: string) => value === "unknown"
    ? "Unknown / missing type"
    : value.replace(/(^|[-_\s]+)(\p{L})/gu, (_, gap: string, letter: string) =>
      `${gap ? " " : ""}${letter.toUpperCase()}`,
    );
  const legend = [...counts.keys()]
    .sort((a, b) => {
      if (a === "unknown") return 1;
      if (b === "unknown") return -1;
      return (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b);
    })
    .map((value) => ({ label: label(value), color: colors.get(value)!, count: counts.get(value)! }));
  return { colorById, legend };
}

/** Clamp to a byte so channel math never overflows the 0–255 range. */
function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Parse "#rrggbb" (or "#rgb") into [r,g,b]; falls back to mid-grey if unparseable. */
function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return [128, 128, 128];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: [number, number, number]): string {
  const s = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return `#${s(r)}${s(g)}${s(b)}`;
}

/**
 * Deterministic per-channel linear interpolation between two hex colors.
 * t is clamped to [0,1]; t=0 → a, t=1 → b. Kept intentionally simple (no
 * gamma/HSL) — the degree ramp only needs a visually monotonic blend.
 */
export function lerpHex(a: string, b: string, t: number): string {
  const clampT = Math.max(0, Math.min(1, t));
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex([
    ca[0] + (cb[0] - ca[0]) * clampT,
    ca[1] + (cb[1] - ca[1]) * clampT,
    ca[2] + (cb[2] - ca[2]) * clampT,
  ]);
}

/** Top-level folder segment of a note path; notes at the root bucket as "Root". */
function topFolder(path: string): string {
  return path.includes("/") ? path.split("/")[0] : "Root";
}

function assignByFolder(nodes: GraphNode[], surface: GraphSurface): ColorResult {
  // Stable colors: sort distinct folders alphabetically, then index into the palette.
  const palette = PALETTES[surface];
  const folders = Array.from(new Set(nodes.map((n) => topFolder(n.path)))).sort();
  const folderColor = new Map<string, string>();
  folders.forEach((f, i) => folderColor.set(f, palette[i % palette.length]));

  const colorById = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const f = topFolder(n.path);
    colorById.set(n.id, folderColor.get(f)!);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }

  const legend: LegendEntry[] = folders
    .map((f) => ({ label: f, color: folderColor.get(f)!, count: counts.get(f) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return { colorById, legend };
}

/**
 * Build a four-step sequential ramp from the active accent. The first step is
 * pulled slightly toward the canvas, while the upper steps move away from it.
 * This keeps every tier in the selected colour world without flattening dark
 * accents such as Ink or losing pale accents against the dark graph.
 */
export function degreeRamp(accent: string, surface: GraphSurface): string[] {
  const canvas = surface === "dark" ? "#000000" : "#ffffff";
  const contrast = surface === "dark" ? "#ffffff" : "#000000";
  return [
    lerpHex(accent, canvas, 0.18),
    lerpHex(accent, accent, 0),
    lerpHex(accent, contrast, 0.22),
    lerpHex(accent, contrast, 0.45),
  ];
}

function assignByDegree(
  nodes: GraphNode[],
  accent: string,
  surface: GraphSurface,
): ColorResult {
  const shades = degreeRamp(accent, surface);

  const maxDeg = nodes.reduce((m, n) => Math.max(m, n.linkCount), 0);

  // Tier boundaries on a LOG scale, not linear thirds.
  //
  // Link-degree in a real vault is heavy-tailed: on a 3.4k-note vault the top
  // node had 1259 links while the vast majority had a handful. Linear thirds of
  // [1, 1259] therefore produced tiers of "1–420 → 3370 nodes", "421–839 → 0",
  // "840–1259 → 5" — one bucket holding 99.9% of the graph, so almost every node
  // drew in the same shade and the colouring carried no information at all.
  // Splitting log(degree) instead puts the boundaries where the nodes are.
  const logSpan = Math.log(Math.max(2, maxDeg));
  const lowMax = Math.max(1, Math.round(Math.exp(logSpan / 3)));
  const midMax = Math.max(lowMax + 1, Math.round(Math.exp((logSpan * 2) / 3)));

  const tierOf = (deg: number): number => {
    if (deg <= 0) return 0;
    if (deg <= lowMax) return 1;
    if (deg <= midMax) return 2;
    return 3;
  };

  const colorById = new Map<string, string>();
  const counts = [0, 0, 0, 0];
  for (const n of nodes) {
    const t = tierOf(n.linkCount);
    colorById.set(n.id, shades[t]);
    counts[t]++;
  }

  const labels = [
    "0",
    lowMax <= 1 ? "1" : `1–${lowMax}`,
    midMax <= lowMax + 1 ? `${lowMax + 1}` : `${lowMax + 1}–${midMax}`,
    maxDeg <= midMax + 1 ? `${Math.max(midMax + 1, maxDeg)}` : `${midMax + 1}–${maxDeg}`,
  ];

  const legend: LegendEntry[] = [0, 1, 2, 3].map((i) => ({
    label: labels[i],
    color: shades[i],
    count: counts[i],
  }));

  return { colorById, legend };
}

/**
 * Assign a fill color to every node according to `mode`. Pure and deterministic
 * so the canvas layer can recolor on demand without side effects.
 */
export function assignColors(
  nodes: GraphNode[],
  mode: ColorMode,
  accent: string,
  surface: GraphSurface = "dark",
): ColorResult {
  switch (mode) {
    case "type":
      return assignByType(nodes, surface);
    case "folder":
      return assignByFolder(nodes, surface);
    case "degree":
      return assignByDegree(nodes, accent, surface);
    case "uniform":
    default: {
      const colorById = new Map<string, string>();
      for (const n of nodes) colorById.set(n.id, accent);
      return { colorById, legend: [] };
    }
  }
}
