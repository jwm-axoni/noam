---
type: spec
spec: requirements
product: Noam
status: draft-v1
date: 2026-07-13
tags: [thread, spec, requirements, features, mvp]
---

# Requirements & Feature Map

The canonical list of what Noam must do, and where each requirement is satisfied. This
is the yardstick every other spec answers to. Source: the 12 hard requirements from the market scan.
Index: [[Noam]].

> [!important] Why these 12
> The scan evaluated 41 OSS apps against these exact 12 requirements and **none passed all 12**. That
> failure is the reason this product exists. So the requirements aren't aspirational — they are the
> precise gap we are building to fill. If a spec ever contradicts one of these, the spec is wrong.

---

## The 12 core requirements

| # | Requirement | What it means for us | Spec | MVP phase |
|---|---|---|---|---|
| 1 | **Desktop app** | Cross-platform macOS/Windows/Linux native app. | [[01-desktop-app]] | **Phase 0** |
| 2 | **User management** | Signup / accounts / login / sessions. | [[04-team-collaboration]] | Phase 2 (accounts) → 3 |
| 3 | **Markdown `.md` + Obsidian-style folder tree** | Plain `.md` files on disk, browsable as a folder tree. | [[01-desktop-app]], [[02-database-architecture]] | **Phase 0** |
| 4 | **Real-time change reflection** | External/AI edits appear instantly; teammate edits appear live. | [[03-sync-engine]] | Phase 1 (local, via watcher+bridge) → 2/3 (across clients) |
| 5 | **Folder/file sharing between members** | Share a folder or file with specific teammates. | [[04-team-collaboration]] | Phase 3 |
| 6 | **Local-first (local copy + cloud sync)** | Full local vault that works offline; cloud sync layered on. | [[02-database-architecture]], [[03-sync-engine]] | Phase 0 (local) → 2 (sync) |
| 7 | **AI-editable plain files** | Any AI can edit the actual `.md` on disk and it flows everywhere. | [[02-database-architecture]] §6, [[01-desktop-app]] §6 | **Phase 0** (free — files are plain md) |
| 8 | **iOS app** | Native iPhone/iPad client. | [[01-desktop-app]] §7 | Phase 4 (deferred; Tauri 2 same core) |
| 9 | **Model-agnostic AI (any LLM / BYOK)** | Not locked to one provider; bring-your-own-key. | see "AI approach" below | Phase 0 (file-level) → later panel |
| 10 | **Nested hierarchy** | Arbitrarily deep folders. | [[01-desktop-app]], [[02-database-architecture]] (`parent_id`) | **Phase 0** |
| 11 | **Built-in Relay-style collaboration (not a plugin)** | CRDT collab is a first-class part of the app, not an add-on. | [[03-sync-engine]] | Phase 2/3 |
| 12 | **Genuinely open source** | (Evaluation criterion for *adopting* OSS.) For *our own* build this is a **business decision**, not a technical constraint — see note below. | — | N/A (business) |

### Requirement #9 — the AI approach (called out because there's no separate AI spec)

"Model-agnostic AI" is satisfied structurally, not by a feature: because notes are **plain `.md` on
disk**, any LLM — via MCP filesystem tools, a BYOK API call, Claude Code, Codex, anything — edits the
real file, and the file→CRDT bridge ([[03-sync-engine]] §5) carries the edit into the index and to
collaborators. There is **no MVP work** to be "AI-editable with any model"; it falls out of the file
being the source of truth. A dedicated in-app AI panel (chat, inline edits, model picker, BYOK key
management) is a later UI layer, not an MVP dependency.

### Requirement #12 — the "open source" nuance

In the scan, "genuinely open source" was a hard requirement because the question was *can we adopt or
fork someone else's tool*. We are now **building our own product to sell** (Noam), so
whether *our* code is open source is a go-to-market decision (open-core, source-available, or closed),
not an engineering requirement. Flagged here so it isn't silently dropped — decide it deliberately at
launch. It does not affect any of the four technical specs.

---

## Supporting features (Obsidian-parity, derived — not in the 12 but expected)

These make it feel like a real second brain rather than a text editor. Most are cheap once the SQLite
index exists.

| Feature | Spec | MVP phase |
|---|---|---|
| Full-text search (FTS5) | [[02-database-architecture]] §3 | Phase 0 |
| `[[wiki-links]]` + backlinks | [[02-database-architecture]] §3, [[01-desktop-app]] §4 | Phase 0 (fast-follow) |
| Tags (`#tag` + frontmatter) | [[02-database-architecture]] §3 | Phase 0 |
| Live-preview rendering (CM6 decorations) | [[01-desktop-app]] §4 | Phase 0 (fast-follow) |
| New/rename/delete note & folder | [[01-desktop-app]] §3 | Phase 0 |
| Attachments (images/pdfs) | [[02-database-architecture]] §5 | Phase 3 (blob store) |
| Presence / live cursors | [[04-team-collaboration]] §5 | Phase 3 |

Deferred to Phase 4: graph view, WYSIWYG block editing, semantic/vector search, comments/mentions,
version history, publishing.

---

## What ships in the MVP (requirement cut)

**In the MVP (Phases 0–3):** requirements **1, 2, 3, 4, 5, 6, 7, 9, 10, 11** — i.e. *ten of the
twelve*. That is already more than any tool in the 41-app scan achieved, because it includes the two
that no OSS tool combined: **#7 AI-editable plain files** *and* **#11 built-in real-time collab**.

**Deferred past the MVP:** **#8 iOS** (Phase 4 — real, but its own milestone; the MVP only commits to
keeping the Rust core UI-agnostic so iOS stays cheap later) and **#12 open source** (a launch/business
decision, not a build task).

**The MVP's defining claim:** a single-user, local, AI-editable `.md` vault ships in **Phase 0** with
no server at all — and the collaboration that every competitor treats as the hard part is layered on
top in Phases 1–3 without ever giving up the plain files. That ordering is the whole strategy: we
never trade requirement #7 to get requirement #11, which is exactly the trade every existing tool was
forced to make.

---

## Traceability rule

Every future feature or spec change must map to a requirement here (or explicitly add one). If work
doesn't trace to a requirement, question whether it belongs in the MVP. Keep this table in sync with
[[STATUS]] as phases land.
