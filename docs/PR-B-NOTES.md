# PR B — Source / Live Preview / Reading modes

## What changed

- `app/apps/desktop/src/lib/editor/viewMode.ts` defines the three-mode facet,
  Reading predicate, and shared cycle order.
- `app/apps/desktop/src/lib/editor/index.ts` separates the presentation extension
  set from the stable editor/Y.Text configuration. Source installs no Markdown
  replacement widgets or marker hiding; Live and Reading install the existing
  Live Preview presentation; Reading also installs read-only/editability facets
  and the `.cm-reading` attribute. Initial CodeMirror `Text` construction now
  preserves CR bytes in CRLF buffers instead of normalizing them.
- `app/apps/desktop/src/lib/editor/reveal.ts`, `livePreview.ts`, `tasks.ts`, and
  `frontmatter.ts` suppress caret-driven reveal in Reading and keep focus state
  stable across mode reconfiguration. Source forces frontmatter to literal,
  dimmed YAML with visible fences, and the Properties panel remains the sole
  frontmatter presentation authority.
- `app/apps/desktop/src/lib/editor/noteHeader.ts` rebuilds header/frontmatter
  decorations when the view-mode facet changes.
- `app/apps/desktop/src/lib/editor/theme.ts` hides only the local caret and any
  active-line fill in Reading; remote cursor layers are unaffected.
- `app/apps/desktop/src/lib/editor/formatting.ts` releases the old inline-code
  `⌘E` binding so the mode shortcut cannot edit bytes before switching modes.
- `app/apps/desktop/src/components/Editor.tsx` owns a fourth Compartment for the
  view mode. Mode changes reconfigure presentation and editability on the same
  `EditorView`; the Y.Text/yCollab binding, awareness activity listener, remote
  cursors, and UndoManager stay mounted. A mode change never invokes rollback or
  focuses the editor.
- `app/apps/desktop/src/lib/prefs.ts` adds the device-local Live Preview default
  and the three settings options.
- `app/apps/desktop/src/store.ts` adds the effective/default modes and a
  vault-scoped, session-only override map keyed by open-note path. Overrides
  follow renames and are pruned with their tabs.
- `app/apps/desktop/src/App.tsx` and `App.css` add the Live / Source / Reading
  header control and the `⌘E` cycle.
- `app/apps/desktop/src/components/AccountSettings.tsx` adds the Appearance
  default-mode select beside Properties in document.
- `app/apps/desktop/src/lib/editor/viewMode.test.ts`,
  `src/lib/__tests__/prefs.test.ts`, `src/__tests__/tabStore.test.ts`, and
  `src/lib/bridge/__tests__/fidelity.test.ts` cover facets/reveal, Source widget
  absence, Reading checkbox refusal, preferences, per-note overrides, same-view
  reconfiguration, all-mode corpus fidelity, and zero-write bridge behaviour.

## Mode-switch mechanism

The editor is constructed once for an open Markdown note. A CodeMirror
`Compartment` contains only the current presentation mode and its presentation
extensions; switching modes dispatches `Compartment.reconfigure` to that same
view. A separate existing editability compartment combines access locks with
`mode === "reading"`. Neither path replaces document state or creates a second
Y.Text-bound view.

## Test results

- `node_modules/.bin/tsc --noEmit -p tsconfig.json` in
  `app/apps/desktop`: passed.
- `node_modules/.bin/vitest run` in `app/apps/desktop`: passed — 121 files
  passed, 2 skipped; 1,400 tests passed, 12 skipped, 1 existing todo.
- `cargo check` in `app/apps/desktop/src-tauri` (the repository's actual Rust
  crate; `app/` has no `Cargo.toml`): passed.
- Full `cargo test`: compilation passed and 127 tests passed, but four existing
  `oauth::tests::*` cases cannot bind `127.0.0.1:0` in this restricted sandbox
  (`Operation not permitted` at `src/oauth.rs:293`). The failure reproduced in
  an isolated OAuth test. `cargo test -- --skip oauth::tests` passed: 127 unit
  tests passed, 1 ignored, 4 filtered; the disk integration test passed; the
  benchmark remained ignored. No Rust files changed.

## Recorded follow-ups

- Re-run the four OAuth loopback-listener tests in an environment that permits
  local socket binds.
- Callout fold markers.
- Ordered-list marker rendering.
- Tag click to search.
- `[[note#heading` completion.
- CodeMirror search-panel styling.
- Rename-time link rewriting.
