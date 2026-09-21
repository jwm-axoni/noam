# Tasks

A task is a LINE in an ordinary vault note. There is no task database, no
`.context/` sidecar and no hidden comment: the `.md` file is the only durable
truth, and SQLite (`src-tauri/src/tasks.rs`) holds a derived projection of it
that any rebuild can throw away and rebuild from the files alone.

Engine: `app/apps/desktop/src/lib/tasks/` — import from its barrel
(`lib/tasks`), never from a file inside it. The frozen shapes live in
`contracts.ts`; nothing in this document may contradict that file.

## The format

```
- [ ] Draft the spec ⏫ 🔁 every week 📅 2026-03-09 #work ^t-k3x9f2a0b1
```

- Bullet `-`/`*`/`+`, a one-character checkbox, then exactly one whitespace:
  `- [ ]` with nothing after it is NOT a task, `- [ ] ` is.
- Statuses: `[ ]` todo, `[x]`/`[X]` done, `[/]` in progress, `[-]` cancelled.
  We read `X` and write `x`.
- Priorities: ⏫ highest, 🔼 high, ▶ medium, 🔽 low, ⏬ lowest. `▶️` (with the
  emoji variation selector) is READ as medium and kept as written until the
  priority itself is edited. Obsidian Tasks' 🔺 is preserved, not interpreted.
- Fields: 📅 due, ⏳ scheduled, 🛫 start, ✅ done, ➕ created, ❌ cancelled,
  🔁 recurrence, 🆔 id, ⛔ dependsOn. `🆔`/`⛔` are PRESERVED, never acted on.
- Dates are floating `YYYY-MM-DD`: a wall-clock day with no time and no zone.
  Comparisons are string comparisons; a `Date` is only ever built from local
  parts. Nothing in the pipeline calls `toISOString`.
- Frontmatter and fenced code are skipped. A `- [ ]` inside a fence is
  documentation about tasks, not a task.

Anything after the checkbox that we do not recognise is kept VERBATIM in
`Task.unparsed` and written back in place, so
`serializeTask(parseTaskLine(line)) === line` for any line — including the ones
we only half understand. The pinned corpus is in
`src/lib/tasks/__tests__/parse.test.ts`.

## Identity

Identity is an Obsidian block id at the end of the line: ` ^t-<10 base36>`. It
travels with the line through a copy, a move to another note, a rename and a
rebuild, which a path-keyed sidecar does not.

Assignment is LAZY. A task has no id until its first structured edit, and that
edit writes the suffix in the SAME span replacement — one write, one undo step,
no pass that stamps every file the moment a vault is opened (`planAssignId`).

The cost of laziness: an un-stamped line that somebody edits can no longer be
re-found (the adapter matches on exact text), and the action reports
`missing-target` rather than guessing. That is the trade the first edit buys out
of.

## Writes

Every write goes through `resolveTask(ref)` against LIVE text — the open
editor's document when the note is on screen, `ipc.readNote` otherwise:

1. by `^t-` id: exactly one hit wins, two are `ambiguous-target` (dedupe first);
2. otherwise by EXACT `sourceText`; a second identical line is
   `ambiguous-target`, never a guess;
3. the span is recomputed from live text and the text is hashed into
   `revision`, which `applyTaskEdit` re-checks immediately before writing.

An open note is edited as ONE CodeMirror transaction, so the edit reaches the
`.md`, the index and Yjs undo exactly like typing and a teammate's cursor maps
through it. A closed note takes the ordinary note-write path the watcher and
sync layer already treat as an external writer. A read-only note (vault posture
or a lock) is refused at the adapter, before any planning.

**An offset from SQLite never reaches a write.** `Task.path`, `line`, `from`
and `to` are search hints for `resolveTask` and nothing else.

## Recurrence and convergence

`🔁` supports: `every day|week|month|year`, `every N <unit>`, `every other
<unit>`, weekday lists (`every monday, friday`, `every 2 weeks on monday`), and
a trailing `when done`. Anything else keeps its text, parses to `rule: null`,
and REPORTS at completion instead of inventing a date.

Completing a recurring task marks it done, stamps ✅, and inserts the next
occurrence directly below — as one edit. Every date on the line moves by the
same number of days as the primary one (due, else scheduled, else start).

Two clients completing the same occurrence offline both spawn a next line, and
nothing coordinates them, so both must write the SAME BYTES:

- the date comes from the line, so it already agrees;
- the id is `occurrenceId(parentId, nextDue) = "t-" + base36(sha256(parentId +
  "\n" + nextDue)).slice(0, 10)` — a hash, not a random number — where
  `parentId` is the `^t-` id of the occurrence that was completed. A line with
  no id yet gets one derived from its note id and its own bytes
  (`contentTaskId`), so the two clients agree on that too.

`planDedupe` is the backstop for what derivation cannot cover (a rebuild that
re-headed a series, a paste): it deletes every line after the first that carries
an id already seen, by document position. Idempotent and convergent — either
client, either order, same text.

## Queries

`parseQuery` reads a closed clause set, one clause per line, and REPORTS what it
does not understand (`issues` + `unsupported`). A line it cannot read never
becomes "match everything".

```
not done                      due before today           priority is high, highest
status is todo, in-progress   due after 2026-03-01       tag: work
done                          due on this week           no tag chores
                              due in today to next week  path: Projects/
is recurring                  no due date                heading is Today
description includes spec     description regex /^A/i    sort by due desc
group by path                 limit 50
```

Relative dates (`today`, `tomorrow`, `yesterday`, `this week`, `next week`,
`last week`, `in N days`, `N days ago`) are stored UNRESOLVED and resolved at
query time against the clock and the vault's week start, so a saved filter
called "Due this week" still means this week next month. A phrase that names a
week resolves to a RANGE, and `before`/`after` use the right edge of it.

`limit` is capped at `MAX_QUERY_LIMIT` (500) and a larger request is clamped
with a `clamped-limit` issue. A task list is a panel, not an export.

## The Rust index

`tasks(row_id, note_id, task_id, series_id, line, char_from, char_to,
source_text, status, text, priority, due, scheduled, start, done, cancelled,
created, recurrence, section, indent, generation)` plus `task_tags(row_id,
tag)`, indexed on `due`, `(status, due)`, `note_id`, `task_id`, `series_id`.

Rows are written from `Index::index_one` inside the note's own transaction, so a
note and its tasks can never disagree, and dropped with the note. `char_*` are
UTF-16 offsets, matching the editor's coordinate space. `query_tasks(query,
page)` is bounded by `MAX_PAGE_SIZE` (500) and epoch-checked like every other
query; the wrapper is `ipc.queryTasks`.

## Not supported

Time of day, durations, reminders, assignment, dependencies beyond preserving
⛔, full Obsidian Tasks query parity (no function clauses, no `filter by
function`, no `happens`), multi-note database boards, external calendar sync,
and any server-side task projection. Tasks live on lines in your notes; that is
the whole model.
