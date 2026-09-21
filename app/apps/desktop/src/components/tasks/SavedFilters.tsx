// Saved filters: the notes in this vault whose frontmatter says
// `noam_kind: task-filter`.
//
// The list comes from the index's `kind` column (the same one the sidebar
// already reads), so a filter written by hand in any editor shows up on the
// next watcher beat without this panel scanning anything.
//
// ADAPTER NOTE: `lib/tasks` exports the contracts for a saved filter
// (`SavedFilter`, the fence info string, the default folder) but no
// parser/serializer, so the two tiny ones live here. Move them down if a
// second caller ever needs them.

import { useState } from "react";
import * as ipc from "../../lib/ipc";
import { useStore } from "../../store";
import {
  DEFAULT_FILTERS_FOLDER,
  NOAM_KIND_KEY,
  TASK_FILTER_FENCE_INFO,
  TASK_FILTER_KIND_VALUE,
  type SavedFilter,
} from "../../lib/tasks";

/** The one `json noam-task-filter` fence, or null. Unknown keys are kept by
 *  never rewriting a filter we only read. */
export function readSavedFilter(text: string): SavedFilter | null {
  const fence = new RegExp(
    "^```" + TASK_FILTER_FENCE_INFO + "\\s*\\n([\\s\\S]*?)\\n```",
    "m",
  ).exec(text);
  if (!fence) return null;
  try {
    const parsed = JSON.parse(fence[1]!) as SavedFilter;
    return typeof parsed?.query === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeSavedFilter(filter: SavedFilter): string {
  return [
    "---",
    `${NOAM_KIND_KEY}: ${TASK_FILTER_KIND_VALUE}`,
    `title: ${filter.name}`,
    "---",
    "",
    `# ${filter.name}`,
    "",
    "```" + TASK_FILTER_FENCE_INFO,
    JSON.stringify(filter, null, 2),
    "```",
    "",
  ].join("\n");
}

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "filter";

export interface SavedFiltersProps {
  vaultEpoch: number;
  /** The query text a new filter is saved from. */
  currentQuery: string;
  onApply: (query: string) => void;
  onError: (message: string) => void;
}

export function SavedFilters({ vaultEpoch, currentQuery, onApply, onError }: SavedFiltersProps) {
  const titles = useStore((state) => state.titles);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const filters = titles.filter((title) => title.kind === TASK_FILTER_KIND_VALUE);

  const apply = async (path: string) => {
    try {
      const filter = readSavedFilter(await ipc.readNote(path, vaultEpoch));
      if (!filter) {
        onError(`"${path}" has no task-filter block.`);
        return;
      }
      onApply(filter.query);
    } catch (err) {
      onError(`Couldn't read "${path}": ${String(err)}`);
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    const path = `${DEFAULT_FILTERS_FOLDER}/${trimmed}.md`;
    const filter: SavedFilter = {
      version: 1,
      id: slug(trimmed),
      name: trimmed,
      query: currentQuery,
    };
    try {
      await ipc.ensureFolder(DEFAULT_FILTERS_FOLDER, vaultEpoch);
      // Create-only: an existing filter of that name is never overwritten.
      const created = await ipc.writeNoteIfMissing(path, serializeSavedFilter(filter), vaultEpoch);
      if (!created) {
        onError(`${path} already exists.`);
        return;
      }
      setNaming(false);
      setName("");
      await useStore.getState().refreshTitles();
    } catch (err) {
      onError(`Couldn't save that filter: ${String(err)}`);
    }
  };

  return (
    <div className="task-filters">
      <div className="task-filters-row">
        {filters.map((filter) => (
          <button
            key={filter.path}
            type="button"
            className="task-filter-chip"
            title={filter.path}
            onClick={() => void apply(filter.path)}
          >
            {filter.title}
          </button>
        ))}
        <button
          type="button"
          className="task-filter-chip new"
          title="Save the current query as a filter note"
          onClick={() => setNaming((open) => !open)}
        >
          + Save
        </button>
      </div>
      {naming && (
        <div className="task-filters-new">
          <input
            className="task-filter-name"
            aria-label="Filter name"
            value={name}
            placeholder="Due this week"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
              if (event.key === "Escape") setNaming(false);
            }}
          />
          <button type="button" className="task-filter-save" onClick={() => void create()}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}
