/**
 * The only door between a task action and the file.
 *
 * `resolveTask` re-finds a task in LIVE text and `applyTaskEdit` writes at the
 * span it found, guarded by a hash of that same text. Nothing else in the task
 * system is allowed to write, and no offset from the SQLite index ever reaches
 * a write — by the time a person clicks a checkbox the note may have been
 * edited by a teammate over CRDT, by an AI through MCP, or by hand in another
 * editor, and the indexed offset would then point at somebody else's line.
 *
 * The three decisions, the same three `workflows/adapter.ts` makes:
 *
 * 1. AN OPEN NOTE IS EDITED THROUGH ITS LIVE VIEW — one CodeMirror
 *    transaction, so the edit reaches the `.md`, the index and Yjs undo
 *    exactly like typing, and a teammate's cursor maps through it. A closed
 *    note takes the ordinary note-write path the watcher already merges.
 * 2. THE REVISION IS A HASH OF THE TEXT WE ARE ABOUT TO EDIT — the live
 *    document for an open note, the file for a closed one. `stale-target`
 *    therefore means the text moved, never that two subsystems disagreed.
 * 3. PERMISSION MIRRORS THE EDITOR. `permissionForPath` is imported rather
 *    than re-derived: a task can never write to a note the editor is painting
 *    with a padlock.
 */

import type { EditorView } from "@codemirror/view";
import * as ipc from "../ipc";
import { useStore } from "../../store";
import { getActiveNote } from "../editor/activeView";
import { sha256Hex } from "../bridge/adapter";
import { permissionForPath } from "../workflows/adapter";
import {
  TASK_ID_SUFFIX_RE,
  type ResolvedTask,
  type SpanChange,
  type Task,
  type TaskResolution,
  type TaskResolutionFailure,
} from "./contracts";
import { applyChanges, mergeChanges } from "./edit";
import { parseTaskLine } from "./parse";

/** What an action carries around: the hints plus the identity. */
export type TaskRef = Pick<Task, "path" | "docId" | "id" | "line" | "sourceText">;

export type TaskEditResult =
  | { ok: true; revision: string }
  | { ok: false; kind: TaskResolutionFailure; message: string };

function epoch(): ipc.VaultEpoch {
  return useStore.getState().vault?.epoch ?? null;
}

function liveView(path: string): EditorView | null {
  const active = getActiveNote();
  if (!active || active.path !== path) return null;
  // `ActiveNote.editorView` is typed `unknown` so the eager sidebar bundle
  // never imports CodeMirror; task code is lazy, so the cast is safe here.
  return (active.editorView as EditorView | null) ?? null;
}

function liveText(path: string): string | null {
  const view = liveView(path);
  return view ? view.state.doc.toString() : null;
}

async function readFromDisk(path: string): Promise<string | null> {
  try {
    return await ipc.readNote(path, epoch());
  } catch {
    return null;
  }
}

/** Live text if the note is open, the file otherwise. */
export async function taskNoteText(path: string): Promise<string | null> {
  return liveText(path) ?? (await readFromDisk(path));
}

interface LineHit {
  index: number;
  from: number;
  to: number;
  text: string;
}

function lines(text: string): LineHit[] {
  const out: LineHit[] = [];
  let offset = 0;
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i]!;
    const trimmed = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    out.push({ index: i, from: offset, to: offset + trimmed.length, text: trimmed });
    offset += raw.length + 1;
  }
  return out;
}

const fail = (kind: TaskResolutionFailure, message: string, matches?: number): TaskResolution => ({
  ok: false,
  kind,
  message,
  ...(matches === undefined ? {} : { matches }),
});

/**
 * Re-find `ref` in live text.
 *
 * By `^t-` id first, because that survives an edit to the line, a move to
 * another note and a rebuild. Without an id the line is found by an EXACT
 * `sourceText` match; a second identical line is reported as ambiguous rather
 * than picked, since guessing would complete somebody else's task.
 */
export async function resolveTask(ref: TaskRef): Promise<TaskResolution> {
  const permission = permissionForPath(ref.path);
  if (permission !== "edit") {
    return fail("read-only", `"${ref.path}" is read-only.`);
  }
  const text = await taskNoteText(ref.path);
  if (text === null) return fail("missing-target", `"${ref.path}" is gone.`);

  const all = lines(text);
  let hit: LineHit | null = null;
  if (ref.id) {
    const byId = all.filter((line) => TASK_ID_SUFFIX_RE.exec(line.text)?.[1] === ref.id);
    if (byId.length > 1) {
      return fail(
        "ambiguous-target",
        `${byId.length} lines in "${ref.path}" carry the id ${ref.id}; dedupe first.`,
        byId.length,
      );
    }
    hit = byId[0] ?? null;
  }
  if (!hit) {
    const byText = all.filter((line) => line.text === ref.sourceText);
    if (byText.length > 1) {
      return fail(
        "ambiguous-target",
        `${byText.length} identical lines in "${ref.path}"; give one an id first.`,
        byText.length,
      );
    }
    hit = byText[0] ?? null;
  }
  if (!hit) {
    return fail("missing-target", `That task is no longer in "${ref.path}".`);
  }

  const docId = ref.docId || (await ipc.getNoteMeta(ref.path, epoch()).catch(() => null))?.id || "";
  const task = parseTaskLine(hit.text, {
    docId,
    path: ref.path,
    line: hit.index,
    from: hit.from,
  });
  if (!task) {
    return fail("stale-target", `That line in "${ref.path}" is no longer a task.`);
  }

  const resolved: ResolvedTask = {
    path: ref.path,
    docId,
    from: hit.from,
    to: hit.to,
    sourceText: hit.text,
    task,
    // Hashed from the very text the write will be checked against, so a
    // mismatch can only mean the text moved.
    revision: await sha256Hex(text),
  };
  return { ok: true, resolved };
}

/**
 * Apply a plan to the note `resolved` came from, as ONE edit.
 *
 * The revision check and the write are as close together as the platform
 * allows: for an open note they are the same tick (hash, then dispatch); for a
 * closed one the file is re-read here rather than trusted from resolution
 * time, and the write itself is CONDITIONAL on that same hash
 * (`ipc.writeNoteIfUnchanged`) so the compare and the write are one operation
 * in Rust.
 */
export async function applyTaskEdit(
  resolved: ResolvedTask,
  changes: SpanChange[],
): Promise<TaskEditResult> {
  const plan = mergeChanges(changes);
  if (plan.length === 0) return { ok: true, revision: resolved.revision };

  const permission = permissionForPath(resolved.path);
  if (permission !== "edit") {
    return { ok: false, kind: "read-only", message: `"${resolved.path}" is read-only.` };
  }

  const view = liveView(resolved.path);
  if (view) {
    if (view.state.readOnly) {
      return { ok: false, kind: "read-only", message: `"${resolved.path}" is read-only.` };
    }
    const current = view.state.doc.toString();
    if ((await sha256Hex(current)) !== resolved.revision) {
      return {
        ok: false,
        kind: "stale-target",
        message: `"${resolved.path}" changed; refresh and try again.`,
      };
    }
    if (plan[plan.length - 1]!.to > current.length) {
      return {
        ok: false,
        kind: "stale-target",
        message: `"${resolved.path}" is shorter than expected.`,
      };
    }
    // ONE transaction: one undo step, one CRDT update, one re-index.
    view.dispatch({ changes: plan, userEvent: "input.task" });
    return { ok: true, revision: await sha256Hex(view.state.doc.toString()) };
  }

  const current = await readFromDisk(resolved.path);
  if (current === null) {
    return { ok: false, kind: "missing-target", message: `"${resolved.path}" is gone.` };
  }
  if ((await sha256Hex(current)) !== resolved.revision) {
    return {
      ok: false,
      kind: "stale-target",
      message: `"${resolved.path}" changed; refresh and try again.`,
    };
  }
  const next = applyChanges(current, plan);
  // CONDITIONAL, not a plain write: Rust re-reads and re-hashes the file under
  // the note-write lock, so a teammate, an AI over MCP or another editor that
  // published between the read above and this call is reported as stale rather
  // than silently overwritten.
  try {
    const outcome = await ipc.writeNoteIfUnchanged(
      resolved.path,
      resolved.revision,
      next,
      epoch(),
    );
    if (!outcome.ok) {
      return {
        ok: false,
        kind: "stale-target",
        message: `"${resolved.path}" changed; refresh and try again.`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      kind: "missing-target",
      message: `Could not write "${resolved.path}": ${String(err)}`,
    };
  }
  return { ok: true, revision: await sha256Hex(next) };
}

/** Resolve and write in one call — the shape every UI action wants. */
export async function editTask(
  ref: TaskRef,
  plan: (resolved: ResolvedTask) => SpanChange[] | Promise<SpanChange[]>,
): Promise<TaskEditResult> {
  const resolution = await resolveTask(ref);
  if (!resolution.ok) {
    return { ok: false, kind: resolution.kind, message: resolution.message };
  }
  return applyTaskEdit(resolution.resolved, await plan(resolution.resolved));
}
