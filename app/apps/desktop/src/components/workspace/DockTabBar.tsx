import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { panelRegistry } from "../../layout/panelRegistry";
import { useDockDrag } from "../../layout/useDockDrag";
import { useLayoutStore } from "../../layout/store";
import { ViewportMenu } from "../ViewportMenu";

export function DockTabBar({ groupId }: { groupId: string }) {
  const group = useLayoutStore((state) => state.layout.groups[groupId]);
  const panels = useLayoutStore((state) => state.layout.panels);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const listTriggerRef = useRef<HTMLButtonElement | null>(null);
  const listMenuRef = useRef<HTMLDivElement | null>(null);
  const requiredWidthRef = useRef(0);
  const measuredTabsKeyRef = useRef("");
  const tabsKey = group?.tabs.map((tab) => tab.id).join("\u0000") ?? "";

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    if (measuredTabsKeyRef.current !== tabsKey) {
      measuredTabsKeyRef.current = tabsKey;
      requiredWidthRef.current = 0;
      if (hasOverflow) {
        setHasOverflow(false);
        return;
      }
    }
    const measure = () => {
      if (!hasOverflow) requiredWidthRef.current = strip.scrollWidth;
      const next = requiredWidthRef.current > strip.clientWidth + 1;
      setHasOverflow(next);
      if (!next) setListOpen(false);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(strip);
    for (const child of strip.children) observer?.observe(child);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [groupId, tabsKey, hasOverflow]);

  useEffect(() => {
    if (!listOpen) return;
    const close = () => setListOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      requestAnimationFrame(() => listTriggerRef.current?.focus());
    };
    window.addEventListener("blur", close);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [listOpen]);

  if (!group) return null;

  return (
    <>
      <div
        ref={stripRef}
        className={`workspace-dock-tabs${hasOverflow ? " has-overflow" : ""}`}
        role="tablist"
        aria-label="Dock panels"
        data-tauri-drag-region
      >
        {group.tabs.map((tab) => {
          if (tab.kind !== "panel") return null;
          const panel = panels[tab.panelId];
          if (!panel) return null;
          return (
            <DockTab
              key={tab.id}
              groupId={groupId}
              tabId={tab.id}
              label={panelRegistry[panel.type].label}
              icon={panelRegistry[panel.type].icon}
              active={group.activeTabId === tab.id}
            />
          );
        })}
      </div>
      {hasOverflow && (
        <div className="tab-list-wrap workspace-dock-tab-list-wrap">
          <button
            ref={listTriggerRef}
            type="button"
            className="tab-list-button"
            aria-label="List dock tabs"
            aria-haspopup="menu"
            aria-expanded={listOpen}
            title="List dock tabs"
            data-no-dock-drag
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setListOpen((open) => !open);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m7 9 5 5 5-5" />
            </svg>
          </button>
          {listOpen && (
            <ViewportMenu
              anchorRef={listTriggerRef}
              menuRef={listMenuRef}
              className="tab-list-menu"
              role="menu"
              onPointerDown={(event) => event.stopPropagation()}
            >
              {group.tabs.map((tab) => {
                if (tab.kind !== "panel") return null;
                const panel = panels[tab.panelId];
                if (!panel) return null;
                const label = panelRegistry[panel.type].label;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      useLayoutStore.getState().dispatch({
                        type: "activate-tab",
                        groupId,
                        tabId: tab.id,
                      });
                      setListOpen(false);
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </ViewportMenu>
          )}
        </div>
      )}
    </>
  );
}

function DockTab({
  groupId,
  tabId,
  label,
  icon,
  active,
}: {
  groupId: string;
  tabId: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
}) {
  const drag = useDockDrag({ groupId, tabId, label });
  return (
    <button
      type="button"
      className={`workspace-dock-tab${active ? " active" : ""}`}
      role="tab"
      aria-selected={active}
      data-dock-tab-id={tabId}
      title={label}
      onPointerDown={drag.onPointerDown}
      onClick={() => useLayoutStore.getState().dispatch({ type: "activate-tab", groupId, tabId })}
    >
      <span className="workspace-dock-tab-icon" aria-hidden="true">{icon}</span>
      <span className="workspace-dock-tab-label">{label}</span>
    </button>
  );
}
