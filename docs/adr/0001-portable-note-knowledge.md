# ADR 0001: Store knowledge semantics in portable Markdown

## Status

Accepted for the Properties and knowledge-graph milestone.

## Context

Noam currently keeps property type choices in `.context/types.json`. That file is device-local and excluded from vault traversal, Git import and export, and sync. Local and server indexes also use `doc_id` as stable note identity, but a clean Git clone cannot recover that identity from the Markdown alone.

The Properties inspector, named relationships, and AI retrieval must agree across devices and Git checkouts. Relationship targets must survive note moves and title changes. Incoming relationships must be derivable without maintaining reciprocal copies. Unsupported Markdown and YAML must remain untouched.

## Decision

Noam will expose a single `NoteKnowledge` module to UI and retrieval callers. It owns inspection, semantic changes, and bounded knowledge queries while hiding YAML spans, Yjs transactions, derived indexes, permission checks, and cursor encoding.

The vault knowledge catalog will be a normal synced note at `_Noam/Knowledge schema.md`. Its frontmatter identifies `noam_kind: knowledge-schema` and a schema version; its body contains declarative JSON definitions only. It is ordinary vault content so Noam sync and Git carry it without a special hidden-path exception.

Notes that participate in named relationships will carry a reserved `noam_document_id` frontmatter value. Outgoing relationships will be stored once, keyed by a stable relationship definition and target document identity. Incoming relationships and reciprocal labels will be derived by indexes.

The module will compute the readable note set before filtering, scoring, traversal, counts, or passage extraction. An unreadable note is indistinguishable from a missing note. Results will identify both source and index revisions; callers that require current evidence receive a stale-index error instead of silent fallback.

## Consequences

- Shared property and relationship semantics survive sync and Git cloning.
- Participating notes gain one system-managed frontmatter field, visible in raw Markdown but hidden from the normal Properties view.
- Raw relationship values favor stable identity over title readability; the UI resolves current titles.
- The schema note is visible vault content. Noam may present it as a system note, but it is never stored in an ignored dot-directory.
- `.context/types.json` remains a temporary read-only migration source, then stops receiving writes after the catalog is authoritative.
- Derived local and server indexes remain disposable and must rebuild to the same result as incremental indexing.
