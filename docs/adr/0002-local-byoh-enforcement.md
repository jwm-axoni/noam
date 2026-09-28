# ADR 0002: Local write enforcement for bring-your-own-harness agents

## Status

Proposed. Gates Phase 3 (agent participants). Nothing in Phase 0 or Phase 1 depends on it.

## Context

Noam's permission engine evaluates a scope before data moves, but only on the
MCP path: `POST /api/mcp` resolves the caller, then `permissions/resolver.ts`
`effectivePermission` decides per doc, then `mcp/doc-writer.ts` applies the
edit to the live Y.Doc. A harness (Claude Code, Codex CLI, Gemini CLI) pointed at
a personal vault's folder does none of that. It writes `.md` files through the
OS; the Rust watcher (`src-tauri/src/watcher.rs`) sees a path change; the bridge
ingests it as CRDT operations under the `disk` origin; sync ships it everywhere.
No scope is consulted, and the edit carries no author.

The security audit (2026-09-23, findings F2 and F7) makes two further points
that the plan's option A did not address:

1. A filesystem watcher observes paths and event kinds, never process
   identity. "Flag writes that bypassed the socket" cannot tell an agent's
   bypass write from the user's own Obsidian or vim save by looking at the
   event. Any flagging scheme needs a positive signal from the mediated path.
2. A local MCP listener that accepts unauthenticated loopback connections is a
   local privilege escalation for every other process on the machine.

## Decision

Option A from the plan, with the attribution mechanism specified so the flag is
honest rather than decorative.

**1. The mediated path is the bundled local MCP server over stdio.** The desktop
ships a `noam-mcp` entry point the harness spawns as a child process. stdio has
no network listener, so there is nothing to authenticate on the wire and F7 does
not arise. A loopback TCP transport is offered only when a harness cannot spawn
a process, and then it binds `127.0.0.1` on a random port with a per-launch
token required on every request. `0.0.0.0` is never an option.

**2. Every mediated write produces a receipt before the bytes land.** The local
server writes through the existing Rust `write_note` command and records, in an
append-only local log outside the vault directory
(`~/Library/Application Support/com.noam.app/audit/<vaultId>.log`), the tuple
`{ participantId, docId, relPath, sha256(bytes), tokenId, at }`. The receipt is
written first; the file write follows.

**3. The watcher correlates, it does not guess.** When the watcher reports a
`modified` path, the bridge already hashes the file (`lastWrittenHash`). Three
outcomes, and the audit line says which one:

| Observation | Audit classification |
|---|---|
| Hash matches a receipt issued in the last 5 s for that path | `mediated`, attributed to the receipt's participant |
| Hash matches this app's own egest echo | `self` (the user's editor), not logged as an agent event |
| Neither, and an agent session holds an open token for this vault | `unmediated`, attributed to no one, with the open session ids listed as `suspects` |
| Neither, and no agent session is open | `external`, not an agent event |

`unmediated` is the honest state. It never names an agent as the author, because
the evidence cannot support that; it names the sessions that could have done
it. The UI shows it as "changed outside Noam while an agent was connected".

**4. Detection is not enforcement, and the product says so.** Settings, the
setup wizard, and the docs state in one sentence: on this device, an agent
with filesystem access to the vault folder can bypass Noam's permissions;
Noam records that it happened and cannot prevent it. Enforcement on local
vaults is option B (Noam spawns and sandboxes the harness), a separate product
surface with its own budget, and this ADR does not promise it.

**5. The audit log is outside the agent's reach.** The log lives outside the
vault directory, is opened append-only, is hash-chained (each line carries the
sha256 of the previous line), and its directory is never granted to any harness
config Noam generates. Team vaults additionally forward every line to the
server (ADR 0003), which is the system of record for shared vaults.

## Consequences

- The Phase 3 wizard must make stdio the default and easiest path, or the
  mediated path exists on paper only.
- The bridge gains one lookup per disk-origin ingest (hash against the recent
  receipt set). The receipt set is small and in memory.
- Users will see `unmediated` lines from their own tools when an agent session
  is open at the same time. The classification says "suspects", never "author",
  and the docs explain why. This is the cost of not lying.
- A harness that writes through the socket but also edits files directly is
  indistinguishable from any other bypass. There is no fix for that short of
  option B.

## Verification required before Phase 3 ships

From the audit's runtime checklist: bypass write through the OS is flagged
`unmediated`; the user's own editor writes are classified `self` or `external`,
never `unmediated`, in a test where both happen inside the same 5 s window; the
loopback transport refuses a connection without the token and refuses to bind a
non-loopback address; the audit log rejects an in-place edit (hash chain breaks)
in a test that tampers with a line.
