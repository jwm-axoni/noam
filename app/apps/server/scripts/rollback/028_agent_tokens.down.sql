-- Reverse of migrations/028_agent_tokens.sql. Lives OUTSIDE migrations/ on
-- purpose: the runner applies every *.sql in that directory, in name order.
--
-- Apply by hand, in a transaction, then forget the migration so it can be
-- re-applied:
--   psql "$DATABASE_URL" -1 -f scripts/rollback/028_agent_tokens.down.sql
--
-- Data loss on rollback: agent tokens, every scope row, the audit log, and the
-- participant attribution columns. User tokens survive untouched.
BEGIN;

ALTER TABLE note_versions DROP COLUMN IF EXISTS author_participant;
ALTER TABLE notes DROP COLUMN IF EXISTS last_edited_participant;

DROP TABLE IF EXISTS mcp_audit;
DROP TABLE IF EXISTS mcp_token_scopes;

-- Agent tokens cannot exist without their columns; remove them first so the
-- CHECK below can be dropped with the rows it guarded.
DELETE FROM mcp_tokens WHERE kind = 'agent';
DROP INDEX IF EXISTS mcp_tokens_participant_idx;
ALTER TABLE mcp_tokens DROP CONSTRAINT IF EXISTS mcp_tokens_kind_participant_chk;
ALTER TABLE mcp_tokens
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS participant_id;

DELETE FROM _migrations WHERE name = '028_agent_tokens.sql';

COMMIT;
