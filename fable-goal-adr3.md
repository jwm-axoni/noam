# Goal: Implement ADR-3 (Agent-scoped tokens and server-stamped attribution)

You are Fable, the build lead. Read `docs/adr/0003-agent-token-identity.md` in
this repo first. That ADR is authoritative. Where anything in it feels wrong,
risky, stale, or inconsistent with the actual code, use your own reasoning,
deviate, and document why. Do NOT implement ADR-2 (`docs/adr/0002`) in this run.

## Working rules

- You lead and you review. You may delegate implementation work to Opus
  subagents, but you review their output yourself, directly, before accepting
  it. Do not accept delegated work on trust.
- You are on branch `feat/adr3-agent-tokens`. Do NOT merge. Do NOT push.
  Leave all work uncommitted on this branch.
- Do not touch `docs/adr/0002-local-byoh-enforcement.md`.
- Update the Status line in `docs/adr/0003-agent-token-identity.md` from
  "Proposed" to "Implemented" only if the whole decision section is actually
  built and tested. If partially built, write "Partially implemented" and say
  exactly what is missing.
- Prove with tests or demos, not claims.

## Build (the ADR's decision section, all of it)

1. **Migration 028, throwaway database first.** Run it against a throwaway DB
   before anything else. Additive only:
   - `mcp_tokens.participant_id TEXT REFERENCES participants(id)`
   - `mcp_tokens.kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','agent'))`
   - `mcp_token_scopes (token_id, resource_type IN ('folder','file','vault'), resource_id, permission IN ('view','edit'))`
   - `mcp_audit (id, token_id, participant_id, user_id, organization_id, tool, doc_id, at, outcome, bytes_out)`; retention 180 days for audit rows
   - `notes.last_edited_participant TEXT REFERENCES participants(id) ON DELETE SET NULL`
2. **Identity types.** `McpAuth` becomes
   `{ userId, organizationId, tokenId, kind, participantId }`. `DocActor`
   becomes `{ userId, participantId }`. An agent token is minted from Vault
   Settings for one agent participant; minting requires owner or admin, the
   same gate as creating the agent row. Existing `user` tokens keep working.
3. **Default-deny scopes.** An agent token with no scope rows can list vaults
   and nothing else. `effectivePermission` for an agent call is
   `min(minting owner's grant, token scope)`: the token can never exceed what
   its minter could do, and it can be narrower. The three presets (reader,
   drafter, editor) are scope templates, not code paths.
4. **Server-stamped attribution.** Ignore any `author`, `participantId`, or
   `name` field inside a tool request body or a Yjs awareness/update payload
   for attribution purposes. For the Hocuspocus path, `onAuthenticate`
   resolves the participant from the sync token's user and stores it on the
   connection context; `onChange` stamps that participant, so client-asserted
   Yjs metadata is never read. The desktop timeline renders
   `last_edited_participant` when present.
5. **Read logging.** Every `tools/call`, including `read_note` and
   `search_notes`, inserts into `mcp_audit`. Extend
   `tests/mcp-tool-inventory.test.ts` to assert by source inspection that no
   MCP tool contains SQL against `mcp_audit`, `shares`, `mcp_tokens`,
   `participants`, or `member`.
6. **Live revocation.** Revoking an agent token deletes its `mcp_tokens` row
   and additionally: the MCP handler re-checks the token hash on every request
   (stateless HTTP already gives this, verify it), any doc socket bound to
   that participant is closed through `disconnectDoc`, and the vault channel
   publishes a `gone` presence frame for the participant so the chip retracts
   within one heartbeat.
7. **Bulk-read rate limits.** `search_notes` and `read_note` share a per-token
   budget (default 120 calls per minute, 50 MB per hour) returning a
   structured `rate_limited` error naming the budget and the reset time. Docs
   must state plainly in one sentence: an agent that can read a note can send
   it anywhere.
8. **Token hygiene.** `expires_at` on agent tokens (default 90 days, renewable
   from Settings without changing scopes), `last_used_at` surfaced as "stale"
   after 30 days, and a "rotate" action that mints a replacement with the same
   participant and scopes and revokes the old one in the same transaction.
   Plaintext shown once at mint.
9. **User-token sunset with a real migration story.** Existing `user` tokens
   keep working, labelled "acts as you" in Settings with a sunset date; no new
   `user` mints once agent tokens ship. PLUS a concrete migration path: docs
   explaining the move and a migrate/rotate action in Settings so existing
   automations are not stranded. A label alone is not enough.

## Two review flags you must address in the implementation

(a) **Quantify the revocation window.** Derive the actual worst-case time from
    revoke to write-stop from the real heartbeat interval in the code.
    Document the number. No hand-waving.
(b) **The user-token sunset must not strand existing automations.** The
    migration path in item 9 is required, not optional.

## Verification

- Migration 028 against a throwaway DB first; verify apply and rollback.
- Unit/integration tests for: scope min() semantics (token narrower than
  owner grant, no-scope token listing vaults only), attribution stamping that
  ignores client-asserted fields, audit-table isolation (no MCP tool can read
  or write it), revocation behavior (write-stop plus chip retraction),
  rate limits engaging with the correct error shape.
- The two-agent negative control from the audit checklist waits for Phase 3
  (no agents exist yet). Note it as unproven in your final report. Do not
  fake it.

## Final report

When done, write `fable-adr3-report.md` in the repo root covering: what was
built per decision item, test counts with pass/fail, what is proven vs
unproven, any deviations from the ADR with your reasoning, and whether the
ADR status line was updated. Then print `--- SESSION DONE ---`.
