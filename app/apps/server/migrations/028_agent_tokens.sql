-- Agent-scoped MCP tokens, token scopes, the MCP audit log, and participant
-- attribution (ADR 0003). Everything here is ADDITIVE: no column is dropped,
-- renamed or narrowed, and every existing row keeps working unchanged — an
-- existing mcp_tokens row is a `user` token with no scopes and no expiry.
-- The reverse of this file is scripts/rollback/028_agent_tokens.down.sql
-- (kept OUT of migrations/, whose runner applies every *.sql it finds).
--
-- 1. mcp_tokens gains a KIND and, for agent tokens, the participant it acts as.
--    A `user` token (every row that predates this migration, plus the OAuth
--    path) still acts AS the human who minted it. An `agent` token acts as one
--    agent participant row (migration 027) inside the minter's vault and can
--    never exceed what the minter could do (src/permissions/token-scope.ts).
--    The CHECK ties the two columns together so a row can't be an agent with
--    nobody to be, or a user token secretly carrying a participant.
--    `expires_at` is NULL for user tokens (they end at the sunset date, a
--    server setting) and set at mint for agent tokens (90 days by default).
--    ON DELETE CASCADE on the participant: a participant row only ever goes
--    away with its organization, and a token bound to nothing must die too.
ALTER TABLE mcp_tokens
  ADD COLUMN IF NOT EXISTS participant_id TEXT REFERENCES participants (id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'agent')),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE mcp_tokens
  ADD CONSTRAINT mcp_tokens_kind_participant_chk
  CHECK ((kind = 'agent') = (participant_id IS NOT NULL));

CREATE INDEX mcp_tokens_participant_idx
  ON mcp_tokens (participant_id)
  WHERE participant_id IS NOT NULL;

-- 2. Default-deny scopes. An agent token's reach is the UNION of its scope
--    rows, each capped by the minter's own effective permission on the doc;
--    a token with no rows can list vaults and nothing else. `resource_id` is
--    a folders.id, a files/notes id (doc_id), or — for 'vault' — the
--    organization id, the same convention `shares` uses for its vault-wide
--    grant. Rows die with their token (CASCADE); rotation copies them.
CREATE TABLE mcp_token_scopes (
  token_id      TEXT NOT NULL REFERENCES mcp_tokens (id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('folder', 'file', 'vault')),
  resource_id   TEXT NOT NULL,
  permission    TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  PRIMARY KEY (token_id, resource_type, resource_id)
);

-- 3. The MCP audit log: one row per tools/call, reads included. Written by the
--    MCP request handler only (src/audit/mcp-audit.ts); no tool and no route
--    reads or writes it on a caller's behalf, and tests/mcp-tool-inventory
--    asserts by source inspection that nothing under src/mcp/ names it.
--
--    Deliberately NO foreign keys: the log has to outlive the token (revoking
--    a token is the moment its history matters most), the participant, and
--    even the organization. Retention is time-based instead — 180 days
--    (MCP_AUDIT_RETENTION_DAYS), pruned lazily by the writer, independent of
--    the Y.Doc compaction threshold.
--
--    `outcome`: ok | error (bad args, unknown id, internal failure) | denied
--    (a permission or scope refusal) | rate_limited (refused before running;
--    does not count against the budget) | revoked (the token was revoked —
--    the one row a session-authenticated route writes, via the same module).
--    `bytes_out` is the size of the tool result handed back, the figure the
--    50 MB/hour read budget is measured on.
CREATE TABLE mcp_audit (
  id              BIGSERIAL PRIMARY KEY,
  token_id        TEXT,                -- NULL for OAuth-authenticated calls
  participant_id  TEXT,
  user_id         TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  tool            TEXT NOT NULL,
  doc_id          TEXT,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome         TEXT NOT NULL
                  CHECK (outcome IN ('ok', 'error', 'denied', 'rate_limited', 'revoked')),
  bytes_out       INTEGER NOT NULL DEFAULT 0 CHECK (bytes_out >= 0)
);
-- The read budget is answered from this table: calls in the last minute and
-- bytes in the last hour, per token (or per user for the OAuth path).
CREATE INDEX mcp_audit_token_at_idx ON mcp_audit (token_id, at DESC);
CREATE INDEX mcp_audit_user_at_idx  ON mcp_audit (user_id, at DESC);
-- Retention prune walks `at`.
CREATE INDEX mcp_audit_at_idx ON mcp_audit (at);

-- 4. Attribution by participant. `last_edited_by` keeps referencing "user"
--    (an agent's edits still name the minting human there, for every reader
--    that predates this column); `last_edited_participant` is the registry
--    row that actually made the edit — a human's own row over sync, an
--    agent's row over MCP. Versions get the same column so the history panel
--    can name the agent rather than its minter. SET NULL on participant
--    delete, like `last_edited_by` on user delete (migration 017).
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS last_edited_participant TEXT
    REFERENCES participants (id) ON DELETE SET NULL;

ALTER TABLE note_versions
  ADD COLUMN IF NOT EXISTS author_participant TEXT
    REFERENCES participants (id) ON DELETE SET NULL;
