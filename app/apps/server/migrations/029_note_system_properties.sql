-- The `created` system property of query_knowledge (spec 06) prefers a note's
-- frontmatter `created:` over `notes.created_at`. The indexer parses it into
-- epoch milliseconds beside the rest of the doc's knowledge state; like every
-- column of this table it is derived and rebuildable from the Yjs Markdown.
--
-- `system_projection` records which version of that projection a row holds.
-- Existing rows start at 0, and boot backfill (`backfillIndex`) re-indexes
-- them without marking them stale, so `current-only` queries keep working
-- while the column fills in (until then `created` falls back to created_at).
ALTER TABLE note_knowledge_state
  ADD COLUMN IF NOT EXISTS frontmatter_created_ms BIGINT,
  ADD COLUMN IF NOT EXISTS system_projection SMALLINT NOT NULL DEFAULT 0;
