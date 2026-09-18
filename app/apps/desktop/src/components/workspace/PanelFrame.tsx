import type { ReactNode } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import type { PanelType } from "../../layout/types";
import { useDockDrag } from "../../layout/useDockDrag";
import { DockTabBar } from "./DockTabBar";
import { PanelMoveMenu } from "./PanelMoveMenu";

export function PanelFrame({
  title,
  subtitle,
  groupId,
  tabId,
  panelType,
  onClose,
  resetKeys,
  children,
}: {
  title: string;
  subtitle?: string | null;
  icon?: ReactNode;
  groupId: string;
  tabId: string;
  panelType: PanelType;
  onClose: () => void;
  resetKeys?: ReadonlyArray<unknown>;
  children: ReactNode;
}) {
  const drag = useDockDrag({ groupId, tabId, label: title });
  return (
    <section className="workspace-panel-frame">
      <header
        className="workspace-panel-header"
        onPointerDown={(event) => {
          // Tab buttons arm their own drag; don't let the press bubble into
          // the header's probe or two drags fight over the same pointer.
          if ((event.target as HTMLElement).closest("[data-dock-tab-id]")) return;
          drag.onPointerDown(event);
        }}
      >
        <DockTabBar groupId={groupId} />
        {subtitle && <span className="workspace-panel-subtitle" title={subtitle}>{subtitle}</span>}
        <PanelMoveMenu groupId={groupId} tabId={tabId} panelType={panelType} />
        <button
          type="button"
          className="icon-btn workspace-panel-close"
          onClick={onClose}
          aria-label={`Close ${title}`}
          title="Close (Esc)"
          data-no-dock-drag
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 7 10 10M17 7 7 17" />
          </svg>
        </button>
      </header>
      <div className="workspace-panel-body" data-panel-frame-type={panelType}>
        <ErrorBoundary
          label={title}
          resetKeys={resetKeys}
          onError={onClose}
        >
          {children}
        </ErrorBoundary>
      </div>
    </section>
  );
}
