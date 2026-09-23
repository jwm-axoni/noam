---
title: Participants and presence (Phase 0 + Phase 1)
status: built 2026-09-23, on branch feat/phase01-participants-presence
tags: [noam, spec, identity, presence, participants]
---

# Participants and presence

Phase 0 gives every human in a team space a **participant row**; Phase 1 makes
presence visible: a People panel, live cursors in registry colors, honest stale
handling. No AI in either phase. The registry carries `kind IN ('human','agent')`
from day one so Phase 3 adds rows, not migrations.

This document supersedes the approved build spec (`noam-phase01-spec.md`,
2026-09-23) where the code disagreed with it. Section 1 lists every such place.

## 1. Where the code won over the spec

The spec was verified against `main` at `1de8a5c0`; this repository's `main`
is at `d8639af` (four commits later, only `store.ts` changed among the cited
files). The drift below is not from those commits. It is from the spec reading
the code wrong, or proposing something the code already forbids.

| Spec said | Code says | What we did |
|---|---|---|
| `remoteCursors.ts` is dead code that nothing imports | `components/Editor.tsx` imports it and renders animated carets with name flags | "Cursor wiring" became: feed carets registry identity through a resolver, add `aria-hidden`, reduced motion, per-color label text. No rendering redesign. |
| Hook the participant insert into "the invitation-accept transaction" in `registry/invitations.ts` | That module is read-only ("Better Auth owns the writes"). Member rows are inserted by three paths: Better Auth accept-invitation, Better Auth create-organization (owner), and `POST /api/orgs/join`. Better Auth hooks run outside its transaction, and `auth/auth.ts` is frozen by the spec. | A Postgres `AFTER INSERT ON member` trigger creates the row. Same transaction by construction, for all three paths. Two more triggers: member delete deactivates the participant; a user rename updates live display names. |
| Client puts `participantId` in the presence frame | The vault channel already stamps `userId` server-side and documents that presence "can't be spoofed" (`sync/vault-protocol.ts`) | The server stamps `participantId`, `name` and `color` from the registry onto every presence frame and ignores the client's strings. Audit finding F5 is closed for presence. |
| DDL: `user_id ... ON DELETE SET NULL` plus `CHECK (kind='agent' OR user_id IS NOT NULL)` | Those two lines together make every user deletion fail | `ON DELETE CASCADE`. `notes.last_edited_by` is already `SET NULL` on user delete (migration 017), so nothing is lost that was not already lost. |
| `GET /api/participants?organizationId=` | Org routes in this server are `/api/orgs/:orgId/...` (`http/routes/orgs.ts`) | `GET/POST /api/orgs/:orgId/participants`, `PATCH /api/orgs/:orgId/participants/:id`. |
| No user ids in the GET payload | The desktop must publish its OWN participant id in awareness | The response carries `self`: the caller's participant id. Still no user ids or emails. |
| `PATCH` re-activates with `deactivatedAt: null`; renames any participant | Product decision 2 locks deactivation as one-way; a user rename trigger would clobber an admin's rename of a human | `deactivated: true` only (400 `reactivation_unsupported` otherwise); rename is agents-only (400 `human_name_follows_account`). |
| Heartbeat/decay is all client-side; "there is no heartbeat or stale-peer decay on the vault channel" | The server already runs a 30 s ping/terminate sweep and publishes a `docId: null` frame when a connection dies (`vault-channel.ts startHeartbeat`, `cleanup`) | The server's frame gains `gone: true` so "left" is distinct from "online, no note open". The client keeps the spec's 10 s heartbeat, 30 s stale, 90 s removal as a fallback for the frames the server path can miss. |
| A peer with `docId: null` is deleted from the roster (existing behaviour the spec did not mention) | That conflates "no note open" with "gone" | `gone` removes; `docId: null` keeps the peer under Online now. Invisible peers are never shown anywhere (the spec's "dimmed in Online now" for invisible users contradicts the word; see section 6). |
| Okabe-Ito palette | Rejected by product decision 3 (orange and vermilion; "red reads as error") | A new 8-color palette, section 7. |
| Presence panel is "new"; "no presence panel exists" | The editor already has a per-note avatar row and "N people here" roster from awareness | Kept. The People panel is vault-wide and lives in the dock system (`layout/panelRegistry.tsx`), which the spec did not know about. |
| 15 MCP tools | Verified: 15 (`mcp/tools.ts`). The tune report and the v2 plan HTML said 11. | The HTML was corrected. |
| `hashtext()` for backfill color | The desktop hashes with FNV-1a; `hashtext` would never agree with it | `participant_color()` is FNV-1a in plpgsql, byte-for-byte the desktop's `hashString`. Offline fallback colors equal registry colors. |
| Migration runs against "a throwaway copy of the database" | No Docker on this machine; a native Postgres 14 answers on 5432 | Migration 027 was applied on a fresh Postgres 14 database, on one upgraded from 026 with seeded data (the `participants.test.ts` upgrade test), and on a fresh Postgres 17 instance. Production is Postgres 16, bracketed by both; nothing in 027 is version-specific. |

## 2. Data model (migration 027)

`participants`: `id`, `organization_id` (FK cascade), `kind`, `user_id` (humans;
FK cascade), `display_name`, `color` (hex, immutable), `harness` (agents only),
`created_by`, `created_at`, `deactivated_at`. Live humans are unique per
`(organization_id, user_id)`; live agents are unique per
`(organization_id, lower(display_name))`. Humans may share a display name.

`participant_color(seed)`: 32-bit FNV-1a over the seed's UTF-8 bytes, modulo 8,
into the palette. Humans seed with their user id (so backfill, live creation
and the desktop's offline fallback agree). Agents get the least-used color in
the org, ties in palette order.

Triggers: `member` insert creates the live human row; `member` delete sets
`deactivated_at`; `"user".name` update refreshes live display names.

Rollback: `DROP TABLE participants` plus the three trigger functions. Nothing
else is altered.

## 3. API

All three routes need a session (401) and org membership (403). Errors use the
server's `{ error: "<code>" }` shape.

- `GET /api/orgs/:orgId/participants` → `{ participants: [{ id, kind,
  displayName, color, harness, createdAt }], self }`. Deactivated rows excluded.
- `POST /api/orgs/:orgId/participants` `{ kind: "agent", displayName, harness }`
  → owner/admin; 201. `kind: "human"` → 400. Duplicate name → 409. Agent rows
  are inert: no token kind can authenticate as one (that is ADR 0003).
- `PATCH /api/orgs/:orgId/participants/:id` `{ displayName? }` |
  `{ deactivated: true }` → owner/admin; color is immutable (400); one-way.

## 4. Presence protocol

Vault-channel presence frame, server → client: `{ t: "presence", userId,
participantId, docId, name, color, status, gone? }`. `userId`, `participantId`,
`name` and `color` are stamped by the server from the token and the registry.
The client's frame still carries `name`/`color` for servers that predate 027;
new servers ignore them. A connection whose user has **no live participant row**
(a deactivated human) publishes no presence at all. The channel re-resolves the
row on `acl-changed`: a row that disappeared mid-session produces one `gone`
frame. Only a human deactivation broadcasts `acl-changed` (it makes every member
re-mint their open note); agent renames and deactivations broadcast nothing,
because agent rows have no presence in Phase 1.

| Rule | Value |
|---|---|
| Client heartbeat (re-send own presence) | 10 s, only after `ready` |
| Stale (dimmed, "no signal for 30 s") | 30 s without a frame |
| Removed, with a quiet panel note | 90 s without a frame, or immediately on `gone` |
| Server ping/terminate sweep | 30 s ticks (existing) |
| y-protocols awareness timeout | 30 s (existing, unchanged) |

Per-doc awareness `user` field: `{ id, participantId, name, color, status }`.
Receivers resolve `participantId` against their own registry copy and render
that name and color; the asserted strings are only a fallback for unknown ids.
Awareness itself is client-asserted (Hocuspocus relays it opaquely); stamping it
server-side is ADR 0003 work.

## 5. Desktop

- People panel (`components/PresencePanel.tsx`), a dock panel of type
  `presence`: Online now, In this note, Agents active (empty state links to the
  changelog). Sections collapse independently. Toggle shortcut is in
  `lib/globalShortcuts.ts`. Opens itself once per vault when the org has more
  than one member; single-member orgs start with it closed.
- Roster and decay are a pure state machine (`lib/presence/roster.ts`).
- Live region (`lib/presence/announcer.ts`): one polite announcement per 5 s at
  most. The caret layer is `aria-hidden`. Reduced motion snaps carets.
- Below 700 px the panel renders nothing. The Tauri window's minimum width is
  720, so this is a web/dev guard; the narrow-window design ships in the next
  minor release (product decision 4).
- Feature flag `noam.flags.presenceV1` (device-local, default on) hides the
  panel and the registry-color plumbing. Pre-existing cursors are not gated.

## 6. Decisions the lead made that the spec left open or got wrong

1. Invisible means invisible. An invisible teammate appears in neither section.
   The spec's acceptance criterion 12 ("appears dimmed in Online now") would
   make invisibility a lie; the existing `statusTone("invisible") === "offline"`
   contract agrees.
2. Human display names follow the account name. Admins rename agents only.
3. The server, not the client, stamps presence identity. The spec's client-sent
   `participantId` would have been the first spoofable identity field on a
   channel that was designed to have none.
4. `gone` is a protocol flag, not a timeout. A dead socket is removed when the
   server says so; the 90 s client timeout is the fallback, not the mechanism.

## 7. Palette

Designed 2026-09-23 to replace Okabe-Ito. Method: candidates on an OKLCH grid
with hue bands for red-through-orange (350..75) and the reserved violet
(`#7f73ff`, ±22°) excluded, chroma ≥ 0.10, contrast floors for a 2 px caret on
light and dark surfaces; then the set of eight maximizing the minimum pairwise
CIEDE2000 under normal vision and simulated protanopia, deuteranopia and
tritanopia (Machado et al. 2009), with quotas of two blues, two greens, one
yellow-olive and one magenta so the set stays a palette and not a proof.

| | hex | reads as |
|---|---|---|
| 1 | `#696713` | olive |
| 2 | `#b4bf2c` | lime |
| 3 | `#789c5b` | sage |
| 4 | `#047e67` | teal |
| 5 | `#2fc5fa` | sky |
| 6 | `#2981fb` | blue |
| 7 | `#982f93` | magenta |
| 8 | `#b976a0` | mauve |

Minimum pairwise ΔE2000: 17.8 normal, 15.7 protan, 16.0 deutan, 15.7 tritan
(Okabe-Ito on the same metric: 21.7 / 12.3 / 11.6 / 10.9; the previous 12-color
palette: 5.0 / 0.35 / 0.90 / 2.1). Label text is white or near-black per swatch
(`textOn`), always ≥ 4.5:1. The test
`lib/presence/__tests__/paletteCvd.test.ts` re-derives all of this from the
shipped constant, so a palette edit that breaks a claim fails CI.

## 8. Security audit checklist, status after Phase 0/1

The audit's 13 runtime items gate Phase 3. Status against this build:

| Item | Status |
|---|---|
| Agent token cannot read outside its scope | **Passing** (ADR 0003 built 2026-09-23): `tests/mcp-agent-scopes.test.ts` — no-scope token lists vaults only; folder/file/vault scopes; `min(minter, scope)` both ways. |
| No agent-reachable tool mutates grants, tokens, shares, registry rows, settings | **Passing, source-asserted**: `tests/mcp-tool-inventory.test.ts` pins the 15 tools and greps every file under `src/mcp/` for SQL against those tables. |
| Revoke mid-session stops writes, retracts chip | **Passing** for the server side: `tests/mcp-revocation.test.ts` — next call 401, a revoke landing mid-batch stops the rest of the batch, `disconnectParticipant` + `gone` frame fired, audited. Window quantified in `docs/AGENT-TOKENS.md`. The two-agent live negative control waits for Phase 3 (no agent runtime yet). |
| Prompt-injection fixture stays in scope | Not applicable yet. |
| Authorship stamping: claimed identity overwritten at the server | **Passing**: presence (`tests/presence-identity.test.ts`) and edits (`tests/mcp-attribution.test.ts`: a body claiming `author`/`participantId`/`name` is stamped with the token's participant; Hocuspocus `onChange` stamps from the connection context, never awareness). |
| Unmediated-write detection | Not built; mechanism specified in ADR 0002. |
| Loopback socket auth | Not built; decision in ADR 0002 (stdio primary). |
| Audit log append-only, hash-chained | Server side built (ADR 0003): `mcp_audit`, one row per tools/call, 180-day retention, unreachable from any tool (`tests/mcp-tool-inventory.test.ts`). Hash chaining and the local forward are ADR 0002. |
| Read instrumentation | **Passing**: `tests/mcp-audit.test.ts` — `read_note` and `search_notes` rows with `bytes_out`. |
| Diff renderer executes no XSS payload | **Passing** for the review components: `components/review/*.test.ts` renders a payload and asserts no element is created. CSP for the webview is not part of this phase. |
| Accept-path authorization, no self-accept | Client-side guard in the review reducer (self-accept refused). Server-side re-check waits for ADR 0001. |
| Token hygiene: show-once, stale inventory, rotation | **Passing**: `tests/mcp-token-lifecycle.test.ts` — 90-day expiry, renew, rotate (one transaction), `stale` after 30 days, user-token sunset + migrate. |
| DoS bound on agent bulk writes | Bulk READS bounded: `tests/mcp-rate-limit.test.ts` (120 calls/min, 50 MB/h per token, structured `rate_limited`). Writes stay bounded by the 10 MB note cap only. |

ADR 0003 (built 2026-09-23, branch `feat/adr3-agent-tokens`) adds the `agent`
token kind bound to these agent rows: see `docs/AGENT-TOKENS.md`. No new tool
was added; the tool inventory is still 15.
