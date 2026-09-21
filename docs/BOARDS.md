# Boards

A board is one ordinary Markdown note. There is no board database, no
`.context/` sidecar and no second copy of anything: the `.md` file is the whole
truth, and Obsidian Kanban can open it.

Code: `app/apps/desktop/src/lib/board/**` (parse, serialize, settings, move,
Kanban import/export) and `app/apps/desktop/src/components/board/**` (the view).
The shapes are frozen in `src/lib/tasks/contracts.ts`.

## The format

````markdown
---

kanban-plugin: basic

---

## Todo

- [ ] Call the notary 📅 2026-09-22
  Bring the signed copy.
- [ ] Reply to Jonas

## Doing

- [ ] Draft the deck ^t-k3x9f2a0b1

***

## Archive

- [x] Pay the deposit

%% kanban:settings
```
{"kanban-plugin":"basic","lane-width":272}
```
%%
````

- **Frontmatter marks the note.** `noam_kind: board` for a Noam-native board, or
  any `kanban-plugin` value for one Obsidian Kanban wrote. `isBoardDocument`
  looks at the FRONTMATTER only — the same words in the body are just words.
- **`## Heading` is a lane.** `#` and `###` are not; they stay as text.
- **`- [ ]` / `- [x]` at the left margin is a card.** A card is a task line, so
  every task rule applies to it: the frozen markers, and the `^t-…` block id
  that identity rides on.
- **Indented lines under a card are its body** and travel with it on a move. A
  blank line ends the card.
- **`***` starts the archive.** Every lane after it is `archive: true`
  (`## Archive` by default).
- **`%% kanban:settings … %%` is kept verbatim** at the end of the note.

Anything the parser did not model — blank lines, trailing spaces, an Obsidian
Kanban `**Complete**` marker, a paragraph between two cards, CRLF — is kept as
verbatim text. `serializeBoard(parseBoard(text)) === text` byte for byte, for
any text. Opening a board must never rewrite the file.

The board reads the task line SHALLOWLY: checkbox, text and `^t-` id. Markers
(dates, priority, recurrence, tags) stay in `task.text` verbatim; the structured
fields come from the task engine's parser (`src/lib/tasks/parse.ts`), which owns
that grammar. The board never writes a marker, so it cannot lose one.

## Obsidian Kanban compatibility

`importKanban(text)` and `exportKanban(doc)` cover a documented subset and
report the rest — itemized, with a reason, never guessed and never dropped
silently.

| Kanban | Noam | Notes |
| --- | --- | --- |
| lanes / cards / card bodies | lanes / cards / body | unchanged |
| `***` + `## Archive` | `lane.archive` | unchanged |
| `@{YYYY-MM-DD}` | `📅 YYYY-MM-DD` | converted both ways |
| `kanban-plugin` | `settings.kanbanPlugin` | export writes `basic` |
| `lane-width` | `settings.laneWidth` | |
| `show-checkboxes` | `settings.showCheckboxes` | |
| `list-collapse` | `lane.collapsed` | positional over the LIVE lanes |
| `date-trigger` other than `@` | — | reported; dates stay as text |
| every other setting | — | reported; kept verbatim in the block |

Markers Kanban cannot show (⏳ 🛫 ✅ ➕ ❌ 🔁 ⛔) stay in the card text on export
and are named in `report.unsupported`, because the task engine owns them and
dropping them would lose data.

## Settings are a span edit

`planUpdateSettings(doc, patch)` replaces the SLICE of the settings JSON that
holds one value, and appends a new key immediately before the closing brace.
Nothing reserializes the object, so unknown keys, key order and formatting
survive a change; a board with no settings block gets one appended. The
recognised subset is `laneWidth`, `showCheckboxes`, `archiveLaneTitle`
(`readSettings`); everything else lives only in `settings.raw`.

## The move safety rule

**A card move is planned against LIVE text, never against the snapshot the
board was painted from.** Between the paint and the drop a teammate may have
typed in another card over CRDT, an AI may have rewritten a lane through MCP, or
the user may have edited the very card they are dragging.

So `planMove({ cardRef, toLane, toIndex, beforeCardRef }, liveText)`:

1. re-parses the live text;
2. re-finds the card by its `^t-` id, or — when it has none — by exact source
   text nearest the line hint;
3. re-finds the lane by heading;
4. re-finds the ANCHOR — `beforeCardRef`, the card the user saw this one land
   above (`null` = the end of the lane) — by the same id-then-text rule, and
   inserts before it;
5. plans ONE `SpanChange[]` — delete the card's span, insert its bytes at the
   destination — both in live-text coordinates, ordered from the end backwards,
   so it applies as one transaction and one undo step.

`planMoveLive(input, host)` is the entry point a UI uses: `host.resolve` is the
task adapter's `resolveTask` (live text, revision, read-only verdict) and
`host.liveText` is the live view when the note is open and `ipc.readNote` when
it is not. It returns the plan plus the `path` and `revision` that
`replaceRange` checks against.

Verdicts: `stale-target` (the moved card's own line was edited: nothing is
planned, the board refreshes), `read-only`, `ambiguous-target` (two lines answer to the same
id or the same text: dedupe first), `missing-target`, `missing-lane`.

The consequences the tests pin: an edit inside ANOTHER card between snapshot and
move succeeds and survives intact; an edit to the MOVED card's line refuses. An
indexed offset never reaches a write.

`toIndex` counts the destination lane's cards with the moved card EXCLUDED, so
"put it third" means the same thing whether the card comes from that lane or
another one. It is a FALLBACK: an index describes the board that was painted,
and a concurrent insert above the destination shifts what "third" means, so the
anchor decides and `toIndex` only steps in when the anchor itself has left the
lane — which the ok result reports as `anchorMissing: true`, and the host shows.

## The view

`BoardView` renders lanes horizontally with a minimum lane width and horizontal
scrolling, so a narrow window shows one lane and a hint of the next rather than
four unreadable ones. Tokens only, so light, dark and every accent preset come
for free.

Keyboard is the contract, not the fallback. The board is one tab stop (roving
tabindex on the cards); inside it:

| Key | Action |
| --- | --- |
| Arrows | move focus |
| `[` / `]` or Shift+Arrow | move the card to the previous / next lane |
| Alt+Arrow | reorder the card inside its lane |
| Enter | open the card |
| Space | toggle done |

The card that moved keeps focus after the document comes back re-parsed. With
`readOnly={{ reason }}` the reason is shown, every control that would write is
disabled, and the move and toggle keys do nothing — opening still works.
