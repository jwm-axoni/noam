import type { PanelBodyProps } from "../layout/panelRegistry";
import { noteLabel } from "../lib/notePath";
import { useStore } from "../store";

export function BacklinksPanel({ activeNotePath, onOpenNote }: PanelBodyProps) {
  const backlinks = useStore((state) => state.backlinks);
  if (!activeNotePath || /\.html?$/i.test(activeNotePath)) {
    return <div className="workspace-panel-empty">Open a Markdown note to see backlinks.</div>;
  }
  if (backlinks.length === 0) {
    return <div className="workspace-panel-empty">No backlinks</div>;
  }
  return (
    <ul className="backlinks-list docked-backlinks">
      {backlinks.map((backlink) => (
        <li key={backlink.id}>
          <button type="button" className="backlink" title={backlink.path} onClick={() => onOpenNote(backlink.path)}>
            <span className="backlink-title">{noteLabel(backlink.path)}</span>
            {backlink.linkText && <span className="backlink-text">{backlink.linkText}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
