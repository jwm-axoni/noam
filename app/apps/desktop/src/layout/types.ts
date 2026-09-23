export const ZONE_IDS = ["left", "center", "right"] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

export const PANEL_TYPES = [
  "files",
  "search",
  "backlinks",
  "properties",
  "outline",
  "graph",
  "history",
  "workflows",
  "tasks",
  "calendar",
  "presence",
  "review",
] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

export type SplitAxis = "x" | "y";

export interface NoteTab {
  id: string;
  kind: "note";
  path: string;
}

export interface PanelTab {
  id: string;
  kind: "panel";
  panelId: string;
}

export type LayoutTab = NoteTab | PanelTab;

export interface LayoutGroup {
  id: string;
  tabs: LayoutTab[];
  activeTabId: string | null;
  /** The sole note host is never removed, including while it has no tabs. */
  permanent?: boolean;
}

export interface LayoutZone {
  groupIds: string[];
  axis: SplitAxis;
  ratio: number;
  /** Relative heights keyed by group, for a vertically stacked right dock. */
  groupSizes?: Record<string, number>;
  /** The user's choice. Viewport fitting never writes its temporary result here. */
  preferredWidth: number;
  userCollapsed: boolean;
}

export interface PanelInstance {
  id: string;
  type: PanelType;
  stateVersion: number;
  state: Record<string, unknown>;
}

export interface LayoutV1 {
  version: 1;
  zones: Record<ZoneId, LayoutZone>;
  groups: Record<string, LayoutGroup>;
  panels: Record<string, PanelInstance>;
  focusedGroupId: string;
}

export const CENTER_NOTE_GROUP_ID = "group:center:note";
export const LEFT_FILES_GROUP_ID = "group:left:files";
export const FILES_PANEL_ID = "panel:files";

export const DEFAULT_LEFT_WIDTH = 264;
export const DEFAULT_RIGHT_WIDTH = 320;
export const WORKSPACE_RESIZE_EVENT = "noam:workspace-resize";

export const PANEL_ALLOWED_ZONES: Readonly<Record<PanelType, readonly ZoneId[]>> = {
  files: ["left", "right"],
  search: ["left", "right", "center"],
  backlinks: ["left", "right", "center"],
  properties: ["left", "right", "center"],
  outline: ["left", "right", "center"],
  graph: ["left", "right", "center"],
  history: ["left", "right", "center"],
  // A dock list, not a document surface: it belongs beside the files tree.
  workflows: ["left", "right"],
  // Same reasoning: a standing list you work a note FROM, not a note surface.
  tasks: ["left", "right"],
  calendar: ["left", "right"],
  // Who is here: a standing roster beside the note, never a document surface.
  presence: ["left", "right"],
  review: ["left", "right", "center"],
};

export const PANEL_MULTIPLICITY: Readonly<Record<PanelType, number>> = {
  files: 1,
  search: 1,
  backlinks: 1,
  properties: 1,
  outline: 1,
  graph: 2,
  history: 1,
  workflows: 1,
  tasks: 1,
  calendar: 1,
  presence: 1,
  review: 1,
};

export function isZoneId(value: unknown): value is ZoneId {
  return typeof value === "string" && (ZONE_IDS as readonly string[]).includes(value);
}

export function isPanelType(value: unknown): value is PanelType {
  return typeof value === "string" && (PANEL_TYPES as readonly string[]).includes(value);
}

export function createDefaultLayout(legacyLeftWidth = DEFAULT_LEFT_WIDTH): LayoutV1 {
  const leftWidth = Number.isFinite(legacyLeftWidth)
    ? Math.min(560, Math.max(220, Math.round(legacyLeftWidth)))
    : DEFAULT_LEFT_WIDTH;
  return {
    version: 1,
    zones: {
      left: {
        groupIds: [LEFT_FILES_GROUP_ID],
        axis: "y",
        ratio: 0.5,
        preferredWidth: leftWidth,
        userCollapsed: false,
      },
      center: {
        groupIds: [CENTER_NOTE_GROUP_ID],
        axis: "x",
        ratio: 0.5,
        preferredWidth: 0,
        userCollapsed: false,
      },
      right: {
        groupIds: [],
        axis: "y",
        ratio: 0.5,
        preferredWidth: DEFAULT_RIGHT_WIDTH,
        userCollapsed: true,
      },
    },
    groups: {
      [LEFT_FILES_GROUP_ID]: {
        id: LEFT_FILES_GROUP_ID,
        tabs: [{ id: "tab:files", kind: "panel", panelId: FILES_PANEL_ID }],
        activeTabId: "tab:files",
      },
      [CENTER_NOTE_GROUP_ID]: {
        id: CENTER_NOTE_GROUP_ID,
        tabs: [],
        activeTabId: null,
        permanent: true,
      },
    },
    panels: {
      [FILES_PANEL_ID]: {
        id: FILES_PANEL_ID,
        type: "files",
        stateVersion: 1,
        state: {},
      },
    },
    focusedGroupId: CENTER_NOTE_GROUP_ID,
  };
}

/** Right-side vertical stacks can hold every available tool; other zones retain one split. */
export function canSplitZone(zoneId: ZoneId, zone: LayoutZone, axis: SplitAxis): boolean {
  return zone.groupIds.length < 2 ||
    (zoneId === "right" && axis === "y" && zone.axis === "y" && zone.groupIds.length < 12);
}
