import { useSyncExternalStore } from "react";
import type { PanelBodyProps } from "../layout/panelRegistry";
import {
  getEditorOutlineSnapshot,
  subscribeEditorOutline,
} from "../lib/editor/outline";

export function OutlinePanel({ activeNotePath }: PanelBodyProps) {
  const snapshot = useSyncExternalStore(
    subscribeEditorOutline,
    getEditorOutlineSnapshot,
    getEditorOutlineSnapshot,
  );
  const headings = snapshot.handle?.getHeadings() ?? [];
  if (!activeNotePath || /\.html?$/i.test(activeNotePath)) {
    return <div className="workspace-panel-empty">Open a Markdown note to see its outline.</div>;
  }
  if (headings.length === 0) {
    return <div className="workspace-panel-empty">This note has no headings.</div>;
  }
  return (
    <nav className="outline-panel" aria-label="Note outline">
      {headings.map((heading) => (
        <button
          key={`${heading.from}:${heading.level}`}
          type="button"
          className="outline-row"
          style={{ "--outline-level": heading.level } as React.CSSProperties}
          title={heading.text}
          onClick={() => snapshot.handle?.navigate(heading.from)}
        >
          <span className="outline-level" aria-hidden="true">H{heading.level}</span>
          <span className="outline-label">{heading.text}</span>
        </button>
      ))}
    </nav>
  );
}

