// A tiny registry for "the note editor that's currently on screen" so code
// outside the Editor component (e.g. the sidebar's global drag-drop handler)
// can drop an embed into the open note at the caret. The Editor sets this when
// it mounts a view and clears it on teardown.
//
// Deliberately CodeMirror-free: the sidebar is eager and imports this module,
// so a value import of `@codemirror/state` here would drag CodeMirror into the
// startup chunk. The CodeMirror half lives in `activeNoteBinding.ts`, which
// only the (lazy) Editor imports.

export interface ActiveNote {
  path: string;
  /** Opaque here so eager sidebar code does not import CodeMirror at runtime. */
  editorView: unknown;
  /** True when the note can receive an insert (not a preview, not locked). */
  editable: () => boolean;
  /** Insert markdown at the caret, on its own line. */
  insert: (md: string) => boolean;
  /** Put the caret on a 0-based line and scroll it into view. */
  revealLine: (line: number) => boolean;
  /** Apply one presentation frontmatter patch through the live editor. */
  setPresentation: (patch: Record<string, unknown>) => boolean;
}

let current: ActiveNote | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function publish(): void {
  revision += 1;
  listeners.forEach((listener) => listener());
}

export function setActiveNote(note: ActiveNote | null): void {
  current = note;
  publish();
}

export function getActiveNote(): ActiveNote | null {
  return current;
}

export function getActiveNoteRevision(): number {
  return revision;
}

export function subscribeActiveNote(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tell out-of-tree note tools to read a fresh snapshot from the live editor. */
export function notifyActiveNoteChanged(): void {
  if (current) publish();
}

/** True when a live, editable note editor is present to receive an embed. */
export function activeNoteEditable(): boolean {
  return current?.editable() ?? false;
}

/**
 * Insert markdown at the caret of the active editor, on its own line. Returns
 * false when there's no editable editor (a preview/HTML view, or a locked note).
 */
export function insertIntoActiveNote(md: string): boolean {
  return current?.insert(md) ?? false;
}

/**
 * Put the caret on `line` (0-BASED, like every line number in the task
 * pipeline) of the open editor for `path` and scroll it into view. False when
 * that note is not the live editor — typically because it has not mounted yet,
 * which is the caller's cue to try again on the next change.
 */
export function revealLineInActiveNote(path: string, line: number): boolean {
  return current?.path === path ? current.revealLine(line) : false;
}

export function setActiveNotePresentation(
  path: string,
  patch: Record<string, unknown>,
): boolean {
  return current?.path === path ? current.setPresentation(patch) : false;
}
