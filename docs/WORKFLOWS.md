# Workflows

A **workflow** is a small, declarative command a person keeps in their vault: "make today's
journal note from a template", "append this line under `## Inbox`", "drop a link to the note I
have open into my reading list". One engine runs them, and every entry point — the slash menu,
the action picker, a keyboard shortcut, the Workflows view — calls that same engine.

Workflows never execute code. See [Safety rules](#safety-rules).

- Code: `app/apps/desktop/src/lib/workflows/`
- Frozen contracts: `src/lib/workflows/contracts.ts`
- Engine: `src/lib/workflows/engine/` · production wiring: `src/lib/workflows/adapter.ts`
- Portable packages (sharing workflows between vaults): [WORKFLOW-PACKAGES.md](./WORKFLOW-PACKAGES.md)

---

## The file format

A workflow definition is an **ordinary Markdown note**. It is never stored only under
`.context/`, so it syncs, versions, merges and diffs like every other note you own.

A note is a workflow when **both** are true:

1. its frontmatter has `noam_kind: workflow`, and
2. its body contains **exactly one** fenced code block whose info string starts with
   `json noam-workflow`.

Prose outside the fence is free-form documentation. Fences with other info strings are ignored,
so a note may quote JSON, show an example, or explain itself at any length.

````markdown
---
noam_kind: workflow
---

Appends a timestamped line to today's journal, creating the note if it is not there yet.

```json noam-workflow
{
  "version": 1,
  "id": "daily-log",
  "name": "Daily log",
  "description": "Add a line to today's journal",
  "icon": "lucide:notebook-pen",
  "shortcut": "mod+shift+l",
  "variables": [
    { "name": "entry", "label": "What happened?", "type": "multiline" }
  ],
  "requires": { "templates": ["Templates/Day.md"] },
  "steps": [
    {
      "type": "append",
      "target": { "path": "Journal/{{date}}.md" },
      "heading": "## Log",
      "content": "- {{time}} — {{entry}}",
      "createIfMissing": { "template": "Templates/Day.md" }
    }
  ]
}
```
````

Both halves of the recognition rule matter. A note that merely *quotes* a workflow in a code
block is never claimed. A workflow note whose fence was deleted reports a **missing fence**
rather than quietly ceasing to be a command.

Templates are ordinary Markdown files too. There is no marker and no required folder;
`Workflows/` and `Templates/` are only defaults.

---

## Schema (version 1)

Top-level fields:

| Field | Type | Notes |
| --- | --- | --- |
| `version` | `1` | Required. A different number is an error, not a guess. |
| `id` | string | Required, unique per vault. `[a-z0-9][a-z0-9-]{0,63}`. |
| `name` | string | Required. What the command palette shows. |
| `description` | string | Optional. |
| `icon` | string | Optional. `lucide:<id>` or `emoji:<grapheme>` — the note-icon encoding. |
| `shortcut` | string | Optional, e.g. `mod+shift+m`. `mod` is ⌘ on macOS, Ctrl elsewhere. |
| `slash` | boolean | Optional, default `true`. Show in the editor's slash menu. |
| `variables` | array | Optional. What the prompt asks for, in order. |
| `requires` | object | Optional. `{ templates?: string[], workflows?: string[] }`. |
| `steps` | array | Required, at least one. |

**Unknown top-level fields are preserved verbatim.** A definition written by a newer build
round-trips through this one unchanged; the parser reports each unknown key as a *warning* and
keeps it in `unknownFields`.

### Variables

```json
{ "name": "topic", "label": "Topic", "type": "text", "required": true, "default": "", "placeholder": "…" }
```

- `name` — `[a-z][a-z0-9_]{0,31}`, and must not shadow a built-in.
- `type` — `text` (default) · `multiline` · `choice` (needs `choices`) · `date` · `clipboard`.
- `required` — default `true`. A required variable with no value stops the run before anything
  is written.

### Steps

| Step | Required | Optional |
| --- | --- | --- |
| `create-note` | `path` (must end `.md`) | `template` **or** `content`, `onExists`, `open` |
| `append` | `target`, `content` | `heading`, `position`, `createIfMissing` |
| `insert` | `target: "current"`, `content` | — |
| `open-note` | `path` | — |
| `run-workflow` | `id` | — |

- **`target`** is `"current"` (the note in the active editor) or `{ "path": "…" }`.
- **`onExists`** — `fail` (default) · `open` (open the existing note instead) · `suffix`
  (create ` 2`, ` 3`, … next to it).
- **`heading`** is the exact heading LINE, e.g. `"## Inbox"`. It is expanded first (`"## {{section}}"`
  is matched as `"## Archive"`), then matched exactly. A heading that is not in the note is a
  `missing-heading` failure — the engine never appends somewhere else instead.
- **`position`** — `end` (default) or `start`, *within the heading's section*. A section runs
  from its heading to the next heading of the **same level or higher**, so `### Today` nested
  under `## Journal` is part of the Journal section. With no `heading`, `end` is the end of the
  note and `start` is the top of the body — below the frontmatter, never above it.
- **`run-workflow`** nests another workflow. Cycles are refused at validation *and* at run time;
  chains are limited to **8** workflows deep. The nested workflow inherits only the prompt
  answers it declares; anything else it needs must have a default.

---

## Variables and expansion

`{{name}}`, or `{{name:argument}}`. That is the entire language — there are no expressions,
no function calls and no nesting. A value that itself contains `{{…}}` is emitted as text and
never re-scanned.

### Built-ins

| Token | Expands to |
| --- | --- |
| `{{date}}` / `{{date:FORMAT}}` | Today. Default format `YYYY-MM-DD`. |
| `{{time}}` / `{{time:FORMAT}}` | Now. Default format `HH:mm`. |
| `{{title}}` | The open note's file name, without its extension. `""` when none is open. |
| `{{path}}` | The open note's vault-relative path. `""` when none is open. |
| `{{folder}}` | The folder that note sits in. `""` at the vault root, or when none is open. |
| `{{selection}}` | The editor selection. `""` when there is none. |
| `{{clipboard}}` | Clipboard text the prompt UI captured **on an explicit user action**. |
| `{{link:Path/To/Note.md}}` | `[Note](Path/To/Note.md)`, spaces percent-encoded in the URL. |

### Date and time formats

Only these tokens are substituted. **Every other character is literal** — there is no escape
syntax and no locale lookup, so a format means the same thing on every machine that opens
the vault.

| Token | Example | Token | Example |
| --- | --- | --- | --- |
| `YYYY` | `2026` | `HH` | `14` |
| `YY` | `26` | `mm` | `03` |
| `MM` | `03` | `ss` | `07` |
| `MMM` | `Mar` | `ddd` | `Mon` |
| `DD` | `09` | | |

Tokens are case-sensitive: `MM` is the month, `mm` is minutes. Validation *warns* when a format
leaves a run of repeated letters unconsumed (`yyyy-mm-dd` is the classic typo) or contains no
token at all.

### An unresolvable name is an error, not an empty string

A `{{name}}` the engine cannot resolve leaves the token verbatim **and reports an issue**, and
the step does not write. Silently expanding a typo to `""` is how a half-written capture reaches
disk. The codes are `unknown-variable` (not a built-in, not declared), `missing-value` (declared,
no answer), `unknown-builtin` (`{{shell:…}}`), `bad-builtin-arg` (`{{link}}` with no path) and
`missing-clipboard`.

### Templates

`renderTemplate` expands a template file. The **body** is expanded as text; each **frontmatter
value** is expanded as a value and re-serialized through the same writer the Properties panel
uses, so an answer containing a newline or a colon is quoted rather than left to corrupt the
YAML. Frontmatter **keys** are never expanded. Frontmatter outside the flat subset Noam can
parse is left exactly as written, with a warning, and only the body renders.

---

## Results

Every run returns an `ExecutionResult` — there is no throw and no silent partial success.

**Success** carries the `effects` that happened, in order (`created`, `appended`, `inserted`,
`opened`, `ran-workflow`), plus any non-fatal `warnings`.

**Failure** carries:

- `kind` — `validation` · `cancelled` · `permission` · `read-only` · `stale-target` ·
  `missing-target` · `missing-heading` · `conflict` · `offline` · `error`
- `message`, and the `step` (zero-based) and `field` (dotted, e.g. `steps.2.path`) it belongs to
- `completed` — the effects that *did* land before the failure, so a partial sequence is visible
  rather than implied
- `recovery` — `{ retryable, pendingContent?, preservedAt? }`

`retryable` is true only where the identical call could succeed on a second try (`stale-target`,
`offline`, `error`). When a step had already rendered content it could not write,
`pendingContent` is that text and `preservedAt` is where it was parked —
`Captures/Unsaved capture <stamp>.md`, written create-only so a second failure never overwrites
the first. **Text a person typed is never dropped.**

Validation issues use the same `WorkflowIssue` shape (`severity`, `code`, `message`, `step`,
`field`). A file with any `error`-severity issue is listed but **not runnable**; `warning`s are
advice an author may ignore.

---

## Safety rules

These are the reasons the format looks the way it does. A workflow can arrive from a package
someone downloaded, so every one of them is enforced in code, not by convention.

**1. Nothing is ever evaluated.** No JavaScript, no shell, no Templater, no expression language.
Steps are data and the only computation is the `{{…}}` substitution described above. A workflow
can write text into your vault and open notes. That is the whole capability.

**2. The clipboard is explicit.** `{{clipboard}}` reads only what the prompt UI captured through
a deliberate user action and passed in. The engine never touches `navigator.clipboard` — a test
installs a throwing getter on `navigator` and runs a clipboard workflow through it.

**3. The target is re-resolved immediately before every write.** Each step asks the host where
its target is, takes the content revision it is given, and hands that revision back to the write.
Anything that moved in between — a teammate's edit, an AI rewrite, a rename — comes back as
`stale-target` instead of landing at a byte offset that now means something else. The order is
*resolve → read → write*; reading first would let the text move under a revision that still
looked current.

**4. Paths cannot leave the vault.** Absolute paths, `..` segments, backslashes and dot-segments
(which is how `.context/` would be reached) are refused. Because a path may contain variables,
the check runs **twice**: on the literal parts at validation, and again on the expanded string at
run time. `{{name}}` answered with `../../etc/passwd` fails before anything is created.

**5. Permission is checked before the write, never inferred from a successful read.** The host
derives it from the same state the editor uses for its read-only decision (the local lock overlay
plus, for the OPEN note alone, that document's sync verdict — `syncStatus` is a per-document
grant, not a vault posture, so a view-only note on screen never bars a write to a different note),
so a workflow cannot write to a note the sidebar is painting with a padlock. `view` → `read-only`;
`none` → `permission`. A **frozen vault root** refuses the same way, before `ensureFolder` runs:
a `create-note` at the root, or one that would make a new top-level folder, fails as `permission`
with the reason, because the server would refuse to register it and leave the note unsyncable.

**6. Collaboration state is never bypassed.** A note open in the editor is edited by dispatching
an ordinary CodeMirror transaction on its live view, so the change reaches the `.md`, the index
and Yjs undo exactly like typing and merges with what a teammate is doing. A **closed** note
takes the ordinary note-write path, which the watcher and sync layer already treat as an external
writer.

---

## Using the engine

```ts
import { createVaultCommandService } from "./lib/workflows";

const workflows = createVaultCommandService();   // once per vault
await workflows.refresh();                       // after a vault open, and on .md changes

const unsubscribe = workflows.subscribe(() => render(workflows.list()));

const prompts = workflows.promptsFor("daily-log");          // WorkflowVariable[], in order
const result = await workflows.run("daily-log", { entry: "shipped it" }, {
  currentPath, selection, clipboard,                        // all optional
});
```

- `list()` is sorted by name and **includes broken files** with their issues and
  `runnable: false`. A workflow note with a typo is something a person has to be able to find; a
  registry that silently dropped it would leave them hunting for a command that vanished.
- `promptsFor(id)` returns the declared variables in order. The answers are a
  `Record<name, string>` — a value for a name the workflow does not declare is refused, so a
  caller cannot silently lose an answer it thought it was passing.
- Two files claiming one `id` makes **both** non-runnable, with a `duplicate-id` issue on each.

Testing: the engine is pure with dependency-injected I/O (`WorkflowHost`). The suites under
`src/lib/workflows/__tests__/engine*.test.ts` run in plain Node against an in-memory host; only
`engine.adapter.test.ts` mocks IPC and the store.
