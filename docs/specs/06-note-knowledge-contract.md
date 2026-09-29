# Note knowledge contract

## Purpose

`NoteKnowledge` is the product seam for the docked Properties inspector, inline property editing, and bounded AI retrieval. Callers do not parse frontmatter, locate text spans, drive Yjs, query index tables directly, or filter permissions after retrieval.

```ts
interface NoteKnowledge {
  inspect<R extends InspectionRequest>(request: R): Promise<InspectionResult<R>>;
  change(request: ChangeRequest): Promise<ChangeReceipt>;
  query(request: KnowledgeQuery): Promise<KnowledgePage>;
}
```

The authenticated vault and actor scope is bound when the module is constructed. Public requests never accept an arbitrary actor ID.

## Inspect

Inspection loads one revision-consistent section at a time:

```ts
type InspectionRequest =
  | { docId: string; section: "summary" }
  | { docId: string; section: "relationships"; direction: "outgoing" | "incoming"; page?: PageRequest }
  | { docId: string; section: "backlinks"; page?: PageRequest }
  | { docId: string; section: "info" }
  | { docId: string; section: "history"; page?: PageRequest };
```

The summary includes typed properties, labels and tags, effective read or edit permission, source revision, index state, and opaque field edit tokens. Backlinks remain separate from named relationships. History identifies its provider, such as Noam versions or Git.

## Change

A caller submits semantic changes against one note. It never submits YAML offsets or Yjs objects.

```ts
type NoteChange =
  | { kind: "setProperty"; propertyId: string; value: PropertyValue; expected: EditToken }
  | { kind: "removeProperty"; propertyId: string; expected: EditToken }
  | { kind: "addRelationship"; relationshipId: string; targetDocId: string; expected: EditToken }
  | { kind: "removeRelationship"; edgeId: string; expected: EditToken };

type ChangeRequest = {
  docId: string;
  changes: NoteChange[];
};
```

Edit tokens are field-scoped. An unrelated body edit does not reject a property change, but a concurrent edit or removal of that property does. The implementation checks permission and tokens while holding the canonical document write serialization, plans minimal non-overlapping spans, applies one document transaction, persists it, and then schedules derived indexing.

A `setProperty` or `removeProperty` on a system property (`created`, `modified`) is refused with `read_only`, even when a catalog reuses the id. The frontmatter `created:` field that feeds `created` stays ordinary, editable Markdown.

## Query

Knowledge queries are bounded and paginated:

```ts
type KnowledgeQuery = {
  text?: string;
  where?: PropertyPredicate[];
  traverse?: {
    fromDocId: string;
    relationshipIds: string[];
    direction: "outgoing" | "incoming";
    maxDepth: 1 | 2 | 3 | 4;
  };
  sort?: {
    key: "name" | "created" | "modified" | { propertyId: string };
    direction: "asc" | "desc";
  };
  page?: { limit?: number; cursor?: string };
  consistency?: "current-only" | "allow-stale";
};

type PropertyPredicate = {
  propertyId: string;
  op: "eq" | "contains" | "lt" | "lte" | "gt" | "gte";
  value: string | number | boolean;
};
```

Pages default to 25 and cap at 50. Cursors are opaque and bound to the actor, vault, normalized query (including `sort`), readable set, catalog revision, and index generation, so a cursor minted under one sort is refused (`cursor_expired`) under another. Every page rechecks permissions.

### Sort

- `name` is the filename stem the UI displays (never the derived title).
- `created` and `modified` are the system properties below.
- `{ propertyId }` sorts by that property's first value (lowest ordinal). Numbers compare numerically, booleans `false < true`, and text (including dates and datetimes, which are ISO strings) compares ASCII-case-insensitively by UTF-8 bytes. When one property holds mixed types across notes, numbers rank before booleans, which rank before text.
- A note with no sortable value for the key (property absent, empty text, a list or nested value, an unknown `created`) sorts **last in both directions**.
- Every tie breaks by `doc_id` ascending (UTF-8 byte order), in both directions.
- With no `sort`, results are in `doc_id` order.

### System properties

Every note has two read-only, derived properties with reserved ids. Both are epoch milliseconds (UTC). They are usable in `where` with `eq`, `lt`, `lte`, `gt` and `gte` against an ISO date, an ISO datetime, or a number of epoch milliseconds. A date-only value means the whole UTC day: `created eq 2026-09-01` matches anything created that day and `lte` includes all of it. `contains`, a boolean, or an unparseable value is `schema_invalid`.

The accepted timestamp grammar is `YYYY-MM-DD` or `YYYY-MM-DD[T ]HH:MM[:SS[.fraction]][Z|±HH:MM|±HHMM]`. A date is its UTC midnight, a datetime without an offset is read as UTC, and fractions truncate to milliseconds. Anything else is not a timestamp.

`created` resolves in this order:

1. frontmatter `created:` when it is a scalar in the grammar above (user-owned, travels with the file);
2. the server's `notes.created_at` (desktop: recorded from the registry pull into the local index, keyed by `doc_id`; it survives `rebuild` because it cannot be re-derived from the file);
3. desktop only: the file birthtime, for local-only vaults. Atomic saves replace the file on every write, so the index keeps the earliest birthtime it has observed. Filesystems without a birthtime give no value.

`modified` is the file mtime on the desktop (second precision; on a freshly synced device every mtime is the moment the note was materialized there, which is acceptable for sorting) and `notes.last_edited_at` on the server (stamped by content edits only, never renames or moves, at most once a minute per editor), falling back to `notes.created_at`.

The desktop reports the resolved source (`frontmatter`, `server` or `birthtime`) beside the value. Server evidence carries `created`, `createdSource` and `modified` as ISO strings.

### Implementations

The server's MCP `query_knowledge` accepts the query above. The desktop exposes the same `where`, `sort` and `traverse` as the `notes` kind of its `query_knowledge` command (`{ kind: "notes", where, sort, traverse? }`, items of kind `noteEntry`; `traverse` walks resolved relationship edges from `fromDocId`, the start excluded, like the server's `traversalCandidates`, and is what a dashboard's `people has [[Paul]]` becomes), plus a bulk `list_note_times` read for list views. Both implementations replay one shared fixture, `app/packages/contracts/fixtures/knowledge-sort-parity.json`, and must produce the same ordered `doc_id`s for every case in it; a contract change updates the fixture and both sides together.

Answer evidence includes `docId`, current relative path, source revision, indexed revision, and bounded source passages. `current-only` returns `stale_index` when the index cannot support current evidence.

## Seeded defaults

Every vault starts with two built-in catalog entries. Each applies only when the vault's catalog note (`_Noam/Knowledge schema.md`) does not define it; the catalog note always wins, and Noam never writes the catalog note or any other file to add them. They exist only in the effective catalog each implementation computes in memory.

| Entry | Definition | Steps aside when the catalog defines |
|---|---|---|
| `type` property | key `type`, name "Type", kind `label`, cardinality `one` | a property with id `type` or key `type` |
| `people` relationship | name "People", cardinality `many`, inverse name "Appears in" | a relationship with id `people` |

`people` is an ordinary named relationship: it is stored in the source note's `noam_relationships` as `people:<document id>`, keyed by the person note's portable identity, so renaming a person's note never breaks it. Users rename or extend either entry by defining it in the catalog note.

## Required invariants

1. Document identity, not path or title, is the relationship key.
2. Outgoing relationships are stored once. Incoming views are derived.
3. Colors classify labels and tags but never affect permissions.
4. Unknown properties and unsupported YAML remain preserved and visible as raw, read-only values.
5. Permission filtering happens before scoring, traversal, counts, and evidence extraction.
6. A clean rebuild and incremental indexing produce equivalent typed values and relationships.
7. Note inspection and mutation never scan the vault.
8. Missing and unreadable notes share the same external error.
9. System properties are derived and read-only; no change request writes them.
10. The same notes and the same query produce the same order on the desktop and the server.

## Errors

The public error vocabulary is discriminated and stable: `not_found`, `read_only`, `stale_edit`, `unsupported_frontmatter`, `schema_invalid`, `ambiguous_reference`, `missing_reference`, `duplicate_document_identity`, `stale_index`, `cursor_expired`, `limit_exceeded`, and `temporarily_unavailable`.

## Migration order

1. Read the existing explicit `.context/types.json` choices without deleting the file.
2. Create `_Noam/Knowledge schema.md` only through a reviewed user action.
3. Keep inferred and unsupported properties raw until an explicit definition exists.
4. Add `noam_document_id` lazily when a note first participates in a named relationship.
5. Add typed property and relationship index rows beside the current indexes.
6. Dual-read and compare during backfill, then switch callers after rebuild equivalence passes.
7. Stop writing `.context/types.json` after the portable catalog becomes authoritative.
