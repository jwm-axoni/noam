import { createHash, createHmac } from "node:crypto";
import type pg from "pg";
import { config } from "../config.js";
import { pgText } from "../db/text.js";
import { pool as defaultPool } from "../db/pool.js";
import { extractDocText } from "../index/indexer.js";
import { listReadableDocsInVault } from "../permissions/vault-docs.js";

type Queryable = Pick<pg.Pool, "query">;

export type KnowledgeErrorCode =
  | "not_found"
  | "stale_index"
  | "cursor_expired"
  | "limit_exceeded"
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
      typeof payload.lastDocId !== "string"
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

function predicateSql(
  predicate: PropertyPredicate,
  params: unknown[],
): string {
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
    const { rows: countRows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM notes n
       JOIN note_index ni ON ni.doc_id = n.id WHERE ${where}`,
      params,
    );
    const count = Number(countRows[0]?.count ?? 0);

    params.push(after, limit + 1);
    const { rows } = await db.query<{
      doc_id: string;
      document_id: string | null;
      title: string | null;
      rel_path: string;
    }>(
      `SELECT n.id AS doc_id, ki.document_id, ni.title, n.rel_path
         FROM notes n JOIN note_index ni ON ni.doc_id = n.id
         LEFT JOIN note_knowledge_identities ki ON ki.doc_id = n.id
        WHERE ${where} AND n.id > $${params.length - 1}
        ORDER BY n.id LIMIT $${params.length}`,
      params,
    );
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
          passages: passage(content, query.text),
        };
      }),
    );
    const lastDocId = pageRows.at(-1)?.doc_id;
    const nextCursor = hasMore && lastDocId
      ? encodeCursor({ ...scope, queryHash, readableHash, indexHash, lastDocId })
      : null;
    return { items, count, nextCursor };
  };
}
