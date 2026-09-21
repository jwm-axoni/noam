// An in-memory WorkflowHost. The engine tests are pure: no Tauri, no store, no
// CodeMirror view — the host IS the whole outside world, so every refusal the
// engine has to handle (a locked note, a revision that moved, a note that is
// not there) is one option away.

import { createHash } from "node:crypto";
import type {
  ExecutionFailureKind,
  PermissionLevel,
  ResolvedTarget,
  WorkflowHost,
  WorkflowId,
} from "../../contracts";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface FakeNote {
  text: string;
  permission?: PermissionLevel;
}

export interface FakeHostOptions {
  notes?: Record<string, string | FakeNote>;
  /** The note the editor has open. `null` means the action picker with none. */
  currentPath?: string | null;
  /** Permission at a path that does not exist yet — where a create would land. */
  permissionForNewPaths?: PermissionLevel;
  now?: Date;
  /** Is there a live editor to receive an `insert` step? */
  hasEditor?: boolean;
  /**
   * Fired at the END of `resolveTarget`, after the snapshot it returns has been
   * taken. Mutating the vault here is exactly the race the engine's
   * re-resolve-then-write rule exists for.
   */
  afterResolve?: (path: string, host: FakeHost) => void;
}

export interface HostCall {
  op: "resolveTarget" | "readNote" | "createNote" | "replaceRange" | "insertAtCaret" | "openNote" | "preserveCapture";
  path: string;
}

export class FakeHost implements WorkflowHost {
  readonly notes = new Map<string, FakeNote>();
  readonly calls: HostCall[] = [];
  readonly opened: string[] = [];
  readonly captures: Array<{ workflowId: WorkflowId; path: string; content: string }> = [];
  /** Caret insertions, in order, for the `insert` step. */
  readonly caretInserts: string[] = [];
  currentPath: string | null;
  hasEditor: boolean;

  private readonly options: FakeHostOptions;
  private docSeq = 0;

  constructor(options: FakeHostOptions = {}) {
    this.options = options;
    this.currentPath = options.currentPath ?? null;
    this.hasEditor = options.hasEditor ?? options.currentPath != null;
    for (const [path, note] of Object.entries(options.notes ?? {})) {
      this.notes.set(path, typeof note === "string" ? { text: note } : { ...note });
    }
  }

  /** Change a note behind the engine's back — the stale-target setup. */
  setNote(path: string, text: string, permission?: PermissionLevel): void {
    const existing = this.notes.get(path);
    this.notes.set(path, { text, permission: permission ?? existing?.permission });
  }

  textOf(path: string): string | undefined {
    return this.notes.get(path)?.text;
  }

  private permissionOf(path: string): PermissionLevel {
    const note = this.notes.get(path);
    if (note) return note.permission ?? "edit";
    return this.options.permissionForNewPaths ?? "edit";
  }

  async resolveTarget(path: string): Promise<ResolvedTarget> {
    this.calls.push({ op: "resolveTarget", path });
    const note = this.notes.get(path);
    const resolved: ResolvedTarget = {
      path,
      docId: note ? `doc-${path}` : null,
      exists: note !== undefined,
      permission: this.permissionOf(path),
      revision: note ? sha256Hex(note.text) : null,
    };
    this.options.afterResolve?.(path, this);
    return resolved;
  }

  currentNotePath(): string | null {
    return this.currentPath;
  }

  async readNote(path: string): Promise<string | null> {
    this.calls.push({ op: "readNote", path });
    return this.notes.get(path)?.text ?? null;
  }

  async createNote(path: string, content: string): Promise<ResolvedTarget> {
    this.calls.push({ op: "createNote", path });
    if (this.notes.has(path)) throw new Error(`createNote: ${path} already exists`);
    this.notes.set(path, { text: content });
    this.docSeq += 1;
    return {
      path,
      docId: `doc-${this.docSeq}`,
      exists: true,
      permission: this.permissionOf(path),
      revision: sha256Hex(content),
    };
  }

  async replaceRange(
    path: string,
    expectedRevision: string,
    from: number,
    to: number,
    insert: string,
  ): Promise<{ ok: true; revision: string } | { ok: false; kind: ExecutionFailureKind; message: string }> {
    this.calls.push({ op: "replaceRange", path });
    const note = this.notes.get(path);
    if (!note) return { ok: false, kind: "missing-target", message: `${path} is gone` };
    const permission = note.permission ?? "edit";
    if (permission === "none") return { ok: false, kind: "permission", message: `no access to ${path}` };
    if (permission === "view") return { ok: false, kind: "read-only", message: `${path} is read-only` };
    if (sha256Hex(note.text) !== expectedRevision) {
      return { ok: false, kind: "stale-target", message: `${path} changed underneath the workflow` };
    }
    const next = note.text.slice(0, from) + insert + note.text.slice(to);
    this.notes.set(path, { ...note, text: next });
    return { ok: true, revision: sha256Hex(next) };
  }

  async insertAtCaret(text: string): Promise<boolean> {
    this.calls.push({ op: "insertAtCaret", path: this.currentPath ?? "" });
    if (!this.hasEditor || this.currentPath === null) return false;
    const note = this.notes.get(this.currentPath);
    if (!note || (note.permission ?? "edit") !== "edit") return false;
    this.caretInserts.push(text);
    this.notes.set(this.currentPath, { ...note, text: note.text + text });
    return true;
  }

  async openNote(path: string): Promise<void> {
    this.calls.push({ op: "openNote", path });
    this.opened.push(path);
    this.currentPath = path;
  }

  async preserveCapture(workflowId: WorkflowId, content: string): Promise<string | null> {
    const path = `Captures/Unsaved capture ${this.captures.length + 1}.md`;
    this.calls.push({ op: "preserveCapture", path });
    this.captures.push({ workflowId, path, content });
    this.notes.set(path, { text: content });
    return path;
  }

  now(): Date {
    return this.options.now ?? new Date(2026, 2, 9, 14, 3, 7);
  }
}
