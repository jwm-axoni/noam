import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelBodyProps } from "../layout/panelRegistry";
import {
  GraphView,
  type GraphViewHandle,
  type GraphViewStatus,
} from "./GraphView";

/** Host adapter for graph panels. Workspace chrome owns the tab/header; the
 * graph owns only controls that affect its canvas. */
export function GraphPanel({
  instanceId,
  visible,
  compact,
  onOpenNote,
}: PanelBodyProps) {
  const graphRef = useRef<GraphViewHandle | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showControls, setShowControls] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<GraphViewStatus>({
    nodes: 0,
    edges: 0,
    total: 0,
  });
  const handleStatus = useCallback((next: GraphViewStatus) => setStatus(next), []);

  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, []);

  const refresh = () => {
    graphRef.current?.refresh();
    setRefreshing(true);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      setRefreshing(false);
    }, 700);
  };

  return (
    <section className={`graph-panel${compact ? " is-compact" : " is-full"}`}>
      <header className="graph-toolbar" aria-label="Graph controls">
        <span className="graph-counts">
          {status.total > status.nodes
            ? `${status.nodes.toLocaleString()} of ${status.total.toLocaleString()} notes`
            : `${status.nodes} ${status.nodes === 1 ? "note" : "notes"}`} {" "}
          · {status.edges} {status.edges === 1 ? "link" : "links"}
        </span>
        <span className="graph-toolbar-spacer" />
        <button
          type="button"
          className={`graph-icon-btn${showControls ? " is-active" : ""}`}
          title="Graph settings"
          aria-label="Graph settings"
          aria-pressed={showControls}
          onClick={() => setShowControls((value) => !value)}
        >
          ⚙
        </button>
        <button
          type="button"
          className={`graph-icon-btn${refreshing ? " is-spinning" : ""}`}
          title="Refresh graph"
          aria-label="Refresh graph"
          onClick={refresh}
        >
          ↻
        </button>
      </header>
      <GraphView
        ref={graphRef}
        instanceId={instanceId}
        visible={visible}
        showControls={showControls}
        onStatusChange={handleStatus}
        onOpenNote={onOpenNote}
      />
    </section>
  );
}
