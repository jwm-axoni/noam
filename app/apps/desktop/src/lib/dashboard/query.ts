/**
 * A parsed dashboard view → the arguments of the ONE query primitive
 * (`queryNotes`, spec 06), and the run that pages it.
 *
 * There is no second query engine here. Filters become `where` predicates the
 * index evaluates; a relationship filter (`people has [[Paul]]`) becomes the
 * contract's `traverse` from the resolved note, incoming over that
 * relationship. What TS does is only what the index cannot know: which
 * catalog property a written key means, and what "this week" means today.
 *
 * The never-widen rule carries through: anything the builder cannot turn into
 * a predicate is a BLOCKING issue, and a blocked view never runs.
 */

import type {
  KnowledgePredicate,
  KnowledgeSort,
  KnowledgeTraverse,
  NoteCardRow,
} from "../ipc";
import type { NoteEntry, NotesPage } from "../knowledge/noteTimes";
import type {
  KnowledgeCatalogV1,
  PropertyDefinition,
  RelationshipDefinition,
} from "../knowledge/types";
import {
  ISO_TIMESTAMP_RE,
  RELATIVE_DATE_RE,
  isBlocked,
  type DashboardViewSpec,
  type ViewIssue,
  type WhereClause,
} from "./parse";

/** Rust `MAX_PAGE_SIZE`: one `query_knowledge` page. */
export const QUERY_PAGE_MAX = 50;
/** Rust `MAX_NOTE_CARDS`. */
export const CARD_BATCH_MAX = 200;

export interface BuildContext {
  /** The EFFECTIVE catalog (`withDefaultCatalogEntries`), so `type`/`people` exist. */
  catalog: KnowledgeCatalogV1;
  /** The clock relative dates resolve against. */
  now: Date;
  /** 1 = Monday (the default), 0 = Sunday. */
  weekStart?: 0 | 1;
}

export interface RelationshipFilter {
  relationshipId: string;
  /** The wikilink target as written (`Paul`, `People/Paul`). */
  target: string;
}

export interface BuiltView {
  where: KnowledgePredicate[];
  sort: KnowledgeSort;
  relationship: RelationshipFilter | null;
  /** Parse issues plus what the catalog could not answer. */
  issues: ViewIssue[];
  blocked: boolean;
}

export type Column =
  | { kind: "name" | "path" | "created" | "modified"; key: string; label: string }
  | { kind: "property"; key: string; label: string; propertyId: string; labels: boolean }
  | { kind: "relationship"; key: string; label: string; relationshipId: string };

// ---------------------------------------------------------------------------
// Catalog resolution
// ---------------------------------------------------------------------------

type Resolved =
  | { kind: "system"; id: "created" | "modified" | "name" | "path" }
  | { kind: "tag"; propertyId: string }
  | { kind: "property"; propertyId: string; definition: PropertyDefinition | null }
  | { kind: "relationship"; definition: RelationshipDefinition };

const lower = (s: string) => s.toLowerCase();

/**
 * A written key → what it names. Order: the system keys, the frontmatter KEY
 * of a catalog property, a property id, a relationship (id, then name), a
 * property's display name, and finally the raw frontmatter key — the index
 * stores an undeclared key under its own name, so `status = done` works in a
 * vault that never wrote a catalog.
 */
export function resolveKey(key: string, catalog: KnowledgeCatalogV1): Resolved {
  const k = lower(key);
  if (k === "created" || k === "modified" || k === "name" || k === "path") {
    return { kind: "system", id: k };
  }
  if (k === "tag" || k === "tags") {
    const tags = catalog.properties.find((p) => p.key === "tags");
    return { kind: "tag", propertyId: tags?.id ?? "tags" };
  }
  const byKey = catalog.properties.find((p) => p.key === key);
  if (byKey) return { kind: "property", propertyId: byKey.id, definition: byKey };
  const byId = catalog.properties.find((p) => p.id === key);
  if (byId) return { kind: "property", propertyId: byId.id, definition: byId };
  const relationship =
    catalog.relationships.find((r) => r.id === key) ??
    catalog.relationships.find((r) => lower(r.name) === k);
  if (relationship) return { kind: "relationship", definition: relationship };
  const byName = catalog.properties.find((p) => lower(p.name) === k);
  if (byName) return { kind: "property", propertyId: byName.id, definition: byName };
  return { kind: "property", propertyId: key, definition: null };
}

// ---------------------------------------------------------------------------
// Relative dates
// ---------------------------------------------------------------------------

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * A relative phrase → the LOCAL half-open range `[from, to)` it names today.
 * Null for anything that is not one of the phrases `parse.ts` accepts.
 */
export function resolveRelative(
  phrase: string,
  now: Date,
  weekStart: 0 | 1 = 1,
): { from: Date; to: Date } | null {
  const m = RELATIVE_DATE_RE.exec(phrase.trim());
  if (!m) return null;
  const text = m[1]!.toLowerCase();
  const today = startOfDay(now);
  if (text === "today") return { from: today, to: addDays(today, 1) };
  if (text === "yesterday") return { from: addDays(today, -1), to: today };
  if (text === "this week" || text === "last week") {
    const into = (today.getDay() - weekStart + 7) % 7;
    const from = addDays(today, -into - (text === "last week" ? 7 : 0));
    return { from, to: addDays(from, 7) };
  }
  if (text === "this month") {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from, to: new Date(today.getFullYear(), today.getMonth() + 1, 1) };
  }
  if (text === "last month") {
    return {
      from: new Date(today.getFullYear(), today.getMonth() - 1, 1),
      to: new Date(today.getFullYear(), today.getMonth(), 1),
    };
  }
  // last/past N days|weeks — today included.
  const n = Number(m[2]);
  const days = m[3]!.toLowerCase().startsWith("week") ? n * 7 : n;
  if (days < 1) return null;
  return { from: addDays(today, 1 - days), to: addDays(today, 1) };
}

/** `YYYY-MM-DD` of a local date — how a date PROPERTY is stored and compared. */
function plainDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A comparison against a range `[from, to)` → predicates. `=` means "inside
 * the range", `<` "before it starts", `<=` "before it ends", `>` "after it
 * ends", `>=` "from its start on".
 */
function rangePredicates(
  propertyId: string,
  op: WhereClause["op"],
  from: string | number,
  to: string | number,
): KnowledgePredicate[] {
  switch (op) {
    case "eq":
      return [
        { propertyId, op: "gte", value: from },
        { propertyId, op: "lt", value: to },
      ];
    case "lt":
      return [{ propertyId, op: "lt", value: from }];
    case "lte":
      return [{ propertyId, op: "lt", value: to }];
    case "gt":
      return [{ propertyId, op: "gte", value: to }];
    case "gte":
      return [{ propertyId, op: "gte", value: from }];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const WIKILINK_RE = /^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/;

/** `[[People/Paul|Paul]]` → `People/Paul`; null when the value is not one link. */
export function wikilinkTarget(value: string): string | null {
  const m = WIKILINK_RE.exec(value.trim());
  const target = m?.[1]?.trim();
  return target ? target : null;
}

const DATE_KINDS = new Set(["date", "datetime"]);
const TEXT_KINDS = new Set(["text", "url", "label", "tag", "alias"]);

export function buildView(spec: DashboardViewSpec, ctx: BuildContext): BuiltView {
  const issues: ViewIssue[] = [...spec.issues];
  const where: KnowledgePredicate[] = [];
  let relationship: RelationshipFilter | null = null;
  const block = (clause: WhereClause, code: string, message: string) =>
    issues.push({ severity: "error", code, message, line: clause.line, blocking: true });

  for (const clause of spec.where) {
    const resolved = resolveKey(clause.key, ctx.catalog);
    switch (resolved.kind) {
      case "system": {
        if (resolved.id === "name" || resolved.id === "path") {
          block(clause, "unsupported-filter", `Filtering by ${resolved.id} is not supported yet.`);
          break;
        }
        const range = resolveRelative(clause.value, ctx.now, ctx.weekStart);
        if (range) {
          where.push(...rangePredicates(resolved.id, clause.op, range.from.getTime(), range.to.getTime()));
        } else if (ISO_TIMESTAMP_RE.test(clause.value) && clause.op !== "has" && clause.op !== "contains") {
          // Absolute: the index owns the grammar (a bare date is the whole UTC day).
          where.push({ propertyId: resolved.id, op: clause.op, value: clause.value });
        } else {
          block(clause, "bad-date", `"${clause.value}" is not a date Noam understands.`);
        }
        break;
      }
      case "tag": {
        if (clause.op !== "eq" && clause.op !== "has") {
          block(clause, "bad-tag", 'A tag filter is "tag = #name".');
          break;
        }
        const tag = clause.value.replace(/^#/, "");
        if (!/^[^\s#]+$/.test(tag)) {
          block(clause, "bad-tag", `"${clause.value}" is not a tag.`);
          break;
        }
        where.push({ propertyId: resolved.propertyId, op: "eq", value: tag });
        break;
      }
      case "relationship": {
        if (clause.op !== "has" && clause.op !== "eq") {
          block(clause, "bad-relationship", `${resolved.definition.name} is a relationship; write "${clause.key} has [[Note]]".`);
          break;
        }
        const target = wikilinkTarget(clause.value);
        if (!target) {
          block(clause, "bad-relationship", `"${clause.value}" is not a [[link]] to a note.`);
          break;
        }
        if (relationship) {
          block(clause, "one-relationship", "A view can filter by one relationship; split it into two views.");
          break;
        }
        relationship = { relationshipId: resolved.definition.id, target };
        break;
      }
      case "property": {
        const predicates = propertyPredicates(clause, resolved.propertyId, resolved.definition, ctx);
        if (typeof predicates === "string") block(clause, "bad-where", predicates);
        else where.push(...predicates);
        break;
      }
    }
  }

  const sort = buildSort(spec, ctx.catalog, issues);
  return { where, sort, relationship, issues, blocked: isBlocked({ issues }) };
}

function propertyPredicates(
  clause: WhereClause,
  propertyId: string,
  definition: PropertyDefinition | null,
  ctx: BuildContext,
): KnowledgePredicate[] | string {
  const kind = definition?.type.kind ?? null;
  const op = clause.op === "has" ? "eq" : clause.op;
  const value = clause.value;

  if (kind === "number" || (kind === null && /^-?\d+(?:\.\d+)?$/.test(value))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return `"${value}" is not a number.`;
    if (op === "contains") return `${clause.key} is a number; compare it with =, <, <=, > or >=.`;
    return [{ propertyId, op, value: n }];
  }
  if (kind === "checkbox" || (kind === null && /^(true|false)$/i.test(value))) {
    if (!/^(true|false)$/i.test(value)) return `${clause.key} is a checkbox; compare it with true or false.`;
    if (op !== "eq") return `${clause.key} is a checkbox; only "=" applies.`;
    return [{ propertyId, op: "eq", value: value.toLowerCase() === "true" }];
  }
  if (kind !== null && DATE_KINDS.has(kind)) {
    const range = resolveRelative(value, ctx.now, ctx.weekStart);
    if (range) {
      if (op === "contains") return `${clause.key} is a date; compare it with =, <, <=, > or >=.`;
      return rangePredicates(propertyId, op, plainDate(range.from), plainDate(range.to));
    }
    if (!ISO_TIMESTAMP_RE.test(value)) return `"${value}" is not a date Noam understands.`;
    return [{ propertyId, op, value }];
  }
  if (RELATIVE_DATE_RE.test(value) && (kind === null || !TEXT_KINDS.has(kind))) {
    // "due >= today" on a key the catalog does not type: comparing the WORD
    // "today" as text would quietly match the wrong notes.
    return `Relative dates work on created, modified and date properties; "${clause.key}" is not one.`;
  }
  let text = value;
  if (kind === "label" || kind === "tag") {
    // A label may be written by its display name; the note stores its id.
    const label = ctx.catalog.labels.find((l) => l.name.toLowerCase() === value.toLowerCase());
    if (label && !ctx.catalog.labels.some((l) => l.id === value)) text = label.id;
  }
  return [{ propertyId, op, value: text }];
}

function buildSort(spec: DashboardViewSpec, catalog: KnowledgeCatalogV1, issues: ViewIssue[]): KnowledgeSort {
  const fallback: KnowledgeSort = { key: "modified", direction: "desc" };
  if (!spec.sort) return fallback;
  const resolved = resolveKey(spec.sort.key, catalog);
  const warn = (message: string) =>
    issues.push({ severity: "warning", code: "bad-sort", message, line: null, blocking: false });
  if (resolved.kind === "system") {
    if (resolved.id === "path") {
      warn("Cannot sort by path; sorted by modified instead.");
      return fallback;
    }
    const natural = resolved.id === "name" ? "asc" : "desc";
    return { key: resolved.id, direction: spec.sort.direction ?? natural };
  }
  if (resolved.kind === "relationship") {
    warn(`Cannot sort by the ${resolved.definition.name} relationship; sorted by modified instead.`);
    return fallback;
  }
  return { key: { propertyId: resolved.propertyId }, direction: spec.sort.direction ?? "asc" };
}

/** The table's columns, resolved through the catalog. `name` always leads. */
export function resolveColumns(spec: DashboardViewSpec, catalog: KnowledgeCatalogV1): Column[] {
  const written = spec.columns ?? ["name", "modified"];
  const out: Column[] = [];
  const seen = new Set<string>();
  for (const key of ["name", ...written]) {
    const resolved = resolveKey(key, catalog);
    let column: Column;
    if (resolved.kind === "system") {
      const labels = { name: "Name", path: "Path", created: "Created", modified: "Modified" } as const;
      column = { kind: resolved.id, key, label: labels[resolved.id] };
    } else if (resolved.kind === "relationship") {
      column = { kind: "relationship", key, label: resolved.definition.name, relationshipId: resolved.definition.id };
    } else if (resolved.kind === "tag") {
      column = { kind: "property", key, label: "Tags", propertyId: resolved.propertyId, labels: true };
    } else {
      const kind = resolved.definition?.type.kind;
      column = {
        kind: "property",
        key,
        label: resolved.definition?.name ?? key,
        propertyId: resolved.propertyId,
        labels: kind === "label" || kind === "tag",
      };
    }
    const id = column.kind === "property" ? `p:${column.propertyId}` : column.kind === "relationship" ? `r:${column.relationshipId}` : column.kind;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(column);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface ViewDeps {
  queryNotes(
    query: { where: KnowledgePredicate[]; sort: KnowledgeSort; traverse?: KnowledgeTraverse | null },
    page: { limit: number; cursor?: string | null },
  ): Promise<NotesPage>;
  /** The index's wikilink resolver (path, then basename, then title). */
  resolveWikilink(name: string): Promise<{ id: string; path: string } | null>;
  listNoteCards(docIds: string[]): Promise<NoteCardRow[]>;
}

export interface ViewRow {
  entry: NoteEntry;
  /** Null when the index had no card row (a note deleted between the reads). */
  card: NoteCardRow | null;
}

export interface ViewRun {
  rows: ViewRow[];
  nextCursor: string | null;
  /** Found while running (e.g. the linked note does not exist). */
  issues: ViewIssue[];
}

/**
 * Fetch up to `want` rows of a built view, continuing from `cursor` when
 * given. Pages are the index's (at most 50); card data comes in one indexed
 * read per 200 rows. A blocked view is never run.
 */
export async function runView(
  built: BuiltView,
  want: number,
  deps: ViewDeps,
  cursor: string | null = null,
): Promise<ViewRun> {
  if (built.blocked) return { rows: [], nextCursor: null, issues: [] };
  let traverse: KnowledgeTraverse | null = null;
  if (built.relationship) {
    const target = await deps.resolveWikilink(built.relationship.target);
    if (!target) {
      return {
        rows: [],
        nextCursor: null,
        issues: [
          {
            severity: "warning",
            code: "missing-note",
            message: `[[${built.relationship.target}]] is not a note in this vault, so nothing can link to it.`,
            line: null,
            blocking: false,
          },
        ],
      };
    }
    traverse = {
      fromDocId: target.id,
      relationshipIds: [built.relationship.relationshipId],
      direction: "incoming",
      maxDepth: 1,
    };
  }

  const entries: NoteEntry[] = [];
  let next = cursor;
  do {
    const page = await deps.queryNotes(
      { where: built.where, sort: built.sort, traverse },
      { limit: Math.min(QUERY_PAGE_MAX, want - entries.length), cursor: next },
    );
    entries.push(...page.items);
    next = page.nextCursor;
  } while (next && entries.length < want);

  const cards = new Map<string, NoteCardRow>();
  for (let i = 0; i < entries.length; i += CARD_BATCH_MAX) {
    const ids = entries.slice(i, i + CARD_BATCH_MAX).map((entry) => entry.noteId);
    for (const card of await deps.listNoteCards(ids)) cards.set(card.docId, card);
  }
  return {
    rows: entries.map((entry) => ({ entry, card: cards.get(entry.noteId) ?? null })),
    nextCursor: next,
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// Table values
// ---------------------------------------------------------------------------

export type CellValue =
  | { kind: "text"; text: string }
  | { kind: "date"; ms: number | null }
  | { kind: "links"; links: Array<{ label: string; path: string | null }> };

function stem(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.toLowerCase().endsWith(".md") ? file.slice(0, -3) : file;
}

/** What one table cell shows. Values are plain text; nothing is rendered as markup. */
export function cellValue(
  row: ViewRow,
  column: Column,
  labelName: (id: string) => string = (id) => id,
): CellValue {
  switch (column.kind) {
    case "name":
      return { kind: "text", text: row.entry.name };
    case "path":
      return { kind: "text", text: row.entry.path };
    case "created":
      return { kind: "date", ms: row.entry.created };
    case "modified":
      return { kind: "date", ms: row.entry.modified };
    case "property": {
      const values = (row.card?.properties ?? [])
        .filter((p) => p.propertyId === column.propertyId)
        .map((p) => (column.labels ? labelName(p.text) : p.text));
      return { kind: "text", text: values.join(", ") };
    }
    case "relationship":
      return {
        kind: "links",
        links: (row.card?.relationships ?? [])
          .filter((r) => r.relationshipId === column.relationshipId)
          .map((r) => ({ label: r.targetPath ? stem(r.targetPath) : "missing note", path: r.targetPath })),
      };
  }
}

/** A comparable key for an in-memory header re-sort (missing values last). */
export function cellSortKey(value: CellValue): string | number | null {
  switch (value.kind) {
    case "date":
      return value.ms;
    case "text":
      return value.text === "" ? null : value.text.toLowerCase();
    case "links":
      return value.links.length === 0 ? null : value.links.map((l) => l.label.toLowerCase()).join(", ");
  }
}

/** Stable in-memory sort for a clicked header; missing values last either way. */
export function sortRows(
  rows: readonly ViewRow[],
  column: Column,
  direction: "asc" | "desc",
  labelName?: (id: string) => string,
): ViewRow[] {
  const keyed = rows.map((row, index) => ({ row, index, key: cellSortKey(cellValue(row, column, labelName)) }));
  keyed.sort((a, b) => {
    if (a.key === b.key) return a.index - b.index;
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    const order =
      typeof a.key === "number" && typeof b.key === "number"
        ? a.key - b.key
        : String(a.key).localeCompare(String(b.key), undefined, { numeric: true });
    if (order === 0) return a.index - b.index;
    return direction === "desc" ? -order : order;
  });
  return keyed.map((k) => k.row);
}

