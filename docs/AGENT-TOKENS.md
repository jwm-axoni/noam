# Agent tokens (MCP)

How an AI client reaches a vault over the Model Context Protocol after ADR 0003
(`docs/adr/0003-agent-token-identity.md`). Server: `app/apps/server/src/mcp/`,
`src/permissions/token-scope.ts`, `src/audit/mcp-audit.ts`, migration 028.
Desktop: Vault Settings → MCP.

**One sentence you must read before minting anything: an agent that can read a
note can send it anywhere.** Scopes, logging and rate limits bound what an agent
can *reach* and how fast; nothing here stops a reader from copying what it read.

## Two token kinds

| | `agent` token | `user` token ("acts as you") |
|---|---|---|
| Acts as | one **agent participant** row (People panel → Agents) | the human who minted it |
| Reach | `min(minter's grant, token scope)` — default **deny** | everything the human can reach |
| Attribution | the agent's name and color on every edit and audit row | the human's name |
| Minted by | an owner or admin, from Vault Settings → MCP | nobody, any more (410) |
| Expires | 90 days (`MCP_AGENT_TOKEN_DAYS`), renewable | at the sunset date (`MCP_USER_TOKEN_SUNSET`, default 2026-12-31) |
| Revoked | per agent; live (see the window below) | per token |

Existing `user` tokens keep working until the sunset date. Settings labels each
one "Acts as you" with that date and a **Migrate** action. See *Migrating a
user token* below — the label alone is not the migration path.

## Scopes and presets

An agent token carries zero or more scope rows
(`mcp_token_scopes (token_id, resource_type, resource_id, permission)`):

- `vault` — the whole vault (resource id = the organization id), `view` or `edit`
- `folder` — a folder and everything under it
- `file` — one note

Its effective permission on any note is `min(what the minter could do, the
widest scope covering the note)`. A scope can narrow; it can never widen: an
agent minted by a member sees at most what that member sees, and a vault set to
Read-only caps an `edit` scope at `view` exactly as it caps the minter. The
minter's grant is re-resolved on every call, so removing or demoting the minter
takes their agents' reach with them. **A token with no scope rows can list
vaults and nothing else.**

The three presets are scope *templates*; the server stores the rows and never
looks at the preset name again:

| Preset | Rows |
|---|---|
| reader | `vault:view` |
| drafter | `vault:view` + `folder:<chosen folder>:edit` |
| editor | `vault:edit` |

Explicit `scopes: [...]` are accepted on mint and migrate for anything the
presets do not express. A resource outside the token's vault is refused
(`scope_outside_vault`).

## Attribution is server-stamped

Every edit an agent makes is stamped with the token's participant, resolved
from the token row — never from an `author`, `participantId` or `name` field in
a tool call, and never from Yjs awareness or update metadata. `notes.last_edited_participant`
and `note_versions.author_participant` carry it; the desktop's "edited by" line
and history panel show the participant's registry name. `last_edited_by` keeps
naming the minting human for readers that predate migration 028.

## Every call is logged

`mcp_audit` gets one row per `tools/call`, reads included: token, participant,
user, organization, tool, note, time, outcome (`ok` / `error` / `denied` /
`rate_limited` / `revoked`) and bytes returned. Retention is 180 days
(`MCP_AUDIT_RETENTION_DAYS`), pruned lazily by the writer. No MCP tool can read
or write the table; `tests/mcp-tool-inventory.test.ts` asserts from source that
nothing under `src/mcp/` names it (or `shares`, `mcp_tokens`, `participants`,
`member`).

## Bulk-read budget

`read_note` and `search_notes` share a per-token budget: **120 calls per
rolling minute** and **50 MB of results per rolling hour**
(`MCP_READ_CALLS_PER_MINUTE`, `MCP_READ_BYTES_PER_HOUR`). Over budget, the tool
does not run and the client gets an `isError` result whose `structuredContent`
is

```json
{ "error": "rate_limited", "budget": "calls_per_minute", "limit": 120, "used": 120, "resetAt": "2026-09-23T14:02:11.000Z" }
```

The refused call is logged as `rate_limited` and does not consume budget.
This is a brake on bulk reads, not exfiltration prevention — see the sentence
at the top.

## Revocation, and how long it takes

Revoking an agent token (`DELETE /api/mcp/tokens/:id`, or **Revoke** in
Settings) deletes the `mcp_tokens` row and then, in the same request:

1. closes every doc socket whose connection is bound to that participant
   (`disconnectParticipant`), and
2. publishes a `gone` presence frame for the participant on every collection of
   the vault (`publishParticipantGone`), and
3. writes a `revoked` audit row.

Measured against the code, not the ADR's "within one heartbeat":

| Path | Worst case from revoke to stop |
|---|---|
| Writes over MCP (HTTP) | **one in-flight tool call.** `verifyMcpToken` re-reads the row on every HTTP request, and inside a batched request `isMcpTokenLive` is re-checked before every `tools/call` after the first. No timer is involved. |
| Writes over a doc socket | **the close handshake.** Agents hold no doc socket today; if one ever does, the socket is closed synchronously at revoke, and there is no route that mints a sync token for an agent, so it cannot reconnect. |
| Presence chip, `gone` frame delivered | **immediate**: the desktop roster removes a peer on `gone` without waiting for a tick. |
| Presence chip, `gone` frame lost | **≤ 95 s**: the roster removes a silent peer once `REMOVE_MS` (90 s) has passed since its last frame, checked every `ROSTER_TICK_MS` (5 s); it dims it as stale after 30 s. The client heartbeat is 10 s, so a peer's "last frame" is at most 10 s old when the revoke lands. |

The ADR's "within one heartbeat" therefore holds on the delivered path (well
under the 10 s heartbeat) and is bounded at 95 s if the frame is lost.

## Token hygiene

- Plaintext is shown once, at mint, rotate and migrate. Only sha256 is stored.
- `expiresAt` on agent tokens; **Renew** extends it without touching scopes.
- **Rotate** mints a replacement with the same participant, name, minter and
  scopes and deletes the old row in one transaction. The old plaintext stops
  working on its next request.
- `stale` is reported on any token unused for 30 days (`MCP_TOKEN_STALE_DAYS`);
  Settings tags it.
- An agent token dies with its participant (deactivated or removed) and with
  the minter's membership.

## Migrating a user token

`user` tokens are the pre-ADR shape. They keep working until the sunset date
and cannot be minted new. To keep an automation running past the sunset:

1. In Vault Settings → MCP, the row shows **Acts as you · stops working on
   <date>**. Click **Migrate**.
2. Pick (or create) the agent participant it should act as, choose a preset or
   scopes, and confirm. The server mints the agent token and revokes the user
   token in one transaction (`POST /api/mcp/tokens/:id/migrate`), and shows the
   new plaintext once.
3. Paste the new token into the client's config in place of the old one. The
   endpoint URL does not change.

What changes for the automation: its edits are now attributed to the agent, it
is capped by the scopes you chose, and it is capped by the grants of the user
who owned the old token — migrating never widens reach. Migrating is an
owner/admin action because binding an agent participant is one; a member with a
user token asks an admin to migrate it (the resulting token still keeps the
member's grants as its cap).

## API summary

```
GET    /api/mcp/tokens                → { tokens, tools, presets, userTokenSunset }
POST   /api/mcp/tokens                { kind:"agent", participantId, name?, preset?|scopes?, folderId?, expiresInDays? } → 201 { token, ...row }
                                      { kind:"user" }                       → 410 user_tokens_sunset
DELETE /api/mcp/tokens/:id            → { revoked, kind, participantId }
POST   /api/mcp/tokens/:id/renew      { expiresInDays? }                    → row
POST   /api/mcp/tokens/:id/rotate     →                                        201 { token, ...row }
POST   /api/mcp/tokens/:id/migrate    { participantId, preset?|scopes?, folderId?, name? } → 201 { token, ...row, migratedFrom }
```

All are session-authenticated. Mint, rotate, renew and migrate of agent tokens
require owner or admin; revoke is allowed to the token's owner and, for agent
tokens, to any owner/admin of the vault.
