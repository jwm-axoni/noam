---
type: reference
product: Noam
date: 2026-08-07
tags: [thread, design, ux, interactions]
---

# Interaction inventory & feedback rules

> Every action the desktop app can take, how long it takes, and what it shows
> while it does. Back to index: [[Noam]].

Two things live here: the **rules** (how any asynchronous action reports for
itself) and the **inventory** (every action, audited against those rules). If you
add a control, add it to the table.

---

## The rules

Derived from the response-time thresholds people actually perceive
([Nielsen's three limits](https://www.nngroup.com/articles/response-times-3-important-limits/),
still the basis of modern guidance) and from Dan Saffer's
[four parts of a microinteraction](https://www.oreilly.com/library/view/microinteractions-full-color/9781491945926/)
— **trigger, rules, feedback, loops**. Features get people to the product;
details are why they stay.

1. **Acknowledge the trigger in the same frame.** Every button has a physical
   press state (`:active`). This is free, needs no state, and it is what makes a
   slow action feel *responsive* rather than *ignored* — the two are different
   properties and only the second is a bug.
2. **Label the wait only after ~140ms** (`SPINNER_DELAY` in
   `lib/useAsyncAction.ts`). Under ~100ms an action already feels instantaneous;
   a spinner that appears immediately flashes on and off and reads as a
   rendering fault. Actions that are usually fast therefore stay visually silent
   and only grow an indicator when they genuinely stall.
3. **Disable on the first click, not on the first spinner.** `useAsyncAction`
   keeps `pending` (true immediately, for the re-entrancy guard) separate from
   `showPending` (true after the delay, for rendering). Conflating them
   double-submits.
4. **Never change size mid-action.** A spinner sits *beside* a label whose width
   is already reserved. A control that grows under the cursor pulls a different
   control into the click.
5. **Optimism where the destination is known.** A vault switch renames the
   sidebar to the target vault immediately; clicking a note selects its row
   immediately. Showing the *old* state until the last round trip is what makes
   a working action look broken. If it fails, the state snaps back.
6. **Hold success long enough to be seen** (`DONE_HOLD`, 900ms). A tick that
   vanishes with the spinner was never feedback.
7. **Errors do not auto-dismiss.** A failure the user blinked past becomes
   "nothing happened" in a bug report. Successes and neutrals fade on their own.
8. **Every animation has a reduced-motion answer**, and the information survives
   the motion being switched off. Spinners *slow* rather than stop — a frozen
   ring says "hung", which is the one thing it must never say.

### Which surface

| Surface | For | Persistence |
| --- | --- | --- |
| Press state | acknowledging a click | instant |
| In-control spinner | this control is working | until it settles |
| Skeleton | content is arriving, roughly this shape | until content lands |
| Toast (`lib/toast.ts`) | an outcome you may miss twice | ~4.2s; errors sticky |
| Banner (`App.tsx`) | something needing a decision | until dismissed/resolved |
| Progress bar | a determinate transfer | until complete |

---

## Inventory

**Latency** is the realistic worst case, not the best. ✅ = reports for itself;
n/a = synchronous or sub-100ms by construction.

### Welcome screen — `components/VaultPicker.tsx`

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| New vault | read vaults root | fast | n/a |
| Create vault | mkdir + open + seed ~20 notes | 1–3s | ✅ label + spinner |
| Open existing | native picker → open + reconcile | 1–5s | ✅ label + spinner |
| Recent vault row | full vault open (+ switch if remote) | 1–5s | ✅ per-row spinner, "Opening…" |
| Remove from recents | local list write | fast | n/a (row leaves) |
| Sign in (link) | opens the modal | instant | n/a |
| *post-sign-in landing* | resolve/create vault, folder, seed | 1–5s | ✅ "Opening your vault…" |

### Auth — `components/AccountMenu.tsx` (`AuthDialog`)

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| Sign in / Create account | auth + roster + billing + land in a vault | 1–5s | ✅ label + spinner |
| Continue with Google | system browser + loopback | up to 3 min | ✅ "Waiting for your browser…" + spinner + Cancel |
| Save server URL | re-read session against a new host | 0.3–2s | ✅ spinner + tick |

### Vault switching & membership — `components/AccountMenu.tsx`

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| Switch vault (menu row) | folder already on device: 3 IPCs, tree swaps first; org activation + roster + reconcile follow in the background. No folder yet: 6+ round trips, then rediscover/mint | <0.2s (on-device) / 1–5s (no folder) | ✅ sidebar renames to target + spinner; tree fades and stops taking clicks (only visible on the no-folder path — the overlay's 180ms fade-in outlasts an on-device switch) |
| Switch vault (settings) | same | same | ✅ per-button spinner + the above |
| Accept invitation | accept → switch → bind folder → reconcile | 1–5s | ✅ spinner |
| Join by code | join → switch → reconcile | 1–5s | ✅ existing busy state |
| New vault (menu) | create org → folder → seed | 1–3s | ✅ existing busy state |
| Remove from device | local teardown | 0.2–1s | ✅ spinner |
| Leave vault | server leave (membership + shares + sockets) → local teardown → folder to Trash | 0.5–3s | ✅ spinner, behind a confirm that names the folder |
| Delete vault (permanent) | provider cancel-at-period-end (Pro only) → server delete + local teardown | 0.5–4s | ✅ spinner, behind a confirm that names the subscription end |
| Delete local vault files | move folder to Trash | 0.2–2s | ✅ spinner, behind a confirm |
| Invite member | server write + roster refresh | 0.3–1s | ✅ existing busy state |
| Remove member | server write + ACL broadcast | 0.3–1s | ✅ spinner, behind a confirm |
| Copy join code | clipboard | instant | ✅ existing "Copied" |
| Manage subscription | billing portal + browser handoff | 1–4s | ✅ spinner |
| Transfer subscription | server write + provider round trip (re-target, un-cancel) | 1–4s | ✅ spinner, behind a confirm |
| Cancel subscription now | server write + provider round trip | 1–4s | ✅ spinner, behind a confirm |
| Create / revoke MCP token | server write | 0.3–1s | ✅ spinner |
| Import files / folder / Export vault | disk walk + registry | 1s–minutes | ✅ existing busy + counts |
| Change vaults root | native picker + config write | fast | n/a |
| Check for update | network | 0.5–3s | ✅ existing update state |
| Install & Restart | download installer, then relaunch | 5s–minutes | ✅ spinner + progress bar in the banner |

### Sidebar — `components/FileTree.tsx`

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| Open a note | meta read + server register | 0.05–2s | ✅ row pre-selects, glyph → spinner, editor skeleton |
| New note / New folder | atomic write + reindex | fast | ✅ row appears, is revealed and opens in inline rename |
| Rename (inline) | disk rename + registry | 0.1–1s | n/a — inline edit already commits visibly |
| Delete (single / bulk) | deepest-first disk + server | 0.2s–10s | ✅ bulk progress counter |
| Lock / Unlock selected | one round trip **per item** | 0.3s–10s | ✅ spinner replaces the padlock |
| Import files / folder | disk copy + registry | 1s–minutes | ✅ toast with counts |
| Export… | disk copy outside the vault | 0.2s–30s | ✅ toast (nothing in-app changes otherwise) |
| Share… | opens the dialog | instant | n/a |
| Set colour, reorder, drag-move | local + registry | fast | n/a |
| Sort (header button) — Name A–Z / Z–A, Modified newest / oldest | local only | instant | n/a; applies to every folder without its own sort; dragged items keep their place |
| Right-click folder → "Sort this folder" | local only (per device) | instant | n/a; direct contents only; follows the folder through in-app renames and moves |
| Sort by Created, newest / oldest | one read of created dates for the vault | fast | n/a; undated notes go last |
| Right-click folder → "Show as gallery" / "Show as list" | local only (per device) | instant | ✅ gallery tab opens in the center |
| Click a gallery-mode folder | index read (no note bodies) | fast | ✅ expands in the tree and opens or retargets the Gallery tab |
| Pointer in the tree or a sync running, under a Modified sort | none | n/a | rows hold still and re-sort once both clear |

### Shared icon picker — `components/IconPicker.tsx`

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| Choose or reset a note, file, or folder icon | local presentation write + reindex | 0.1–1s | ✅ picker closes after a successful write and returns focus to its opener; a failed write keeps the picker open |
| Close the picker (Close button / Escape / outside press) | local UI | instant | n/a; Close and Escape return focus to the opener |

### Dashboards — `components/dashboard/`, `lib/dashboard/` ([[DASHBOARDS]])

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| New dashboard (file tree menu) | create-only write + open | fast | ✅ opens on the Dashboard surface |
| Dashboard / Text toggle | local (per note path) | instant | n/a |
| A view running | index query per view | fast | ✅ "Loading…" on the first run only; rows stay on screen during refreshes |
| Show more | next cursor page | fast | ✅ rows append; starts over if the cursor expired |
| Table header click | in-memory re-sort | instant | n/a; the note is not rewritten |
| Card / row click or Enter | open note | as note open | ✅ |
| A view fails | none | n/a | ✅ error inside that view only; the others keep working |

### Editor & main — `components/Editor.tsx`, `App.tsx`

| Action | Work | Latency | Feedback |
| --- | --- | --- | --- |
| Note open (bridge + first sync) | SQLite hydrate + provider sync | 0.05–3s | ✅ skeleton in the prose column, delayed 180ms |
| Typing / autosave | debounced egest | n/a | ✅ existing "Auto-saved" |
| Push-to-talk | mic + relay | instant | ✅ existing talk states |
| Search | local FTS5 | fast | n/a |
| Graph view | in-memory sim | fast | n/a |
| Gallery: arrows / Home / End, Enter or click | local | instant | ✅ focus moves card to card; opens the note or enters the subfolder; breadcrumbs go back up |
| Properties panel "Load more" | next page of relationships or backlinks | fast | ✅ rows stay loaded when an edit refreshes the panel |
| Find in note (⌘F / Ctrl+F in the editor) | in-memory search | instant | ✅ floating bubble top-right, live "3 of 12"; prefilled from a one-line selection |
| Find and replace (⌘⌥F on macOS, Ctrl+H elsewhere) | in-memory, one transaction per Replace All | instant | ✅ replace row; Replace All is one undo step |
| Vault search (⌘F outside a note, ⌘⇧F anywhere) | local FTS5 | fast | ✅ Search panel opens focused |
| Open terminal (Ctrl+` / activity button) | spawn login shell in vault root | 0.1–1s | ✅ opens in the bottom panel, focused; the prompt is the feedback. A restored tab shows "Session ended" + Restart, never a silent respawn |
| Hide / show the bottom panel (Ctrl+` from its terminal, header chevron) | layout only | instant | n/a; the shell keeps running and focus returns to the note |
| Resize the bottom panel (drag its top edge) | layout only | instant | ✅ live preview; the note keeps at least 200 px |
| Add AGENTS.md (terminal banner) | create-only write of AGENTS.md (+ CLAUDE.md if missing) | fast | ✅ banner leaves every terminal; toast names what was added, or says an existing CLAUDE.md needs the `@AGENTS.md` line |
| Drag a terminal tab to the bottom (empty panel) | layout only | instant | ✅ a "Drop to dock at the bottom" strip appears mid-drag for tabs allowed there |
| New terminal (Ctrl+Shift+`) | same, new tab (max 4) | 0.1–1s | ✅ tab opens focused; at the limit nothing opens |
| Shell exits | pty EOF + wait | instant | ✅ "Shell exited with code N" + Restart under the output |
| Ping a peer | awareness field | instant | ✅ existing ping toast |
| New tab (`+` / ⌘N) | create + open + reveal | fast | ✅ row pulses in the sidebar, highlight slides to the new tab, cursor waits in the note's title |
| Switch tab (click / Ctrl-Tab) | same as note open | 0.05–2s | ✅ tab dims while opening, then the highlight slides to it |
| Rename via the inline title | file rename + registry + tabs | 0.1–1s | ✅ inline warning under the title for a refused or taken name; the tab and sidebar row follow |
| Edit a property | one CM6 transaction over a span | instant | n/a (the value is the feedback) |
| Property edited by someone else mid-typing | re-parse + span revalidate | instant | ✅ "Changed by someone else while you were typing." under the row |

### Known gaps (deliberate, not oversights)

- **Rename** has no spinner. It is an inline edit that already commits visibly,
  and a spinner over a text field you just typed into is noise. Its one real
  gap is closed: a name that is illegal or already taken now says so inline,
  under the title, and keeps the focus instead of silently choosing another.
- **`useAsyncAction` has no unit test.** It is a React hook and the repo has no
  `@testing-library/react`; adding one for a 140-line hook was not worth a new
  dependency. Its two constants are exported and documented, and the pure pieces
  around it (`lib/toast.ts`, `lib/vault/landing.ts`) are covered.
- **Bulk lock/unlock has no per-item counter** the way bulk delete does. Same
  shape of work, so it should get one; the spinner is the floor, not the ceiling.
- **The tab strip has no unit test.** Same reason as `useAsyncAction`: it is a
  React component and the repo has no `@testing-library/react`. Its whole
  contract lives in the store instead (`src/__tests__/tabStore.test.ts` covers
  the stable tab order, what `closeTab` lands on, the shared create path and the reveal
  request), and the strip itself is on the manual pass.
- **Editor selection geometry is verified manually.** jsdom does no layout, so
  `getComputedStyle(line).paddingLeft` cannot resolve the `max()`/`calc()`/`ch`
  the inset is built from. `editorGeometry.test.ts` asserts WHERE the declaration
  sits and the widget/DOM contract the CSS depends on; the pixels are a
  two-minute look in both themes.
