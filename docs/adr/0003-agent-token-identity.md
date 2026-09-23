# ADR 0003: Agent-scoped tokens and server-stamped attribution

## Status

Proposed. Gates Phase 3 (agent participants). Phase 0 shipped the registry rows
this design attaches to; nothing in Phase 0 or Phase 1 widens the current token
model.

## Context

Today an MCP token (`mcp_tokens`, migration 006; `mcp/tokens.ts`) authenticates
a client `AS one user WITHIN one vault`. `McpAuth` is `{ userId, organizationId,
tokenId? }`, and every tool call runs under `effectivePermission(userId, docId)`.
Attribution is user-shaped too: `DocActor` is `{ userId }`, and
`notes.last_edited_by` (migration 017) references `"user"`. The only per-token
telemetry is `use_count`, `last_used_at`, `last_client` (migration 009). There
is no per-call log, reads leave no trace, and an agent's edits are recorded as
the human who minted the token.

The audit's critical finding (F1) stands: this is a user-impersonation bearer
credential, stored in plaintext in harness config files (F6). Findings F3, F4,
F5, F8, F9, F10 and F13 all route through the same gap: there is no principal
for the agent, so nothing can be scoped to it, logged against it, or revoked
for it alone.

What Phase 0 already put in place: a `participants` table with `kind IN
('human','agent')`, agent rows creatable only by an owner or admin, display
names unique per organization, a deterministic color, and one-way
deactivation. Presence frames on the vault channel are stamped server-side
with the participant id; a client cannot claim another participant's name or
color there (`sync/vault-channel.ts`).

## Decision

**1. A second token kind, `agent`, bound to a participant row.** `mcp_tokens`
gains `participant_id TEXT REFERENCES participants(id)` and `kind TEXT NOT NULL
DEFAULT 'user' CHECK (kind IN ('user','agent'))`. An agent token is minted from
Vault Settings for one agent participant, carries the participant id, and is
revocable per agent. Minting requires owner or admin, the same gate as creating
the row. Existing `user` tokens keep working but are labelled "acts as you" in
Settings, show a sunset date, and cannot be minted new once agent tokens ship.
No silent coexistence: the UI names the difference on every row.

**2. Default-deny scopes on agent tokens.** `mcp_token_scopes (token_id,
resource_type IN ('folder','file','vault'), resource_id, permission IN
('view','edit'))`. An agent token with no scope rows can list vaults and
nothing else. `effectivePermission` for an agent call is `min(user grant of
the minting owner, token scope)`: the token can never exceed what its minter
could do, and it can be narrower. The three presets (reader, drafter, editor)
are scope templates, not code paths.

**3. Attribution is server-stamped, from the token, never from the request.**
`McpAuth` becomes `{ userId, organizationId, tokenId, kind, participantId }`.
`DocActor` becomes `{ userId, participantId }`. `notes.last_edited_by` keeps
referencing `"user"` for compatibility and gains `last_edited_participant TEXT
REFERENCES participants(id) ON DELETE SET NULL`. The desktop's timeline renders
`last_edited_participant` when present. Any `author`, `participantId`, or
`name` field inside a tool request body or a Yjs awareness/update payload is
ignored for attribution. For the Hocuspocus path (humans today, agents if they
ever hold a doc socket), `onAuthenticate` resolves the participant from the
sync token's user and stores it on the connection context; `onChange` stamps
that participant, so the client-asserted Yjs metadata is never read.

**4. Reads are logged, and the log is a table the agent cannot reach.**
`mcp_audit (id, token_id, participant_id, user_id, organization_id, tool,
doc_id, at, outcome, bytes_out)` records every `tools/call`, including
`read_note` and `search_notes`. It has no route that writes it except the MCP
handler, no tool exposes it, and the inventory test
(`tests/mcp-tool-inventory.test.ts`) asserts by source inspection that no MCP
tool contains SQL against it, `shares`, `mcp_tokens`, `participants`, or
`member`. Retention is 180 days for audit rows, independent of the Y.Doc
compaction threshold (F13). Local vaults forward their append-only log (ADR
0002) into the same table when they sync.

**5. Revocation is live.** Revoking an agent token deletes its `mcp_tokens` row
(as today) and additionally: the MCP handler re-checks the token hash on every
request (already true since MCP is stateless HTTP), any doc socket bound to that
participant is closed through `disconnectDoc`, and the vault channel publishes a
`gone` presence frame for the participant so the chip retracts within one
heartbeat. The desktop shows the revocation in the note's timeline with the
cutoff time.

**6. Bulk reads are rate-limited per token.** `search_notes` and `read_note`
share a per-token budget (default 120 calls per minute, 50 MB per hour) that
returns a structured `rate_limited` error naming the budget and the reset
time. Exfiltration is not prevented by this, and the docs say so in one
sentence: an agent that can read a note can send it anywhere.

**7. Token hygiene.** Plaintext is shown once at mint (already true). New:
`expires_at` on agent tokens (default 90 days, renewable from Settings without
changing scopes), `last_used_at` surfaced as "stale" after 30 days, and a
"rotate" action that mints a replacement with the same participant and scopes
and revokes the old one in the same transaction.

## What this does not change

- No agent ever gets a human's `user` row. `participants.user_id` stays NULL
  for agents, and the CHECK constraints from migration 027 enforce it.
- Presence identity stays stamped by the server as shipped in Phase 1.
- Team-space agent registration stays owner/admin only (F14).

## Consequences

- One migration (028) for the token kind, scopes, audit table and attribution
  column. All additive.
- The MCP service gets a scope check before every doc access and an audit
  insert after every call. Cost: one indexed insert per call.
- The desktop timeline, Settings, and the wizard need the participant id on
  every line they render. Phase 0's registry API already returns it.
- Existing `user` tokens become a visible deprecation, which is the point.

## Verification required before Phase 3 ships

From the audit's runtime checklist: two agents, two scopes, negative control
over MCP and over the local socket; no agent-reachable tool mutates grants,
tokens, shares, registry rows, or settings (source-asserted, already in place
for the 15 current tools); revoke mid-session stops writes within the
heartbeat window and retracts the chip; a request claiming another participant
id is stamped with the token's own id and the attempt is logged; the audit
table rejects writes from any MCP tool; bulk-read rate limit engages before the
FTS reindex degrades the vault for the human user.
