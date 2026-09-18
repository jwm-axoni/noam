-- MCP connection telemetry.
--
-- Each mcp_tokens row IS one MCP connection into a workspace (the AI client that
-- holds it). Migration 006 tracked only last_used_at. To surface a live view of
-- connections in the desktop — is it still active, how much has it been used, and
-- what client is on the other end — we add two lightweight counters:
--
--   use_count   → number of tool CALLS made with this token (bumped per
--                 tools/call, not per request, so it reads as real activity).
--   last_client → the client's User-Agent from its most recent request, so the
--                 UI can name the connection ("Claude Code", "Claude Desktop", …).
--
-- "Connected vs disconnected" is derived, not stored: MCP here is stateless HTTP
-- (no long-lived socket), so a connection is "active" when last_used_at is recent.
-- The desktop computes that from last_used_at; nothing to persist.

ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS use_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS last_client TEXT;
