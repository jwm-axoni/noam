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
  page?: { limit?: number; cursor?: string };
  consistency?: "current-only" | "allow-stale";
};
```

Pages default to 25 and cap at 50. Cursors are opaque and bound to the actor, vault, normalized query, readable set, catalog revision, and index generation. Every page rechecks permissions.

Answer evidence includes `docId`, current relative path, source revision, indexed revision, and bounded source passages. `current-only` returns `stale_index` when the index cannot support current evidence.

## Required invariants

1. Document identity, not path or title, is the relationship key.
2. Outgoing relationships are stored once. Incoming views are derived.
3. Colors classify labels and tags but never affect permissions.
4. Unknown properties and unsupported YAML remain preserved and visible as raw, read-only values.
5. Permission filtering happens before scoring, traversal, counts, and evidence extraction.
6. A clean rebuild and incremental indexing produce equivalent typed values and relationships.
7. Note inspection and mutation never scan the vault.
8. Missing and unreadable notes share the same external error.

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
