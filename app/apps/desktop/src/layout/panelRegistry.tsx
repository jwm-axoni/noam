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
    default: function FilesPanel({ visible }: PanelBodyProps) {
      return <FileTree visible={visible} />;
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

const propertiesLoader: PanelRegistration["load"] = () =>
  import("../components/PropertiesDockPanel").then(({ PropertiesDockPanel }) => ({
    default: PropertiesDockPanel,
  }));

const graphLoader: PanelRegistration["load"] = () =>
  import("../components/GraphPanel").then(({ GraphPanel }) => ({ default: GraphPanel }));

const historyLoader: PanelRegistration["load"] = () =>
  import("../components/VersionPanel").then(({ VersionPanel }) => ({
    default: function HistoryPanelBody({ onRequestClose }: PanelBodyProps) {
      return <VersionPanel onRequestClose={onRequestClose} />;
    },
  }));

const workflowsLoader: PanelRegistration["load"] = () =>
  import("../components/workflows/WorkflowsPanel").then(({ WorkflowsPanel }) => ({
    default: WorkflowsPanel,
  }));

const tasksLoader: PanelRegistration["load"] = () =>
  import("../components/tasks/TasksPanel").then(({ TasksPanel }) => ({
    default: TasksPanel,
  }));

// The calendar panel itself takes every data source as a prop; the HOST is what
// wires them to this vault, so the registry loads the host.
const calendarLoader: PanelRegistration["load"] = () =>
  import("../components/calendar/CalendarPanelHost").then(({ CalendarPanelHost }) => ({
    default: CalendarPanelHost,
  }));

const presenceLoader: PanelRegistration["load"] = () =>
  import("../components/PresencePanel").then(({ PresencePanel }) => ({
    default: PresencePanel,
  }));

const reviewLoader: PanelRegistration["load"] = () =>
  import("../components/review/ReviewPanel").then(({ ReviewPanel }) => ({ default: ReviewPanel }));

/** Keep only the People panel's per-section collapsed flags. */
const presencePersistentState = (state: Record<string, unknown>) => {
  const raw = state.collapsed;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const collapsed = Object.fromEntries(
    (["online", "agents", "note"] as const).flatMap((key) =>
      typeof src[key] === "boolean" ? [[key, src[key]]] : [],
    ),
  );
  return { collapsed };
};

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
  properties: {
    type: "properties",
    label: "Properties",
    defaultZone: "right",
    defaultGroup: "primary",
    icon: icon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>),
    allowedZones: ["left", "right", "center"],
    minimumWidth: 260,
    minimumHeight: 220,
    multiplicity: 1,
    load: propertiesLoader,
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
  workflows: {
    type: "workflows",
    label: "Workflows",
    defaultZone: "left",
    defaultGroup: "primary",
    // lucide `zap`: a command you fire, not a document you read.
    icon: icon(<path d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9z" />),
    allowedZones: ["left", "right"],
    minimumWidth: 260,
    minimumHeight: 200,
    multiplicity: 1,
    load: workflowsLoader,
    validateState: emptyState,
    persistentState: noPersistentState,
  },
  tasks: {
    type: "tasks",
    label: "Tasks",
    defaultZone: "left",
    defaultGroup: "primary",
    // lucide `check-square`.
    icon: icon(<><path d="M9 11.5 12 14.5 21 5" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>),
    allowedZones: ["left", "right"],
    minimumWidth: 220,
    minimumHeight: 200,
    multiplicity: 1,
    load: tasksLoader,
    validateState: emptyState,
    persistentState: noPersistentState,
  },
  calendar: {
    type: "calendar",
    label: "Calendar",
    defaultZone: "left",
    defaultGroup: "primary",
    // lucide `calendar`.
    icon: icon(<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>),
    allowedZones: ["left", "right"],
    minimumWidth: 220,
    minimumHeight: 220,
    multiplicity: 1,
    load: calendarLoader,
    validateState: emptyState,
    persistentState: noPersistentState,
  },
  presence: {
    type: "presence",
    label: "People",
    defaultZone: "right",
    defaultGroup: "primary",
    // lucide `users`.
    icon: icon(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>),
    allowedZones: ["left", "right"],
    minimumWidth: 220,
    minimumHeight: 180,
    multiplicity: 1,
    load: presenceLoader,
    validateState: emptyState,
    persistentState: presencePersistentState,
  },
  review: {
    type: "review",
    label: "Review",
    defaultZone: "right",
    defaultGroup: "secondary",
    icon: icon(<><path d="M4 5h16v11H8l-4 4z" /><path d="m9 10.5 2 2 4-4" /></>),
    allowedZones: ["left", "right", "center"],
    minimumWidth: 320,
    minimumHeight: 220,
    multiplicity: 1,
    load: reviewLoader,
    validateState: emptyState,
    persistentState: noPersistentState,
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
