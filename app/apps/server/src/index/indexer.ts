import { createHash } from "node:crypto";
import * as Y from "yjs";
import { pgText } from "../db/text.js";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { loadDocState } from "../yjs/persistence.js";
import { cosineSimilarity, embed, tokenize } from "./embedder.js";
import {
  parseKnowledgeCatalog,
  parseKnowledgeMarkdown,
  type KnowledgeCatalog,
  type KnowledgeProjection,
} from "../knowledge/markdown.js";

/**
 * Note indexing engine (spec: links + vectors).
 *
 * Whenever a note's Yjs doc is stored we (re)derive search + graph data:
 *   - extract the note's plain text from the shared Y.Text `content`,
 *   - parse `[[wikilink]]` references into note_links edges,
 *   - compute an embedding vector and upsert note_index.
 *
 * Indexing is debounced per doc so a burst of keystroke-sized updates collapses
 * into one DB write. note_index / note_links are a rebuildable cache derived
 * from the canonical Yjs state — see migration 005.
 */

type Queryable = Pick<pg.Pool, "query">;
type TransactionalQueryable = Queryable & Partial<Pick<pg.Pool, "connect">>;

/** The shared Y.Text that holds a note body (matches the desktop bridge). */
const CONTENT_FIELD = "content";

/** Default debounce window: collapse bursts of updates into one index write. */
const DEBOUNCE_MS = 2000;

/**
 * One reprojection cycle uses a small fixed retry ladder. The per-vault
 * recovery queue repeats cycles with a capped backoff until Postgres reports no
 * stale, failed, or missing projection rows. Those rows also survive a process
 * exit, so boot backfill can resume recovery.
 */
export const CATALOG_REPROJECTION_RETRY_DELAYS_MS = [25, 100, 250] as const;
export const CATALOG_RECOVERY_BACKOFF_MS = [100, 500, 2_000, 5_000] as const;

// Per-doc pending timers (debounce). Keyed by docId.
const pending = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; stale: Promise<void> }
>();

function sourceRevision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function inTransaction<T>(
  db: TransactionalQueryable,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (!db.connect) return fn(db);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Parse `[[wikilink]]` targets out of note text. Captures the title portion
 * only — the part before any `|` alias or `#` heading anchor — and trims it.
 * Duplicates within one doc are collapsed.
 */
export function parseWikilinks(text: string): string[] {
  const re = /\[\[([^\]|#]+)/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const title = m[1].trim();
    if (title && !seen.has(title)) {
      seen.add(title);
      out.push(title);
    }
  }
  return out;
}

/** Decode a doc's stored Yjs state into its plain-text `content` body. */
export async function extractDocText(
  docId: string,
  db: Queryable = defaultPool,
): Promise<string> {
  const state = await loadDocState(docId, db);
  if (!state) return "";
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return doc.getText(CONTENT_FIELD).toString();
  } finally {
    doc.destroy();
  }
}

async function replaceKnowledgeRows(
  tx: Queryable,
  docId: string,
  vaultId: string,
  projection: KnowledgeProjection,
): Promise<void> {
  await tx.query("DELETE FROM note_knowledge_identities WHERE doc_id = $1", [docId]);
  await tx.query("DELETE FROM note_property_values WHERE doc_id = $1", [docId]);
  await tx.query("DELETE FROM note_labels WHERE doc_id = $1", [docId]);
  await tx.query("DELETE FROM note_relationships WHERE from_doc = $1", [docId]);

  if (projection.documentId) {
    await tx.query(
      `INSERT INTO note_knowledge_identities (doc_id, vault_id, document_id)
       VALUES ($1, $2, $3)`,
      [docId, vaultId, projection.documentId],
    );
  }
  for (const value of projection.properties) {
    await tx.query(
      `INSERT INTO note_property_values
         (doc_id, vault_id, property_id, value_order, value_type,
          text_value, number_value, boolean_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        docId,
        vaultId,
        value.propertyId,
        value.order,
        value.type,
        value.text,
        value.number,
        value.boolean,
      ],
    );
  }
  for (const label of projection.labels) {
    await tx.query(
      `INSERT INTO note_labels (doc_id, vault_id, property_id, label, kind)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [docId, vaultId, label.propertyId, label.label, label.kind],
    );
  }
  for (const relationship of projection.relationships) {
    await tx.query(
      `INSERT INTO note_relationships
         (vault_id, from_doc, relationship_id, target_document_id, value_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        vaultId,
        docId,
        relationship.relationshipId,
        relationship.targetDocumentId,
        relationship.order,
      ],
    );
  }
}

export const KNOWLEDGE_SCHEMA_PATH = "_Noam/Knowledge schema.md";

async function loadKnowledgeCatalog(
  tx: Queryable,
  vaultId: string,
): Promise<KnowledgeCatalog | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM notes
      WHERE vault_id = $1 AND rel_path = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [vaultId, KNOWLEDGE_SCHEMA_PATH],
  );
  const docId = rows[0]?.id;
  if (!docId) return null;
  return parseKnowledgeCatalog(await extractDocText(docId, tx));
}

/** Mark the projection stale before the debounce window begins. */
export async function markKnowledgeIndexStale(
  docId: string,
  db: Queryable = defaultPool,
): Promise<void> {
  await db.query(
    `WITH changed AS (
       SELECT id, vault_id, rel_path FROM notes
        WHERE id = $1 AND deleted_at IS NULL
     )
     INSERT INTO note_knowledge_state (doc_id, vault_id, state, generation)
       SELECT n.id, n.vault_id, 'stale', 1
         FROM notes n JOIN changed c ON c.vault_id = n.vault_id
        WHERE n.deleted_at IS NULL
          AND (n.id = c.id OR c.rel_path = $2)
     ON CONFLICT (doc_id) DO UPDATE
       SET state = 'stale',
           generation = note_knowledge_state.generation + 1,
           error_code = NULL`,
    [docId, KNOWLEDGE_SCHEMA_PATH],
  );
}

/**
 * Index one note now (no debounce). Resolves the doc's vault + title from the
 * notes table, extracts its text, then upserts note_index and replaces the
 * doc's note_links rows. No-op for docs with no live note row (e.g. binary
 * files), so we never index things that aren't markdown notes.
 */
async function indexDocOnce(
  docId: string,
  db: TransactionalQueryable = defaultPool,
): Promise<{ indexed: boolean; catalogVaultId: string | null }> {
  try {
    return await inTransaction(db, async (tx) => {
      const { rows } = await tx.query<{
        vault_id: string;
        title: string | null;
        rel_path: string;
      }>(
        `SELECT vault_id, title, rel_path FROM notes
          WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [docId],
      );
      const note = rows[0];
      if (!note) {
        await purgeNoteIndex([docId], tx);
        return { indexed: false, catalogVaultId: null };
      }

      await tx.query(
        `INSERT INTO note_knowledge_state (doc_id, vault_id, state)
         VALUES ($1, $2, 'stale') ON CONFLICT (doc_id) DO NOTHING`,
        [docId, note.vault_id],
      );
      await tx.query(
        "SELECT generation FROM note_knowledge_state WHERE doc_id = $1 FOR UPDATE",
        [docId],
      );

      const rawContent = await extractDocText(docId, tx);
      const revision = sourceRevision(rawContent);
      const content = pgText(rawContent);
      const title = pgText(note.title ?? relPathStem(note.rel_path));
      const links = parseWikilinks(content);
      const catalog = await loadKnowledgeCatalog(tx, note.vault_id);
      const projection = parseKnowledgeMarkdown(rawContent, catalog);
      const vector = embed(`${title ?? ""}\n${content}`);

      await tx.query(
        `INSERT INTO note_index (doc_id, vault_id, title, content, vector, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, now())
         ON CONFLICT (doc_id) DO UPDATE
           SET vault_id = EXCLUDED.vault_id,
               title = EXCLUDED.title,
               content = EXCLUDED.content,
               vector = EXCLUDED.vector,
               updated_at = now()`,
        [docId, note.vault_id, title, content, JSON.stringify(vector)],
      );

      await tx.query("DELETE FROM note_links WHERE from_doc = $1", [docId]);
      for (const toTitle of links) {
        await tx.query(
          `INSERT INTO note_links (vault_id, from_doc, to_title)
           VALUES ($1, $2, $3)
           ON CONFLICT (from_doc, to_title) DO NOTHING`,
          [note.vault_id, docId, toTitle],
        );
      }
      await replaceKnowledgeRows(tx, docId, note.vault_id, projection);
      await tx.query(
        `UPDATE note_knowledge_state
            SET source_revision = $2,
                index_revision = $2,
                state = 'current',
                error_code = NULL,
                indexed_at = now()
          WHERE doc_id = $1`,
        [docId, revision],
      );
      if (note.rel_path === KNOWLEDGE_SCHEMA_PATH) {
        await tx.query(
          `UPDATE note_knowledge_state ks
              SET state = 'stale', generation = ks.generation + 1, error_code = NULL
             FROM notes n
            WHERE n.id = ks.doc_id AND n.vault_id = $1 AND n.deleted_at IS NULL
              AND n.id <> $2`,
          [note.vault_id, docId],
        );
      }
      return {
        indexed: true,
        catalogVaultId: note.rel_path === KNOWLEDGE_SCHEMA_PATH ? note.vault_id : null,
      };
    });
  } catch (error) {
    try {
      await db.query(
        `INSERT INTO note_knowledge_state (doc_id, vault_id, state, error_code)
           SELECT id, vault_id, 'failed', 'index_failed' FROM notes
            WHERE id = $1 AND deleted_at IS NULL
         ON CONFLICT (doc_id) DO UPDATE
           SET state = 'failed', error_code = 'index_failed'`,
        [docId],
      );
    } catch (stateError) {
      console.error(`[indexer] failed to record failure state for ${docId}:`, stateError);
    }
    throw error;
  }
}

/**
 * Index one note. Updating the canonical catalog note also reprojects its vault,
 * so an incremental catalog edit has the same result as a clean rebuild.
 */
export async function indexDoc(
  docId: string,
  db: TransactionalQueryable = defaultPool,
): Promise<boolean> {
  const result = await indexDocOnce(docId, db);
  if (result.catalogVaultId) {
    await reprojectKnowledgeCatalogForVault(result.catalogVaultId, db);
  }
  return result.indexed;
}

export async function markKnowledgeCatalogStaleForVault(
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<void> {
  await db.query(
    `UPDATE note_knowledge_state ks
        SET state = 'stale', generation = ks.generation + 1, error_code = NULL
       FROM notes n
      WHERE n.id = ks.doc_id AND n.vault_id = $1 AND n.deleted_at IS NULL`,
    [vaultId],
  );
}

export async function knowledgeCatalogProjectionNeedsRecovery(
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const { rows } = await db.query<{ needs_recovery: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM notes n
       LEFT JOIN note_knowledge_state ks ON ks.doc_id = n.id
       WHERE n.vault_id = $1 AND n.deleted_at IS NULL
         AND (ks.doc_id IS NULL OR ks.state <> 'current')
     ) AS needs_recovery`,
    [vaultId],
  );
  return rows[0]?.needs_recovery ?? false;
}

export async function reprojectKnowledgeCatalogForVault(
  vaultId: string,
  db: TransactionalQueryable = defaultPool,
  retryDelaysMs: readonly number[] = CATALOG_REPROJECTION_RETRY_DELAYS_MS,
): Promise<void> {
  let failures: unknown[] = [];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    failures = [];
    try {
      const { rows } = await db.query<{ id: string }>(
        `SELECT n.id FROM notes n
          LEFT JOIN note_knowledge_state ks ON ks.doc_id = n.id
         WHERE n.vault_id = $1 AND n.deleted_at IS NULL
           AND (ks.doc_id IS NULL OR ks.state <> 'current')
         ORDER BY CASE WHEN n.rel_path = $2 THEN 0 ELSE 1 END, n.id`,
        [vaultId, KNOWLEDGE_SCHEMA_PATH],
      );
      for (const row of rows) {
        try {
          await indexDocOnce(row.id, db);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 0) {
        if (!(await knowledgeCatalogProjectionNeedsRecovery(vaultId, db))) return;
        failures.push(new Error("Catalog reprojection left non-current peers"));
      }
    } catch (error) {
      failures.push(error);
    }

    const delayMs = retryDelaysMs[attempt];
    if (delayMs === undefined) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      if (typeof timer.unref === "function") timer.unref();
    });
  }
  throw new AggregateError(
    failures,
    `Knowledge catalog reprojection failed for vault ${vaultId}`,
  );
}

interface CatalogRecovery {
  db: TransactionalQueryable;
  requested: boolean;
  retryDelaysMs: readonly number[];
  promise: Promise<void>;
}

const catalogRecoveries = new Map<string, CatalogRecovery>();

/**
 * Queue one recovery per vault. Callers may acknowledge a committed move as
 * soon as this is queued. Recovery keeps running with a capped backoff while a
 * live note has stale, failed, or missing projection state. A second request
 * records an immediate follow-up pass and supplies the latest database handle,
 * so replaying an already-committed move can still repair its projections.
 */
export function scheduleKnowledgeCatalogReprojection(
  vaultId: string,
  db: TransactionalQueryable = defaultPool,
  retryDelaysMs: readonly number[] = CATALOG_RECOVERY_BACKOFF_MS,
): Promise<void> {
  const existing = catalogRecoveries.get(vaultId);
  if (existing) {
    existing.db = db;
    existing.requested = true;
    existing.retryDelaysMs = retryDelaysMs;
    return existing.promise;
  }

  const recovery = {
    db,
    requested: false,
    retryDelaysMs,
    promise: Promise.resolve(),
  } satisfies CatalogRecovery;
  recovery.promise = (async () => {
    let retry = 0;
    while (true) {
      recovery.requested = false;
      try {
        await reprojectKnowledgeCatalogForVault(vaultId, recovery.db);
      } catch (error) {
        console.error(`[indexer] catalog recovery failed for vault ${vaultId}:`, error);
      }
      let needsRecovery = true;
      try {
        needsRecovery = await knowledgeCatalogProjectionNeedsRecovery(vaultId, recovery.db);
      } catch (error) {
        console.error(`[indexer] failed to inspect catalog recovery for vault ${vaultId}:`, error);
      }
      if (!needsRecovery && !recovery.requested) return;
      if (recovery.requested) {
        retry = 0;
        continue;
      }
      const delays = recovery.retryDelaysMs;
      const delayMs = delays.length === 0
        ? 0
        : delays[Math.min(retry, delays.length - 1)]!;
      retry++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        if (typeof timer.unref === "function") timer.unref();
      });
    }
  })().finally(() => {
    if (catalogRecoveries.get(vaultId) === recovery) catalogRecoveries.delete(vaultId);
  });
  catalogRecoveries.set(vaultId, recovery);
  return recovery.promise;
}

/**
 * Schedule a debounced (re)index for a doc. Called from the sync server's store
 * hook — repeated calls within the window reset the timer so only the last one
 * fires. The returned promise resolves only after the stale marker is durable,
 * so a caller cannot acknowledge a canonical edit while current-only queries
 * can still read the previous generation. Debounced indexing remains
 * best-effort and logs its own failures.
 */
export async function scheduleIndex(
  docId: string,
  delayMs: number = DEBOUNCE_MS,
  db: TransactionalQueryable = defaultPool,
): Promise<void> {
  const existing = pending.get(docId);
  if (existing) clearTimeout(existing.timer);
  const stale = existing?.stale ?? markKnowledgeIndexStale(docId, db);
  const timer = setTimeout(() => {
    pending.delete(docId);
    stale
      .catch((err) => {
        // A stale-marker outage must not suppress the later indexing attempt.
        console.error(`[indexer] failed to mark ${docId} stale:`, err);
      })
      .then(() => indexDoc(docId, db))
      .catch((err) => {
        console.error(`[indexer] failed to index ${docId}:`, err);
      });
  }, delayMs);
  // Don't keep the event loop alive just for a pending index.
  if (typeof timer.unref === "function") timer.unref();
  pending.set(docId, { timer, stale });
  await stale;
}

/**
 * Backfill: index any live note that has no note_index row yet, using its
 * already-stored Yjs state. Runs once on boot so existing docs become
 * searchable/graphable without waiting for a fresh edit. Best-effort — a
 * failure on one doc is logged and skipped. Returns the count indexed.
 */
export async function backfillIndex(db: Queryable = defaultPool): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT n.id FROM notes n
       LEFT JOIN note_index ni ON ni.doc_id = n.id
       LEFT JOIN note_knowledge_state ks ON ks.doc_id = n.id
      WHERE n.deleted_at IS NULL
        AND (ni.doc_id IS NULL OR ks.doc_id IS NULL OR ks.state <> 'current')`,
  );
  let count = 0;
  for (const { id } of rows) {
    try {
      if (await indexDoc(id, db)) count++;
    } catch (err) {
      console.error(`[indexer] backfill failed for ${id}:`, err);
    }
  }
  return count;
}

/**
 * Drop the derived index rows for a set of docs.
 *
 * note_index / note_links are a rebuildable cache derived from the canonical
 * Yjs state (migration 005), so deleting them loses nothing that a re-index
 * can't recompute. Doing so on delete matters twice over: note_index holds a
 * FULL PLAIN-TEXT COPY of the note body, so keeping it for a "deleted" note is
 * both unbounded table growth and a privacy problem.
 */
export async function purgeNoteIndex(
  docIds: string[],
  db: Queryable = defaultPool,
): Promise<void> {
  if (docIds.length === 0) return;
  const { rows: catalogVaults } = await db.query<{ vault_id: string }>(
    `SELECT DISTINCT vault_id FROM notes
      WHERE id = ANY($1::text[]) AND rel_path = $2`,
    [docIds, KNOWLEDGE_SCHEMA_PATH],
  );
  for (const { vault_id: vaultId } of catalogVaults) {
    await db.query(
      `UPDATE note_knowledge_state ks
          SET state = 'stale', generation = ks.generation + 1, error_code = NULL
         FROM notes n
        WHERE n.id = ks.doc_id AND n.vault_id = $1 AND n.deleted_at IS NULL
          AND NOT (n.id = ANY($2::text[]))`,
      [vaultId, docIds],
    );
  }
  await db.query("DELETE FROM note_index WHERE doc_id = ANY($1::text[])", [docIds]);
  await db.query("DELETE FROM note_links WHERE from_doc = ANY($1::text[])", [docIds]);
  await db.query("DELETE FROM note_relationships WHERE from_doc = ANY($1::text[])", [docIds]);
  await db.query("DELETE FROM note_labels WHERE doc_id = ANY($1::text[])", [docIds]);
  await db.query("DELETE FROM note_property_values WHERE doc_id = ANY($1::text[])", [docIds]);
  await db.query("DELETE FROM note_knowledge_identities WHERE doc_id = ANY($1::text[])", [docIds]);
  await db.query("DELETE FROM note_knowledge_state WHERE doc_id = ANY($1::text[])", [docIds]);
  for (const { vault_id: vaultId } of catalogVaults) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM notes
        WHERE vault_id = $1 AND deleted_at IS NULL AND NOT (id = ANY($2::text[]))
        ORDER BY id`,
      [vaultId, docIds],
    );
    for (const row of rows) await indexDocOnce(row.id, db);
  }
}

// ── search ──────────────────────────────────────────────────────────────────

/**
 * One ranked search hit. This shape is the API contract of BOTH
 * `GET /api/vaults/:vaultId/search` and the MCP `search_notes` tool — don't
 * change it without changing them together.
 */
export interface NoteSearchHit {
  docId: string;
  title: string;
  relPath: string;
  score: number;
}

/**
 * How many note_index rows to score per round trip. Only a doc id, a 256-float
 * vector and a small integer cross the wire per row (~2-3 KB), so a batch peaks
 * around 1 MB regardless of vault size. Note BODIES never leave Postgres.
 */
const SEARCH_BATCH = 500;

/**
 * Rank the notes of one vault against a query, keeping peak memory bounded.
 *
 * Ranking is unchanged from the original inline implementations in
 * http/routes/graph.ts and mcp/service.ts: `cosineSimilarity(embed(q), vector)`
 * plus a keyword boost of `0.1 * (matched distinct query tokens / total)`, then
 * sort by score descending and take the top `k`.
 *
 * What changed is HOW: those versions selected `ni.content` AND `ni.vector` for
 * every row in the vault with no LIMIT, so one search materialized every note
 * body and every embedding on the heap before slicing to k <= 100. Here:
 *
 *   1. the keyword-match count is computed in SQL (`position(token IN
 *      lower(title || ' ' || content))`), so bodies stay in the database;
 *   2. rows are walked in keyset-paginated batches ordered by doc_id, and only
 *      a `{docId, score}` pair is retained per note;
 *   3. titles and rel_paths are fetched afterwards for the <= k winners only.
 *
 * `readableDocIds` is pushed into the query rather than filtered afterwards, so
 * notes the caller may not read are never scored (they'd be a content oracle).
 *
 * Note on `lower()`: query tokens are ASCII by construction (`tokenize` yields
 * `[a-z0-9_]+`), and Postgres `lower()` matches JS `toLowerCase()` on ASCII, so
 * substring matching is equivalent for every realistic input. Exotic Unicode
 * that case-folds INTO ASCII (e.g. U+212A KELVIN SIGN) is the only place the two
 * could disagree, and only in the small keyword-boost term.
 */
export async function searchNoteIndex(opts: {
  vaultId: string;
  query: string;
  /** Max hits to return. Callers clamp this (search route <= 100, MCP <= 50). */
  k: number;
  /** Doc ids the caller may read — the candidate set. */
  readableDocIds: Iterable<string>;
  db?: Queryable;
}): Promise<NoteSearchHit[]> {
  const db = opts.db ?? defaultPool;
  if (opts.k <= 0) return [];
  const docIds = Array.from(opts.readableDocIds);
  if (docIds.length === 0) return [];

  const qVec = embed(opts.query);
  const qTokens = Array.from(new Set(tokenize(opts.query)));

  // Phase 1: score every candidate, retaining only id + score per note.
  const scored: Array<{ docId: string; score: number }> = [];
  let after = "";
  for (;;) {
    const { rows } = await db.query<{
      doc_id: string;
      vector: number[] | null;
      matched: number;
    }>(
      `SELECT ni.doc_id,
              ni.vector,
              (
                SELECT count(*) FROM unnest($4::text[]) AS t(tok)
                 WHERE position(t.tok IN lower(coalesce(ni.title, '') || ' ' || ni.content)) > 0
              )::int AS matched
         FROM note_index ni
         JOIN notes n ON n.id = ni.doc_id AND n.deleted_at IS NULL
        WHERE ni.vault_id = $1
          AND ni.doc_id = ANY($2::text[])
          AND ni.doc_id > $3
        ORDER BY ni.doc_id
        LIMIT $5`,
      [opts.vaultId, docIds, after, qTokens, SEARCH_BATCH],
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      const sim = r.vector ? cosineSimilarity(qVec, r.vector) : 0;
      const boost = qTokens.length > 0 ? 0.1 * (r.matched / qTokens.length) : 0;
      scored.push({ docId: r.doc_id, score: sim + boost });
    }
    after = rows[rows.length - 1].doc_id;
    if (rows.length < SEARCH_BATCH) break;
  }

  // Stable sort over doc_id-ordered input, so equal scores keep a deterministic
  // order (the previous version left ties at the database's arbitrary order).
  const top = scored.sort((a, b) => b.score - a.score).slice(0, opts.k);
  if (top.length === 0) return [];

  // Phase 2: fetch the display fields for the winners only.
  const { rows: metaRows } = await db.query<{
    doc_id: string;
    title: string | null;
    rel_path: string;
  }>(
    `SELECT ni.doc_id, ni.title, n.rel_path
       FROM note_index ni
       JOIN notes n ON n.id = ni.doc_id AND n.deleted_at IS NULL
      WHERE ni.doc_id = ANY($1::text[])`,
    [top.map((t) => t.docId)],
  );
  const meta = new Map(metaRows.map((r) => [r.doc_id, r]));

  const hits: NoteSearchHit[] = [];
  for (const t of top) {
    const m = meta.get(t.docId);
    if (!m) continue; // deleted between the two phases
    hits.push({
      docId: t.docId,
      title: m.title ?? relPathStem(m.rel_path),
      relPath: m.rel_path,
      score: t.score,
    });
  }
  return hits;
}

/** Filename stem of a rel_path, used as a fallback title. */
function relPathStem(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.[^.]+$/, "");
}
