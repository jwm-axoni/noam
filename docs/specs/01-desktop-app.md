---
type: spec
spec: 01-desktop-app
product: Noam
status: draft-v1
date: 2026-07-13
tags: [thread, spec, desktop, tauri, codemirror]
---

# 01 · Desktop App

The client shell: what the user runs. Cross-platform desktop (macOS/Windows/Linux) today, iOS from
the same core later. Overview: [[00-architecture-overview]]. Index: [[Noam]].

---

## 1. Decisions

| Concern | Choice | Reasoning |
|---|---|---|
| Shell | **Tauri v2** (Rust core) | ~5–10 MB bundle & ~30–40 MB idle vs Electron's ~150 MB / ~250 MB; **native iOS + Android from the same Rust core** (stable since Oct 2024) — a hard requirement Electron cannot meet; deny-by-default filesystem security. |
| UI framework | **React + Vite + TypeScript** | Ecosystem gravity — every editor binding, Yjs provider, and tree component we need is React-first. Vite SPA, not Next.js (no SSR needed). |
| Editor | **CodeMirror 6** + `@codemirror/lang-markdown` | The editor buffer *is* the markdown text — zero serialize/deserialize, so files round-trip losslessly and an AI editing the file produces exactly what the editor shows. Binds to `Y.Text` via `y-codemirror.next`. |
| File tree | **react-arborist** (virtualized) | Purpose-built file explorer: virtualization, drag-and-drop, inline rename, keyboard nav out of the box. |
| Filesystem | **Rust** `std::fs`/`tokio::fs` in Tauri commands + a debounced watcher (`notify` crate) | Rust owns disk. `@tauri-apps/plugin-fs` used only for the folder-picker dialog and runtime scope grant. |
| State (UI) | Zustand (or React context) | Lightweight; UI holds *view* state only, never the file system as truth. |

**Why not Electron:** no mobile story (we'd rewrite for iOS), 15–25× the bundle, 5–7× idle memory,
and full Node access by default. The only Electron win is a slightly gentler ramp (no Rust). Our
Rust surface is tiny and bounded (~5 commands + a watcher), so that cost is acceptable.

**Why CodeMirror 6 over TipTap/ProseMirror/Lexical:** those make a **JSON doc** canonical and treat
markdown as a lossy export target — every custom node needs a correct serializer or data is silently
lost on save. That directly fights "plain `.md` is sacred." CM6 keeps CRDT state, editor state, and
file bytes conceptually identical. Obsidian and Logseq both use CM6. Trade-off: block-drag/slash-menu
WYSIWYG is more work in CM6 — acceptable, because we are Obsidian-shaped, not Notion-shaped. Revisit
TipTap only if the product pivots to a block editor (Phase 4).

## 2. Architecture: Rust core / thin UI

The universal pattern across Obsidian, Logseq, AppFlowy, and Noteriv: **a native core owns the
filesystem; the web UI never touches disk and communicates through typed commands + events.** We
adopt it wholesale.

```
┌──────────────────────── React UI (WebView) ────────────────────────┐
│  Sidebar (react-arborist)   Editor (CodeMirror 6)   Command palette │
│         │  invoke()                │ invoke()               ▲        │
│         ▼                          ▼                        │ listen │
├─────────────────────────── Tauri IPC boundary ─────────────────────┤
│         │                          │                        │        │
│  ┌──────▼──────────────────────────▼────────────────────────┴─────┐ │
│  │                       Rust core (commands)                      │ │
│  │  pick_vault · list_tree · read_note · write_note · watcher      │ │
│  │  (Phase 1+) crdt bridge · sqlite index · sync client            │ │
│  │  std::fs / tokio::fs / notify                                    │ │
│  └──────────────────────────────┬──────────────────────────────────┘ │
└─────────────────────────────────┼────────────────────────────────────┘
                                   ▼
                          Vault folder of .md files (source of truth)
```

## 3. The Rust command surface (Phase 0 — the whole disk API)

Five commands + one event channel. This is the entire MVP backend.

| Command | Signature | Does |
|---|---|---|
| `pick_vault()` | → `VaultPath` | Native folder dialog; **extend the fs scope to that path at runtime** so the app may read/write it. |
| `list_tree(vault)` | → `TreeNode` (nested JSON) | Recursive `std::fs` walk; skips dotfolders and the `.context/` app dir; returns the folder/file tree. |
| `read_note(path)` | → `String` | Read a `.md` file to a string. |
| `write_note(path, content)` | → `()` | Atomic write (temp file + rename). This is "save." |
| `start_watcher(vault)` | → stream | Debounced `notify` watcher; emits `file-changed { path, kind }` events to the UI. |

Fast follows (still Phase 0): `create_note`, `create_folder`, `rename_path`, `delete_path`
(rename/delete are metadata ops keyed to the note's stable id where an index exists — see
[[02-database-architecture]]).

**Events → UI:** `file-changed` (refresh tree / reload open note), `vault-opened`. All file mutations
originate in Rust; the UI reacts.

## 4. Editor UX

- **Note load:** select in tree → `read_note` → set CodeMirror doc. **Debounced autosave**
  (~500 ms idle) → `write_note`. (Copy Noteriv's interval autosave loop.)
- **External-edit reload (Phase 0):** on `file-changed` for the open note, if the buffer is clean,
  reload; if dirty, reconcile (Phase 1 makes this seamless via the CRDT — no reload prompt).
- **Live-preview feel:** CM6 decorations that hide/style markdown tokens on inactive lines (how
  Obsidian gets its look without leaving plain text). Ship raw markdown first; add decorations next.
- **`[[wiki-links]]`:** autocomplete + click-to-navigate, resolved against the index (Phase 0 fast
  follow).
- **Undo/redo:** CM6 history in Phase 0; swap to Yjs `UndoManager` (local-change scoped) in Phase 1.

## 5. File-tree UI

- Rust `list_tree` returns the nested structure; the watcher keeps it live.
- Render with **react-arborist**: virtualize from day one (a real vault has thousands of notes —
  flatten to a visible-node list and virtualize that).
- Drag-and-drop move, inline rename, right-click new/delete → map to the Rust mutation commands.
- Respect an ignore list (`.git`, dotfolders, `.context/`).

## 6. Collaboration & AI hooks (where later phases attach)

- **Phase 1:** wrap the CM6 doc in a `Y.Text` via `y-codemirror.next`; the editor becomes the
  editor-origin producer for the bridge. Nothing else in the UI changes. See [[03-sync-engine]].
- **Phase 3:** awareness renders remote cursors + "who's here" avatars automatically through the
  editor binding. See [[04-team-collaboration]].
- **AI:** requires **no special editor work**. Because notes are plain `.md`, any BYOK LLM (via MCP
  filesystem tools or our own agent) edits the file; the watcher → bridge reflects it into the editor
  and to collaborators. A chat/inline-AI panel is a later UI layer, not an MVP dependency.

## 7. Mobile (deferred, but shapes one rule now)

Tauri 2 ships iOS/Android from the same Rust core. The only thing MVP must do to stay iOS-ready:
**keep the Rust core UI-agnostic** (no desktop-only assumptions in commands). iOS is its own
milestone (Phase 4); Noteriv's Expo companion is the interim reference if we want a phone client
sooner.

## 8. OSS references (study patterns, write our own code)

- **Noteriv** (`github.com/thejacedev/Noteriv`, MIT) — **the primary blueprint**: Tauri 2 + React +
  CM6 + Rust `std::fs` + `watcher.rs` + vault-folder model + autosave + optional Yjs. Take the whole
  skeleton and the Rust command shape.
- **AppFlowy** — the Rust-core / thin-UI discipline; a small, typed command/event API across the
  boundary (we don't need its Protobuf at MVP, just the principle).
- **Obsidian / Logseq** — the "vault = folder of files, links resolved at runtime" mental model;
  both use CodeMirror; confirms "files as truth, DB as derived index."
- **Notebook Navigator plugin** (`github.com/johansan/notebook-navigator`) — TanStack-Virtual tree
  reference if react-arborist's opinions get in the way at scale.

## 9. Phase 0 build order (the MVP core)

1. `create-tauri-app` (React/TS/Vite). Verify a macOS build first.
2. Implement the 5 Rust commands + `file-changed` event.
3. react-arborist sidebar fed by `list_tree`, refreshed on events.
4. CodeMirror 6 editor; select → `read_note`; debounced autosave → `write_note`.
5. External-edit reload on `file-changed`.
6. Wire it end-to-end and verify: **open a vault → edit a note → the `.md` on disk changes → an edit
   made in an external editor appears in-app.** That's a shippable local Obsidian-lite.

Then fast-follow: new/rename/delete, live-preview decorations, `[[wiki-links]]`, search (backed by
the SQLite index from [[02-database-architecture]]).

**Defer:** Yjs/collab (Phase 1), any cloud sync (Phase 2), SQLite (add when plain-file scan gets
slow — but we bring it into Phase 0 for search/backlinks), AI chat UI, iOS.
