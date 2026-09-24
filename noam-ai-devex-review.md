# Noam AI Plan — Developer Experience Review (gstack plan-devex-review, devex mode)

**Verdict: 3.0/10. Not shippable for builders.** The plan designs a great product for end users and almost nothing for the developers it depends on. The agent socket is a button with no flow behind it: "Add agent participant" exists in the settings mock, but what happens after the click, what the MCP tools are named, what an error looks like, and how you debug a broken workflow file are all unspecified. The single most important DX fact the plan misses: **the MCP server already exists** (11 tools, scoped tokens, per eng review), which means Phase 3's DX work is not building a server, it is making an existing surface usable. Ship that framing and half the "new" work becomes documentation and error quality.

## Auto-decisions (no user available; recorded assumptions)

| Point | Auto-choice | Why |
|---|---|---|
| Persona | **Builder John**: technical note-taker, CLI-comfortable, will install Claude Code or already has it, ~10-15 min setup tolerance | Plan assumes BYOH fluency (harness installs, API keys in keychain); designing for a non-technical user would contradict the plan's own premises |
| Mode | **DX POLISH** | Scope is set by three prior reviews; the job is rigor on the accepted surface, not expansion |
| TTHW target | **Competitive (2-5 min)** with harness installed; 10-15 min end-to-end including harness install | Champion (<2 min) is dishonest when a third-party CLI install is on the path |
| Magical moment | You add an agent, watch "Claude is editing Q3 Planning" appear live in the presence panel, and approve its first proposed diff from inside Noam | This is the plan's own Bet 1 + Bet 2 fused; it is the only moment that sells the whole thesis |
| Delivery vehicle | Guided **"Add agent participant" wizard** in Settings that ends with a live verification probe | The wizard is the only vehicle that reaches the magical moment inside the plan's stated UI |

## Developer Persona Card

**Who:** Builder John. A technical knowledge worker (the Obsidian refugee Noam targets) who lives in Markdown, is comfortable in a terminal, and already runs or will install Claude Code, Codex CLI, or Gemini CLI.
**Context:** They hit Settings → AI & Agents, connect an agent to a vault, and later author or fork workflow files.
**Tolerance:** 10-15 minutes from "Add agent participant" to a verified working connection. One unexplained failure and they write their own MCP wrapper or walk away.
**Expects:** Copy-paste commands that work, error messages that name the fix, and docs that match the app version. They notice everything because they build for a living.

## Empathy Narrative

I am Builder John. I install Noam, open Settings → AI & Agents, and click "Add agent participant." A dialog asks which harness I use. I pick Claude Code. Then... nothing in the plan tells me what happens next. Do I paste a config snippet into `~/.claude.json`? Does Noam write it for me? Where does the MCP server listen, stdio or a local socket? I generate a scoped token (good, those exist) and paste it somewhere. I click the "Write AGENTS.md for this vault" button and get a file, but is it valid? There is no schema, no lint, no example of a good one. I ask my agent to triage my inbox. It fails with some error. Was it a permission denial? A bad scope? A malformed workflow file? I cannot tell, because no error contract exists. I open the docs. There are no docs. I have now spent 40 minutes and I have a button, a token, and a guess. The product idea is excellent. The builder experience is a rough draft.

## Competitive DX Benchmark

| Tool | Start → result | Time + evidence type | DX choice | Source |
|---|---|---|---|---|
| Tolaria | install app → agent reads vault via setup path | ~10-15 min, estimated from README setup paths for 3 CLIs + AGENTS.md | Docs-first BYOH: you do the wiring, they document it | github.com/refactoringhq/tolaria README (verified Sept 22, 2026) |
| Obsidian + community MCP | install plugin → agent touches vault | ~15-30 min, estimated; fragmented, no canonical path | No canonical interface; users build their own servers | Strategy doc: "one user built a custom MCP server because raw access burned as many tokens" |
| Noam plan (as specified) | Settings click → verified agent participant | ~30-45 min, predicted: harness install + manual MCP config + hand-written AGENTS.md + manual keychain entry + unknown endpoint | A button with no flow behind it | Plan artifact sections 02-04 |
| Noam (proposed target) | Settings click → verified agent participant | 2-5 min harness-installed, predicted | Guided wizard + verification probe + generated config | This review |

The gap to Tolaria is embarrassing in the wrong direction: Tolaria documents the manual path honestly. Noam promises a one-click path and specifies nothing behind it. A promise with no flow scores worse than an honest manual.

## Developer Journey Map (predicted from the plan; no real flow exists to trace)

| Stage | Developer does | Friction | Status |
|---|---|---|---|
| Discover | Reads site/README, learns Noam has an agent socket | No docs IA, no quickstart, no playground; "bundled MCP server" is a phrase, not a page | Gap |
| Install/setup | Clicks "Add agent participant" | Post-click flow unspecified: endpoint location, config format, token placement all unknown | Gap |
| Hello world | Writes AGENTS.md via the button | No schema, no starter template, no validator; is the output valid? Unknown | Gap |
| Real usage | Authors/forks a workflow file | No lint, no dry-run, no "did it work" signal; write markdown and pray | Gap |
| Debug | Agent fails or gets denied | No error contract; permission denial (the most common scoped-permission event!) is unspecified | Gap |
| Upgrade | Protocol or tool names change | No versioning story for the participant protocol or workflow files; files rot silently | Gap |

## The 8 Passes

### Pass 1: Getting Started — 3/10
A 10 for Noam: Settings → AI & Agents → "Add agent participant" → pick harness → Noam shows one copy-paste config block (or writes it with permission) → generates AGENTS.md from a real template → runs `noam agent verify`, which calls `tools/list` over the bundled server and reports green with the agent's presence chip appearing live. Three steps, terminal optional, under 5 minutes. The plan has step zero of this: a button. The eng review confirms the server and tokens exist, so the only missing pieces are the wizard UI, the generated snippets, and the probe. That is weeks, not quarters, which makes the omission worse, not better.
**Fix:** Specify the wizard flow in the plan: exact screens, exact config snippets per harness, the verify probe's expected output, and the time budget per step. Put the magical moment (live presence chip + first approved diff) at the end of the wizard as the designed payoff.

### Pass 2: API/CLI/SDK Design — 4/10
The 11 MCP tools exist but the plan names none of them, specifies no naming grammar, no defaults, no idempotency. Two concrete problems. First, scoped tokens currently act AS the user (eng review hard blocker 3). For builders that is a DX trust bug: every tool error and audit line will say "you" when the agent did it. Errors must carry the participant id. Second, the safe default is missing: tools should default to read-only scopes, with write grants explicit and every mutation returning a suggestion id the UI can render. A 10: `noam.read_note`, `noam.propose_edit`, `noam.list_vault` style guessable names, read-only by default, structured errors (see Pass 3), and a `tools/list` response a builder can read without the docs open.
**Fix:** Publish the tool inventory as an appendix to the plan with names, parameters, defaults, and scope requirements. Decide: does every mutation return a suggestion id, or do some apply directly? (My call: all agent mutations return suggestion ids. It is the plan's own Bet 2.)

### Pass 3: Error Messages & Debugging — 2/10
Nothing in the plan. Trace the three most common failure paths and all three are blank:
1. **Permission denied.** The single most frequent event in a scoped-permission system. What does the agent receive? What does the user see? Specified: nowhere. Should be: structured error with the denied path, the scope the agent holds, the grant it needs, and a one-click "approve this scope" affordance on the user side.
2. **Malformed AGENTS.md / workflow file.** No schema means no parser, which means failures surface as silent agent confusion. Should be: `noam agent lint` with Elm-style output naming the file, the line, what was expected, and the fix.
3. **Harness cannot reach the MCP server.** Port in use, wrong endpoint, stale token. Should be: the verify probe prints the attempted endpoint, the failure class (connection refused vs auth vs protocol), and the exact command to fix it.
A 10 follows the formula: what happened + why + how to fix + where to learn more + the actual values. Today this plan is Tier 0 on all three paths.
**Fix:** Write the error contract into the plan before Phase 3 code: error shape, the three paths above with before/after message text, and a debug/verbose mode for the MCP server.

### Pass 4: Documentation & Learning — 3/10
The plan references an AGENTS.md convention and "a documented folder convention + README" for the workflow gallery, but commits to no docs. No quickstart, no tool reference, no copy-paste harness snippets, no versioning. 52% of developers are blocked by missing docs, and this plan's entire Phase 3 adoption depends on builders who cannot succeed without them. The gold standard is blunt: features do not ship until docs are finalized. A 10 for Noam: a quickstart that a builder can copy-paste to a verified connection in under 5 minutes with real shown output; a tool reference with one real example per tool; every error message links to the relevant docs page; docs versioned with the app so v0.2's protocol docs never describe v0.1's tools.
**Fix:** Add a docs checklist as a Phase 3 exit criterion: quickstart, tool reference, AGENTS.md authoring guide, workflow-file authoring guide, error catalog. Docs ship with the feature or the feature does not ship.

### Pass 5: Upgrade & Migration Path — 1/10
Not addressed. This is the quiet killer for the "agents as vault files" bet: workflow files are markdown in user vaults that Noam will keep for years. When a tool renames or the protocol revs, every community workflow breaks silently and the gallery rots. A 10: workflow files carry a `noam-agent: v1` frontmatter version; the participant registry pins the protocol version per agent; renames ship with in-app deprecation warnings one release before removal; a `noam workflow migrate` command rewrites files forward.
**Fix:** Put protocol versioning and workflow-file schema versioning into the architecture section now, before Phase 3. It is a one-paragraph decision with multi-year consequences.

### Pass 6: Developer Environment & Tooling — 4/10
Local harnesses are assumed, which is fine, but the authoring loop for agents-as-files has no tooling: no linter, no dry-run, no way to test a workflow without letting it touch your vault. The pit-of-success move is obvious: `noam workflow dry-run <file>` renders the proposed diffs without applying anything, so authors iterate safely. Also missing: non-interactive mode for CI (lint workflow files in a GitHub Action before sharing), and offline behavior (everything here should work with the network off; say so explicitly, it is a selling point). A 10: lint + dry-run + CI-ready + offline-first, all documented.
**Fix:** Add `noam agent lint` and `noam workflow dry-run` to the Phase 3/4 scope as first-class CLI surface, with the dry-run output format specified.

### Pass 7: Community & Ecosystem — 6/10
The strongest DX bet in the plan: forkable vault files, no central registry, gists as distribution. That is genuinely good DX philosophy (you own every line, no version conflicts, à la shadcn). But "the community maintains itself" is a hope, not a mechanism. A gallery with three broken reference workflows is worse than no gallery. A 10: the three reference jobs (morning digest, meeting-notes-to-actions, inbox triage) ship as real, lint-passing, dry-run-verified files; a starter template repo with CI lint that forks in one click; a documented folder convention with a README that actually renders somewhere users browse.
**Fix:** Make "reference workflows pass lint + dry-run in CI" a Phase 4 exit criterion. Cut Phase 4 to the one reference job with real users (per the CEO review's cut) and make that one file exemplary instead of three mediocre ones.

### Pass 8: DX Measurement — 1/10
Nothing. No TTHW instrumentation, no setup-funnel tracking, no friction audit planned. You cannot improve what you do not measure, and the magical moment (wizard → live chip → first approved diff) is precisely measurable: time from "Add agent participant" click to verified probe green, and drop-off per wizard step. A 10: those two metrics instrumented from day one of Phase 3, plus a scheduled friction audit (one builder, one fresh machine, watch them set it up) before calling Phase 3 done.
**Fix:** Add measurement to the plan: the two funnel metrics, the audit ritual, and an owner. (This proposes instrumentation, not a recurring human process beyond one audit; the audit cadence itself is an open question below.)

## Claude Code Skill DX Checklist (applies: this plan is an MCP/agent-tool surface)

- **State storage:** PARTIAL. The participant registry is well-conceived (one identity type), but the plan never says where builder-visible state lives (per-vault file vs app DB) or how a builder inspects it. Decide and document.
- **Progressive consent:** STRONG. Per-agent approval modes with always-ask default is exactly the pattern. Keep it.
- **Error recovery:** MISSING. No resume-from-failure story for interrupted agent work; no partial-results preservation. Name it or cut it explicitly.
- **Bounded autonomy:** STRONG. Scoped permissions are the plan's moat. The gap is only that denials have no designed UX (Pass 3).
- **Skill composition:** MISSING. Can workflow files call other workflow files? The plan is silent. One sentence settles it.
- **Session continuity:** PARTIAL. The audit log covers what the agent touched, but there is no story for resuming an interrupted job.
- **Auto-upgrade:** MISSING. Follows from Pass 5.
- **AskUserQuestion design:** N/A to the product, but the setup wizard should follow the one-issue-per-screen pattern.

## Scorecard

```
Getting Started      |  3/10
API/CLI/SDK          |  4/10
Error Messages       |  2/10
Documentation        |  3/10
Upgrade Path         |  1/10
Dev Environment      |  4/10
Community            |  6/10
DX Measurement       |  1/10
--------------------------------
TTHW                 | ~30-45 min → 2-5 min target
Competitive Rank     | Red Flag (current trajectory)
Magical Moment       | designed, no vehicle specified
Product Type         | MCP server + setup flow + file-format conventions + docs
Mode                 | POLISH
Overall DX           |  3.0/10
```

Anything below 6 is critical DX debt. Five of eight dimensions are below 6, and three are at 2 or below. The debt is concentrated exactly where adoption happens: setup, errors, docs.

## NOT in scope (considered, deferred)

- A hosted playground or sandbox for trying the MCP server without installing Noam. Good DX, but contradicts the local-first premise; revisit only if acquisition data demands it.
- SDKs in multiple languages. The MCP protocol is the SDK; do not build wrappers until a real builder asks.
- A workflow-file package manager. Gists + git are the stated distribution; a registry would recreate the maintenance burden the plan explicitly rejects.
- Windows support for the setup wizard. Noam is Apple Silicon only today; note the gap, do not design for it yet.

## What already exists (reuse, per eng review grounding)

- `POST /api/mcp` JSON-RPC endpoint with 11 tools and scoped tokens. The DX task is naming, defaults, errors, docs, not construction.
- Folder/file ACL with instant revoke. The DX task is the denial UX and the scope-request flow.
- Participant registry concept needs the agent-kind rows from day one of Phase 1 (eng review's greenlight condition). For DX this means the registry schema is also the builder-visible identity model; document it once.
- Y.Doc snapshot/compaction and the presence lib are sync internals; builders never touch them, keep them out of the DX surface.

## Implementation Tasks

- [ ] **T1 (P1, human: ~1 day)** — Setup wizard flow spec — Specify the post-click "Add agent participant" flow: screens, per-harness config snippets, token placement, verify probe with exact expected output, time budget per step. Ends at the magical moment (live presence chip + first approved diff).
  - Surfaced by: Pass 1 — the settings mock has a button with no flow behind it; TTHW ~30-45 min predicted.
  - Verify: A builder unfamiliar with the plan can follow the spec to a verified connection without asking questions.
- [ ] **T2 (P1, human: ~4h)** — MCP tool inventory appendix — Name all 11 tools, parameters, defaults, scope requirements. Decide: all agent mutations return suggestion ids; tools default to read-only scopes.
  - Surfaced by: Pass 2 — tools exist but are unnamed and underspecified; tokens act as the user (identity bug).
  - Verify: A builder can use every tool correctly after reading the appendix once.
- [ ] **T3 (P1, human: ~1 day)** — AGENTS.md schema + `noam agent lint` — Define the schema, ship a validator with Elm-style errors (file, line, expected, fix), publish a copy-paste starter template.
  - Surfaced by: Passes 1, 3, 4 — the most-copied artifact in the Tolaria pattern is currently a string in a plan.
  - Verify: A malformed AGENTS.md produces an error naming the file, line, and fix.
- [ ] **T4 (P1, human: ~4h)** — Permission-denied error contract — Structured error to the agent (denied path, held scope, required grant) + user-side affordance (approval prompt naming the agent). Include before/after message text for the three traced failure paths.
  - Surfaced by: Pass 3 — the most common event in a scoped system has no designed UX.
  - Verify: Revoke a grant mid-session; agent and user both see exactly what happened and the fix.
- [ ] **T5 (P2, human: ~1 day)** — Workflow file schema + `noam workflow dry-run` — One schema decision (frontmatter + body), dry-run renders proposed diffs without applying, CI-usable non-interactive mode.
  - Surfaced by: Pass 6 — authors currently write markdown and pray.
  - Verify: `dry-run` on the morning-digest reference job shows diffs, touches nothing.
- [ ] **T6 (P2, human: ~2 days)** — Docs exit criteria for Phase 3 — Quickstart (<5 min, real output shown), tool reference with one real example per tool, AGENTS.md authoring guide, workflow authoring guide, error catalog. Docs ship with the feature or the feature does not ship.
  - Surfaced by: Pass 4 — zero docs commitments in the plan.
  - Verify: Fresh builder reaches verified connection following only the quickstart.
- [ ] **T7 (P2, human: ~2h)** — Protocol + workflow-file versioning — `noam-agent: v1` frontmatter, per-agent protocol pin in the registry, deprecation-warning policy. One paragraph in the architecture section.
  - Surfaced by: Pass 5 — unversioned vault files rot silently.
  - Verify: Rename a tool in a draft spec; the deprecation path is describable in one paragraph.
- [ ] **T8 (P3, human: ~4h)** — Setup funnel instrumentation + one friction audit — Metric: click-to-verified-green time and per-step drop-off. One recorded fresh-machine setup session before Phase 3 sign-off.
  - Surfaced by: Pass 8 — no measurement exists.
  - Verify: The two metrics are queryable after the first real setup.
- [ ] **T9 (P3, human: ~1 day)** — Reference workflow quality bar — The kept reference job(s) pass lint + dry-run in CI; starter template repo with one-click fork and lint action.
  - Surfaced by: Pass 7 — gallery quality is the ecosystem's first impression.
  - Verify: `lint` and `dry-run` green on all shipped reference files.

## Open questions for John (genuine product decisions, not reviewable without you)

1. **Config generation vs copy-paste:** Should Noam write the harness config files for the user (e.g. MCP entries into Claude Code's config) or show copy-paste snippets? Auto-write is magical but touches files outside the vault; snippets are honest but slower. This single call shapes the whole TTHW number.
2. **MCP transport:** Where does the bundled server listen, local stdio or a local HTTP socket? Every setup instruction, error message, and the verify probe hang off this. (My recommendation: stdio for CLIs, it is the harness-native pattern; but pick one primary and document it.)
3. **Workflow file format:** YAML frontmatter + markdown body, or pure markdown with conventions? The schema decision (T5) cannot start until this is picked. Frontmatter is my recommendation: parseable, versionable, familiar.
4. **Agent shell access:** Do agents ever get shell execution through Noam, or are the MCP tools file-only? BYOH harnesses bring their own shells, so file-only is defensible and simpler to permission. Say it loudly either way; it is a DX feature, not a limitation.
5. **Friction-audit cadence:** One fresh-machine setup audit per phase, or only before Phase 3 sign-off? (T8 proposes the minimum; a cadence is your call.)

## Cross-review notes

- **Agrees with eng review:** the MCP server, ACL, and tokens already exist, so Phase 3 DX is documentation and error quality, not construction. The token-acts-as-user finding is also a DX identity bug (T2), not just a security issue.
- **Sharpens CEO review:** the CEO questioned whether mediated BYOH is the right premise. DX view: even on the plan's own premises, the setup gap kills adoption before philosophy matters. Fix the wizard and the premise gets a fair test.
- **Sharpens design review:** the design review scored the suggest-mode loop 3/10 as a user interaction. The builder side is worse: the people who must implement and extend that loop (workflow authors) have no tooling at all (T5).

STATUS: DONE_WITH_CONCERNS — review complete; five of eight dimensions are critical DX debt (below 6), concentrated in setup, errors, and docs. No durable learnings surfaced beyond the session itself.
