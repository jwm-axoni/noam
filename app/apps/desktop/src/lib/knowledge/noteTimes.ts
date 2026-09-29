import * as ipc from "../ipc";
import { SYSTEM_PROPERTY_IDS, type SystemPropertyId } from "./types";
import type {
  KnowledgePredicate,
  KnowledgeSort,
  KnowledgeTraverse,
  LocalKnowledgeItem,
  NoteTimes,
  VaultEpoch,
} from "../ipc";

/**
 * The `created`/`modified` system properties and sorted note queries, for
 * list surfaces (explorer sorts, folder gallery, dashboards). Everything here
 * reads the local index through Rust; nothing parses frontmatter or stats
 * files in TS. Semantics: docs/specs/06-note-knowledge-contract.md.
 */

export type { KnowledgePredicate, KnowledgeSort, KnowledgeTraverse, NoteTimes } from "../ipc";

export { SYSTEM_PROPERTY_IDS } from "./types";

export function isSystemPropertyId(id: string): id is SystemPropertyId {
  return (SYSTEM_PROPERTY_IDS as readonly string[]).includes(id);
}

export interface NoteTimesIndex {
  byPath: Map<string, NoteTimes>;
  byDocId: Map<string, NoteTimes>;
}

/**
 * System properties for many notes in ONE indexed read, keyed both ways.
 * Omit `filter` for the whole vault (what an explorer sort wants); pass paths
 * or doc ids to narrow it. Epoch-pinned so a vault switch mid-flight rejects
 * instead of answering for the wrong vault.
 */
export async function getNoteTimes(
  filter: { paths?: string[]; docIds?: string[] } = {},
  expectedEpoch?: VaultEpoch,
): Promise<NoteTimesIndex> {
  const rows = await ipc.listNoteTimes(filter, expectedEpoch);
  return {
    byPath: new Map(rows.map((row) => [row.path, row])),
    byDocId: new Map(rows.map((row) => [row.noteId, row])),
  };
}

export type NoteEntry = Extract<LocalKnowledgeItem, { kind: "noteEntry" }>;

export interface NotesPage {
  items: NoteEntry[];
  nextCursor: string | null;
}

/**
 * One page of notes matching `where`, ordered by `sort` (ties by doc id,
 * missing values last in both directions). A cursor only continues the exact
 * query that minted it; anything else is refused with `cursor_expired`.
 */
export async function queryNotes(
  query: {
    where?: KnowledgePredicate[];
    sort?: KnowledgeSort | null;
    /** Spec 06 `traverse` (relationship filters). Left off the wire when unset. */
    traverse?: KnowledgeTraverse | null;
  } = {},
  page: { limit?: number; cursor?: string | null } = {},
): Promise<NotesPage> {
  const result = await ipc.queryKnowledge(
    {
      kind: "notes",
      where: query.where ?? [],
      sort: query.sort ?? null,
      ...(query.traverse ? { traverse: query.traverse } : {}),
    },
    page,
  );
  return {
    items: result.items.filter((item): item is NoteEntry => item.kind === "noteEntry"),
    nextCursor: result.nextCursor,
  };
}

/**
 * What the registry hands the index after a pull: every listed note's server
 * creation time. Best effort by design — a failure here costs only the
 * `server` source of `created` until the next pull, so it never interrupts
 * sync, and it is skipped when nothing changed since the last call.
 */
export function createServerCreatedRecorder(
  record: typeof ipc.recordServerCreatedTimes = (...args) => ipc.recordServerCreatedTimes(...args),
) {
  let lastSent = new Map<string, string>();
  let warned = false;
  return (
    notes: Array<{ docId: string; createdAt: string | null | undefined }>,
    expectedEpoch?: VaultEpoch,
  ): Promise<void> => {
    const entries: Array<{ docId: string; createdAt: string }> = [];
    const next = new Map<string, string>();
    for (const { docId, createdAt } of notes) {
      if (!docId || typeof createdAt !== "string" || !createdAt) continue;
      next.set(docId, createdAt);
      if (lastSent.get(docId) !== createdAt) entries.push({ docId, createdAt });
    }
    if (entries.length === 0) return Promise.resolve();
    return Promise.resolve()
      .then(() => record(entries, expectedEpoch))
      .then(
        () => {
          lastSent = new Map([...lastSent, ...next]);
        },
        (error: unknown) => {
          // Once per recorder: a pull every few seconds must not flood the log.
          if (!warned) console.warn("[knowledge] could not record server created times", error);
          warned = true;
        },
      );
  };
}
