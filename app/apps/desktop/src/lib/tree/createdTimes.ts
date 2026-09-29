// Created dates for the sidebar's Created sorts.
//
// `TreeNode` carries the mtime (the Modified sorts' key) but not the created
// date: that is resolved by the knowledge index (frontmatter `created:` →
// server `created_at` → earliest file birthtime; docs/specs/06) and read with
// ONE vault-wide `getNoteTimes` call. The store keeps the result as a path →
// ms map and `sortTree` reads it through `SortContext.created`.
//
// Pay-for-what-you-use: the read happens only while some active sort — the
// global default or ANY folder's override — is a Created mode. A vault sorted
// by name or modified never makes it.
//
// Refresh points: every tree refresh (the store calls `load` after it), and the
// moment a Created sort is picked. A note created since the last read isn't in
// the map yet, so it sorts with the unknowns (last) until the tree refresh its
// own create triggers lands — which is the same refresh that makes its row
// appear, so in practice it is placed correctly on first paint or one refresh
// later. Chosen over fetching inside every create path because there are many
// create paths (sidebar, wikilink, MCP/sync materialize, external writers) and
// all of them already end in a tree refresh.

import type { FolderSorts, TreeSort } from "./sort";
import { usesCreatedSort } from "./sort";

/**
 * Gate + coalescer around the one read this needs. Generic over what `fetch`
 * resolves to, so the store can tag the result with the vault epoch it was
 * read under and drop an answer for a vault it has since left.
 */
export interface CreatedTimesLoader<T> {
  /**
   * A fresh read for these sorts, or `null` when no active sort needs one (and
   * then `fetch` is not called). Calls that arrive while a read is in flight
   * coalesce: they share ONE follow-up read that starts after the current one,
   * so a burst of watcher refreshes costs at most two reads and the last caller
   * still sees data fresher than its own call.
   */
  load(mode: TreeSort, overrides: FolderSorts): Promise<T | null>;
}

export function createCreatedTimesLoader<T>(fetch: () => Promise<T>): CreatedTimesLoader<T> {
  let inFlight: Promise<T> | null = null;
  let queued: Promise<T> | null = null;

  const run = (): Promise<T> => {
    const p = fetch().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };

  return {
    load(mode, overrides) {
      if (!usesCreatedSort(mode, overrides)) return Promise.resolve(null);
      if (!inFlight) return run();
      // A read is already running, but it may have started before whatever
      // change prompted this call — queue exactly one more behind it.
      if (!queued) {
        queued = inFlight
          .catch(() => undefined)
          .then(() => {
            queued = null;
            return run();
          });
      }
      return queued;
    },
  };
}

/** Collapse `getNoteTimes().byPath` to what the sort reads: path → created ms,
 *  dropping notes no source dated (they sort as unknown, i.e. last). */
export function createdByPath(
  byPath: ReadonlyMap<string, { created: number | null }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [path, t] of byPath) if (t.created != null) out.set(path, t.created);
  return out;
}
