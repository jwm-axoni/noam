import { lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import type { PanelType, ZoneId } from "./types";

export interface PanelBodyProps {
  instanceId: string;
  vaultKey: string;
  vaultEpoch: number;
  activeNotePath: string | null;
  visible: boolean;
  compact: boolean;
  onOpenNote: (path: string) => void;
  onRequestClose: () => void;
}

export interface PanelRegistration {
  type: PanelType;
  label: string;
  icon: ReactNode;
  defaultZone: ZoneId;
  defaultGroup: "primary" | "secondary";
  allowedZones: readonly ZoneId[];
  minimumWidth: number;
  minimumHeight: number;
  multiplicity: 1 | 2;
  load: () => Promise<{ default: ComponentType<PanelBodyProps> }>;
  validateState: (state: unknown) => state is Record<string, unknown>;
  persistentState: (state: Record<string, unknown>) => Record<string, unknown>;
}

const emptyState = (state: unknown): state is Record<string, unknown> =>
  state != null && typeof state === "object" && !Array.isArray(state);
const noPersistentState = () => ({});
const graphPersistentState = (state: Record<string, unknown>) => {
  const durableKeys = [
    "scope", "localDepth", "charge", "linkDistance", "linkStrength", "gravity",
    "nodeSize", "edgeThickness", "labelScale", "colorMode", "minDegree", "hideOrphans",
  ];
  return Object.fromEntries(durableKeys.flatMap((key) =>
    state[key] === undefined ? [] : [[key, state[key]]],
  ));
};

const icon = (children: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const filesLoader: PanelRegistration["load"] = () =>
  import("../components/FileTree").then(({ FileTree }) => ({
    default: function FilesPanel() {
      return <FileTree />;
    },
  }));

const searchLoader: PanelRegistration["load"] = () =>
  import("../components/SearchPanel").then(({ SearchPanel }) => ({
    default: function SearchPanelBody(props: PanelBodyProps) {
      return <SearchPanel {...props} />;
    },
  }));

const backlinksLoader: PanelRegistration["load"] = () =>
  import("../components/BacklinksPanel").then(({ BacklinksPanel }) => ({
    default: function BacklinksPanelBody(props: PanelBodyProps) {
      return <BacklinksPanel {...props} />;
    },
  }));

const graphLoader: PanelRegistration["load"] = () =>
  import("../components/GraphPanel").then(({ GraphPanel }) => ({ default: GraphPanel }));

const historyLoader: PanelRegistration["load"] = () =>
  import("../components/VersionPanel").then(({ VersionPanel }) => ({
    default: function HistoryPanelBody({ onRequestClose }: PanelBodyProps) {
      return <VersionPanel onRequestClose={onRequestClose} />;
    },
  }));

const outlineLoader: PanelRegistration["load"] = () =>
  import("../components/OutlinePanel").then(({ OutlinePanel }) => ({
    default: OutlinePanel,
  }));

export const panelRegistry = {
  files: {
    type: "files",
    label: "Files",
    defaultZone: "left",
    defaultGroup: "primary",
    icon: icon(<><path d="M3 6.5h7l2 2h9v10H3z" /><path d="M3 6.5V4h7l2 2" /></>),
    allowedZones: ["left", "right"],
    minimumWidth: 220,
    minimumHeight: 180,
    multiplicity: 1,
    load: filesLoader,
    validateState: emptyState,
    persistentState: noPersistentState,
  },
  search: {
    type: "search",
    label: "Search",
    defaultZone: "left",
    defaultGroup: "primary",
    icon: icon(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
    allowedZones: ["left", "right", "center"],
    minimumWidth: 220,
    minimumHeight: 180,
    multiplicity: 1,
    load: searchLoader,
    validateState: emptyState,
    persistentState: noPersistentState,
  },
  backlinks: {
    type: "backlinks",
    label: "Backlinks",
    defaultZone: "right",
    defaultGroup: "primary",
    icon: icon(<><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1" /></>),
    allowedZones: ["left", "right", "center"],
    minimumWidth: 220,
    minimumHeight: 180,
    multiplicity: 1,
    load: backlinksLoader,
    validateState: emptyState,
    persistentState: noPersistentState,
  },
  outline: {
    type: "outline",
    label: "Outline",
    defaultZone: "right",
    defaultGroup: "primary",
    icon: icon(<><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r=".7" /><circle cx="4" cy="12" r=".7" /><circle cx="4" cy="18" r=".7" /></>),
    allowedZones: ["left", "right", "center"],
    minimumWidth: 220,
    minimumHeight: 180,
    multiplicity: 1,
    load: outlineLoader,
    validateState: emptyState,
    persistentState: noPersistentState,
  },
  graph: {
    type: "graph",
    label: "Graph",
    defaultZone: "right",
    defaultGroup: "secondary",
    icon: icon(<><circle cx="5" cy="6" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="13" r="2" /><circle cx="19" cy="19" r="2" /><path d="m7 7 3.5 4M14 11.5l2.5-4.5M13.5 14.5l4 3" /></>),
    allowedZones: ["left", "right", "center"],
    minimumWidth: 240,
    minimumHeight: 180,
    multiplicity: 2,
    load: graphLoader,
    validateState: emptyState,
    persistentState: graphPersistentState,
  },
  history: {
    type: "history",
    label: "Version history",
    defaultZone: "right",
    defaultGroup: "primary",
    icon: icon(<><path d="M3 12a9 9 0 1 0 2.6-6.4" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></>),
    allowedZones: ["left", "right", "center"],
    minimumWidth: 220,
    minimumHeight: 180,
    multiplicity: 1,
    load: historyLoader,
    validateState: emptyState,
    persistentState: noPersistentState,
  },
} as const satisfies Record<PanelType, PanelRegistration>;

export function lazyPanel(type: PanelType): LazyExoticComponent<ComponentType<PanelBodyProps>> {
  return lazy(panelRegistry[type].load);
}
