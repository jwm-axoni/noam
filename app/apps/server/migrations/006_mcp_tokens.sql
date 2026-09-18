-- MCP access tokens.
--
-- The server exposes a Model Context Protocol endpoint (POST /api/mcp) so any
-- MCP-speaking AI client can read/write the vault the SAME way the app does —
-- gated by the SAME per-file ACL (src/permissions/resolver.ts).
--
-- A token is minted by a signed-in user from Workspace settings and scoped to
-- one (user, workspace) pair: the MCP acts AS that user IN that workspace, so
-- owners/admins get full access and plain members only see what's shared with
-- them. We store only a sha256 hash of the token (never the plaintext) plus a
-- short prefix for display. Revoke = delete the row (access dies immediately).

CREATE TABLE mcp_tokens (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,       -- sha256(hex) of the plaintext token
  token_prefix    TEXT NOT NULL,              -- first chars, e.g. "mcp_ab12…", for display
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ
);
CREATE INDEX mcp_tokens_user_idx ON mcp_tokens (user_id);
CREATE INDEX mcp_tokens_org_idx ON mcp_tokens (organization_id);
