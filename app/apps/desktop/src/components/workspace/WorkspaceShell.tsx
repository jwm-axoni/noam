import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { TabBar } from "../TabBar";
import { useStore } from "../../store";
import {
  PANE_SEPARATOR_SIZE,
  bottomResizeBounds,
  dockResizeBounds,
  fitBottomDock,
  fitWorkspace,
} from "../../layout/geometry";
import { getDockDragSnapshot, subscribeDockDrag } from "../../layout/dragSession";
import { lazyPanel, panelRegistry } from "../../layout/panelRegistry";
import { useLayoutPersistence } from "../../layout/persistence";
import { useLayoutStore } from "../../layout/store";
import { closePanelTab } from "../../layout/workspaceActions";
import {
  CENTER_NOTE_GROUP_ID,
  DEFAULT_BOTTOM_HEIGHT,
  DEFAULT_LEFT_WIDTH,
  DEFAULT_RIGHT_WIDTH,
  PANEL_ALLOWED_ZONES,
  type LayoutTab,
  type PanelType,
  type ZoneId,
} from "../../layout/types";
import { ActivityBar } from "./ActivityBar";
import { DockZone } from "./DockZone";
import { DocumentHost } from "./DocumentHost";
import { PaneSeparator } from "./PaneSeparator";
import { PanelFrame } from "./PanelFrame";
import { PresenceLiveRegion, usePresenceAutoOpen } from "../PresenceLiveRegion";
import "../../styles/workspace.css";

const PANEL_COMPONENTS = {
  files: lazyPanel("files"),
  search: lazyPanel("search"),
  backlinks: lazyPanel("backlinks"),
  properties: lazyPanel("properties"),
  outline: lazyPanel("outline"),
  graph: lazyPanel("graph"),
  history: lazyPanel("history"),
  workflows: lazyPanel("workflows"),
  tasks: lazyPanel("tasks"),
  calendar: lazyPanel("calendar"),
  presence: lazyPanel("presence"),
  review: lazyPanel("review"),
  terminal: lazyPanel("terminal"),
  gallery: lazyPanel("gallery"),
};

interface WorkspaceShellProps {
  vaultKey: string;
  vaultEpoch: number;
  center: ReactNode;
  historyAvailable?: boolean;
  onPanelOpen?: (type: PanelType) => void;
  onPanelClose?: (type: PanelType) => void;
}

function focusAfterClose(type: PanelType): void {
  window.requestAnimationFrame(() => {
    const activity = document.querySelector<HTMLElement>(`[data-activity-panel="${type}"]`);
    if (activity) activity.focus();
    else document.querySelector<HTMLElement>(".editor-host .cm-content")?.focus();
  });
}

function WorkspaceGroup({
  groupId,
  zone,
  vaultKey,
  vaultEpoch,
  document,
  onPanelClose,
}: {
  groupId: string;
  zone?: ZoneId;
  vaultKey: string;
  vaultEpoch: number;
  document?: ReactNode;
  onPanelClose?: (type: PanelType) => void;
}) {
  const group = useLayoutStore((state) => state.layout.groups[groupId]);
  const panels = useLayoutStore((state) => state.layout.panels);
  const activeNotePath = useStore((state) => state.openNote?.path ?? null);
  if (!group) return null;
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId);
  const activePanel = activeTab?.kind === "panel" ? panels[activeTab.panelId] : null;
  const closeActive = () => {
    if (!activePanel || !activeTab) return;
    const type = activePanel.type;
    void closePanelTab(groupId, activeTab.id).then(() => {
      onPanelClose?.(type);
      focusAfterClose(type);
    });
  };
  // Same animated, focus-returning close as closeActive, but for an arbitrary
  // tab — the TabBar's × / middle-click / context-menu path for panel tabs.
  // Without this, closing a center tool tab skipped the collapse animation on
  // side zones and the focus return to the invoker or editor.
  const closePanelTabById = (tab: LayoutTab) => {
    const panel = tab.kind === "panel" ? panels[tab.panelId] : null;
    if (!panel) return;
    const type = panel.type;
    void closePanelTab(groupId, tab.id).then(() => {
      onPanelClose?.(type);
      focusAfterClose(type);
    });
  };

  const bodies = group.tabs.map((tab) => {
    if (tab.kind !== "panel") return null;
    const panel = panels[tab.panelId];
    if (!panel) return null;
    const Body = PANEL_COMPONENTS[panel.type];
    const visible = tab.id === group.activeTabId;
    return (
      <div
        key={panel.id}
        className={`workspace-panel-instance${visible ? " visible" : ""}`}
        data-panel-id={panel.id}
        data-panel-type={panel.type}
        data-panel-visible={visible ? "true" : "false"}
        tabIndex={visible ? -1 : undefined}
        inert={visible ? undefined : true}
        aria-hidden={visible ? undefined : true}
      >
        <Suspense fallback={<div className="workspace-panel-placeholder">Loading…</div>}>
          <Body
            instanceId={panel.id}
            vaultKey={vaultKey}
            vaultEpoch={vaultEpoch}
            activeNotePath={activeNotePath}
            visible={visible}
            compact={!group.permanent}
            onOpenNote={(path) => void useStore.getState().openNoteByPath(path)}
            onRequestClose={closeActive}
          />
        </Suspense>
      </div>
    );
  });

  if (group.permanent) {
    return (
      <div className="workspace-group-content workspace-note-group">
        <TabBar groupId={groupId} onClosePanelTab={closePanelTabById} />
        <div className="workspace-group-surface">
          {document != null && <DocumentHost hidden={activePanel != null}>{document}</DocumentHost>}
          <div className="workspace-center-panels">{bodies}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-group-content">
      {activePanel && activeTab?.kind === "panel" && (
        <PanelFrame
          title={panelRegistry[activePanel.type].label}
          icon={panelRegistry[activePanel.type].icon}
          groupId={groupId}
          tabId={activeTab.id}
          panelType={activePanel.type}
          onClose={closeActive}
          resetKeys={[activePanel.id, activeNotePath]}
          windowDrag={zone !== "bottom"}
          onCollapse={zone === "bottom" ? collapseBottom : undefined}
        >
          {bodies}
        </PanelFrame>
      )}
    </div>
  );
}

function collapseBottom(): void {
  useLayoutStore.getState().dispatch({ type: "set-zone-collapsed", zone: "bottom", collapsed: true });
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(".editor-host .cm-content")?.focus();
  });
}

/**
 * The empty bottom dock has no surface to drop on, so while a tab that is
 * allowed there is being dragged, a strip appears along the bottom of the
 * center column. It carries `data-empty-zone="bottom"` for `useDockDrag`.
 */
function BottomDropStrip({ drag }: { drag: ReturnType<typeof getDockDragSnapshot> }) {
  const layout = useLayoutStore((state) => state.layout);
  if (!drag.source || layout.zones.bottom.groupIds.length > 0) return null;
  const tab = layout.groups[drag.source.groupId]?.tabs.find((t) => t.id === drag.source?.tabId);
  const panel = tab?.kind === "panel" ? layout.panels[tab.panelId] : null;
  if (!panel || !PANEL_ALLOWED_ZONES[panel.type].includes("bottom")) return null;
  const armed = drag.target?.kind === "zone" && drag.target.zone === "bottom";
  return (
    <div className={`workspace-bottom-drop${armed ? " armed" : ""}`} data-empty-zone="bottom" aria-hidden="true">
      <span>Drop to dock at the bottom</span>
    </div>
  );
}

export function WorkspaceShell({
  vaultKey,
  vaultEpoch,
  center,
  historyAvailable = false,
  onPanelOpen,
  onPanelClose,
}: WorkspaceShellProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hydrated = useLayoutPersistence(vaultKey);
  usePresenceAutoOpen(vaultKey, hydrated);
  const layout = useLayoutStore((state) => state.layout);
  const drag = useSyncExternalStore(subscribeDockDrag, getDockDragSnapshot, getDockDragSnapshot);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportWidth(entry.contentRect.width);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const leftRequested = hydrated && layout.zones.left.groupIds.length > 0 && !layout.zones.left.userCollapsed;
  const rightRequested = hydrated && layout.zones.right.groupIds.length > 0 && !layout.zones.right.userCollapsed;
  const fit = useMemo(() => fitWorkspace({
    viewportWidth,
    leftOpen: leftRequested,
    rightOpen: rightRequested,
    preferredLeft: layout.zones.left.preferredWidth,
    preferredRight: layout.zones.right.preferredWidth,
    leastRecentlyUsed: layout.zones.right.groupIds.includes(layout.focusedGroupId) ? "left" : "right",
  }), [viewportWidth, leftRequested, rightRequested, layout]);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const [columnHeight, setColumnHeight] = useState(0);
  useEffect(() => {
    const column = columnRef.current;
    if (!column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setColumnHeight(entry.contentRect.height);
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, []);
  const bottomOpen = hydrated && layout.zones.bottom.groupIds.length > 0 && !layout.zones.bottom.userCollapsed;
  const bottomHeight = fitBottomDock({
    columnHeight,
    open: bottomOpen,
    preferredHeight: layout.zones.bottom.preferredHeight,
  });
  const bottomBounds = bottomResizeBounds(columnHeight);
  const previewBottom = (height: number) => {
    columnRef.current?.style.setProperty("--workspace-bottom-height", `${height}px`);
  };

  const leftBounds = dockResizeBounds("left", viewportWidth, fit.rightWidth);
  const rightBounds = dockResizeBounds("right", viewportWidth, fit.leftWidth);
  const dispatch = useLayoutStore.getState().dispatch;

  const preview = (side: "left" | "right", width: number) => {
    shellRef.current?.style.setProperty(`--workspace-${side}-width`, `${width}px`);
  };
  const restorePreview = () => {
    preview("left", fit.leftWidth);
    preview("right", fit.rightWidth);
  };

  return (
    <div
      ref={shellRef}
      className="workspace-shell"
      style={{
        "--workspace-left-width": `${fit.leftWidth}px`,
        "--workspace-right-width": `${fit.rightWidth}px`,
        "--workspace-left-separator": `${fit.leftWidth > 0 ? PANE_SEPARATOR_SIZE : 0}px`,
        "--workspace-right-separator": `${fit.rightWidth > 0 ? PANE_SEPARATOR_SIZE : 0}px`,
      } as React.CSSProperties}
    >
      <div className="workspace-titlebar-drag" data-tauri-drag-region aria-hidden="true" />
      <ActivityBar side="left" onNewNote={() => void useStore.getState().createNoteIn("")} onPanelOpen={onPanelOpen} />
      <DockZone zoneId="left">
        {hydrated && layout.zones.left.groupIds.map((groupId) => (
          <WorkspaceGroup key={groupId} groupId={groupId} vaultKey={vaultKey} vaultEpoch={vaultEpoch} onPanelClose={onPanelClose} />
        ))}
      </DockZone>
      {fit.leftWidth > 0 ? (
        <PaneSeparator
          orientation="vertical" value={fit.leftWidth} min={leftBounds.min} max={leftBounds.max}
          defaultValue={DEFAULT_LEFT_WIDTH} label="Resize left dock" className="workspace-separator-left"
          onPreview={(width) => preview("left", width)}
          onCommit={(width) => dispatch({ type: "resize-zone", zone: "left", width })}
          onCancel={restorePreview}
        />
      ) : <div className="pane-separator-placeholder workspace-separator-left" />}
      <div
        ref={columnRef}
        className="workspace-center-column"
        style={{
          "--workspace-bottom-height": `${bottomHeight}px`,
          "--workspace-bottom-separator": `${bottomHeight > 0 ? PANE_SEPARATOR_SIZE : 0}px`,
        } as React.CSSProperties}
      >
        <DockZone zoneId="center">
          {layout.zones.center.groupIds.map((groupId) => (
            <WorkspaceGroup
              key={groupId}
              groupId={groupId}
              zone="center"
              vaultKey={vaultKey}
              vaultEpoch={vaultEpoch}
              document={groupId === CENTER_NOTE_GROUP_ID ? center : undefined}
              onPanelClose={onPanelClose}
            />
          ))}
        </DockZone>
        {bottomHeight > 0 ? (
          <PaneSeparator
            orientation="horizontal" value={bottomHeight} min={bottomBounds.min} max={bottomBounds.max}
            defaultValue={DEFAULT_BOTTOM_HEIGHT} direction={-1} label="Resize bottom panel"
            className="workspace-separator-bottom"
            onPreview={previewBottom}
            onCommit={(height) => dispatch({ type: "resize-bottom", height })}
            onCancel={() => previewBottom(bottomHeight)}
          />
        ) : <div className="pane-separator-placeholder workspace-separator-bottom" />}
        {/* Always mounted, even collapsed: a hidden terminal keeps its view and
            its shell, and comes back exactly as it was. */}
        <DockZone zoneId="bottom" className={bottomHeight > 0 ? "" : "is-collapsed"}>
          {hydrated && layout.zones.bottom.groupIds.map((groupId) => (
            <WorkspaceGroup key={groupId} groupId={groupId} zone="bottom" vaultKey={vaultKey} vaultEpoch={vaultEpoch} onPanelClose={onPanelClose} />
          ))}
        </DockZone>
        <BottomDropStrip drag={drag} />
      </div>
      {fit.rightWidth > 0 ? (
        <PaneSeparator
          orientation="vertical" value={fit.rightWidth} min={rightBounds.min} max={rightBounds.max}
          defaultValue={DEFAULT_RIGHT_WIDTH} direction={-1} label="Resize right dock" className="workspace-separator-right"
          onPreview={(width) => preview("right", width)}
          onCommit={(width) => dispatch({ type: "resize-zone", zone: "right", width })}
          onCancel={restorePreview}
        />
      ) : <div className="pane-separator-placeholder workspace-separator-right" />}
      <DockZone zoneId="right">
        {hydrated && layout.zones.right.groupIds.map((groupId) => (
          <WorkspaceGroup key={groupId} groupId={groupId} vaultKey={vaultKey} vaultEpoch={vaultEpoch} onPanelClose={onPanelClose} />
        ))}
      </DockZone>
      <ActivityBar side="right" historyAvailable={historyAvailable} onPanelOpen={onPanelOpen} />
      <PresenceLiveRegion />
      {drag.source && (
        <div className="dock-drag-label" style={{ left: drag.clientX + 12, top: drag.clientY + 14 }} aria-hidden="true">
          {drag.source.label}
        </div>
      )}
    </div>
  );
}
