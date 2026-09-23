# Noam Phase 0 + Phase 1 Spec

**Status:** APPROVED for build. John's decisions on the open questions are recorded below (Sept 23, 2026).

## Decisions (locked Sept 23, 2026)

1. **Display-name collisions:** duplicates allowed, disambiguated by color chip.
2. **Deactivation reversibility:** one-way until Phase 3. No re-activation path in Phase 1.
3. **Palette:** Okabe-Ito rejected. Design a colorblind-safe palette that keeps the repo's "red reads as error" rule before it ships.
4. **Mobile timing:** responsive design ships in the next minor release after Phase 1 (1.x = next minor, not "when it hurts").
5. **Agents empty state:** link to docs or changelog from the empty state.
**Source plan:** `noam-ai-plan-v2.html` sections 02, 03, 04 (tuned plan, 2026-09-23).
**Verified against:** `jwm-axoni/noam` repo, 2026-09-23. Branch checked: `main` at `1de8a5c0` (matches `development` tree for all files cited).
**Spec skill:** gstack `/spec`, five-phase workflow. John was unavailable during drafting, so every judgment call the plan did not already settle was auto-decided per the plan's recommendations and recorded in section 14. Nothing was decided silently.

---

## 1. Why this matters

**Who is affected.** Every future Noam user in a team space, and the builder implementing this. Phase 0 touches identity, the one thing everything downstream assumes. Phase 1 is the first visible piece of the human-agent collaboration story: seeing who is in the note with you.

**Current behavior, verified.** Identity already exists and works: better-auth with email+password (argon2id), optional Google OAuth, server-side sessions, and an organization/member/invitation model. Presence is half built: the desktop publishes viewing state over a vault channel, keeps a `VaultPeer` roster in the store, binds y-protocols awareness per open note, and even has an animated remote-cursor module. But there is no participant registry anywhere, no presence panel UI, the cursor module is dead code that nothing imports, and there is no heartbeat or stale-peer decay on the vault channel.

**Target behavior.** A human is a participant row. A team space is a set of participant rows. The registry schema carries `kind` in `{human, agent}` from day one so Phase 3 adds rows, not migrations. Presence becomes visible: a toggleable right sidebar, live cursors in the editor, per-note presence chips, and honest stale handling. No AI in either phase.

**Why now.** Phases 2 (diffs), 3 (agents), and 4 (jobs) all assume identity and presence. Building them first would mean retrofitting identity later, which breaks attribution, permissions, and muscle memory. Phase 1 is also the smallest shippable that proves the collaboration thesis to a user.

**Done when.** Every acceptance criterion in section 9 passes, on a fresh DB and on a DB migrated from 026 with existing orgs and members.

---

## 2. Verified current state

Cited with file paths from the repo, checked 2026-09-23. Anything not cited here was not verified.

- **Identity:** better-auth 1.6.23. Tables `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` (`app/apps/server/migrations/001_better_auth.sql`). Email+password with argon2id, 30-day sliding server-side sessions, session token in OS keychain on desktop (`app/apps/server/src/auth/auth.ts`). No new auth system is needed or wanted.
- **Team membership:** `member` rows bind `userId` to `organizationId` with a `role` (`001_better_auth.sql`). Invitations exist (`src/registry/invitations.ts`).
- **MCP server:** `POST /api/mcp`, JSON-RPC 2.0 Streamable HTTP, **15 tools** (`app/apps/server/src/mcp/tools.ts`, `TOOLS` array): list_vaults, list_folders, list_notes, read_note, search_notes, query_knowledge, create_note, update_note, append_note, edit_note, delete_note, create_folder, delete_folder, move_note, move_folder. Untouched by Phase 0/1.
- **MCP tokens:** `mcp_tokens` table, sha256 stored, `mcp_` prefix, scoped to `(user_id, organization_id)`, act AS the user (`migrations/006_mcp_tokens.sql`, `src/mcp/tokens.ts`). Revoke is row delete, immediate. No per-call audit log exists; only counters (`use_count`, `last_used_at`, `last_client` in `009_mcp_usage.sql`). Read instrumentation is a Phase 3 concern, not this spec.
- **ACL:** `shares` table with `resource_type` in (folder, file, workspace), `principal_type` in (org, user), workspace-wide grants possible, locks cap grants (`migrations/002_app_tables.sql`, `008_workspace_grants.sql`). Untouched by Phase 0/1.
- **Y.Doc store:** `doc_updates` + `doc_snapshots` (`002_app_tables.sql`). Untouched.
- **Attribution:** `notes.last_edited_by` + `last_edited_at`, stamped server-side (`migrations/017_last_edited_by.sql`). Today this references `"user"`. Phase 0/1 keep it user-scoped; agent attribution arrives with Phase 3's registry-signed identity.
- **Presence lib:** `app/apps/desktop/src/lib/presence/` holds `color.ts` (deterministic FNV-1a hash onto a 12-color palette, `PresenceUser {id, name, color, status}`), `ping.ts` (WebAudio mention chime), `viewingDocId.ts` (announces the SERVER doc_id, never the local id).
- **Vault channel presence:** `VaultPeer {userId, docId, name, color, status}` and `LocalPresence` in `app/apps/desktop/src/lib/sync/vaultSyncEngine.ts`. The store keeps `vaultPresence: VaultPeer[]` (`app/apps/desktop/src/store.ts:363`). `announcePresence()` re-broadcasts on member join. Invisible users broadcast a null doc. Frames for docs outside the receiver's readable set are dropped.
- **Per-doc awareness:** y-protocols `Awareness` bound per open note in `docSession.ts`; local state field `user` set via `presenceUser()`.
- **Remote cursors:** `app/apps/desktop/src/lib/editor/remoteCursors.ts` renders animated remote carets with persistent name flags in a CodeMirror layer. **Nothing imports it.** It is finished code with no wiring.
- **No presence panel exists.** No participant registry exists. No agent concept exists anywhere in schema or code.

---

## 3. Landscape audit

One row per capability Phase 0/1 touches or deliberately avoids. This is the full picture so the builder does not tunnel-vision on the new code.

| Capability | Status today | Gap closed by this spec |
|---|---|---|
| Identity (better-auth user/org/member) | Shipped | None. Bind to it, do not rebuild it |
| MCP server + tokens | Shipped (15 tools) | None. Untouched |
| Folder/file/workspace ACL | Shipped | None. Untouched |
| Participant registry | Missing | Built: migration 027, server module, 3 endpoints |
| Presence color lib | Shipped (12-color palette) | Palette swapped to fixed 8-color Okabe-Ito per plan |
| Vault channel presence | Shipped, partial | Heartbeat (10s), decay (30s stale / 90s removed), `participantId` in frames |
| Per-doc awareness | Shipped | Reuse as-is |
| Remote cursors module | Dead code | Wired into the editor |
| Presence panel UI | Missing | Built: toggleable right sidebar, 3 sections |
| Agent tokens + agent identity | Missing | Explicitly Phase 3. Schema carries the `kind` column now so no migration is needed later |
| Follow mode | Missing | Deferred to 1.1 by plan |
| Mobile presence | Missing | Declared desktop-only for Phase 1 |

---

## 4. Scope

### Phase 0 ships

1. **Participant registry, server-side.** New Postgres table `participants` (full DDL in section 5), migration `027_participants.sql`, backfill creating one `human` row per existing `member` row.
2. **Team space defined as the existing organization.** No new team-space table. A team space is the set of participant rows sharing an `organization_id`.
3. **Ensure-on-join.** Accepting an invitation or joining an org creates the human participant row in the same transaction. A member without a participant row is a bug.
4. **Registry API.** `GET /api/participants`, `POST /api/participants` (agent rows only, owner/admin), `PATCH /api/participants/:id` (rename, deactivate). Shapes in section 6.
5. **Deactivation, not deletion.** Setting `deactivated_at` removes a participant from presence and the registry listing. Attribution on `notes.last_edited_by` survives.

### Phase 0 does NOT build

- A Noam auth system, SSO, or device management. better-auth stays exactly as is.
- Agent rows that do anything. The `kind='agent'` column exists and the create endpoint accepts agent rows, but no agent can authenticate until Phase 3. Agent rows are inert data in Phase 0.
- Any change to MCP, ACL, sync, or billing.

### Phase 1 ships

1. **Presence panel.** Toggleable right sidebar with three sections: Online now, Agents active, In this note. Shortcut-toggleable. Collapsed by default in personal vaults (single-member orgs), open in team spaces (multi-member orgs).
2. **Live cursors.** Wire the existing `remoteCursors.ts` into the editor against the per-doc awareness already bound in `docSession.ts`. Cursor color equals the participant's registry color on every client.
3. **Per-note presence chips.** Who is in this note, with registry colors and names.
4. **Heartbeat and decay.** Client re-pushes vault-channel presence every 10s. A peer with no frame for 30s reads as stale (dimmed, cursor fades). At 90s the peer is removed from the roster with a quiet panel note. Stale presence is loud, never a ghost.
5. **Agent identity colors, defined now.** Fixed 8-color colorblind-safe palette (Okabe-Ito, section 7). Violet `#7f73ff` is reserved for Noam's own actions and is never assigned to a participant. Defined now so Phase 3 does not retrofit color identity.
6. **Accessibility.** Remote cursors are aria-hidden with a polite text alternative. Presence changes announce through a debounced polite live region. `prefers-reduced-motion` snaps cursors instead of gliding them.
7. **Desktop-only, declared.** Below 700px viewport width the panel does not render; the editor stays fully usable with no horizontal overflow. This is stated in the release notes, not hidden.

### Phase 1 does NOT build

- Follow mode (viewport sync). Deferred to 1.1 by the plan.
- Comments, @mentions, notifications.
- Suggestion mode or diffs (Phase 2).
- Agent participants that connect, agent tokens, the setup wizard (Phase 3).
- Mobile presence UI. The 700px rule above is the whole mobile story for Phase 1.

### Explicit non-goals for both phases

- No new auth, no SSO, no device management.
- No MCP surface changes, no token format changes, no read/write audit log (Phase 3).
- No ACL model changes.
- No E2E encryption changes; presence frames keep the existing trust model (dropped when the doc is unreadable to the receiver).
- No server-side key storage, no inference, no model anything.
- No workflow files, no jobs, no scheduler.

---

## 5. Data model

One new table. Everything else is read from existing tables.

```sql
-- app/apps/server/migrations/027_participants.sql
-- Participant registry: one row per human or agent in a team space.
-- Phase 0/1: human rows are functional; agent rows are inert until Phase 3.

CREATE TABLE participants (
  id              TEXT PRIMARY KEY,  -- uuid
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  -- Set for humans, NULL for agents. Agents get identity from their registry
  -- row plus (in Phase 3) an agent-scoped token, never a user row.
  user_id         TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  display_name    TEXT NOT NULL,
  -- One of the 8 registry palette hexes (section 7), assigned at creation,
  -- immutable afterwards. Deterministic across clients: no per-session color.
  color           TEXT NOT NULL,
  -- Agent-only: which harness this agent runs on
  -- ('claude-code' | 'codex-cli' | 'gemini-cli' | 'custom'). NULL for humans.
  harness         TEXT,
  created_by      TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft delete. Deactivated participants leave presence and listings, but
  -- attribution (notes.last_edited_by) and history keep working.
  deactivated_at  TIMESTAMPTZ,
  CHECK (kind = 'agent' OR user_id IS NOT NULL),
  CHECK (kind = 'human' OR harness IS NULL)
);

CREATE INDEX participants_org_idx ON participants (organization_id);

-- One live human row per (org, user).
CREATE UNIQUE INDEX participants_human_user_uidx
  ON participants (organization_id, user_id)
  WHERE kind = 'human' AND user_id IS NOT NULL AND deactivated_at IS NULL;

-- Agent display names are unique per org so "@Claude" always means one agent.
CREATE UNIQUE INDEX participants_agent_name_uidx
  ON participants (organization_id, display_name)
  WHERE kind = 'agent' AND deactivated_at IS NULL;

-- Backfill: every existing member becomes a human participant.
-- Color is deterministic: hash of user_id mod 8 over the Okabe-Ito palette,
-- so re-running the backfill assigns the same color.
INSERT INTO participants (id, organization_id, kind, user_id, display_name, color, created_at)
SELECT gen_random_uuid()::text,
       m."organizationId",
       'human',
       m."userId",
       u.name,
       (ARRAY['#E69F00','#56B4E9','#009E73','#F0E442','#0072B2','#D55E00','#CC79A7','#000000'])
         [mod(abs(hashtext(m."userId")), 8) + 1],
       now()
FROM member m
JOIN "user" u ON u.id = m."userId"
ON CONFLICT DO NOTHING;
```

Design notes the builder should not have to rediscover:

- **Server-side Postgres, not local.** The plan's ADR-3 puts the registry next to vaults, folders, and notes because team presence needs one shared source of truth. The desktop never invents participant rows locally.
- **Color stored, not computed at read time.** The desktop's `colorForUser` hashes at render; the registry stores the hex so the server, the desktop, and (later) agents all agree without sharing hash code. Assignment is still deterministic (hash of the participant id), so backfill and live creation agree.
- **Humans may share display names.** Two "John"s in one org are fine; uniqueness is on `(organization_id, user_id)`. The panel disambiguates with color, same as cursors do.
- **`notes.last_edited_by` is untouched.** It still references `"user"`. Agent attribution needs the registry-signed identity from ADR-3, which is Phase 3 work.

---

## 6. API surfaces

Base: existing Hono server, existing session auth (`Authorization: Bearer <session-token>`). All three endpoints require org membership; non-members get 403. No new auth mechanism.

### GET /api/participants?organizationId={id}

List the live roster for one org. This is identity, not presence: it answers "who exists here", not "who is online".

Response 200:
```json
{
  "participants": [
    {
      "id": "p_01H...",
      "kind": "human",
      "displayName": "John",
      "color": "#0072B2",
      "harness": null,
      "createdAt": "2026-09-23T14:02:11Z"
    }
  ]
}
```

Rules: deactivated rows are excluded. No emails, no user ids, no session data. The client needs names and colors; it does not need anything else.

### POST /api/participants

Create an **agent** row only. Human rows are created by the join flow, never by this endpoint.

Request:
```json
{ "organizationId": "org_...", "kind": "agent", "displayName": "Claude", "harness": "claude-code" }
```

Rules: caller must have owner or admin role in the org (403 otherwise). `kind: "human"` is rejected with 400. Duplicate agent display name in the org is rejected with 409. Response 201 returns the row in the GET shape. In Phase 1 the row is inert: no token can authenticate as it until Phase 3.

### PATCH /api/participants/:id

Request: `{ "displayName": "Claude 2" }` and/or `{ "deactivatedAt": "2026-09-23T15:00:00Z" }` (pass null to re-activate).

Rules: owner/admin only. Color is immutable (400 on attempt). Deactivating a human does not remove their `member` row; membership stays better-auth's job.

### What is NOT a new API

Presence itself. Online state keeps riding the existing vault channel and per-doc awareness. No polling endpoint, no websocket addition, no SSE. The plan is explicit that Phase 1 is UI over existing infra, and the infra is already there.

---

## 7. Presence protocol

### Frame contents

The vault-channel frame gains one field. Everything else is unchanged.

```ts
interface LocalPresence {
  participantId: string;   // NEW: the registry row id
  docId: string | null;    // unchanged: server doc_id, null when invisible
  name: string;            // unchanged: registry display_name
  color: string;           // CHANGED: registry color, not a local hash
  status: ActivityStatus;  // unchanged
}
```

`VaultPeer` gains the same `participantId`. The desktop resolves name and color from the registry at session start and caches them; frames carry the values so a client that missed the registry fetch still renders.

### Heartbeat and decay

| Rule | Value | Why |
|---|---|---|
| Heartbeat interval | 10s | The vault channel keeps no shared roster; re-pushing converges newcomers without a query round |
| Stale threshold | 30s without a frame | Peer dims in the panel, cursor fades in the editor |
| Removal threshold | 90s without a frame | Peer leaves the roster; the panel shows one quiet note ("Maya disconnected") |
| y-protocols awareness timeout | 30s (existing default, unchanged) | Per-doc cursor state already expires here; the 10s heartbeat keeps idle cursors alive |

The 30s/90s split is deliberate: at 30s the UI admits uncertainty (dimmed, not gone), at 90s it commits. A peer that reconnects re-announces and reappears; no manual refresh exists or is needed.

### Cursor wiring

`remoteCursors.ts` is finished and unreferenced. The work is wiring, not building:

1. Export a bind function from `remoteCursors.ts` taking the CodeMirror `EditorView`, the `Y.Text`, and the doc's `Awareness` (the same awareness `docSession.ts` already binds per open note).
2. Call it where the editor view is created for a synced note. One caret per remote client, skipped for folded regions (already handled in the module), skipped off-screen (already handled).
3. Cursor color and name come from the awareness `user` field, which `applyPresence` already sets. Change `applyPresence` to publish the registry color and `participantId` instead of the local hash.

### Palette

The registry assigns from this fixed set at row creation. Order is the canonical Okabe-Ito order.

```
#E69F00  orange          #56B4E9  sky blue
#009E73  bluish green    #F0E442  yellow
#0072B2  blue            #D55E00  vermilion
#CC79A7  reddish purple  #000000  black
```

Violet `#7f73ff` is reserved for Noam's own actions and is never assigned. This supersedes the current `color.ts` 12-color palette's rule against red/orange tones for participant identity; the plan chose Okabe-Ito explicitly because colorblind safety beats the no-red aesthetic. `color.ts` keeps its deterministic-hash approach but hashes onto these 8.

---

## 8. Desktop changes

| File | Change |
|---|---|
| `app/apps/server/migrations/027_participants.sql` | New. Table, indexes, backfill |
| `app/apps/server/src/registry/participants.ts` | New. `ensureHumanParticipant`, `createAgentParticipant`, `listParticipants`, `deactivateParticipant` |
| `app/apps/server/src/http/routes/participants.ts` | New. GET / POST / PATCH handlers, membership + role gates |
| `app/apps/server/src/http/app.ts` | Mount the participants route |
| `app/apps/server/src/registry/invitations.ts` | Hook: create the human participant row inside the invitation-accept transaction |
| `app/apps/desktop/src/lib/presence/color.ts` | Swap `PRESENCE_PALETTE` to the 8-color Okabe-Ito set; keep the FNV-1a hash |
| `app/apps/desktop/src/lib/editor/remoteCursors.ts` | Export a bind function; no rendering logic changes |
| `app/apps/desktop/src/lib/presence/PresencePanel.tsx` | New. Toggleable right sidebar: Online now / Agents active / In this note |
| `app/apps/desktop/src/lib/sync/vaultSyncEngine.ts` | 10s heartbeat, 30s/90s decay, `participantId` in frames |
| `app/apps/desktop/src/lib/sync/docSession.ts` | `applyPresence` publishes registry color + participantId |
| `app/apps/desktop/src/store.ts` | Panel open state, stale flags on `vaultPresence`; default collapsed for single-member orgs |

The panel follows the plan's interaction rules: approval-style UI never appears here (no approvals exist yet), sections collapse independently, keyboard shortcut toggles the panel, and the Agents active section renders an honest empty state in Phase 1 ("No agents yet. Agents arrive in Phase 3.") rather than hiding.

---

## 9. Acceptance criteria

Numbered, pass/fail, no vibes. Phase 0 criteria gate Phase 1 work.

### Phase 0

1. Migration 027 applies cleanly on an empty DB and upgrades a DB at 026 with existing orgs, members, and vaults. No data loss, no downtime beyond the migration itself.
2. After migration, every `member` row has exactly one live `human` participant row in the same org. Verified by count query, not by spot check.
3. A user accepting an invitation lands in the org with a participant row in the same transaction. Killing the process mid-accept never leaves a member without a row (test with a transaction rollback).
4. `GET /api/participants` with a non-member session token returns 403. With a member token it returns only that org's live rows, with no emails or user ids in the payload.
5. `POST /api/participants` with `kind: "human"` returns 400. With `kind: "agent"` as a non-admin returns 403, as owner returns 201. A second agent with the same display name in the org returns 409.
6. `PATCH` deactivation removes the participant from `GET` results within one request. `notes.last_edited_by` rows pointing at the human's user id are unaffected.
7. Login, signup, password reset, and invitation email flows behave exactly as before. Zero changes to `src/auth/auth.ts` or the better-auth config.

### Phase 1

8. **Two-client cursor E2E.** Client A and B open the same note. B moves its cursor. B's caret with B's name flag is visible in A's editor within 2 seconds, in B's registry color. Measured wall-clock, not simulated.
9. **Disconnect decay E2E.** B's network is killed (socket drop, no clean close). Within 30 to 40 seconds A's panel shows B dimmed as stale. Within 90 to 100 seconds B is removed from A's roster and the panel shows one quiet note. No ghost cursors remain in the editor.
10. **Panel behavior.** Shortcut toggles the panel. Three sections render with correct membership: Online now lists live peers, In this note lists peers whose `docId` matches the open note, Agents active shows the Phase 1 empty state. In a single-member org the panel starts collapsed; in a multi-member org it starts open.
11. **Color agreement.** For every participant, the cursor color, the panel chip, and the registry row agree on both clients. No per-session randomness: reopening the app assigns the same color.
12. **Invisible status.** A user set to invisible broadcasts a null doc, appears dimmed in Online now, and never appears in In this note. Verified the existing behavior survives the `participantId` change.
13. **No-regression on presence dots.** The existing file-tree presence dots keep working with registry colors.
14. **Reduced motion.** With `prefers-reduced-motion`, remote cursors snap to new positions with no glide transition.
15. **Screen reader.** Remote cursor layer is aria-hidden. Join/leave announcements go through a single polite live region, debounced to at most one announcement per 5 seconds.
16. **Desktop-only declared.** At 390px width the editor is fully usable with no horizontal overflow and no presence UI renders. The release notes state Phase 1 is desktop-only.
17. **Unit coverage.** New vitest tests for: registry CRUD and gates, backfill determinism (same user id always maps to the same color), heartbeat/decay state machine, stale-vs-removed transitions, and the cursor bind against a fake awareness. Existing `multiuser.test.ts` and presence tests stay green.

---

## 10. Test plan

- **Server:** vitest (existing framework) for `registry/participants.ts`: backfill determinism, unique-index conflicts (duplicate human, duplicate agent name), role gates on POST/PATCH, deactivation semantics. Route tests for 403/400/409 shapes.
- **Desktop:** vitest for the decay state machine (pure logic, fake timers), color agreement (registry hex in, same hex out), panel section membership from a fake roster.
- **E2E:** two real clients against a local server (criteria 8 and 9). Cursor latency measured with a scripted cursor move and a screenshot or DOM poll on the receiving client. Disconnect simulated by killing the client's socket, not by clean close, because clean closes are the easy case.
- **Regression:** existing sync, multiuser, and presence test files run unchanged and green before merge.

---

## 11. Ordering and dependencies

```
027 migration + backfill
  └─> ensure-on-join hook ──> registry API routes
        └─> desktop: registry color plumbing (color.ts, applyPresence)
              ├─> cursor wiring (remoteCursors bind)
              └─> presence panel ──> heartbeat/decay ──> a11y + 700px rule
```

The migration and backfill come first because everything reads the registry. The join hook and API come next because the desktop needs rows to exist. Cursor wiring and the panel are independent of each other once colors flow. Decay is last among the build items because it is only observable with the panel and cursors in place. Tests are written alongside each item, not after.

---

## 12. Failure modes and rollback

- **Migration 027 is additive.** New table, new indexes, backfill inserts. Rollback is `DROP TABLE participants`. No existing table is altered, so a rollback cannot corrupt vaults, notes, or auth.
- **Backfill conflict.** If the migration runs twice, `ON CONFLICT DO NOTHING` keeps it idempotent. The color assignment is deterministic, so a partial rerun assigns identical colors.
- **Join hook failure.** The participant insert lives inside the invitation-accept transaction. If it fails, the join fails loudly and rolls back. A member without a row is impossible by construction, not by convention.
- **Presence is additive UI.** If the panel or cursors regress, the feature flag `presenceV1` disables the panel and cursor binding without touching sync or editing. Rollback does not require a migration.
- **Decay false positives.** A peer on a flaky connection may flap between stale and live. The 30s dimmed state exists exactly for this: the UI shows uncertainty instead of lying. No action is taken on the peer's data at any decay stage.

---

## 13. Do not touch

Stated so the implementer does not "fix" working things into regressions.

- `src/auth/auth.ts` and the better-auth config. Identity works.
- `src/mcp/` in its entirety. The 15 tools, token format, and counter telemetry are Phase 3's problem.
- `src/permissions/` and the `shares` table. The ACL model is settled for this phase.
- The Y.Doc store, snapshot/compaction, and sync protocol framing.
- `ping.ts` and `viewingDocId.ts`. They are correct as-is.
- The rendering logic inside `remoteCursors.ts`. Wire it, do not redesign it.

---

## 14. Assumptions

Auto-decided while John was unavailable, per the plan's stated recommendations. Each is reversible and none is load-bearing for the plan's thesis.

1. Team space equals the existing better-auth organization. No new team-space entity.
2. Participant rows are created server-side only. The desktop never invents them.
3. Color is assigned at row creation from the Okabe-Ito 8 and stored immutably.
4. Backfill color uses `mod(abs(hashtext(user_id)), 8)`, deterministic across reruns.
5. Human display names may collide within an org; color disambiguates.
6. Agent display names are unique per org so @-references (Phase 2+) are unambiguous.
7. Agent rows are creatable in Phase 0/1 but inert: no authentication path exists until Phase 3.
8. Presence transport stays on the vault channel + y-protocols awareness. No new HTTP or socket API.
9. Heartbeat 10s, stale 30s, removed 90s, per the plan. y-protocols' 30s awareness timeout is left at its default.
10. The Agents active panel section ships as an honest empty state, not hidden.
11. Violet `#7f73ff` is reserved for Noam actions and never assigned to a participant.
12. Single-member org equals personal vault for the panel's default-collapsed rule.
13. `notes.last_edited_by` stays user-scoped; agent attribution waits for Phase 3.
14. Below 700px the panel does not render; the release notes declare Phase 1 desktop-only.
15. A `presenceV1` feature flag gates the panel and cursor wiring for safe rollback.
16. The Okabe-Ito palette supersedes the in-repo 12-color palette's no-red rule for participant identity, per the plan's explicit choice.

---

## 15. Open questions for John

All five questions were answered by John on Sept 23, 2026. Decisions are locked in the "Decisions" section at the top of this spec. The original questions are preserved here for context:

1. **Display-name collisions.** ~~Two "John"s in one org are allowed by this spec, disambiguated by color. Do you want that, or unique display names per org with a rename prompt at join?~~ **Decided: allow duplicates, disambiguate by color.**
2. **Deactivation reversibility.** ~~This spec lets owners re-activate a deactivated participant by nulling `deactivated_at`. Should deactivation be reversible in Phase 1, or one-way until Phase 3?~~ **Decided: one-way until Phase 3.**
3. **Palette override.** ~~The plan chose Okabe-Ito, which includes orange and vermilion tones the current in-repo palette deliberately excluded ("red reads as error"). Keep the plan's call, or revisit the palette before it ships?~~ **Decided: revisit the palette before it ships.**
4. **Mobile timing.** ~~The plan says desktop-only for Phase 1 with responsive in 1.x. Is 1.x the next minor release, or "when it hurts"? This decides whether the 700px rule gets a real design later or just a better empty state.~~ **Decided: 1.x is the next minor release.**
5. **Agents empty state.** ~~The Agents active section says "No agents yet. Agents arrive in Phase 3." Should it link anywhere (docs, changelog) or stay silent?~~ **Decided: link to docs or changelog.**

---

*End of spec. Sections 1-13 are buildable as written once section 15 is answered.*
