# Noam AI Plan v2: Tune Report

**Date:** Sept 23, 2026
**Input:** `noam-ai-plan.html` (v1) + `noam-ai-strategy.md`
**Process:** four gstack plan-review rounds (CEO, design, eng, devex) + a repo audit of `jwm-axoni/noam` at `development`, v0.1.59
**Output:** `noam-ai-plan-v2.html` (this tune's deliverable; v1 preserved untouched)

One process note: gstack's actual `plan-tune` skill is about tuning question-asking sensitivity, not plan consolidation. It does not contain a plan-merging workflow. This tune followed the consolidation workflow John asked for, while applying the skill's decision discipline: auto-choose the recommended option where no user was available, record every assumption, and reserve genuine product calls for John. The ten open questions in section 09 of the v2 plan are the result.

## What the repo audit changed

The v1 plan was written without reading the repo. The audit corrected the build-status cards, and the correction shrank Phase 3 substantially:

| v1 claimed | Verified in the repo |
|---|---|
| Agent socket (MCP server): new | SHIPPED: `POST /api/mcp`, JSON-RPC, 11 tools (`read_note`, `update_note`, `append_note`, `search_notes`, +7 more), scoped tokens minted from desktop Vault settings, MCP tab. Writes mutate the live Y.Doc like human edits. |
| Permission engine: new | HALF: folder/file ACL (`/api/shares`) with instant revoke is shipped. Missing: agent-scoped grants. Tokens are scoped to (user, vault) and act AS THE USER (user impersonation). |
| Snapshot + compact: mitigation to build | SHIPPED server-side: binary Y.Doc store, `doc_updates` append log + `doc_snapshots`, compaction at 50 updates. |
| Presence channel: new | HALF: `app/apps/desktop/src/lib/presence/` has `color.ts`, `ping.ts`, `viewingDocId.ts` plus tests. The UI panel is what is missing. |
| Sync core | Verified: `yjs`, `y-protocols`, `y-codemirror.next`, `@hocuspocus/provider`; Cargo.toml confirms the Rust bridge holds un-egested CRDT updates; `rusqlite`; server is Hono + `@hocuspocus/server` + Redis + Postgres 16, Dockerized. |
| Key storage | Verified: OS keychain (`keyring` crate) holds session tokens; server holds only sha256 of MCP tokens. Polar SDK billing exists server-side. |

Net: Phase 3 is about 40% of what v1 implied. The remaining work is identity-shaped (token kinds, registry), surface-shaped (wizard, errors, docs), and decision-shaped (the ADR).

## What changed section by section

- **01 Positioning:** kept the map and the three guardrail cards. Added the clock: a public obsidian-multiplayer spec targets the self-hosted enterprise lane. Added "agents are file-only through Noam" to the boundary card, stated loudly.
- **02 Architecture:** rebuilt with verified status tags (SHIPPED / HALF / NEW) on every layer. The "every edit passes through policy" arrow is now honestly qualified: it holds inside the MCP path; the local path is ADR-2. The exists/build cards list the verified inventory.
- **03 ADR (new section):** four decision records gate Phase 2/3 code, plus a Phase 0 identity prerequisite and the revenue/messaging contradiction flagged for John. See below for recommendations.
- **04 Phased plan:** now five phases. Phase 0 (identity, piggyback not build) added. Phase 1 greenlit with the registry schema built right the first time (agent kinds included), follow mode deferred to 1.1, desktop-only declared. Phase 2 gated on ADR-1 with op-coalescing rules and a retention SLO as acceptance criteria. Phase 3 rescoped (registry + chips first, MCP tools second; wizard, error contract, docs criteria included). Phase 4 cut to one reference job.
- **05 Diff loop (new section):** the design review's 3/10 finding, fixed. Rendering (inline + review bar, never toasts), keyboard grammar (`]`/`[` move, `A` accept, `R` reject, hinted in bar), state tables (stale presence, diff conflict, revoked grant, unreachable MCP, key failure, empty states), fatigue answer (batch review, trust tiers, "accept all from X in this note"), accessibility (aria-hidden cursors with polite alternatives, 44px targets, reduced motion), agent color palette (fixed 8-color Okabe-Ito, violet reserved), three authored moments, explicit 30-day reversibility copy.
- **06 Builder experience (new section):** the devex review's 3.0/10 finding, fixed. Six-step wizard spec ending in `noam agent verify` and the magical moment. Tool inventory rules (read-only defaults, suggestion ids on all mutations, participant id in errors). Error contract formula + three failure paths. AGENTS.md schema + `noam agent lint`, `noam workflow dry-run`, `noam-agent: v1` versioning with deprecation policy, offline-first stated. Docs as Phase 3 exit criteria (quickstart, tool reference, two authoring guides, error catalog, versioned with the app). Measurement: click-to-verify-green time + per-step drop-off, one friction audit before sign-off.
- **07 Settings:** mock revised. Credentials split into "Model keys, system keychain (BYOK)" vs "MCP tokens, server-minted" (the v1 conflation the eng review caught). Agent rows show registry-signed identity and token kind. Avatars use the agent palette. Approval options admit the fatigue problem. Switches redrawn at 44px. Deltas annotated in the mock.
- **08 Decisions & risks:** D1-D5 (added human suggest mode and mobile scope), R1-R5 (R1 now models prompt injection with read instrumentation + signed identity + named exfiltration gap; R3 carries the retention SLO; R5 adds the bulk-write reindex benchmark).
- **09 Open questions:** ten deduplicated product calls for John (see v2 plan).
- **10 Recommendation:** greenlight Phase 0+1 now; require ADR sign-off before Phase 2/3 code; kept/changed/cut summary.

## ADR recommendations (all proposed, awaiting John)

- **ADR-1 (staging):** sandbox Y.Doc per proposal. Accept replays ops, reject drops the doc, base-region changes raise a conflict card. Highest-uncertainty item; needs sign-off before Phase 2 code.
- **ADR-2 (local enforcement):** gated local socket (stdio) as the primary path + filesystem-watch flagging of unmediated writes in the audit log. Honest hybrid. Plus loopback-plus-token auth on the socket.
- **ADR-3 (token kinds):** new agent-scoped token kind (agent id, vault, folder/file scopes, approval mode); registry in server-side Postgres; registry-signed display identity; reads logged with token id, doc id, timestamp.
- **ADR-4 (scheduler):** desktop scheduler for personal vaults, server cron for team spaces.
- **Phase 0 (identity):** piggyback Tailscale identity, do not build auth.
- **Revenue:** no recommendation; founder call. Reconcile STATUS.md vs public messaging first.

## Assumptions made (no user available)

Per the plan-tune discipline, each recorded:

1. Review posture: consolidation, not expansion. Scope cuts (Phase 4 to one job, follow mode to 1.1) follow the CEO review's explicit recommendations.
2. Persona for builder specs: Builder John (technical, CLI-comfortable, 10-15 min setup tolerance), from the devex review.
3. MCP transport: stdio primary (devex recommendation).
4. Workflow format: YAML frontmatter + markdown body with `noam-agent: v1` (devex recommendation).
5. Config delivery: copy-paste snippets as default, auto-write opt-in later (touches files outside the vault; flagged as Q6 for John).
6. Keyboard grammar `]`/`[`/`A`/`R`: proposed, flagged as Q7 for John's taste check.
7. Presence decay: 10s heartbeat, fade at 30s, removal at 90s with panel note (reconciles design's 10s/60s with eng's 30s/90s).
8. Reversibility: 30-day undo window on accepts, as explicit copy.
9. Op-coalescing: 2s window per paragraph; a proposal is a set of coalesced regions.
10. Workflow includes: one level, vault-relative path, cycles rejected by lint (answers the composition question in one sentence).
11. Interrupted agent work: explicitly out of v1 scope (pending diffs stay pending, no auto-resume). Named and cut.
12. Phase 1 mobile: desktop-only declared, mobile design in 1.x.
13. Agent shell access through Noam: file-only (Q9 for John to confirm as a loud feature).
14. The 11 MCP tools: only 4 names verified (`read_note`, `update_note`, `append_note`, `search_notes`); the v2 plan does not invent the other 7. The tool inventory appendix is a Phase 3 deliverable filled from source.

## Scores, before and after

| Review | v1 verdict | v2 status |
|---|---|---|
| CEO | Selective expansion | Folded: mediation flagged (ADR-2), Phase 0 added, revenue flagged, fatigue answered, Phase 4 cut |
| Design | 3/10 | Diff loop fully specified (section 05); artifact contrast fixed (`#6a6355` captions) |
| Eng | Conditional go | Repo facts corrected; 4-item ADR written; Phase 1 greenlit with conditions |
| DevEx | 3.0/10 | Wizard, tool inventory, error contract, lint/dry-run, versioning, docs criteria, measurement (section 06) |

## Files

- `noam-ai-plan-v2.html`: the tuned plan (68 KB, 10 sections, zero em dashes, verified single `</html>`)
- `noam-ai-devex-review.md`: the full devex review (kept from the review round)
- `noam-ai-plan.html` (v1) and `noam-ai-strategy.md`: preserved untouched
