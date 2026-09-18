---
type: spec
spec: 00-architecture-overview
product: Noam
status: draft-v1
date: 2026-07-13
tags: [thread, spec, architecture]
---

# 00 · Architecture Overview

The system-level view: how the four pillars fit, the one hard problem they all revolve around (the
markdown↔CRDT bridge), the end-to-end data flow, and the principles every pillar must obey.

Requirements this answers to: [[REQUIREMENTS]]. Pillar specs: [[01-desktop-app]] · [[02-database-architecture]] · [[03-sync-engine]] · [[04-team-collaboration]]. Index: [[Noam]].

---

## 1. What we're building, in one sentence

A local-first desktop app where a team's notes are **plain `.md` files on disk** that an AI can edit
directly, **and** that teammates edit together in real time — reconciled by a bidirectional bridge
between the files and a Yjs CRDT.

## 2. The single hard problem

Everything non-trivial in this product is one problem: **keeping a plain markdown file and a CRDT
document equal, in both directions, without loops or data loss.** The market scan proved no existing
tool solves both sides — file-first tools have no real collaboration, collab-first tools bury notes
in binary blobs. We solve it explicitly and treat it as the core of the product.

**Resolution.** Two sources of truth with defined roles:

- **`.md` file = durable truth.** It is the artifact the user opens, the AI edits, git commits. If
  every server and CRDT vanished, the vault is intact and complete.
- **Yjs `Y.Text` (raw markdown string) = live truth.** While a note is open or syncing, the CRDT is
  the authority that merges concurrent edits. It persists locally and syncs to peers.
- **The bridge keeps them convergent.** Neither "wins"; they are continuously reconciled.

We use `Y.Text` holding the *raw markdown bytes* — not a structural rich-text CRDT — for the MVP.
That choice is what makes "AI edits a real file" trivially correct: the CRDT literally *is* the
markdown, so the round-trip is lossless. (Structural `Y.XmlFragment`/WYSIWYG is a Phase-4 upgrade
that reintroduces lossy serialization; we defer it deliberately.)

## 3. The four pillars

| Pillar | Owns | Spec |
|---|---|---|
| **Desktop app** | The Tauri 2 shell, React UI, CodeMirror 6 editor, file tree, and the Rust command surface that owns disk I/O and the file watcher. | [[01-desktop-app]] |
| **Database architecture** | On-disk vault layout, the local SQLite index (search/backlinks/tags), local CRDT persistence, and the server's Postgres + binary Yjs stores. | [[02-database-architecture]] |
| **Sync engine** | Yjs, the Hocuspocus server, the sync protocol, and — critically — the file↔CRDT bridge algorithm with loop avoidance. | [[03-sync-engine]] |
| **Team collaboration** | Better Auth accounts + organizations, the folder ACL, how permissions gate which docs a client may sync, and presence. | [[04-team-collaboration]] |

They connect through two join keys that every pillar shares:

- **`doc_id`** — a stable per-note identity. The `.md` file, the Yjs document, the SQLite index row,
  and the Postgres `notes`/`file` row all reference the same `doc_id`. **We key everything by
  `doc_id`, never by path**, so a rename or move never forks a note.
- **the session** — Better Auth issues a session; the session mints short-lived per-doc sync tokens;
  Hocuspocus enforces them. Identity and access flow through this one chokepoint.

## 4. End-to-end data flow

```
   ┌──────────────────── CLIENT A · Tauri 2 (Rust core + React UI) ────────────────────┐
   │                                                                                    │
   │   AI agent (MCP / BYOK)          CodeMirror 6 editor        react-arborist tree     │
   │        │ writes .md                   │ keystrokes                 ▲                │
   │        ▼                              ▼                            │ list_tree      │
   │   ┌─────────┐   watcher(diff)   ┌──────────────┐   y-codemirror    │                │
   │   │ .md file│ ───────────────▶ │  Yjs  Y.Text  │◀──────────────────┘                │
   │   │ DURABLE │ ◀─────────────── │  LIVE truth   │  undo/redo (UndoManager)            │
   │   │  truth  │  serialize+hash   └──────┬───────┘                                     │
   │   └────┬────┘                          │ update event                               │
   │        │ parse (links/tags)            ├──▶ persist Yjs updates → SQLite             │
   │        ▼                               │                                            │
   │   ┌──────────────┐                     │                                            │
   │   │ index.sqlite │  FTS5 · links · tags·│ note-id↔path map                          │
   │   └──────────────┘                     │ binary Yjs update                          │
   └────────────────────────────────────────┼───────────────────────────────────────────┘
                                             │  WebSocket (@hocuspocus/provider) + JWT
                                             ▼
                        ┌─────────────────────────────────────────────┐
                        │        SYNC + APP SERVER (Node / TS)          │
                        │  ┌───────────────┐   ┌─────────────────────┐ │
                        │  │  Hocuspocus   │   │   Better Auth        │ │
                        │  │ onAuthenticate│   │  users/orgs/members  │ │
                        │  │  + readOnly   │   │  invitations/session │ │
                        │  └──────┬────────┘   └─────────────────────┘ │
                        │         │ persists          Postgres          │
                        │  ┌──────▼───────────────────────────────────┐ │
                        │  │ doc_updates (append log, binary Y.Doc)    │ │
                        │  │ doc_snapshots (compacted)                 │ │
                        │  │ folders / files / shares (ACL)            │ │
                        │  │ blobs (attachments → S3/R2)               │ │
                        │  └───────────────────────────────────────────┘ │
                        └───────────────────────┬─────────────────────────┘
                                                │ relays binary updates
                                                │ (only to authorized clients)
                                                ▼
                     ┌──────────────── CLIENT B (teammate) ────────────────┐
                     │  Yjs Y.Text ─serialize▶ .md file  +  index.sqlite    │
                     │  awareness ▶ live cursors of A                       │
                     └──────────────────────────────────────────────────────┘
```

Read the diagram as: **the file and the CRDT are peers on each client; the server only ever moves
opaque binary Yjs updates between clients that permissions allow.** Markdown never travels over the
wire — only CRDT updates do. Each client re-derives its own `.md` files and its own SQLite index.

## 5. How a single edit propagates (worked example)

1. Teammate A types in CodeMirror. `y-codemirror.next` applies the change to `Y.Text` with
   `origin = 'editor'`.
2. The Yjs update is (a) persisted to A's local SQLite and (b) sent to Hocuspocus.
3. A's CRDT→file observer (debounced) serializes `Y.Text`, records `lastWrittenHash`, and atomically
   writes A's `.md`. A's watcher sees the write, hashes it, matches `lastWrittenHash`, drops it → no
   loop. A's index re-parses the note for links/tags/FTS.
4. Hocuspocus appends the update to `doc_updates`, then relays it to every other authorized client
   subscribed to that `doc_id`.
5. Teammate B's provider receives the update with `origin = 'remote'`, applies it to B's `Y.Text`.
   B's editor updates live; A's cursor shows via awareness. B's CRDT→file observer writes B's `.md`;
   B's index re-parses. B's watcher drops the echo.
6. If an **AI** had instead edited A's `.md` on disk: A's watcher fires, diffs old-vs-new, applies
   the delta to `Y.Text` with `origin = 'disk'` → identical propagation from step 2 onward. The AI
   needs no special API; the bridge carries it into collaboration.

## 6. The bridge, stated precisely (full algorithm in [[03-sync-engine]])

- **file → CRDT (ingest):** watcher fires → debounce → read file → if `hash == lastWrittenHash`
  **drop** (our own echo) → else `diff-match-patch(currentYText, fileText)` → replay patches as
  `Y.Text.insert/delete` inside `doc.transact(fn, 'disk')`.
- **CRDT → file (egest):** `Y.Text.observe` → if `origin == 'disk'` **drop** → else debounce →
  serialize → set `lastWrittenHash = hash(content)` **before** writing → atomic write (temp+rename).

Two guards make it safe: **origin tags** (never react to a change you caused) and the
**`lastWrittenHash`** (the watcher ignores the exact bytes it just produced). Concurrent edits are
safe because everything becomes commutative CRDT ops — we never blindly overwrite `Y.Text` from a
file. Startup rule: **pull from server first, then seed orphan docs from local markdown** (reversing
this causes permanent divergence).

## 7. Cross-cutting principles (binding on all pillars)

1. **Files are the source of truth.** Any DB, index, or CRDT store is derived and rebuildable from
   the `.md` files. Never put note bodies only in a DB (the mistake Joplin/AppFlowy made).
2. **Key by `doc_id`, never by path.** Renames/moves are metadata ops on a stable id.
3. **Rust owns disk; UI is stateless about files.** The React layer calls typed commands and reacts
   to events; it never reads/writes files itself.
4. **The server stores binary Y.Doc only** — never parsed JSON/markdown rebuilt into a doc (that
   duplicates updates on reconnect).
5. **Permissions gate sync at the socket.** A user cannot open a connection to a `doc_id` they were
   not granted; read-only grants issue read-only tokens. Revocation is minutes (or instant on kick).
6. **Each phase is independently useful** and does not require the next. Phase 0 ships without any
   server or CRDT.
7. **Reuse patterns, own the code.** Study the OSS references named in each spec; implement ourselves.

## 8. MVP sequencing (summary; live checklist in [[STATUS]])

- **Phase 0** — single-user local app: files + tree + editor + SQLite index. No CRDT, no server.
- **Phase 1** — local CRDT bridge: `Y.Text` per note + the bidirectional bridge, tested hard.
- **Phase 2** — sync server: Hocuspocus + Postgres + Better Auth; multi-device for one user.
- **Phase 3** — team collaboration: orgs, folder ACL gating sync, presence.
- **Phase 4** — deferred polish: WYSIWYG CRDT, vector search, AI-as-peer, encryption, iOS.

## 9. Technology summary

| Concern | MVP choice | Alternative / later |
|---|---|---|
| Desktop shell | Tauri v2 (Rust) | Electron (rejected: no mobile, 15× size) |
| UI / editor | React + Vite + CodeMirror 6 | TipTap/ProseMirror only if WYSIWYG becomes core |
| CRDT | Yjs (`Y.Text`-of-markdown) | Loro (size), structural `Y.XmlFragment` (WYSIWYG) |
| Sync server | Hocuspocus + Postgres | y-sweet (S3, Rust — what Relay forked) |
| Local stores | `.md` files + SQLite (FTS5) + Yjs updates | libSQL (encryption/Turso) later |
| Auth + teams | Better Auth (org plugin) + argon2id + sessions | Supabase Auth (if buying the platform) |
| Permissions | folder ACL, additive, highest-wins → per-doc tokens | teams/groups, file-level overrides later |
| Presence | Yjs awareness | follow-mode, cursor chat later |
