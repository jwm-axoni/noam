-- Rebuildable note-knowledge projections derived from canonical Yjs Markdown.
-- Every table is disposable. `src/index/indexer.ts` replaces one document's
-- rows after each successful parse and can rebuild the same rows from scratch.

CREATE TABLE note_knowledge_state (
  doc_id          TEXT PRIMARY KEY REFERENCES notes (id) ON DELETE CASCADE,
  vault_id        TEXT NOT NULL,
  source_revision TEXT,
  index_revision  TEXT,
  state           TEXT NOT NULL DEFAULT 'stale'
                  CHECK (state IN ('current', 'stale', 'failed')),
  generation      BIGINT NOT NULL DEFAULT 0,
  error_code      TEXT,
  indexed_at      TIMESTAMPTZ
);
CREATE INDEX note_knowledge_state_vault_idx
  ON note_knowledge_state (vault_id, state, doc_id);

-- A portable identity is allowed to be duplicated in storage so indexing one
-- malformed note never destroys the prior projection. Resolution uses only
-- identities that occur exactly once within a vault.
CREATE TABLE note_knowledge_identities (
  doc_id       TEXT PRIMARY KEY REFERENCES notes (id) ON DELETE CASCADE,
  vault_id     TEXT NOT NULL,
  document_id  TEXT NOT NULL
);
CREATE INDEX note_knowledge_identities_lookup_idx
  ON note_knowledge_identities (vault_id, document_id, doc_id);

CREATE TABLE note_property_values (
  doc_id         TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  vault_id       TEXT NOT NULL,
  property_id    TEXT NOT NULL,
  value_order    INTEGER NOT NULL,
  value_type     TEXT NOT NULL
                 CHECK (value_type IN ('text', 'number', 'boolean', 'date', 'datetime')),
  text_value     TEXT,
  number_value   DOUBLE PRECISION,
  boolean_value  BOOLEAN,
  PRIMARY KEY (doc_id, property_id, value_order)
);
CREATE INDEX note_property_values_filter_idx
  ON note_property_values (vault_id, property_id, value_type, text_value, doc_id);
CREATE INDEX note_property_values_number_idx
  ON note_property_values (vault_id, property_id, number_value, doc_id)
  WHERE number_value IS NOT NULL;

-- Labels include ordinary label-valued properties and the special tags field.
-- `kind` keeps tags distinct without a second copy of their source value.
CREATE TABLE note_labels (
  doc_id       TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  vault_id     TEXT NOT NULL,
  property_id  TEXT NOT NULL,
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('label', 'tag')),
  PRIMARY KEY (doc_id, property_id, label)
);
CREATE INDEX note_labels_filter_idx
  ON note_labels (vault_id, property_id, label, doc_id);

-- Store the authored direction once. The target remains the portable document
-- identity; incoming rows and current note ids are resolved by indexed reversal.
CREATE TABLE note_relationships (
  vault_id              TEXT NOT NULL,
  from_doc              TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  relationship_id       TEXT NOT NULL,
  target_document_id    TEXT NOT NULL,
  value_order            INTEGER NOT NULL,
  PRIMARY KEY (from_doc, relationship_id, target_document_id)
);
CREATE INDEX note_relationships_outgoing_idx
  ON note_relationships (vault_id, from_doc, relationship_id, value_order);
CREATE INDEX note_relationships_incoming_idx
  ON note_relationships (vault_id, target_document_id, relationship_id, from_doc);
