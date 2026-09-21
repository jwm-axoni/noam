// The production `PackageHost`: the package service's only door to the disk.
//
// Every file operation is one of the vault-scoped Rust commands, epoch-pinned
// like the rest of the app, so path safety, atomic writes and re-indexing all
// come from the layer that already owns them. Two boundaries are inherited,
// not invented here: `write_binary_file` refuses anything outside
// `attachments/` (so binary entries must live there — `paths.ts` says the same
// thing at validation time), and `delete_file` refuses directories and
// `.context/`.
//
// WHERE THE RECOVERY RECORD LIVES — and why it is not a file.
//
// The record must survive a crash, must not appear in the vault (a JSON blob
// in the sidebar, the index and the sync registry is worse than no record) and
// must be deletable once the import lands. Nothing on the IPC surface can do
// that today:
//   - `write_binary_file` → `ensure_attachment_rel` rejects `.context/…`;
//   - `write_note` WOULD write `.context/recovery/x.json` (`resolve_in_vault`
//     permits it) but then calls `index.index_note` on it, putting the private
//     store into the SQLite index — the one thing `.context/` exists to avoid;
//   - `delete_file` refuses `.context/` outright, so such a record could never
//     be cleaned up;
//   - `write_trash_copy` can write under `.context/trash/<stamp>/`, but that
//     is the deleted-notes area a person restores from, not a scratch space;
//   - `set_vault_config` / `set_vault_types` own their own files and travel
//     with the vault.
//
// A MARKDOWN DESTINATION IS A NOTE, NOT A FILE. An import that lands on a `.md`
// obeys the two rules every other write in this app obeys (`workflows/adapter.ts`
// says the same thing for the engine): it is refused unless this user may EDIT
// that path — a note under a read-only lock or a view-only grant is never
// overwritten, and the refusal travels up as a throw so `applyImport` rolls the
// whole import back — and when the destination is the note on screen it is
// replaced through the LIVE editor, as one transaction, so Yjs/the bridge/the
// index/teammates see it like typing. A raw `write_note` behind an open
// collaborative editor would be clobbered by the live document on its next
// egest, or worse, propagated as a whole-file replacement. A closed note keeps
// `write_note`, which the watcher/sync layer already treats as an external
// writer and merges.
//
// So the record is DEVICE-LOCAL, in `localStorage`, namespaced per vault. It
// survives a reload and a crash, which is what the rollback story needs, and
// `listRecoveryRecords` lets a "last import did not finish" banner find it.
// The limitation is real and deliberate: a `localStorage` quota failure makes
// `writeRecoveryRecord` throw, and `applyImport` then refuses to write
// anything at all. When Rust grows a command that can write and delete an
// arbitrary file under `.context/`, only this file changes.

import type { EditorView } from "@codemirror/view";
import * as ipc from "../../ipc";
import { getActiveNote } from "../../editor/activeView";
import type { ImportRecoveryRecord, PackageHost } from "../contracts";
import { permissionForPath } from "../adapter";

const RECOVERY_PREFIX = "context.workflowPackages.recovery";

/** The key/value slice the recovery store needs. */
export interface RecoveryStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

export function memoryRecoveryStore(): RecoveryStore {
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key) ?? null,
    write: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()],
  };
}

export function localStorageRecoveryStore(): RecoveryStore {
  const storage = () => (globalThis as { localStorage?: Storage }).localStorage ?? null;
  return {
    read: (key) => storage()?.getItem(key) ?? null,
    // Deliberately NOT swallowed: a record we could not store must stop the import.
    write: (key, value) => storage()?.setItem(key, value),
    remove: (key) => storage()?.removeItem(key),
    keys: () => {
      const s = storage();
      if (!s) return [];
      const out: string[] = [];
      for (let i = 0; i < s.length; i += 1) {
        const key = s.key(i);
        if (key?.startsWith(RECOVERY_PREFIX)) out.push(key);
      }
      return out;
    },
  };
}

/** Unfinished imports this device knows about, newest last. */
export function listRecoveryRecords(
  store: RecoveryStore = localStorageRecoveryStore(),
): Array<{ path: string; record: ImportRecoveryRecord }> {
  const out: Array<{ path: string; record: ImportRecoveryRecord }> = [];
  for (const key of store.keys().sort()) {
    if (!key.startsWith(RECOVERY_PREFIX)) continue;
    const raw = store.read(key);
    if (!raw) continue;
    try {
      out.push({ path: key, record: JSON.parse(raw) as ImportRecoveryRecord });
    } catch {
      /* a corrupt record is not a reason to hide the others */
    }
  }
  return out;
}

/** The live view for `path`, or null when that note is not the one on screen. */
function liveView(path: string): EditorView | null {
  const active = getActiveNote();
  if (!active || active.path !== path) return null;
  // `ActiveNote.editorView` is deliberately typed `unknown` so the eager
  // sidebar bundle never imports CodeMirror; package code is lazy, so the cast
  // is safe here (same reasoning as `workflows/adapter.ts`).
  return (active.editorView as EditorView | null) ?? null;
}

/** Is this destination an ordinary note, rather than an attachment? */
function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/**
 * Write a note the way the rest of the app writes notes. Throws rather than
 * reports: every caller is inside `applyImport`, whose answer to a failed write
 * is to put the vault back.
 */
async function writeNoteThroughApp(
  path: string,
  content: string,
  epoch: ipc.VaultEpoch,
): Promise<void> {
  const permission = permissionForPath(path);
  if (permission === "none") throw new Error(`you do not have access to "${path}"`);
  if (permission === "view") throw new Error(`"${path}" is read-only`);

  const view = liveView(path);
  if (!view) {
    await ipc.writeNote(path, content, epoch);
    return;
  }
  if (view.state.readOnly) throw new Error(`"${path}" is read-only`);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    userEvent: "input.workflow",
  });
}

export interface PackageHostOptions {
  /** `await getVersion()` from `@tauri-apps/api/app`; `PackageHost.appVersion` is sync. */
  appVersion: string;
  /** Pins every call to ONE vault, like the rest of the app's disk access. */
  epoch?: ipc.VaultEpoch;
  /** Namespaces the recovery keys; the vault path or id. */
  vaultKey?: string;
  recoveryStore?: RecoveryStore;
}

export function createPackageHost(options: PackageHostOptions): PackageHost {
  const { appVersion, epoch, vaultKey = "default" } = options;
  const store = options.recoveryStore ?? localStorageRecoveryStore();
  const keyFor = (record: ImportRecoveryRecord) =>
    `${RECOVERY_PREFIX}:${vaultKey}:${record.packageId}:${record.startedAt}`;

  return {
    async exists(path) {
      return ipc.noteExists(path, epoch).catch(() => false);
    },
    async readText(path) {
      return ipc.readNote(path, epoch).catch(() => null);
    },
    async readBytes(path) {
      return ipc.readBinaryFile(path, epoch).catch(() => null);
    },
    async writeText(path, content) {
      if (isMarkdown(path)) {
        await writeNoteThroughApp(path, content, epoch);
        return;
      }
      await ipc.writeNote(path, content, epoch);
    },
    async writeBytes(path, bytes) {
      await ipc.writeBinaryFile(path, bytes, epoch);
    },
    async remove(path) {
      await ipc.deleteFile(path, epoch);
    },
    async ensureFolder(path) {
      await ipc.ensureFolder(path, epoch);
    },
    async writeRecoveryRecord(record) {
      const key = keyFor(record);
      try {
        store.write(key, JSON.stringify(record));
      } catch (e) {
        throw new Error(`could not store the import recovery record: ${String(e)}`);
      }
      return key;
    },
    async deleteRecoveryRecord(path) {
      store.remove(path);
    },
    appVersion() {
      return appVersion;
    },
  };
}
