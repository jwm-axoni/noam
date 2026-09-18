-- Workspace join codes + note indexing engine.
--
-- 1. org_join_codes: one shareable code per workspace. Any signed-in user can
--    redeem a code to become a 'member' of that workspace (see /api/orgs/join).
-- 2. note_index / note_links: derived search + graph data. Populated by the
--    indexer whenever a note's Yjs doc is stored (src/index/indexer.ts). These
--    are a rebuildable cache — safe to truncate and re-derive from doc state.

-- ── Workspace join codes (one per org, lazily generated) ───────────────────
CREATE TABLE org_join_codes (
  organization_id TEXT PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  code            TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Note index (plain text + embedding vector, one row per doc) ─────────────
CREATE TABLE note_index (
  doc_id     TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL,
  title      TEXT,
  content    TEXT NOT NULL DEFAULT '',
  vector     JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX note_index_vault_idx ON note_index (vault_id);

-- ── Wikilink graph edges (from a doc to a raw [[target]] title) ─────────────
CREATE TABLE note_links (
  vault_id text NOT NULL,
  from_doc text NOT NULL,
  to_title text NOT NULL,
  PRIMARY KEY (from_doc, to_title)
);
CREATE INDEX note_links_vault_idx ON note_links (vault_id);
