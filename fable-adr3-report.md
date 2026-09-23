# ADR 0003 build report — agent-scoped tokens and server-stamped attribution

Date: 2026-09-23 · Branch: `feat/adr3-agent-tokens` (uncommitted, not pushed, not merged)
Lead: Fable. Implementation split across five Opus workstreams (B scopes, C attribution,
D audit + budget, F routes/hygiene/revocation, G desktop UI); every diff was reviewed by the
lead directly, three of them amended, and all suites re-run by the lead on a clean database.

ADR 0002 was not touched. `docs/adr/0002-local-byoh-enforcement.md` is unchanged.

## Status line

`docs/adr/0003-agent-token-identity.md` now reads **Partially implemented**, naming exactly
what is missing (see "Unproven / not built" below). Not "Implemented", because one sentence of
decision 5 is not built.

## What was built, per decision item

### 1. Migration 028 (throwaway database first)
`app/apps/server/migrations/028_agent_tokens.sql`, additive only:
- `mcp_tokens.participant_id TEXT REFERENCES participants(id) ON DELETE CASCADE`,
  `mcp_tokens.kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','agent'))`,
  `mcp_tokens.expires_at TIMESTAMPTZ`, a CHECK tying `kind='agent'` to a non-null participant,
  and a partial index on `participant_id`.
- `mcp_token_scopes (token_id → mcp_tokens CASCADE, resource_type IN ('folder','file','vault'),
  resource_id, permission IN ('view','edit'))`, PK on the triple.
- `mcp_audit (id bigserial, token_id, participant_id, user_id, organization_id, tool, doc_id, at,
  outcome CHECK IN (ok, error, denied, rate_limited, revoked), bytes_out)`; indexes on
  `(token_id, at desc)`, `(user_id, at desc)`, `(at)`. **No foreign keys on purpose**: the log
  must outlive the token, the participant and the organization. Retention 180 days
  (`MCP_AUDIT_RETENTION_DAYS`), pruned lazily by the writer at most hourly.
- `notes.last_edited_participant TEXT REFERENCES participants(id) ON DELETE SET NULL` and
  (addition, same shape) `note_versions.author_participant`.

Verification on a fresh throwaway DB `noam_adr3_throwaway` (native Postgres on 5432):
apply all migrations → `pg_dump --schema-only` → run
`scripts/rollback/028_agent_tokens.down.sql` → dump → re-apply → dump. Result: after rollback the
only differences from the pre-028 schema were the `\restrict` nonce pg_dump prints and two
trailing-comma artefacts on the last column of two tables; after re-apply the schema was
byte-identical (nonce aside) to the first apply. The rollback script lives under `scripts/`,
not `migrations/`, because the runner applies every `*.sql` it finds there.

### 2. Identity types
`McpAuth = { userId, organizationId, tokenId?, kind: 'user'|'agent', participantId }`
(`src/mcp/tokens.ts`); `DocActor = { userId?, participantId? }` (`src/mcp/doc-writer.ts`).
`participantId` is resolved server-side: the agent's row for an agent token, the user's live
human row for a user token or an OAuth session, null when there is none. Agent tokens are
minted from Vault Settings → MCP by an owner or admin (`POST /api/mcp/tokens {kind:'agent'}`,
403 `owner_or_admin_required` otherwise), bound to one live agent participant (404
`participant_not_found` for a human or deactivated row). Existing `user` tokens keep working
(`createMcpToken` still exists for them and for tests); `verifyMcpToken` accepts both kinds.

### 3. Default-deny scopes
`src/permissions/token-scope.ts` (rows, `expandPreset`, `normalizeScopes`, `scopePermission`,
`scopeFolderPermission`, `listScopedDocsInVault`, `listScopedFoldersInVault`) and
`src/permissions/mcp-access.ts` (`mcpDocPermission` = `min(effectivePermission(minter),
scope)`, `mcpReadableDocsInVault`, `mcpFolderScope`, `mcpVisibleFolders`). `service.ts` routes
every doc/folder check through them; user tokens are unchanged (`mcpFolderScope` is `edit`
for them, i.e. no cap). A no-scope agent token gets `list_vaults` only: folders and notes
list empty, reads are `forbidden`, search and `query_knowledge` return nothing, creates are
refused. The reviewer of B caught and closed a hole the brief missed: moving a note or folder
OUT to the vault root skipped the folder check for users, so agents now need root scope for it
(`requireRootScope`). Presets are row templates only (`expandPreset`); the server stores rows
and never reads the preset name again. `vault` scope ids are the organization id, as in
`shares`.

### 4. Server-stamped attribution
- MCP: the actor passed to every doc write is `{ userId: auth.userId, participantId:
  auth.participantId }` from the verified token. Extra `author` / `participantId` / `name`
  fields in a tool body are inert (tested).
- Hocuspocus: `SyncContext.participantId` is resolved in `onAuthenticate` via
  `resolvePresenceIdentity(user, vault)` and stored on the connection; `onChange` reads
  `data.context` only (the connection's context for a client edit, the
  `LocalTransactionOrigin` context for a server write). Awareness and update payloads are
  never read for identity, with a comment saying why. `onDocEdited` / `onDocWritten` now
  carry `{ userId, participantId }`.
- `versions/capture.ts` stamps `last_edited_participant` alongside `last_edited_by`, treats a
  participant change as an editor change for the throttle, and writes
  `author_participant` on versions. Reverts are attributed to the reverting user's own row.
- `GET /api/notes` returns `last_edited_participant(_name)`; the versions routes return
  `authorParticipant(Name)`. Desktop `api.ts` prefers the participant name in
  `noteLastEdited()` (the Editor's "edited by" line) and in version rows (the history panel).

### 5. Read logging
`src/audit/mcp-audit.ts` (outside `src/mcp/`) is injected into `McpContext`; `protocol.ts`
records one row per `tools/call` around the dispatch — `ok` with `bytes_out` = utf8 length of
the result text, `denied` for a `forbidden` refusal, `error` otherwise, `rate_limited` when the
budget refuses, including unknown tool names; `initialize` / `ping` / `tools/list` are not
logged. `tests/mcp-tool-inventory.test.ts` now asserts by source inspection that
`tools.ts`, `service.ts`, `protocol.ts` and `doc-writer.ts` contain no SQL statement (read or
write, any case) naming `mcp_audit`, `shares`, `mcp_tokens`, `mcp_token_scopes`,
`participants` or `member`; that `src/mcp/*` only `import type` from `../audit/`; that no
dispatch file imports mint/revoke/rotate/renew/migrate; and pins the exact `mcp_tokens`
writes in `tokens.ts`.

### 6. Live revocation
`DELETE /api/mcp/tokens/:id` deletes the row (scopes cascade) and, for an agent token, calls
`disconnectParticipant(server, participantId)` (`sync/hocuspocus.ts`: walks the in-memory
document map and closes every connection whose context carries that participant),
`vaultChannel.publishParticipantGone(vaultId, {participantId, name, color})` for every
collection of the org (a `gone` presence frame keyed `agent:<participantId>`), and writes a
`token.revoke` / `revoked` audit row. The MCP handler re-verifies the token hash on every
HTTP request (already true; verified by test) **and**, new, re-checks `isMcpTokenLive` before
every `tools/call` after the first inside a batched body — the lead widened that check to
also cover participant deactivation and membership loss. Authorization: the token's own
user, or an owner/admin of the vault for an agent token; managers cannot revoke someone
else's user token.

### 7. Bulk-read rate limits
`read_note` and `search_notes` share a per-token budget, 120 calls per rolling minute and
50 MB of result bytes per rolling hour (`MCP_READ_CALLS_PER_MINUTE`,
`MCP_READ_BYTES_PER_HOUR`), answered from `mcp_audit` with two indexed queries, keyed by
token (or by user for OAuth). Refusal is an `isError` result with `structuredContent`
`{ error: 'rate_limited', budget, limit, used, resetAt }`; it is logged and does not
consume budget. Docs state the sentence in bold at the top of `docs/AGENT-TOKENS.md`: *an
agent that can read a note can send it anywhere.*

### 8. Token hygiene
`expires_at` defaults to now + 90 days (`MCP_AGENT_TOKEN_DAYS`), enforced in
`verifyMcpToken`; `POST /:id/renew` extends it without touching scopes; `stale: true` on any
row unused for 30 days (`MCP_TOKEN_STALE_DAYS`); `POST /:id/rotate` inserts the replacement
(same participant, name, minter, scopes) and deletes the old row in one transaction and
returns the plaintext once. Settings shows Renew, Rotate and the stale tag.

### 9. User-token sunset with a migration story
`GET /api/mcp/tokens` returns `userTokenSunset` (`MCP_USER_TOKEN_SUNSET`, default
2026-12-31T00:00Z); user rows carry `expiresAt = sunset`; `verifyMcpToken` rejects user
tokens past it (tested; agent tokens unaffected). `POST /api/mcp/tokens {kind:'user'}` → 410
`user_tokens_sunset`. **Migration path:** `POST /api/mcp/tokens/:id/migrate` mints the agent
token and revokes the user token in one transaction, keeping the OLD token's `user_id` as
the cap so migrating can never widen reach; Settings shows "Acts as you · stops working on
<date>" with a **Migrate** action that reuses the agent + preset form and shows the new
plaintext once; `docs/AGENT-TOKENS.md` has the step-by-step. Migration is owner/admin
(binding an agent participant is a manager act); a member asks an admin, and the resulting
token still carries the member's grants as its cap.

## The two review flags

**(a) Revocation window, quantified from the code** (`docs/AGENT-TOKENS.md` has the table):

| Path | Worst case from revoke to stop |
|---|---|
| MCP writes | one in-flight tool call. Token re-verified per HTTP request; inside a batch, re-checked before each `tools/call` after the first. No timer. |
| Doc socket writes | the close handshake; closed synchronously at revoke. Agents hold no doc socket today and no route mints them a sync token, so no reconnect. |
| Chip, `gone` frame delivered | immediate (`PresenceRoster.apply` deletes on `gone`). |
| Chip, `gone` frame lost | ≤ 95 s: `REMOVE_MS` 90 s since the last frame, checked every `ROSTER_TICK_MS` 5 s (stale at 30 s). Client heartbeat `PRESENCE_HEARTBEAT_MS` is 10 s. |

The ADR's "within one heartbeat" holds on the delivered path and is bounded at 95 s otherwise.

**(b) Not stranding automations:** item 9 above — a real migrate endpoint and Settings action,
one transaction, plaintext shown once, cap unchanged, documented.

## Tests

Server, full suite, run alone on a clean database (`noam_adr3_lead`) after all workstreams
landed: **68 files, 747 tests, 747 passed, 0 failed.** `tsc --noEmit` clean.

New / extended suites (all passing, counts from a verbose run):

| Suite | Tests | Proves |
|---|---|---|
| `tests/mcp-agent-scopes.test.ts` (new) | 7 | no-scope token = list_vaults only; folder view/edit, file and vault scopes; token narrower than minter; token cannot exceed minter (Read-only vault, membership loss); drafter preset as rows; move-to-root refusal |
| `tests/mcp-attribution.test.ts` (new) | 6 | agent and user writes stamped from the token despite body-claimed `author`/`participantId`/`name`; `last_edited_participant` and version `author_participant`; Hocuspocus `onChange` stamps from the connection context and reports nothing for an anonymous origin |
| `tests/mcp-audit.test.ts` (new) | 8 | one row per tools/call incl. reads; `bytes_out`; denied vs error; handshakes unlogged; retention prune |
| `tests/mcp-rate-limit.test.ts` (new) | 4 | 4th read refused with the structured error; refused calls do not count; per-token; bytes budget |
| `tests/mcp-revocation.test.ts` (new) | 5 | 401 on next call; sockets kicked + `gone` frame + audit row; mid-batch stop; authorization matrix; user-token revoke fires no hook; a subscribed vault-channel client receives the `gone` frame |
| `tests/mcp-token-lifecycle.test.ts` (new) | 13 | 410 on user mint; role/participant/scope gates; 90-day expiry; manager vs member listing; stale; expiry → renew; rotate; migrate (own, member's-by-owner, agent refused); sunset enforcement |
| `tests/mcp-tool-inventory.test.ts` (extended) | 5 | 15 tools unchanged; pinned `mcp_tokens` writes; no SQL against the five tables in the dispatch path; audit module only type-imported |
| `tests/participants.test.ts` (fixed) | 21 | the migration-replay test now rolls 028 back too and expects both to re-apply |

Desktop: `tsc --noEmit` clean; the touched suites (`mcpTokenLabels`, `registryNoteMeta`,
`versionsApi`, `versionStore`, `noteMetaListener`, `presence/*`) 103/103 by the lead; the
full desktop suite was run once by workstream G after its changes: 234 files passed, 2615
tests passed, 12 skipped, 1 todo.

Failure-first evidence (workstreams removed their change and watched tests fail, then
restored): C (3 attribution tests), D (9 of 12 audit/rate-limit tests), F (the mid-batch
test), G (the label test). B could not do a failing-first run and says so.

## Proven vs unproven

Proven by tests on this branch: everything in the tables above; migration apply/rollback/
re-apply on a throwaway DB; the source-inspection isolation of the audit table.

Not proven, stated plainly:
- **The two-agent live negative control** from the audit checklist: no agent runtime exists
  (Phase 3), so scope isolation is asserted over MCP only. Not faked.
- **The desktop MCP tab was not exercised visually** or against a live server (no app run in
  this session); it is typechecked and its pure label helpers are tested.
- **`disconnectParticipant` on a real agent socket**: exercised through the route's injected
  hook and the unit walk; no agent can open a doc socket today, so the end-to-end kick is
  structural, not observed.

## Deviations from the ADR, with reasoning

1. **Decision 5, "the desktop shows the revocation in the note's timeline with the cutoff
   time" — not built.** The desktop has no per-note event feed (the Editor shows one
   "edited by" line; the history panel lists versions). The revocation is recorded in
   `mcp_audit` and the token leaves Settings; adding a per-note event stream for this one
   line was out of proportion. This is the reason the status is "Partially implemented".
2. **`note_versions.author_participant` added** (not in the ADR's column list). Without it,
   an agent's version would be labelled with its minter, the exact misattribution the ADR
   removes. Additive, same shape as `notes.last_edited_participant`.
3. **`mcp_audit` has no foreign keys** although the ADR lists `token_id`/`participant_id`.
   A cascade would erase an agent's history at the moment of revocation. Time-based
   retention replaces referential cleanup.
4. **Read budget is DB-backed, not in-memory**, keyed on `mcp_audit` rows: survives
   restarts and works across instances, at two indexed queries per read call. OAuth
   sessions (no token row) are budgeted per user.
5. **User-token sunset is enforced, not just displayed** (`verifyMcpToken` rejects after
   the date, configurable). A date shown but not enforced would be a lie in Settings.
6. **`expires_at` on agent tokens lives in migration 028** (the goal's migration list omitted
   it; item 8 needs it). Additive.
7. **Move-to-root needs root scope for agents** (`requireRootScope`), stricter than a literal
   reading of "scope on the folder": a folder-scoped agent could otherwise relocate notes
   out of its own scope.
8. **Migrate requires owner/admin even on your own user token.** Binding an agent
   participant is a manager act (F14). Members are not stranded: an admin migrates for them
   and the cap stays the member's grants. Flagged for product review.
9. **Mid-batch re-check also covers participant deactivation and membership loss** (lead
   widened F's row-exists check), so a batch cannot outlive any of the three facts
   `verifyMcpToken` checks.

## Files (33 changed, 16 new; ~2,000 lines added)

Server: `migrations/028_agent_tokens.sql`, `scripts/rollback/028_agent_tokens.down.sql`,
`src/config.ts`, `src/mcp/{tokens,service,protocol,doc-writer,oauth}.ts`,
`src/permissions/{token-scope,mcp-access}.ts`, `src/audit/mcp-audit.ts`,
`src/http/{app.ts,routes/mcp.ts,routes/registry.ts,routes/versions.ts}`,
`src/sync/{hocuspocus,vault-channel}.ts`, `src/versions/{capture,revert}.ts`, `src/index.ts`,
`tests/helpers/{app,db,seed}.ts`, six new test files, three extended.
Desktop: `src/lib/api.ts`, `src/lib/mcpTokenLabels.ts` (+test),
`src/components/VaultSettingsDialog.tsx`, `src/App.css`, four test files adjusted.
Docs: `docs/AGENT-TOKENS.md` (new), `docs/adr/0003-agent-token-identity.md` (status),
`docs/specs/07-participants-and-presence.md` (audit checklist rows), `docs/STATUS.md`,
`docs/Noam.md` (index link).

## Housekeeping
- Nothing committed or pushed; working tree left on `feat/adr3-agent-tokens`.
- Throwaway databases `noam_adr3_{throwaway,b,c,d,f,lead}` on the native 5432 server were
  dropped at the end of the session (`noam_phase01` untouched).
- `fable-goal-adr3.md` and `launch-noam-adr3.sh` at the repo root are the session's launch
  artefacts, untracked, not part of the change.
