# /goal Noam human-agent collaboration: Phase 0/1 build with adversarial review

You are the lead on this. Delegate the implementation work to Opus subagents. You personally do direct review of everything they produce. Nothing ships past you without your eyes on it.

**The one rule that overrides everything else:** use your own reasoning everywhere. The docs below contain verified repo findings, expert opinions, and untested proposals. If anything feels wrong, off, risky, or contradicts what you see in the actual code, stop and say so. Propose the better path. Do not blindly implement a spec just because it is written down. A plan that survives your skepticism is worth more than a plan you executed faithfully.

**Repo:** this checkout (/Users/jm/Projects/Noam/noam-clean). Start by confirming branch, head commit, and that the working tree is clean before you touch anything.

**Input docs (read all of them first, they sit next to this prompt):**
- `noam-phase01-spec.md` — the approved Phase 0/1 spec. Status is APPROVED for build. Five product decisions are locked at the top: duplicate display names allowed, one-way deactivation until Phase 3, Okabe-Ito palette rejected, responsive in the next minor release, agents empty state links to docs/changelog.
- `noam-cso-audit.md` — the security audit. Static architecture audit only, no runtime assurance was possible. 14 ranked findings, STRIDE/OWASP mappings, and a 13-item runtime verification checklist.
- `noam-ai-plan-v2.html` plus `noam-ai-plan-v2-tune-report.md` — the tuned plan and what changed.
- `noam-diffloop-variants/` — three interactive mockups of the suggestion diff loop (Rail, Review Session, Drawer). Mocks only, not real components.

**Trust tiers (from the author of these docs):**
- Verified against the repo: 15 MCP tools (not 11), `remoteCursors.ts` implemented but unreferenced, better-auth identity foundations already exist, no per-call MCP audit log, next migration is 027. Trust these.
- Opinions: the review scores and audit rankings. Respect them, question them freely.
- Untested proposals: the 027 DDL has never run against a real database. The presence protocol, endpoint shapes, and acceptance criteria are designs, not running code. The spec lists 16 assumptions. The repo has moved since the spec was verified, so recheck for drift before building.

**Objectives, in order:**
1. Recheck the spec against the current repo state. List every place the code has drifted from what the spec assumes. Fix the plan where the code wins.
2. Implement Phase 0 (participant identity, migration 027, registry) and Phase 1 (presence protocol, cursor wiring, the three endpoint shapes) per the spec. Run migration 027 against a throwaway copy of the database first. If it fails, fix the SQL and document what was wrong with the original.
3. Hit the 17 acceptance criteria in the spec. Prove each one with a test or a demo, not a claim.
4. Work through the security audit's 13-item runtime verification checklist against your implementation. Phase 3 work does not start until ADR-2 (local BYOH enforcement) and ADR-3 (agent token identity, server-stamped attribution) are implemented and this checklist passes. The audit's critical finding stands: MCP tokens are currently user-impersonation bearer credentials, and anything you build must not widen that hole.
5. Diff loop UI: the recommended direction is variant A (the Rail) as default, variant B (Review Session) as an optional power mode, variant C's chip bar for narrow windows. Build the real thing, not the mock. If the mocks got an interaction wrong for real usage, say so and change it.
6. Palette: Okabe-Ito is rejected. Design a colorblind-safe participant palette that keeps the repo's "red reads as error" rule.
7. The v2 plan HTML never got its visual QA pass. Finish it: render it, fix layout issues on desktop and mobile widths, and confirm it reads clean.

**How to report back:** for each objective, state what was built, what you challenged or changed and why, what you verified and how, and what is still open. Separate "done and proven" from "done but unproven" from "blocked." If you disagree with any locked product decision, say so plainly with your reasoning instead of silently working around it.
