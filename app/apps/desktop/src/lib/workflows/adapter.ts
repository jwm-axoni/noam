/**
 * The production `WorkflowHost` — the engine's only door to this app.
 *
 * Everything above this file is pure and testable; everything below it is the
 * store, IPC and CodeMirror. Three decisions live here and nowhere else.
 *
 * 1. AN OPEN NOTE IS EDITED THROUGH ITS LIVE VIEW. A write to the note on
 *    screen is dispatched as an ordinary CodeMirror transaction, so it reaches
 *    the `.md`, the index and Yjs undo exactly like typing does, and a
 *    teammate's cursor maps through it. Writing the file instead would push a
 *    whole-file replacement past the CRDT and clobber whatever they were doing.
 *    A CLOSED note takes the GUARDED note-write path
 *    (`ipc.writeNoteIfUnchanged`), which the watcher/sync layer already treats
 *    as an external writer and merges — conditional because the compare and
 *    the write have to be one operation, or an external writer fits between
 *    them.
 *
 * 2. THE REVISION IS A HASH OF THE TEXT WE ARE ABOUT TO EDIT. Not the index's
 *    stored sha (which is as old as the last re-index) and not a mtime. It is
 *    taken from the SAME source the write will go to — the live document for an
 *    open note, the file for a closed one — so `stale-target` means the text
 *    moved, never that two subsystems disagreed.
 *
 * 3. PERMISSION MIRRORS THE EDITOR. `Editor.tsx` decides read-only from the
 *    local lock overlay plus the doc's sync verdict; the same derivation is
 *    reused here (`lockScopesByPath` + `effectiveLockForPath`), so a workflow
 *    can never write to a note the editor is painting with a padlock.
 */

import type { EditorView } from "@codemirror/view";
import * as ipc from "../ipc";
import { useStore } from "../../store";
import { effectiveLockForPath, lockScopesByPath } from "../locks";
import { getActiveNote, insertIntoActiveNote } from "../editor/activeView";
import { sha256Hex } from "../bridge/adapter";
import type {
  CommandService,
  ExecutionFailureKind,
  PermissionLevel,
  ResolvedTarget,
  WorkflowHost,
  WorkflowId,
} from "./contracts";
import { createCommandService } from "./engine/registry";

/** Where a capture goes when the write it was meant for could not happen. */
export const CAPTURES_FOLDER = "Captures";

/** The epoch of the vault open RIGHT NOW (see `ipc.VaultEpoch`). */
function epoch(): ipc.VaultEpoch {
  return useStore.getState().vault?.epoch ?? null;
}

/** The path of the vault open right now — the other half of its identity. */
function vaultPath(): string | null {
  return useStore.getState().vault?.path ?? null;
}

/** The live view for `path`, or null when that note is not the one on screen. */
function liveView(path: string): EditorView | null {
  const active = getActiveNote();
  if (!active || active.path !== path) return null;
  // `ActiveNote.editorView` is deliberately typed `unknown` so the eager
  // sidebar bundle never imports CodeMirror. This module is only reached from
  // workflow code, which is lazy, so the cast is safe here.
  return (active.editorView as EditorView | null) ?? null;
}

function liveText(path: string): string | null {
  const view = liveView(path);
  return view ? view.state.doc.toString() : null;
}

/**
 * What this user may do to `path`, from the state the sidebar and editor
 * already agree on. A local vault has no ACL at all, so it is always `edit`.
 */
export function permissionForPath(path: string): PermissionLevel {
  const state = useStore.getState();
  if (!state.syncEnabled) return "edit";
  // `syncStatus` is the OPEN note's provider verdict — a per-document grant,
  // not a vault posture (`sync/syncManager.ts`). Applying it to every target
  // would stop a workflow appending to a note this user may edit just because
  // the note on screen happens to be view-only.
  const isOpenNote = state.openNote?.path === path;
  if (isOpenNote && state.syncStatus === "no-access") return "none";
  const locked = effectiveLockForPath(
    lockScopesByPath(state.tree, state.locks, state.session?.user.id, state.lifts),
    path,
  );
  if (locked) return "view";
  return isOpenNote && state.syncStatus === "read-only" ? "view" : "edit";
}

/** Is `name` a folder directly under the vault root, in the tree we hold? */
function topLevelFolderExists(tree: ipc.TreeNode | null, name: string): boolean {
  const wanted = name.toLowerCase();
  return (tree?.children ?? []).some(
    (node) => node.isDir && node.path.toLowerCase() === wanted,
  );
}

/**
 * Why a note at `path` cannot be CREATED while this vault's root is frozen, or
 * null when it can.
 *
 * The same latch the sidebar's New note obeys (`store.ts rootCreateBlocked`,
 * `FileTree.tsx rootBlocked`). Client-side purely so the user gets a sentence:
 * the server is the authority and refuses to register a root-level item, which
 * would leave a workflow's note permanently unsyncable. A new TOP-LEVEL folder
 * is a root create by another name — `ensureFolder` would make it — so a path
 * whose first segment is not already a folder is refused too.
 */
export function frozenRootReason(path: string): string | null {
  const state = useStore.getState();
  if (!state.rootFrozen) return null;
  const folder = folderOf(path);
  if (folder === "") {
    return `This vault's root is frozen, so "${path}" cannot be created there — put it inside a folder.`;
  }
  const top = folder.split("/")[0]!;
  if (!topLevelFolderExists(state.tree, top)) {
    return `This vault's root is frozen, so the new top-level folder "${top}" cannot be created — use a folder that is already there.`;
  }
  return null;
}

/** The folder part of a vault-relative path; "" at the root. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** `2026-03-09 14-03-07` — sortable, and legal on every filesystem we ship on. */
function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  );
}

async function readFromDisk(path: string, at: ipc.VaultEpoch = epoch()): Promise<string | null> {
  try {
    return await ipc.readNote(path, at);
  } catch {
    return null;
  }
}

/**
 * Build the production host, PINNED to the vault that is open right now.
 *
 * A run is a sequence of awaits — a template render, a prompt, a file read —
 * and the user can open another vault in the middle of one. The store is a
 * single global slot, so an unpinned host would resolve `Journal/Today.md`
 * against whichever vault happens to be current when each step lands, and a
 * step would create or append in a vault the workflow was never started in.
 * So: the epoch AND the path are captured here, every ipc call quotes that
 * epoch (Rust refuses a mismatch, `state::Inner::vault_epoch`), and the three
 * operations that reach disk refuse locally first, with a sentence the run
 * report can show.
 */
export function createWorkflowHost(): WorkflowHost {
  const pinnedEpoch = epoch();
  const pinnedPath = vaultPath();
  const movedOn = (): boolean => epoch() !== pinnedEpoch || vaultPath() !== pinnedPath;
  const switchedMessage = (path: string) =>
    `"${path}" belongs to a vault that is no longer open; the workflow was stopped.`;

  return {
    async resolveTarget(path: string): Promise<ResolvedTarget> {
      // Nothing true can be said about a path in a vault we no longer hold, so
      // it is reported as present-but-forbidden: every caller then takes the
      // permission path instead of trying to create it.
      if (movedOn()) {
        return {
          path,
          docId: null,
          exists: true,
          permission: "none",
          permissionReason: switchedMessage(path),
          revision: null,
        };
      }
      const live = liveText(path);
      const text = live ?? (await readFromDisk(path, pinnedEpoch));
      const meta = text === null ? null : await ipc.getNoteMeta(path, pinnedEpoch).catch(() => null);
      // A frozen root only bars CREATING something; an existing root note is
      // edited like any other.
      const frozen = text === null ? frozenRootReason(path) : null;
      return {
        path,
        docId: meta?.id ?? null,
        exists: text !== null,
        permission: frozen === null ? permissionForPath(path) : "none",
        ...(frozen === null ? {} : { permissionReason: frozen }),
        // Hashed from the very text the write will be checked against, so a
        // mismatch can only mean the text moved.
        revision: text === null ? null : await sha256Hex(text),
      };
    },

    currentNotePath(): string | null {
      return getActiveNote()?.path ?? useStore.getState().openNote?.path ?? null;
    },

    async readNote(path: string): Promise<string | null> {
      if (movedOn()) return null;
      return liveText(path) ?? (await readFromDisk(path, pinnedEpoch));
    },

    async createNote(path: string, content: string): Promise<ResolvedTarget> {
      // Before `ensureFolder`, which would create the top-level folder the
      // latch exists to refuse.
      if (movedOn()) throw new Error(switchedMessage(path));
      const frozen = frozenRootReason(path);
      if (frozen !== null) throw new Error(frozen);
      const folder = folderOf(path);
      if (folder !== "") await ipc.ensureFolder(folder, pinnedEpoch);
      // Create-only: the engine checked, but between its check and this call a
      // teammate's pull could have materialized the same path.
      const created = await ipc.writeNoteIfMissing(path, content, pinnedEpoch);
      if (!created) throw new Error(`"${path}" appeared before it could be created`);
      return {
        path,
        docId: (await ipc.getNoteMeta(path, pinnedEpoch).catch(() => null))?.id ?? null,
        exists: true,
        permission: permissionForPath(path),
        revision: await sha256Hex(content),
      };
    },

    async replaceRange(
      path: string,
      expectedRevision: string,
      from: number,
      to: number,
      insert: string,
    ): Promise<{ ok: true; revision: string } | { ok: false; kind: ExecutionFailureKind; message: string }> {
      if (movedOn()) {
        return { ok: false, kind: "stale-target", message: switchedMessage(path) };
      }
      const permission = permissionForPath(path);
      if (permission === "none") return { ok: false, kind: "permission", message: `No access to "${path}".` };
      if (permission === "view") return { ok: false, kind: "read-only", message: `"${path}" is read-only.` };

      const view = liveView(path);
      if (view) {
        if (view.state.readOnly) {
          return { ok: false, kind: "read-only", message: `"${path}" is read-only.` };
        }
        const current = view.state.doc.toString();
        if ((await sha256Hex(current)) !== expectedRevision) {
          return { ok: false, kind: "stale-target", message: `"${path}" changed while the workflow ran.` };
        }
        if (to > current.length) {
          return { ok: false, kind: "stale-target", message: `"${path}" is shorter than expected.` };
        }
        // An ordinary transaction: Yjs, the bridge, the index and every open
        // teammate see it exactly as they see a keystroke.
        view.dispatch({ changes: { from, to, insert }, userEvent: "input.workflow" });
        return { ok: true, revision: await sha256Hex(view.state.doc.toString()) };
      }

      const current = await readFromDisk(path, pinnedEpoch);
      if (current === null) return { ok: false, kind: "missing-target", message: `"${path}" is gone.` };
      const revision = await sha256Hex(current);
      if (revision !== expectedRevision) {
        return { ok: false, kind: "stale-target", message: `"${path}" changed while the workflow ran.` };
      }
      const next = current.slice(0, from) + insert + current.slice(to);
      // CONDITIONAL, not a plain write: Rust re-reads and re-hashes the file
      // under the note-write lock, so an external writer that lands between
      // the read above and the write below is reported, never overwritten.
      try {
        const outcome = await ipc.writeNoteIfUnchanged(path, revision, next, pinnedEpoch);
        if (!outcome.ok) {
          return { ok: false, kind: "stale-target", message: `"${path}" changed while the workflow ran.` };
        }
      } catch (err) {
        return { ok: false, kind: "error", message: `Could not write "${path}": ${String(err)}` };
      }
      return { ok: true, revision: await sha256Hex(next) };
    },

    async insertAtCaret(text: string): Promise<boolean> {
      return insertIntoActiveNote(text);
    },

    async openNote(path: string): Promise<void> {
      await useStore.getState().openNoteByPath(path);
    },

    /**
     * Park text that could not be written where a person will find it. Never
     * overwrites: a second failure in the same second takes the next suffix,
     * because the whole point is that nothing is lost.
     */
    async preserveCapture(workflowId: WorkflowId, content: string): Promise<string | null> {
      if (movedOn()) return null;
      try {
        await ipc.ensureFolder(CAPTURES_FOLDER, pinnedEpoch);
        const at = new Date();
        const body = `---\nnoam_kind: capture\nworkflow: ${workflowId}\ncaptured: ${at.toISOString()}\n---\n\n${content}\n`;
        const base = `${CAPTURES_FOLDER}/Unsaved capture ${stamp(at)}`;
        for (let n = 0; n < 20; n++) {
          const path = n === 0 ? `${base}.md` : `${base} ${n + 1}.md`;
          if (await ipc.writeNoteIfMissing(path, body, pinnedEpoch)) return path;
        }
        return null;
      } catch {
        return null;
      }
    },

    now(): Date {
      return new Date();
    },
  };
}

/** Every `.md` path in the vault, from the tree Rust already walks. */
async function listVaultNotes(): Promise<string[]> {
  const root = await ipc.listTree(epoch());
  const paths: string[] = [];
  const walk = (node: ipc.TreeNode): void => {
    if (node.isDir) {
      node.children?.forEach(walk);
      return;
    }
    if (node.path.toLowerCase().endsWith(".md")) paths.push(node.path);
  };
  root.children?.forEach(walk);
  return paths;
}

/**
 * The vault's command service, wired to this app. Build ONE of these per vault
 * and call `refresh()` after a vault open and on the `files-changed` batches
 * that touch a `.md`; every UI entry point then shares one registry.
 */
export function createVaultCommandService(
  reservedShortcuts?: ReadonlySet<string>,
): CommandService {
  return createCommandService({
    listNotes: listVaultNotes,
    readNote: readFromDisk,
    host: createWorkflowHost(),
    ...(reservedShortcuts ? { reservedShortcuts } : {}),
  });
}
