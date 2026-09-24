import { useEffect, useMemo, useRef, useState } from "react";
import { resolveVaultAsset } from "../lib/fileTypes/assetResolver";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { noteLabel } from "../lib/notePath";
import { panelRegistry } from "../layout/panelRegistry";
import { useLayoutStore } from "../layout/store";
import { CENTER_NOTE_GROUP_ID, type LayoutTab } from "../layout/types";
import { useDockDrag } from "../layout/useDockDrag";
import {
  applyTilingAction,
  closeAllTabs,
  closeOtherTabs,
  closeTabsToRight,
  tilingAvailability,
  type CloseTabsResult,
  type TilingAction,
} from "../layout/workspaceActions";
import { useStore } from "../store";
import { ViewportMenu } from "./ViewportMenu";
import { itemColorValue } from "../lib/appearance";
import { iconFromIndexed, type IndexedPresentation } from "../lib/presentation/types";
import { PresentationIcon } from "./PresentationIcon";
import "./presentation.css";

interface TabMenuState {
  tabId: string;
  /** Cursor position where the menu was requested; the menu opens here. */
  x: number;
  y: number;
}

function tabLabel(tab: LayoutTab, panels: ReturnType<typeof useLayoutStore.getState>["layout"]["panels"]): string {
  if (tab.kind === "note") return noteLabel(tab.path);
  const panel = panels[tab.panelId];
  return panel ? panelRegistry[panel.type].label : "Tool";
}

function reconcileClosed(result: CloseTabsResult): void {
  if (result.closedNotePaths.length === 0) return;
  const closed = new Set(result.closedNotePaths);
  const state = useStore.getState();
  useStore.setState({
    viewModeOverrides: Object.fromEntries(
      Object.entries(state.viewModeOverrides).filter(([path]) => !closed.has(path)),
    ),
  });
  if (!state.openNote || !closed.has(state.openNote.path)) return;
  if (result.nextTab?.kind === "note") void state.openNoteByPath(result.nextTab.path);
  else state.closeNote();
}

export function TabBar({ groupId = CENTER_NOTE_GROUP_ID, onClosePanelTab }: {
  groupId?: string;
  /** Focus-aware close for panel tabs (animated collapse on side zones, focus
   *  returns to the invoker or editor). Falls back to a raw close-tab dispatch. */
  onClosePanelTab?: (tab: LayoutTab) => void;
}) {
  const group = useLayoutStore((state) => state.layout.groups[groupId]);
  const panels = useLayoutStore((state) => state.layout.panels);
  const openingPath = useStore((state) => state.openingNotePath);
  const titles = useStore((state) => state.titles);
  const vaultPath = useStore((state) => state.vault?.path ?? null);
  const presentationByPath = useMemo(
    () => new Map(titles.map((title) => [title.path, title])),
    [titles],
  );
  const reduceMotion = useReducedMotion();
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [rovingId, setRovingId] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const listTriggerRef = useRef<HTMLButtonElement | null>(null);
  const listMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const activeId = group?.activeTabId ?? null;
  const tabs = group?.tabs ?? [];

  useEffect(() => {
    if (activeId) setRovingId(activeId);
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-workspace-tab-id="${CSS.escape(activeId ?? "")}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  useEffect(() => {
    if (!menu && !listOpen) return;
    const close = () => { setMenu(null); setListOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const contextTabId = menu?.tabId;
      close();
      requestAnimationFrame(() => {
        if (contextTabId) {
          stripRef.current
            ?.querySelector<HTMLElement>(`[data-workspace-tab-id="${CSS.escape(contextTabId)}"]`)
            ?.focus();
        } else {
          listTriggerRef.current?.focus();
        }
      });
    };
    window.addEventListener("blur", close);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu, listOpen]);

  if (!group) return null;

  const activate = (tab: LayoutTab) => {
    if (tab.kind === "note") void useStore.getState().openNoteByPath(tab.path);
    else useLayoutStore.getState().dispatch({ type: "activate-tab", groupId, tabId: tab.id });
  };
  const closeOne = (tab: LayoutTab) => {
    if (tab.kind === "note") useStore.getState().closeTab(tab.path);
    else if (onClosePanelTab) onClosePanelTab(tab);
    else useLayoutStore.getState().dispatch({ type: "close-tab", groupId, tabId: tab.id });
  };
  const moveFocus = (fromId: string, step: number | "first" | "last") => {
    const index = tabs.findIndex((tab) => tab.id === fromId);
    if (index < 0 || tabs.length === 0) return;
    const next = step === "first"
      ? tabs[0]!
      : step === "last"
        ? tabs[tabs.length - 1]!
        : tabs[(index + step + tabs.length) % tabs.length]!;
    setRovingId(next.id);
    requestAnimationFrame(() => stripRef.current
      ?.querySelector<HTMLElement>(`[data-workspace-tab-id="${CSS.escape(next.id)}"]`)
      ?.focus());
  };
  const selected = menu ? tabs.find((tab) => tab.id === menu.tabId) : null;
  const selectedIndex = selected ? tabs.indexOf(selected) : -1;
  return (
    <div className="workspace-tab-row">
      <div
        className="tab-strip"
        role="tablist"
        aria-label="Workspace tabs"
        ref={stripRef}
        data-tauri-drag-region
      >
        <LayoutGroup id={`workspace-tabs:${groupId}`}>
          {tabs.map((tab) => (
            <WorkspaceTab
              key={tab.id}
              groupId={groupId}
              tab={tab}
              label={tabLabel(tab, panels)}
              presentation={tab.kind === "note" ? presentationByPath.get(tab.path) : undefined}
              vaultPath={vaultPath}
              active={tab.id === activeId}
              opening={tab.kind === "note" && tab.path === openingPath && tab.id !== activeId}
              tabIndex={(rovingId ?? activeId ?? tabs[0]?.id) === tab.id ? 0 : -1}
              reduceMotion={!!reduceMotion}
              onActivate={() => activate(tab)}
              onClose={() => closeOne(tab)}
              onFocus={() => setRovingId(tab.id)}
              onMoveFocus={(step) => moveFocus(tab.id, step)}
              onMenu={(position) => setMenu({ tabId: tab.id, ...position })}
            />
          ))}
        </LayoutGroup>
      </div>

      <button
        type="button"
        className="tab-new"
        title="New note (⌘N)"
        aria-label="New note"
        onClick={() => void useStore.getState().createNoteIn("")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <TilingMenu />
      <div className="tab-list-wrap">
        <button
          ref={listTriggerRef}
          type="button"
          className="tab-list-button"
          aria-label="List all tabs"
          aria-expanded={listOpen}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); setListOpen((open) => !open); }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5" /></svg>
        </button>
        {listOpen && (
          <ViewportMenu
            anchorRef={listTriggerRef}
            menuRef={listMenuRef}
            className="tab-list-menu"
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {tabs.map((tab) => (
              <button key={tab.id} type="button" role="menuitem" onClick={() => { activate(tab); setListOpen(false); }}>
                {tabLabel(tab, panels)}
              </button>
            ))}
            {tabs.length === 0 && <span className="tab-list-empty">No open tabs</span>}
          </ViewportMenu>
        )}
      </div>

      {selected && (
        <ViewportMenu
          anchorPoint={menu ?? undefined}
          menuRef={contextMenuRef}
          className="tab-context-menu"
          role="menu"
          align="start"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => { closeOne(selected); setMenu(null); }}>Close</button>
          <button
            type="button"
            role="menuitem"
            disabled={tabs.length < 2}
            onClick={() => { reconcileClosed(closeOtherTabs(groupId, selected.id)); setMenu(null); }}
          >Close others</button>
          <button
            type="button"
            role="menuitem"
            disabled={selectedIndex < 0 || selectedIndex === tabs.length - 1}
            onClick={() => { reconcileClosed(closeTabsToRight(groupId, selected.id)); setMenu(null); }}
          >Close tabs to the right</button>
          <button type="button" role="menuitem" onClick={() => { reconcileClosed(closeAllTabs(groupId)); setMenu(null); }}>Close all</button>
        </ViewportMenu>
      )}
    </div>
  );
}

function WorkspaceTab({
  groupId,
  tab,
  label,
  presentation,
  vaultPath,
  active,
  opening,
  tabIndex,
  reduceMotion,
  onActivate,
  onClose,
  onFocus,
  onMoveFocus,
  onMenu,
}: {
  groupId: string;
  tab: LayoutTab;
  label: string;
  presentation: IndexedPresentation | undefined;
  vaultPath: string | null;
  active: boolean;
  opening: boolean;
  tabIndex: number;
  reduceMotion: boolean;
  onActivate: () => void;
  onClose: () => void;
  onFocus: () => void;
  onMoveFocus: (step: number | "first" | "last") => void;
  onMenu: (position: { x: number; y: number }) => void;
}) {
  const drag = useDockDrag({ groupId, tabId: tab.id, label });
  const icon = iconFromIndexed(presentation);
  const assetUrl =
    icon?.kind === "asset" && vaultPath
      ? resolveVaultAsset({ vaultPath, documentPath: "", source: icon.path, sourceKind: "path" })
      : null;
  return (
    <div
      className={`tab${active ? " active" : ""}${opening ? " opening" : ""}`}
      data-dock-tab-id={tab.id}
      onPointerDown={drag.onPointerDown}
      onAuxClick={(event) => { if (event.button === 1) onClose(); }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onMenu({ x: event.clientX, y: event.clientY }); }}
    >
      {active && (
        <motion.span
          className="tab-active-bg"
          layoutId={`tab-active-bg:${groupId}`}
          aria-hidden="true"
          transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 34, mass: 0.9 }}
        />
      )}
      {tab.kind === "panel" && (
        <span className="workspace-tab-icon" aria-hidden="true">
          {panelRegistry[useLayoutStore.getState().layout.panels[tab.panelId]?.type ?? "graph"].icon}
        </span>
      )}
      {tab.kind === "note" && icon && (
        <span
          className="workspace-tab-icon"
          style={icon.kind === "lucide" ? { color: itemColorValue(presentation?.iconColor ?? undefined) } : undefined}
          aria-hidden="true"
        >
          <PresentationIcon icon={icon} assetUrl={assetUrl} className="tab-note-icon" />
        </span>
      )}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-workspace-tab-id={tab.id}
        className="tab-label"
        tabIndex={tabIndex}
        title={tab.kind === "note" ? tab.path : label}
        onFocus={onFocus}
        onClick={onActivate}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") { event.preventDefault(); onMoveFocus(1); }
          else if (event.key === "ArrowLeft") { event.preventDefault(); onMoveFocus(-1); }
          else if (event.key === "Home") { event.preventDefault(); onMoveFocus("first"); }
          else if (event.key === "End") { event.preventDefault(); onMoveFocus("last"); }
        }}
      >
        {label}
      </button>
      <button type="button" className="tab-close" data-no-dock-drag title="Close tab" aria-label={`Close ${label}`} onClick={(event) => { event.stopPropagation(); onClose(); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}

const TILING_LABELS: Record<TilingAction, string> = {
  single: "Single pane",
  "split-right": "Split right",
  "split-below": "Split below",
  swap: "Swap groups",
  join: "Join groups",
};

function TilingMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const layout = useLayoutStore((state) => state.layout);
  const available = tilingAvailability(layout);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    window.addEventListener("blur", close);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const run = (action: TilingAction) => {
    const host = document.querySelector<HTMLElement>(".workspace-dock-center");
    const size = action === "split-below" ? host?.clientHeight : host?.clientWidth;
    useLayoutStore.getState().replace(applyTilingAction(action, size ?? 0));
    setOpen(false);
  };
  return (
    <div className="tiling-menu-wrap" onPointerDown={(event) => event.stopPropagation()}>
      <button ref={triggerRef} type="button" className="tiling-menu-button" aria-label="Workspace layout" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></svg>
      </button>
      {open && (
        <ViewportMenu
          anchorRef={triggerRef}
          menuRef={menuRef}
          className="tiling-menu"
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {available.map((item) => (
            <button
              key={item.action}
              type="button"
              role="menuitem"
              disabled={!item.enabled}
              title={item.reason}
              onClick={() => run(item.action)}
            >
              {TILING_LABELS[item.action]}
              {!item.enabled && item.reason && <span>{item.reason}</span>}
            </button>
          ))}
        </ViewportMenu>
      )}
    </div>
  );
}
