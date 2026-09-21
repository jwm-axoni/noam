---
type: reference
product: Noam
date: 2026-09-20
tags: [workflows, packages, import, export, quickadd]
---

# Portable workflow packages & the QuickAdd importer

> One JSON file carries a set of workflows, templates and assets between
> vaults. Importing one is previewed first, applied atomically, and safe to
> repeat. Back to index: [[Noam]].

Code: `app/apps/desktop/src/lib/workflows/packages/` and `…/workflows/quickadd/`.
Types: `…/workflows/contracts.ts` (frozen). Tests:
`…/workflows/__tests__/packages*.test.ts`, `…/quickadd*.test.ts`.

---

## 1. The package file

A package is **ONE JSON file**, suffix `.noam-package.json`
(`PACKAGE_FILE_SUFFIX`). It holds a manifest and the file bodies it describes:

```jsonc
{
  "manifest": {
    "format": "noam-package",
    "formatVersion": 1,
    "id": "starter-pack",              // same pattern as a workflow id
    "name": "Starter pack",
    "description": "…",
    "version": "1.2.0",                // semver-ish: 1, 1.2, 1.2.3, 1.2.3-beta.1
    "minAppVersion": "0.1.0",          // compared numerically against the app
    "workflowSchemaVersion": 1,
    "dependencies": [{ "kind": "template", "path": "Templates/Daily.md" }],
    "entries": [
      { "path": "Workflows/Daily note.md", "kind": "workflow",
        "sha256": "24f5…", "id": "daily-note" },
      { "path": "Templates/Daily.md", "kind": "template", "sha256": "…" },
      { "path": "attachments/logo.png", "kind": "asset", "sha256": "…" }
    ]
  },
  "files": {
    "Workflows/Daily note.md": { "encoding": "utf8", "content": "---\nnoam_kind: workflow\n---\n…" },
    "attachments/logo.png":    { "encoding": "base64", "content": "iVBORw0…" }
  }
}
```

Rules the validator (`packages/manifest.ts`) enforces — everything in a package
comes from outside the vault, so all of it is untrusted input:

| Rule | Why |
| --- | --- |
| `format` / `formatVersion` must be `noam-package` / `1` | a newer file is refused, not half-read |
| `id` matches `WORKFLOW_ID_PATTERN`, `version` is semver-ish | ids are stable keys, versions are compared |
| `minAppVersion` ≤ this build (numeric dotted compare, `0.10.0 > 0.9.0`) | "update Noam" beats a broken import |
| `workflowSchemaVersion` == `WORKFLOW_SCHEMA_VERSION` | the definitions must be readable |
| Entry paths are **relative, forward-slash, normalised** | no `..`, no absolute, no `C:\`, no backslash, no empty/`.`/`..` segment, no leading `/`, no trailing `/`, no control characters |
| Entry paths never start with `.context/` or any dotted folder | `.context/` is the private store; it is never walked, synced or indexed |
| `workflow` / `template` destinations end in `.md` | they are ordinary notes |
| `asset` destinations start with `attachments/` | Rust's `write_binary_file` refuses a binary write anywhere else (`attachments.rs ensure_attachment_rel`) |
| No two entries name the same destination (case-insensitively) | paths compare case-insensitively everywhere in this app |
| Every entry has a body, every body has an entry | no silent omissions, no stowaways |
| The body's SHA-256 equals the entry's `sha256` | a package is tamper-evident; this is the only thing that makes the round trip verifiable |
| `workflow` entries carry a valid workflow `id` | dependency resolution needs it |

`validateManifest(pkg, host)` returns a `string[]` of user-readable problems
(empty = valid). It is **async** because the hashes are verified with
`crypto.subtle.digest`. `validatePackage()` returns the same errors plus
`entryErrors` by entry index and `compatibility` on its own, which is what the
preview shows per row.

## 2. Preview decisions

`previewImport(pkg, host, { ledger, existingWorkflowIds })` decides everything
before a byte moves:

| Situation at the destination | Decision | Destination used |
| --- | --- | --- |
| nothing there | `add` | the entry's path (or the prior import's path, if the ledger has one) |
| byte-identical to the entry | `skip` (reason `identical`) | unchanged |
| this device's prior copy of THIS entry, unmodified since | `replace` | that same path |
| anything else — another file, or the prior copy after a local edit | `duplicate` | `Name (package-id).md`, then ` 2`, ` 3`… |
| the entry itself is invalid | `unsupported` | — (and the package is refused) |

**An unrelated note is never overwritten.** `replace` is the only destructive
decision and it requires the device-local **ledger** (`packages/ledger.ts`) to
say "I wrote this file, from this package" AND the bytes on disk to still be
the ones it wrote. A file the user edited since becomes a `duplicate`, not a
replace. Losing the ledger degrades every decision to the safe one.

`preview.errors` is fatal: non-empty means `applyImport` refuses.
`preview.compatibility` is reported separately so the UI can say "this package
needs a newer Noam" rather than "invalid package". `preview.dependencies`
resolves each declared dependency against the package itself, the vault
(`host.exists`) and the workflow ids the caller passes in
(`existingWorkflowIds`, from the command service — the host cannot scan).

### Idempotence

Re-importing the same package is a **no-op**: every entry hashes equal to what
is on disk, so every item is `skip` and `preview.idempotent` is true; applying
that preview writes nothing. This falls out of the hash comparison — it is not
a special case. A renamed `duplicate` is remembered in the ledger under the
path the manifest asked for, so the second import skips it instead of piling up
` 2`, ` 3`, ` 4`.

## 3. Atomic apply and recovery

`applyImport(preview, pkg, host, { ledger })`, in order:

1. refuse outright when `preview.errors` is non-empty — nothing is written;
2. **re-check every destination against what the preview SAW there**
   (`ImportPreviewItem.destinationSha256`; `null` = "nothing was there"). A destination created
   or edited while the preview was on screen returns
   `{ ok: false, rolledBack: true, failedAt }` with nothing written and no recovery record — the
   user re-previews and sees the real decision instead of silently losing that file;
3. read the CURRENT bytes of every path the import will touch;
4. **write the `ImportRecoveryRecord` BEFORE the first write** (pre-import
   content for every path, `null` for the ones that did not exist). If the
   record cannot be stored, the import does not happen at all;
5. create the destination folders;
6. write the entries in preview order, updating the record's `written` list;
7. on ANY failure, restore every path written so far — original bytes back, or
   delete if the path did not exist — and return
   `{ ok: false, rolledBack: true, failedAt }`. If the rollback ITSELF fails,
   return `{ ok: false, rolledBack: false, recoveryRecord: "<path>" }` and keep
   the record, so a person can finish by hand;
8. on success, delete the record and write the ledger entry.

Rollback leaves the folders it created; an empty folder is harmless, an
unwritten note is not.

### Where the recovery record lives (and why it is not a file)

It is **device-local, in `localStorage`**, keyed
`context.workflowPackages.recovery:<vault>:<packageId>:<startedAt>`
(`packages/hostAdapter.ts`, `listRecoveryRecords()` enumerates unfinished
imports for a "the last import did not finish" banner).

Nothing on today's IPC surface can hold it properly:

- `write_binary_file` → `ensure_attachment_rel` refuses anything outside
  `attachments/`;
- `write_note` *would* write `.context/recovery/x.json` (`resolve_in_vault`
  permits `.context/`), but it then calls `index.index_note` on what it wrote,
  putting the private store into the SQLite index — exactly what `.context/`
  exists to prevent;
- `delete_file` refuses `.context/` outright, so such a record could never be
  cleaned up;
- `write_trash_copy` can write under `.context/trash/<stamp>/`, but that is the
  deleted-notes area people restore from, not scratch space;
- `set_vault_config` / `set_vault_types` own their own files and travel with
  the vault.

Writing it into the vault proper was rejected: it would appear in the sidebar,
the index and the sync registry.

**Limitation, stated plainly:** `localStorage` is per-device, bounded (~5 MB)
and not durable against a profile wipe. A quota failure makes
`writeRecoveryRecord` throw, and `applyImport` then refuses to write anything —
fail-safe, but it means a very large package (many big originals) can be
refused outright. When Rust grows a command that can write AND delete an
arbitrary file under `.context/`, only `hostAdapter.ts` changes.

### A Markdown destination is a note, not a file

`createPackageHost` refuses a `.md` write unless `permissionForPath` (the same
derivation the engine and the editor use) says `edit`, so an import can never
overwrite a note under a read-only lock or a view-only grant — the refusal
throws, and `applyImport` rolls the whole import back. When the destination is
the note **open in the editor** it is replaced through the live CodeMirror view
as ONE transaction, so Yjs, the bridge, the index and every open teammate see it
exactly as they see typing; a raw `write_note` behind an open collaborative
editor would be clobbered by the live document on its next egest. A closed note
keeps `write_note`, which the watcher/sync layer treats as an external writer.

## 4. Export

Workflow notes the registry could not read (or that do not validate) are listed
**disabled, with the reason** in the export picker and are never put into a
package: an entry without a valid workflow `id` builds fine and then fails
`validatePackage` on import.

`exportPackage(selection, host)` reads the chosen files — `.md` as utf8,
everything else as base64 — computes each `sha256` over the decoded bytes, and
builds a manifest with `minAppVersion = host.appVersion()`. A workflow entry
without an explicit `id` takes it from the note's own JSON fence.
`serializePackage(pkg)` renders the file; `parsePackage(text)` shape-checks it
back (`{ pkg }` or `{ error }`) and leaves the real judgement to the validator.
Export → serialize → parse → import reproduces every body and hash, base64
assets included.

## 5. QuickAdd import — the supported subset

`convertQuickAdd(json)` reads a QuickAdd `data.json` **as data** and returns
`{ workflows, report }`. Every choice it meets gets a report row:
`converted` | `skipped` | `unsupported`, with a reason and a bounded
`sourceExcerpt` (≤ 200 characters).

**This is not QuickAdd compatibility and it never will be.** Nothing from the
source is executed — no `eval`, no `new Function`, no Templater, no user
script, ever. A pinned test proves neither `eval` nor `Function` is called
during a conversion.

### What converts

| QuickAdd | Noam |
| --- | --- |
| `Template` choice | `create-note` (folder + file-name format + `templatePath`) |
| `folder.folders` (exactly one, non-interactive) | the destination folder |
| `fileNameFormat.format` | the destination file name (`.md` appended) |
| `fileExistsMode: "Increment the file name"` | `onExists: "suffix"` |
| `fileExistsMode: "Nothing"` | `onExists: "open"` (reported as a change) |
| `openFile` | `open` (and an `open-note` step after a capture) |
| `Capture` choice | `append` |
| `captureToActiveFile` | `target: "current"` |
| `captureTo` | `target: { path }` |
| `insertAfter.enabled` / `.after` | `heading` |
| `prepend` | `position: "start"` |
| `task` | a `- [ ] ` prefix on the content |
| `createFileIfItDoesntExist` | `createIfMissing` (`template` when it had one) |
| `Multi` choice | its children, each converted on its own |
| `Macro` choice | a `run-workflow` sequence — ONLY when every command is `NestedChoice`/`Template`/`Capture`/`Choice`; each nested choice becomes its own workflow note |
| `{{DATE}}`, `{{DATE:fmt}}` | `{{date}}`, `{{date:fmt}}` |
| `{{TIME}}`, `{{TIME:fmt}}` | `{{time}}`, `{{time:fmt}}` |
| `{{VALUE}}`, `{{NAME}}` | `{{value}}` + a prompted variable |
| `{{VALUE:Label}}` | `{{label}}` (slugified) + a prompted variable |
| `{{TITLE}}`, `{{CLIPBOARD}}`, `{{SELECTED}}` | `{{title}}`, `{{clipboard}}`, `{{selection}}` |

Ids come from the choice name (slugified, deduplicated `name`, `name-2`, …);
notes are written to `Workflows/<Name>.md` (deduplicated `Name 2.md`).

### What is NOT supported

Every item below is reported with a reason and an excerpt; none of it is
guessed at.

- **User scripts** (`UserScript`) — arbitrary JavaScript. One in a macro
  refuses the WHOLE macro, naming the script file.
- **Obsidian commands** (`Obsidian`), **editor commands** (`EditorCommand`),
  **waits** (`Wait`) — same refusal, same itemisation.
- **Templater** anywhere: `<% … %>`, `{{TEMPLATER:…}}`.
- **`{{MACRO:…}}`, `{{TEMPLATE:…}}`, `{{FIELD:…}}`, `{{MATH}}`, `{{VDATE:…}}`**
  and any other unknown `{{TOKEN}}` — refused rather than passed through as
  literal text.
- **Date formats outside `DATE_FORMAT_TOKENS`** (`YYYY YY MM DD HH mm ss ddd
  MMM`): `dddd`, `Do`, `[literals]`, week numbers, locale formats.
- **Interactive folder pickers**: `folder.chooseWhenCreatingNote`,
  `chooseFromSubfolders`, `createInSameFolderAsActiveFile`, or more than one
  folder offered.
- **`fileExistsMode`**: `Overwrite the file`, `Append to the bottom of the
  file`, `Append to the top of the file` — Noam has no step that overwrites.
- **`appendLink`**, `insertAfter.createIfNotFound`, `insertAfter.insertAtEnd`,
  open-in-new-tab/pane and other window options — dropped, and named in the
  report row of an otherwise converted choice.
- QuickAdd plugin settings themselves (`inputPrompt`, `devMode`,
  `templateFolderPath`, …) — nothing to convert.

## 6. Using it from the UI

```ts
// Import
const parsed = parsePackage(await fileText);          // { pkg } | { error }
const host = createPackageHost({ appVersion, epoch, vaultKey });
const ledger = new PackageLedger(localStorageLedgerStore(vaultKey));
const preview = await previewImport(parsed.pkg, host, {
  ledger,
  existingWorkflowIds: commandService.list().map((w) => w.id),
});
// render preview.items / .dependencies / .compatibility / .errors / .idempotent
const outcome = await applyImport(preview, parsed.pkg, host, { ledger });

// Export
const pkg = await exportPackage({ id, name, version, description, entries }, host);
const text = serializePackage(pkg);                   // save as `<name>.noam-package.json`

// QuickAdd
const { workflows, report } = convertQuickAdd(JSON.parse(dataJsonText));
// write each workflow.markdown to workflow.path (create-only), then show `report`
```
