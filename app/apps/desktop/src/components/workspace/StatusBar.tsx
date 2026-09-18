import type { DocumentStats } from "../../lib/editor/documentStats";

function stat(value: number, singular: string, plural?: string): string {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural ?? `${singular}s`}`;
}

export function StatusBar({ stats }: { stats: DocumentStats | null }) {
  return (
    <footer
      className="workspace-status-bar"
      aria-label="Document statistics"
      aria-busy={stats == null}
    >
      {stats && (
        <div className="workspace-status-values">
          <span data-stat="words">{stat(stats.words, "word")}</span>
          <span data-stat="characters">{stat(stats.characters, "character")}</span>
          <span data-stat="backlinks">{stat(stats.backlinks, "backlink")}</span>
          <span data-stat="properties">{stat(stats.properties, "property", "properties")}</span>
        </div>
      )}
    </footer>
  );
}
