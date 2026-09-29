---
type: plan
product: Noam
status: draft-revised
date: 2026-09-28
supersedes: "Noam Plan: Interactive Views, Query Layer, and Sorting (draft, 2026-09-28)"
tags: [plan, query, dashboards, sorting, find-replace, terminal]
---

# Plan: interactive views, query layer, sorting, terminal

This is the revised version of the September 28 draft. The first draft was written without checking
the code, and about half of what it proposed already exists. This version keeps the draft's
principles, drops the parts that would rebuild shipped features, fills the gaps the draft missed,
and adds an embedded terminal track.

Nothing here is approved for build yet. Each section says what exists today, what changes, and
where the risk is.

---

## Principles (unchanged)

1. **Finding content never costs an LLM call.** Retrieval is deterministic, local, free and works
   offline. An LLM may summarize results at answer time, never to find them. PageIndex-style
   reasoning retrieval stays rejected for that reason.
2. **Dashboards are a designed, permissioned feature, not side-loaded code.** Obsidian proved the
   demand with community plugins that run unsandboxed. Noam gets the same power with a real
   security model.
3. **One query primitive powers every surface.** Dashboards, folder views and agent answers all
   read from the same query layer. That primitive already exists: `NoteKnowledge`
   ([[06-note-knowledge-contract]]).

---

## What the first draft got wrong

| Draft said | What the code says |
|---|---|
| Build a structured query API in the Tauri backend | It exists. `src-tauri/src/knowledge.rs` implements typed properties, labels and doc_id-keyed relationships from a catalog note (`_Noam/Knowledge schema.md`), exposed as the `query_knowledge` command with `where` predicates, text, traversal, pagination and permission checks. |
| Expose the query API to "Noam's agent" | There is no in-app agent. Agents are external MCP clients talking to the **server**, which has its own `query_knowledge` MCP tool (`server/src/mcp/tools.ts`). Spec 06 is the contract that keeps the Rust and server implementations in step. |
| The explorer only sorts A to Z | It sorts by **Recently modified** (the default) and **Name A–Z** (`lib/tree/sort.ts`). Folders stay A–Z in every mode on purpose. |
| Manual drag-to-order is a possible later addition | Shipped. `itemOrder` + `applyOrder` layer a manual arrangement over the sort. |
| Open question: where does metadata editing live? | The Properties panel already exists (`lib/editor/noteHeader.ts`, `lib/frontmatter/`). |
| Open question: FTS5 or Tantivy? | FTS5 is live in `index.rs`. Tantivy comes up again only when a measured scale problem appears. |
| Timeline and graph views later | A graph view exists. The real question is whether a graph becomes a dashboard view type. |

---

## Part 1: extend NoteKnowledge (don't rebuild it)

> **Status ✅ (2026-09-29).** Shipped on desktop and server with a shared parity fixture
> (`app/packages/contracts/fixtures/knowledge-sort-parity.json`). Details in
> [[06-note-knowledge-contract]]. Notes from the build: the registry pull already carried
> `created_at`, so no server listing change was needed; frontmatter `created:` without an offset is
> read as UTC, and a bare date means the whole UTC day in `where`; the desktop keeps the EARLIEST
> birthtime it has seen, because atomic saves replace the file and reset birthtime; server
> `modified` is `notes.last_edited_at` (content edits only, never renames).

- **Add `sort` to `KnowledgeQuery`.** The contract has `where` and `page` but no ordering. Sort keys:
  name, created, modified, and any catalog property with a sortable type. Cursors already bind to
  the normalized query, so sort becomes part of that binding.
- **System properties `created` and `modified`.** Queryable like catalog properties, but read-only
  and derived.
- **Seed `type` and `people` as catalog entries, not hardcoded columns.** Users can rename or extend
  them, like any other property. `people` should be a **relationship to person notes**, keyed by
  doc_id, so renaming "Paul.md" never breaks "all my conversations with Paul".
- **Server parity.** Every contract change lands in both `knowledge.rs` and the server's
  `query_knowledge` in the same PR, with a shared fixture test so the two can't drift.

### Created date needs a source before we promise it

Nothing durable stores a note's creation time today. The SQLite `notes` table has `mtime` only, and
file birthtime is wrong in any synced vault: a note materialized on a new device reports the day it
arrived. Resolution order:

1. frontmatter `created:` if present (user-owned, travels with the file);
2. server `notes.created_at` for synced notes (the registry pull already carries note rows);
3. file birthtime, for local-only vaults, and only as a last resort.

`modified` has a softer version of the same problem: a fresh device's mtimes all reflect
materialization time. Acceptable for sorting, and the docs should say so.

---

## Part 2: dashboards

- **Storage: a note with `noam_kind: dashboard` in frontmatter**, following the Boards precedent
  (`noam_kind: board`, [[BOARDS]]). It is a plain `.md` file, so it syncs, versions, and keeps its
  doc_id. A dashboard is a saved list of `KnowledgeQuery` objects plus a layout.
- **ACL comes free.** A shared dashboard is run by each viewer against their own local index, which
  only holds notes they can read.
- **v1 view types: cards grid and table, rendered by React from query results.** No iframe and no
  user JavaScript. Nothing in v1 needs a sandbox, which removes the riskiest part of the draft.
- **Sandboxed JS views move to Phase E**, behind two prerequisites:
  - the app CSP is `frame-src 'none'` and `script-src 'self'`, and a `srcdoc` frame inherits it, so
    running scripts in a frame means a deliberate CSP change, not a tweak;
  - whether Tauri v2 injects its IPC bridge into subframes varies by platform webview. That needs an
    audit proving a frame cannot reach any Tauri command before anything executes inside one.
  `HtmlView.tsx`'s current `sandbox=""` with no scripts stays the posture until then.
- **Agent-saved dashboards** ("keep this view") are UI-only in v1. The MCP server already has
  `create_note`, so an agent could write a dashboard note later without new plumbing.

Still not v1: arbitrary JavaScript in regular notes, and any third-party widget marketplace.

---

## Part 3: folder gallery

- Per-folder view mode: list or gallery. Clicking a folder can open its gallery directly.
- Cards show the filename stem (the UI's title rule, `noteLabel`), a thumbnail and the modified
  date.
- **Thumbnails come from the index, not per-card rendering.** Rust stores `excerpt` (first
  meaningful paragraph, plain text) and `first_image` (attachment path) at index time. The gallery
  never renders markdown per card.
- **Empty-card state.** Server-only notes stay 0 bytes until they hydrate, so they have no excerpt
  yet. Show a placeholder card, not a broken one.

---

## Part 4: sorting

> **Status ✅ Name/Modified (2026-09-29).** Two deliberate deviations from the bullets below, found
> while building: (1) per-folder overrides are keyed by **path**, not id — a local folder has no id
> other than its path (`TreeNode.id` and the SQLite `folders.id` are both the path; only synced
> vaults have server ids), so keys are remapped on in-app rename/move in `remapTabs` and dropped in
> `pruneTabs`, the same way manual order already works. A folder renamed outside the app loses its
> override. (2) In the Name modes folders follow the name direction (Z–A reverses them too); they
> stay A–Z only in the time modes, which is where the reshuffle problem lives.

Options: Name A–Z, Name Z–A, Modified newest, Modified oldest, Created newest, Created oldest.
Created ships once Part 1 settles its source; the rest can ship now.

- **Folders stay A–Z in every mode.** A folder's mtime moves whenever anything inside it does, so
  sorting folders by time reshuffles the sidebar skeleton on every save. The new modes apply to
  files, like the current "Recently modified" mode does.
- **Manual order stays on top.** `applyOrder` runs after `sortTree`, so a hand-arranged folder keeps
  its arrangement under any sort.
- **Two levels:** the existing global default (`treeSort`), plus a per-folder override.
- **Key the per-folder override by folder id, not path**, or renaming a folder silently drops its
  setting. Store it device-local, like `treeSort`. Sort choice is a reading preference, not vault
  data.

---

## Part 5: find and replace

> **Status ✅ (2026-09-29).** Decision on ⌘F: inside a note editor ⌘F / Ctrl+F opens the note's
> find bubble; anywhere else it opens vault Search; ⌘⇧F / Ctrl+Shift+F always opens vault Search.
> Replace: ⌘⌥F on macOS, Ctrl+H on Windows/Linux (⌘H stays "Hide Noam"). Replace All is one undo
> step in solo and shared notes (tested against a real Yjs UndoManager).

The current editor uses `@codemirror/search`'s default panel, the gray strip at the bottom. Replace
it with a floating bubble in the editor's top-right:

- Build it as a custom `createPanel` passed to `search({ top: true })`, not a new search engine.
- Live match count ("3 of 12"), match case / regex / whole word toggles, Enter and Shift+Enter for
  next and previous, Esc to dismiss and return focus to the editor.
- Highlight every match, with the active match visually distinct.
- Replace and Replace All buttons. Replace All must land as **one transaction**, so in collab mode
  the Yjs undo manager reverts it with a single Cmd+Z.
- **Don't use Cmd+H for replace.** It is "Hide app" on macOS. Use Cmd+Opt+F (Ctrl+H on
  Windows/Linux) plus an expand toggle in the bubble.
- ⌘F is already handled in `App.tsx`'s global key handler (search panel). Decide which one wins
  when the editor has focus, and write it down in the shortcut table.

---

## Part 6: embedded terminal

A terminal inside Noam, so people can run Claude Code, Codex or anything else against the vault
without leaving the app. It fits the product: an AI editing the `.md` files on disk is exactly the
external-writer path the bridge already handles (`handleLocalFileChanged` diff-merges the file into
the CRDT, and whole-file rewrites take a recovery snapshot), so terminal edits reach teammates live.

### Where it lives

It opens in a new **bottom zone** under the center column. It can be dragged into the center tab
strip to become a full tab, or into a side dock.

```
┌──────┬──────────┬──────────────────────────┬──────────┬──────┐
│ Act. │  left    │  center (tabs)           │  right   │ Act. │
│ bar  │  dock    │  [note.md] [Graph] [>_ ] │  dock    │ bar  │
│      │          │  editor                  │          │      │
│      │          ├──────────────────────────┤          │      │
│      │          │  bottom zone   >_ zsh    │          │      │
│      │          │  $ claude                │          │      │
└──────┴──────────┴──────────────────────────┴──────────┴──────┘
```

What already exists and what doesn't:

| Piece | Today | Work |
|---|---|---|
| Drag a tab into the center strip | Exists (`layout/useDockDrag.ts`, `move-tab`) | Register the panel with `"center"` in its allowed zones |
| Resizable splitter | Exists (`PaneSeparator`, horizontal supported) | Reuse |
| Bottom zone | Only `left`, `center`, `right` (`layout/types.ts ZONE_IDS`) | New `"bottom"` zone: grid row in `workspace.css`, `persistence.ts parseZone`, `geometry.ts` height bounds, `useDockDrag targetAt`, and widen `move-tab-to-zone`'s zone type |
| PTY and terminal view | Nothing | Rust PTY manager (`portable-pty`) + xterm.js panel |
| IT kill switch | `managed-policy.json` reads only `autoUpdate` | Add a `terminal` key to `ManagedPolicyFile` |

The bottom zone sits under the center column only, so the side docks keep their full height.
Spanning the window would mean reworking the whole grid.

### Design rules

- **Rust owns the process, not the tab.** Each PTY lives in a Rust session manager under a session
  id stored in the panel's state, with a bounded scrollback buffer. Moving the tab from the bottom
  zone to the center may remount the React component; the xterm view reattaches by session id and
  replays scrollback. Dragging a tab must never kill a running Claude Code session.
- **Login shell.** A GUI app doesn't inherit the user's shell PATH (macOS especially), so spawning
  `$SHELL` plainly leaves `claude` and `codex` unfound. Spawn the user's login shell (`$SHELL -l`,
  PowerShell/ConPTY on Windows).
- **Working directory is the vault root.**
- **Only the main window can spawn.** The PTY commands take no input from notes, dashboards, frames
  or MCP. A shell starts only because a person clicked or pressed the shortcut. This shares the IPC
  audit with Phase E's sandboxed views.
- **No auto-respawn.** The layout persists to localStorage, so a terminal tab survives a relaunch,
  but its shell doesn't. The tab shows "Session ended" with a Restart button. Noam never starts a
  shell at launch on its own.
- **Several terminals.** Each terminal is its own panel instance. Closing a tab kills its process;
  switching vaults or quitting kills all of them.
- **Keyboard passthrough.** `App.tsx`'s global handler takes ⌘F, ⌘G, ⌘N, ⌘R and others. While a
  terminal has focus, those keys go to the terminal (vim and Claude Code rely on them), except the
  terminal toggle itself.
- **Toggle shortcut: Ctrl+`.** It's the familiar one from VS Code. ⌘` is already macOS window
  cycling.
- **Managed policy.** `managed-policy.json` gains `{ "terminal": { "enabled": false } }`. With it
  set, the panel type doesn't register and the Rust commands refuse.

### Guarding `.context/`

An agent in the terminal can read and write anything the user can, including `.context/`
(`index.sqlite`, the CRDT store, `config.json`). Existing safety nets help: the disk-delete path's
bulk cap (`max(5, ceil(mapped * 0.2))`) and trash copies catch a mass delete, and a 0-byte file
never clears a populated doc. On top of that, Noam offers to write a vault-root `AGENTS.md` (and a
`CLAUDE.md` pointing at it) that tells coding agents never to touch `.context/`. It offers the file
rather than writing it silently, because it's a visible file in the user's vault.

### Terminal build steps

- **T1 ✅:** Rust PTY manager + xterm panel, allowed in the center and right zones. Usable as a full tab
  from day one, before any layout work. Shipped with the main-window check, the managed-policy key,
  keyboard passthrough (`lib/terminal/keys.ts`) and Ctrl+` / Ctrl+Shift+` pulled forward from T2/T3.
- **T2 ✅:** the bottom zone in the layout system, and the Ctrl+` toggle. `"bottom"` is a fourth
  `ZoneId` under the center column only (side docks keep full height), splits side by side only,
  and stays mounted while collapsed so a hidden terminal keeps running. Layouts saved before it
  existed still load (an empty bottom zone is filled in). New terminals open there; Ctrl+` from
  inside the bottom terminal hides the dock, anywhere else it shows one. The header's chevron hides
  without closing. A terminal only refits while really on screen, so hiding the dock never resizes
  the shell.
- **T3 ✅:** managed-policy key and keyboard passthrough (shipped with T1), and the `AGENTS.md`
  offer (`lib/terminal/agentGuide.ts`): a banner above a running terminal when the vault root has
  no `AGENTS.md`, with Add it / Not now / Don't ask again (per vault, device-local). Add it writes
  create-only via `write_note_if_missing`, so an existing file is never touched, and the watcher
  syncs the new note like any external write. It also adds a one-line `CLAUDE.md` importing
  `@AGENTS.md` when the vault has none; a user's own `CLAUDE.md` is left alone with a toast saying
  which line to add. No offer in a vault whose root is frozen.

---

## Build order

```
Phase A   quick wins, independent of each other
          ├─ sorting (everything but Created)
          ├─ find/replace bubble
          └─ terminal T1 (PTY + xterm as a tab)

Phase B   extend NoteKnowledge
          ├─ sort + system props (created, modified), created-date source decided
          ├─ seed type / people in the catalog
          ├─ server query_knowledge parity
          └─ Created sort options go live

Phase C   folder gallery (reads Phase B; thumbnails from the index)
          terminal T2 (bottom zone) + T3

Phase D   dashboards v1: noam_kind: dashboard, React cards/table, no frame JS

Phase E   sandboxed JS views, after the CSP change and the Tauri subframe IPC audit
```

Sorting, find/replace and the terminal don't depend on the query layer, so they don't wait for it.

---

## Open questions

1. **Created date:** is frontmatter `created:` written automatically on note creation (new notes
   are created empty today, `notefile.rs create_note`), or only read when present?
2. **Per-folder sort:** device-local (proposed) or synced in `.context/config.json`?
3. **Terminal scrollback:** how much does Rust keep per session, and does it survive only moves or
   also a window reload?
4. **Graph as a dashboard view type:** reuse the existing canvas graph with a query as its node
   filter, or keep graph separate?
5. ~~**`AGENTS.md` offer:** on first terminal open, or as a vault setting?~~ Decided: on a running
   terminal, once per vault per session, with a device-local "Don't ask again".

See [[STATUS]] for build progress once any of this starts.
