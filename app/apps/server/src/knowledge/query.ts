import { createHash, createHmac } from "node:crypto";
import type pg from "pg";
import { config } from "../config.js";
import { pgText } from "../db/text.js";
import { pool as defaultPool } from "../db/pool.js";
import { extractDocText } from "../index/indexer.js";
import { listReadableDocsInVault } from "../permissions/vault-docs.js";
import {
  compareSorted,
  isSystemProperty,
  noteName,
  systemRange,
  textSortValue,
  type KnowledgeSort,
  type SortValue,
} from "./system.js";

export type { KnowledgeSort } from "./system.js";

type Queryable = Pick<pg.Pool, "query">;

export type KnowledgeErrorCode =
  | "not_found"
  | "stale_index"
  | "cursor_expired"
  | "limit_exceeded"
  | "schema_invalid"
  | "temporarily_unavailable";

export class KnowledgeQueryError extends Error {
  constructor(readonly code: KnowledgeErrorCode, message: string) {
    super(message);
  }
}

export interface PropertyPredicate {
  propertyId: string;
  op: "eq" | "contains" | "lt" | "lte" | "gt" | "gte";
  value: string | number | boolean;
}

export interface KnowledgeQuery {
  text?: string;
  where?: PropertyPredicate[];
  traverse?: {
    fromDocId: string;
    relationshipIds: string[];
    direction: "outgoing" | "incoming";
    maxDepth: 1 | 2 | 3 | 4;
  };
  /**
   * Order of the page. Ties break by doc id ascending; a note without a
   * sortable value sorts last in both directions. Absent = doc id order.
   */
  sort?: KnowledgeSort;
  page?: { limit?: number; cursor?: string };
  consistency?: "current-only" | "allow-stale";
}

export interface AnswerEvidence {
  docId: string;
  documentId: string | null;
  title: string;
  path: string;
  sourceRevision: string;
  indexRevision: string | null;
  indexState: "current" | "stale" | "failed" | "missing";
  /** System property `created` (ISO, UTC): frontmatter `created:`, else when
   *  the server first registered the note. */
  created: string;
  createdSource: "frontmatter" | "server";
  /** System property `modified` (ISO, UTC): the last content edit. */
  modified: string;
  passages: Array<{ start: number; end: number; text: string }>;
}

export interface KnowledgePage {
  items: AnswerEvidence[];
  count: number;
  nextCursor: string | null;
}

interface CursorPayload {
  actorId: string;
  vaultId: string;
  queryHash: string;
  readableHash: string;
  indexHash: string;
  lastDocId: string;
  /** Sorted queries only: the last row's sort value (JSON), for keyset paging. */
  lastKey?: string;
}

interface IndexedState {
  doc_id: string;
  generation: string | number | null;
  index_revision: string | null;
  state: "current" | "stale" | "failed" | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_FILTERS = 50;
const MAX_FILTER_TEXT = 8_192;
const PASSAGE_CHARS = 600;
const DEFINITION_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function encodeCursor(payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${cursorSignature(body)}`;
}

function cursorSignature(body: string): string {
  return createHmac("sha256", config.jwtSecret).update(body, "utf8").digest("base64url");
}

function decodeCursor(value: string): CursorPayload {
  if (value.length > 8_192) {
    throw new KnowledgeQueryError("cursor_expired", "The query cursor is invalid");
  }
  const [body, checksum, extra] = value.split(".");
  if (!body || !checksum || extra || cursorSignature(body) !== checksum) {
    throw new KnowledgeQueryError("cursor_expired", "The query cursor is invalid");
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (
      !payload ||
      typeof payload.actorId !== "string" ||
      typeof payload.vaultId !== "string" ||
      typeof payload.queryHash !== "string" ||
      typeof payload.readableHash !== "string" ||
      typeof payload.indexHash !== "string" ||
      typeof payload.lastDocId !== "string" ||
      (payload.lastKey !== undefined && typeof payload.lastKey !== "string")
    ) {
      throw new Error("invalid cursor payload");
    }
    return payload as CursorPayload;
  } catch {
    throw new KnowledgeQueryError("cursor_expired", "The query cursor is invalid");
  }
}

function revision(content: string): string {
  return hash(content);
}

function passage(content: string, query: string | undefined): AnswerEvidence["passages"] {
  if (content.length === 0) return [];
  const needle = query?.trim().toLowerCase() ?? "";
  const match = needle ? content.toLowerCase().indexOf(needle) : 0;
  const center = match >= 0 ? match : 0;
  const start = Math.max(0, center - Math.floor(PASSAGE_CHARS / 3));
  const end = Math.min(content.length, start + PASSAGE_CHARS);
  return [{ start, end, text: content.slice(start, end) }];
}

async function readableNoteState(
  db: Queryable,
  vaultId: string,
  readable: string[],
): Promise<IndexedState[]> {
  if (readable.length === 0) return [];
  const { rows } = await db.query<IndexedState>(
    `SELECT n.id AS doc_id, ks.generation, ks.index_revision, ks.state
       FROM notes n
       LEFT JOIN note_knowledge_state ks ON ks.doc_id = n.id
      WHERE n.vault_id = $1 AND n.deleted_at IS NULL AND n.id = ANY($2::text[])
      ORDER BY n.id`,
    [vaultId, readable],
  );
  return rows;
}

async function traversalCandidates(
  db: Queryable,
  vaultId: string,
  readable: string[],
  traversal: NonNullable<KnowledgeQuery["traverse"]>,
): Promise<string[]> {
  if (!readable.includes(traversal.fromDocId)) {
    throw new KnowledgeQueryError("not_found", "The note was not found");
  }
  const outgoing = traversal.direction === "outgoing";
  const nextDoc = outgoing ? "target.doc_id" : "r.from_doc";
  const joins = outgoing
    ? `JOIN note_relationships r ON r.vault_id = $1 AND r.from_doc = walk.doc_id
       JOIN unique_identity target ON target.document_id = r.target_document_id`
    : `JOIN unique_identity target ON target.doc_id = walk.doc_id
       JOIN note_relationships r ON r.vault_id = $1
        AND r.target_document_id = target.document_id`;
  const { rows } = await db.query<{ doc_id: string }>(
    `WITH RECURSIVE unique_identity AS (
       SELECT document_id, min(doc_id) AS doc_id
         FROM note_knowledge_identities
        WHERE vault_id = $1 AND doc_id = ANY($2::text[])
        GROUP BY document_id HAVING count(*) = 1
     ), walk(doc_id, depth, visited) AS (
       SELECT $3::text, 0, ARRAY[$3::text]
       UNION ALL
       SELECT ${nextDoc}, walk.depth + 1, walk.visited || ${nextDoc}
         FROM walk
         ${joins}
        WHERE walk.depth < $4
          AND ${nextDoc} = ANY($2::text[])
          AND NOT (${nextDoc} = ANY(walk.visited))
          AND (cardinality($5::text[]) = 0 OR r.relationship_id = ANY($5::text[]))
     )
     SELECT DISTINCT doc_id FROM walk WHERE depth > 0 ORDER BY doc_id`,
    [vaultId, readable, traversal.fromDocId, traversal.maxDepth, traversal.relationshipIds],
  );
  return rows.map((row) => row.doc_id);
}

/**
 * The system properties as SQL over `notes n` + `note_knowledge_state ks`, in
 * epoch ms. `modified` reads `last_edited_at`, which only content edits stamp
 * (a rename or move bumps `updated_at` instead); see `system.ts`.
 */
const CREATED_MS_SQL =
  "COALESCE(ks.frontmatter_created_ms, floor(extract(epoch FROM n.created_at) * 1000)::bigint)";
const MODIFIED_MS_SQL =
  "floor(extract(epoch FROM COALESCE(n.last_edited_at, n.created_at)) * 1000)::bigint";
const CREATED_SOURCE_SQL =
  "CASE WHEN ks.frontmatter_created_ms IS NOT NULL THEN 'frontmatter' ELSE 'server' END";
const SYSTEM_PREDICATE_HELP =
  "compares (eq/lt/lte/gt/gte) with an ISO date/datetime or epoch milliseconds";

function systemPredicateSql(predicate: PropertyPredicate, params: unknown[]): string {
  const range = systemRange(predicate.op, predicate.value);
  if (!range) {
    throw new KnowledgeQueryError("schema_invalid", `${predicate.propertyId} ${SYSTEM_PREDICATE_HELP}`);
  }
  const expr = predicate.propertyId === "created" ? CREATED_MS_SQL : MODIFIED_MS_SQL;
  const bounds: string[] = [];
  if (range.lo !== null) {
    params.push(range.lo);
    bounds.push(`${expr} >= $${params.length}::bigint`);
  }
  if (range.hi !== null) {
    params.push(range.hi);
    bounds.push(`${expr} < $${params.length}::bigint`);
  }
  return `(${bounds.join(" AND ")})`;
}

function predicateSql(
  predicate: PropertyPredicate,
  params: unknown[],
): string {
  if (isSystemProperty(predicate.propertyId)) return systemPredicateSql(predicate, params);
  params.push(predicate.propertyId);
  const property = `$${params.length}`;
  if (typeof predicate.value === "number") {
    params.push(predicate.value);
    const value = `$${params.length}`;
    if (predicate.op === "contains") return "FALSE";
    const op = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" }[predicate.op];
    return `EXISTS (SELECT 1 FROM note_property_values pv
      WHERE pv.doc_id = n.id AND pv.property_id = ${property}
        AND pv.value_type = 'number'
        AND pv.number_value ${op} ${value}::double precision)`;
  }
  if (typeof predicate.value === "boolean") {
    if (predicate.op !== "eq") return "FALSE";
    params.push(predicate.value);
    return `EXISTS (SELECT 1 FROM note_property_values pv
      WHERE pv.doc_id = n.id AND pv.property_id = ${property}
        AND pv.value_type = 'boolean'
        AND pv.boolean_value = $${params.length}::boolean)`;
  }
  params.push(predicate.value);
  const value = `$${params.length}`;
  if (predicate.op === "contains") {
    return `EXISTS (SELECT 1 FROM note_property_values pv
      WHERE pv.doc_id = n.id AND pv.property_id = ${property}
        AND pv.value_type IN ('text', 'date', 'datetime')
        AND position(lower(${value}) IN lower(coalesce(pv.text_value, ''))) > 0)`;
  }
  const op = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" }[predicate.op];
  return `EXISTS (SELECT 1 FROM note_property_values pv
    WHERE pv.doc_id = n.id AND pv.property_id = ${property}
      AND pv.value_type IN ('text', 'date', 'datetime')
      AND pv.text_value ${op} ${value})`;
}

interface CandidateRow {
  doc_id: string;
  document_id: string | null;
  title: string | null;
  rel_path: string;
  created_ms: string;
  created_source: "frontmatter" | "server";
  modified_ms: string;
}

interface SortColumns {
  sort_type?: string | null;
  sort_text?: string | null;
  sort_number?: number | null;
  sort_boolean?: boolean | null;
}

/** One row's sort value; null = no sortable value (sorts last). */
function sortValue(sort: KnowledgeSort, row: CandidateRow & SortColumns): SortValue | null {
  if (sort.key === "name") return textSortValue(noteName(row.rel_path));
  if (sort.key === "created") return { t: "n", v: Number(row.created_ms) };
  if (sort.key === "modified") return { t: "n", v: Number(row.modified_ms) };
  switch (row.sort_type) {
    case "number":
      return row.sort_number == null ? null : { t: "n", v: Number(row.sort_number) };
    case "boolean":
      return row.sort_boolean == null ? null : { t: "b", v: row.sort_boolean };
    case "text":
    case "date":
    case "datetime":
      return textSortValue(row.sort_text);
    default:
      return null;
  }
}

export function createKnowledgeQuery(
  scope: { actorId: string; vaultId: string },
  deps: { db?: Queryable; readableDocs?: typeof listReadableDocsInVault } = {},
) {
  const db = deps.db ?? defaultPool;
  const readableDocs = deps.readableDocs ?? listReadableDocsInVault;

  return async function queryKnowledge(query: KnowledgeQuery): Promise<KnowledgePage> {
    const limit = query.page?.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new KnowledgeQueryError("limit_exceeded", `Page limit must be between 1 and ${MAX_LIMIT}`);
    }
    if (query.traverse && ![1, 2, 3, 4].includes(query.traverse.maxDepth)) {
      throw new KnowledgeQueryError("limit_exceeded", "Traversal depth must be between 1 and 4");
    }
    if ((query.where?.length ?? 0) > MAX_FILTERS) {
      throw new KnowledgeQueryError("limit_exceeded", `Queries accept at most ${MAX_FILTERS} property filters`);
    }
    if (query.where?.some((predicate) =>
      predicate.propertyId.length > 256 ||
      (typeof predicate.value === "string" && predicate.value.length > MAX_FILTER_TEXT)
    )) {
      throw new KnowledgeQueryError("limit_exceeded", "A property filter is too large");
    }
    if (query.sort) {
      const { key, direction } = query.sort;
      const validKey = key === "name" || key === "created" || key === "modified" || (
        typeof key === "object" && key !== null &&
        typeof key.propertyId === "string" && key.propertyId.length > 0 && key.propertyId.length <= 256
      );
      if (!validKey || (direction !== "asc" && direction !== "desc")) {
        throw new KnowledgeQueryError(
          "schema_invalid",
          "sort needs a key (name, created, modified or { propertyId }) and a direction (asc or desc)",
        );
      }
    }
    for (const predicate of query.where ?? []) {
      if (isSystemProperty(predicate.propertyId) && !systemRange(predicate.op, predicate.value)) {
        throw new KnowledgeQueryError("schema_invalid", `${predicate.propertyId} ${SYSTEM_PREDICATE_HELP}`);
      }
    }
    if (query.traverse && (
      query.traverse.relationshipIds.length > MAX_FILTERS ||
      query.traverse.relationshipIds.some((id) => !DEFINITION_ID.test(id))
    )) {
      throw new KnowledgeQueryError(
        "limit_exceeded",
        `Traversal accepts at most ${MAX_FILTERS} valid relationship ids`,
      );
    }

    // This must remain the first data-dependent operation. Every later filter,
    // traversal, count and evidence read works only over this set.
    const readableSet = await readableDocs(scope.actorId, scope.vaultId, db);
    const readable = [...readableSet].sort();
    const states = await readableNoteState(db, scope.vaultId, readable);
    const noteIds = states.map((state) => state.doc_id);
    const stateById = new Map(states.map((state) => [state.doc_id, state]));
    const stale = states.some((state) => state.state !== "current" || !state.index_revision);
    if ((query.consistency ?? "current-only") === "current-only" && stale) {
      throw new KnowledgeQueryError("stale_index", "The knowledge index is not current");
    }

    const queryShape = { ...query, page: { limit }, consistency: query.consistency ?? "current-only" };
    const queryHash = hash(stable(queryShape));
    const readableHash = hash(readable.join("\0"));
    const { rows: catalogRows } = await db.query<{ index_revision: string | null }>(
      `SELECT ks.index_revision FROM notes n
       LEFT JOIN note_knowledge_state ks ON ks.doc_id = n.id
       WHERE n.vault_id = $1 AND lower(n.rel_path) = lower('_Noam/Knowledge schema.md')
         AND n.deleted_at IS NULL AND n.id = ANY($2::text[]) LIMIT 1`,
      [scope.vaultId, noteIds],
    );
    const indexHash = hash(
      `${catalogRows[0]?.index_revision ?? ""}\0${states
        .map((state) => `${state.doc_id}:${state.generation ?? ""}:${state.index_revision ?? ""}:${state.state ?? "missing"}`)
        .join("\0")}`,
    );

    let after = "";
    let afterKey: SortValue | null | undefined;
    if (query.page?.cursor) {
      const cursor = decodeCursor(query.page.cursor);
      if (
        cursor.actorId !== scope.actorId ||
        cursor.vaultId !== scope.vaultId ||
        cursor.queryHash !== queryHash ||
        cursor.readableHash !== readableHash ||
        cursor.indexHash !== indexHash
      ) {
        throw new KnowledgeQueryError("cursor_expired", "The query changed since this page was read");
      }
      after = cursor.lastDocId;
      if (query.sort) {
        if (cursor.lastKey === undefined) {
          throw new KnowledgeQueryError("cursor_expired", "The query changed since this page was read");
        }
        afterKey = JSON.parse(cursor.lastKey) as SortValue | null;
      }
    }

    let candidates = noteIds;
    if (query.traverse) {
      candidates = await traversalCandidates(db, scope.vaultId, noteIds, query.traverse);
    }
    if (candidates.length === 0) return { items: [], count: 0, nextCursor: null };

    const params: unknown[] = [scope.vaultId, candidates];
    const filters = ["n.vault_id = $1", "n.deleted_at IS NULL", "n.id = ANY($2::text[])"];
    if (query.text?.trim()) {
      params.push(query.text.trim());
      filters.push(
        `position(lower($${params.length}) IN lower(coalesce(ni.title, '') || ' ' || ni.content)) > 0`,
      );
    }
    for (const predicate of query.where ?? []) filters.push(predicateSql(predicate, params));
    const where = filters.join(" AND ");
    const from = `notes n
       JOIN note_index ni ON ni.doc_id = n.id
       LEFT JOIN note_knowledge_state ks ON ks.doc_id = n.id`;
    const columns = `n.id AS doc_id, ki.document_id, ni.title, n.rel_path,
            ${CREATED_MS_SQL}::text AS created_ms, ${CREATED_SOURCE_SQL} AS created_source,
            ${MODIFIED_MS_SQL}::text AS modified_ms`;

    let count: number;
    let rows: CandidateRow[];
    let pageKeys: Array<SortValue | null> = [];
    if (query.sort) {
      // Sorted: order every matching row with the SAME comparator the desktop
      // uses (`system.ts`), then keyset-page on (sort value, doc id). The set
      // is bounded by the caller's readable notes in one vault.
      const sort = query.sort;
      const property = typeof sort.key === "object" ? sort.key.propertyId : null;
      let lateral = "";
      if (property !== null) {
        params.push(property);
        lateral = `LEFT JOIN LATERAL (
          SELECT pv.value_type, pv.text_value, pv.number_value, pv.boolean_value
            FROM note_property_values pv
           WHERE pv.doc_id = n.id AND pv.property_id = $${params.length}
           ORDER BY pv.value_order LIMIT 1
        ) sv ON TRUE`;
      }
      const sortColumns = property !== null
        ? `, sv.value_type AS sort_type, sv.text_value AS sort_text,
             sv.number_value AS sort_number, sv.boolean_value AS sort_boolean`
        : "";
      const { rows: all } = await db.query<CandidateRow & SortColumns>(
        `SELECT ${columns}${sortColumns}
           FROM ${from}
           LEFT JOIN note_knowledge_identities ki ON ki.doc_id = n.id
           ${lateral}
          WHERE ${where}`,
        params,
      );
      const keyed = all.map((row) => ({ row, key: sortValue(sort, row), docId: row.doc_id }));
      keyed.sort((a, b) => compareSorted(a, b, sort.direction));
      count = keyed.length;
      let start = 0;
      if (afterKey !== undefined) {
        const last = { key: afterKey, docId: after };
        while (start < keyed.length && compareSorted(keyed[start]!, last, sort.direction) <= 0) start++;
      }
      const slice = keyed.slice(start, start + limit + 1);
      rows = slice.map((entry) => entry.row);
      pageKeys = slice.map((entry) => entry.key);
    } else {
      const { rows: countRows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${from} WHERE ${where}`,
        params,
      );
      count = Number(countRows[0]?.count ?? 0);

      params.push(after, limit + 1);
      ({ rows } = await db.query<CandidateRow>(
        `SELECT ${columns}
           FROM ${from}
           LEFT JOIN note_knowledge_identities ki ON ki.doc_id = n.id
          WHERE ${where} AND n.id > $${params.length - 1}
          ORDER BY n.id LIMIT $${params.length}`,
        params,
      ));
    }
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = await Promise.all(
      pageRows.map(async (row): Promise<AnswerEvidence> => {
        const canonicalContent = await extractDocText(row.doc_id, db);
        const content = pgText(canonicalContent);
        const sourceRevision = revision(canonicalContent);
        const indexed = stateById.get(row.doc_id);
        const indexRevision = indexed?.index_revision ?? null;
        const indexState = indexed?.state ?? "missing";
        if (
          (query.consistency ?? "current-only") === "current-only" &&
          (indexState !== "current" || sourceRevision !== indexRevision)
        ) {
          throw new KnowledgeQueryError("stale_index", "The knowledge index is not current");
        }
        return {
          docId: row.doc_id,
          documentId: row.document_id,
          title: row.title ?? row.rel_path.replace(/^.*\//, "").replace(/\.[^.]+$/, ""),
          path: row.rel_path,
          sourceRevision,
          indexRevision,
          indexState,
          created: new Date(Number(row.created_ms)).toISOString(),
          createdSource: row.created_source,
          modified: new Date(Number(row.modified_ms)).toISOString(),
          passages: passage(content, query.text),
        };
      }),
    );
    const lastDocId = pageRows.at(-1)?.doc_id;
    const lastKey = query.sort ? JSON.stringify(pageKeys[pageRows.length - 1] ?? null) : undefined;
    const nextCursor = hasMore && lastDocId
      ? encodeCursor({
          ...scope,
          queryHash,
          readableHash,
          indexHash,
          lastDocId,
          ...(lastKey !== undefined ? { lastKey } : {}),
        })
      : null;
    return { items, count, nextCursor };
  };
}
