# Dashboards

A dashboard is one ordinary Markdown note. There is no dashboard database, no
`.context/` sidecar and no code in it: the `.md` file is the whole truth, it
syncs and versions like any note, and it keeps its `doc_id`. Its views are
plain-text query blocks that each viewer runs against their own local index.

Code: `app/apps/desktop/src/lib/dashboard/**` (parse, query building, the run,
template) and `app/apps/desktop/src/components/dashboard/**` (the surface and
the views). The card face is shared with the folder gallery
(`src/components/gallery/NoteCard.tsx`).

## The format

````markdown
---
noam_kind: dashboard
---

```noam-view
title: Conversations with Paul
view: table
where: type = conversation
where: people has [[Paul]]
where: created >= last 30 days
sort: modified desc
limit: 24
columns: name, type, people, modified
width: half
```

```noam-view
title: Recently modified
width: half
```
````

- **Frontmatter marks the note.** `noam_kind: dashboard`. `isDashboardDocument`
  looks at the FRONTMATTER only; the same words in the body are just words.
- **Every fenced block whose info string is exactly `noam-view` is a view**, in
  document order (backtick or tilde fences). A block quoted inside a longer
  fence is not a view.
- **Everything else in the note is ignored by the Dashboard surface.** Prose
  between the blocks stays in the file and shows in the Text view; v1 renders
  only the views.
- The note opens on a **Dashboard / Text** segmented control, remembered per
  note path in `localStorage` (`noam:dashboard-view:<path>`), like boards.

## The grammar

One clause per line. `#` followed by a space (or at the end of a line) starts a
comment, so `tag = #meeting` is still a value. Quotes around a value are
removed. The set is CLOSED: nothing is evaluated.

| Clause | Values | Default | Notes |
| --- | --- | --- | --- |
| `title:` | text | "Notes" / "Table" | Rendered as text. |
| `view:` | `cards` \| `table` | `cards` | |
| `where:` | `key op value` | none | Repeatable; all lines AND together. |
| `sort:` | `name` \| `created` \| `modified` \| property key, then `asc` \| `desc` | `modified desc` | Direction defaults to newest first for dates, ascending otherwise. |
| `limit:` | 1–200 | 24 | Over 200 is clamped (warning). |
| `columns:` | comma list of keys | `name, modified` | Table only. `name` always leads. At most 12. |
| `width:` | `full` \| `half` | `full` | Two half views sit side by side. |

A repeated clause other than `where:` keeps the first line (warning).

### `where:` operators

| Written | Meaning | Applies to |
| --- | --- | --- |
| `=` | equals (a list property matches any member) | properties, `tag`, `created`, `modified` |
| `<` `<=` `>` `>=` | ordered compare | numbers, dates, text |
| `contains` | case-insensitive substring | text properties |
| `has [[Note]]` | the note is linked by that relationship | named relationships (`people`, …) |

There is no `!=`, no `or`, and no filter by `name` or `path` yet; each is an
issue, never ignored.

### Keys

A key resolves through the **effective catalog** (the vault's
`_Noam/Knowledge schema.md` plus the seeded `type` and `people`), in this
order: `created` / `modified` (system properties), `tag` / `tags`, a property's
frontmatter key, a property id, a relationship id or name, a property's display
name, and finally the raw frontmatter key (the index stores undeclared keys
under their own name, so `status = done` works without a catalog).

Values are typed by the catalog: a `number` property compares numerically, a
`checkbox` takes `true`/`false`, a `label` may be written by its display name.
An undeclared key infers a number or a boolean from the literal. `tag = #x`
matches frontmatter `tags` (inline `#tags` in the body are not in the
knowledge index yet).

### Dates

`created` and `modified` take an ISO date or datetime (the contract's grammar:
a bare date is the whole UTC day) or a **relative phrase**: `today`,
`yesterday`, `this week`, `last week`, `this month`, `last month`,
`last N days`, `last N weeks` (`past` works too). Relative phrases are stored
unresolved and resolved when the view runs, to a LOCAL range `[from, to)`:
`=` means inside the range, `>=` from its start, `>` after its end, `<` before
its start, `<=` before its end. Weeks start on Monday. A catalog `date` /
`datetime` property takes the same phrases (compared as `YYYY-MM-DD`).

## Rules

- **Never widen.** An unknown line, a malformed `where:`, or a filter the
  catalog cannot express (a second relationship, a relative date on an
  untyped key, `contains` on a number) is a BLOCKING issue: the view shows
  the issue and NO results, because running without it would show more than
  was asked for. A bad presentation line (`view`, `width`, `limit`, `sort`,
  `columns`, `title`) cannot widen anything, so it is a warning and the view
  still runs with the default.
- **One query primitive.** Filters and sort become the arguments of
  `queryNotes` (`lib/knowledge/noteTimes.ts`, spec 06). A relationship filter
  resolves `[[Paul]]` with the index's wikilink resolver (`resolve_wikilink`)
  and becomes the contract's `traverse`
  (`{ fromDocId, relationshipIds: [id], direction: "incoming", maxDepth: 1 }`),
  evaluated by Rust next to the `where` predicates. There is no second query
  engine and no filtering in TS. One relationship filter per view; a link
  that resolves to no note shows a warning and matches nothing.
- **Index only.** Card and column data (excerpt, first image, property values,
  relationship targets) come from one `list_note_cards` read; no note is read
  and no markdown is rendered per card.
- **Security.** No iframe, no `dangerouslySetInnerHTML`, nothing from the note
  is evaluated; titles, values and excerpts render as text. A dashboard shared
  with a teammate runs against THEIR local index, which holds only notes they
  can read, so it never shows them anything else.
- **Live.** Every watcher batch re-runs every view, debounced 300 ms; an edit
  to the dashboard note re-parses it. Each view runs on its own, so one slow or
  failing view never blanks another.

## The views

**Cards** are the folder gallery's note cards (first image, else excerpt, else
a placeholder; "Not downloaded yet" for a 0-byte note), with the same arrow-key
grid movement. **Table** has a sticky header, one row per note, `name` as a
link, property values as text (label ids shown by their catalog name),
relationship values as note links, and dates as relative text with the full
date as a tooltip. Clicking a header re-sorts the rows on screen for the
session only; it never rewrites the note.

Both open a note on click or Enter, say "No notes match" for an empty result,
and show "Showing 24 of 25+" (at least one more matches) with a **Show more** button when the index has
more; Show more continues from the query's cursor (and starts over if the
index moved on under it).

## Creating one

The file tree's context menu has **New dashboard** next to New note. It creates
`Dashboard.md` (`Dashboard 1.md`, … when taken) in that folder with the
frontmatter and one example view (recently modified notes as cards) and opens
it on the Dashboard surface. The root-freeze latch refuses it at a frozen root,
exactly like New note.

## Where the code lives

| Piece | File |
| --- | --- |
| Detection, block extraction, grammar | `src/lib/dashboard/parse.ts` |
| Catalog resolution, relative dates, `queryNotes` arguments, run, table values | `src/lib/dashboard/query.ts` |
| New-dashboard template | `src/lib/dashboard/template.ts` |
| Per-path Dashboard/Text preference | `src/lib/dashboard/surfacePref.ts` |
| Surface (toggle) | `src/components/dashboard/DashboardSurface.tsx` |
| Host (text, catalog, live refresh) | `src/components/dashboard/DashboardHost.tsx` |
| One view (cards, table, Show more) | `src/components/dashboard/DashboardView.tsx` |
| Shared card face | `src/components/gallery/NoteCard.tsx` |
| `traverse` on the notes query | `src-tauri/src/knowledge.rs` (`traversal_candidates`) |
| `list_note_cards` | `src-tauri/src/cards.rs` (`NoteCardRow`), `index.rs` (`note_cards`) |
