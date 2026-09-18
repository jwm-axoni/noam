import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export interface OutlineHeading {
  level: number;
  text: string;
  from: number;
  to: number;
}

export interface EditorOutlineHandle {
  getHeadings: () => readonly OutlineHeading[];
  navigate: (offset: number) => void;
}

const HEADING = /^(?:ATXHeading|SetextHeading)([1-6])$/;

/** Extract headings from the Markdown parser tree, so fenced `#` text is ignored. */
export function extractOutline(state: EditorState): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      const match = HEADING.exec(node.name);
      if (!match) return;
      const level = Number(match[1]);
      const raw = state.doc.sliceString(node.from, node.to);
      const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
      const text = node.name.startsWith("ATX")
        ? firstLine.replace(/^\s*#{1,6}\s*/, "").replace(/\s+#+\s*$/, "").trim()
        : firstLine.trim();
      if (text) headings.push({ level, text, from: node.from, to: node.to });
    },
  });
  return headings;
}

interface OutlineSnapshot {
  handle: EditorOutlineHandle | null;
  revision: number;
}

let snapshot: OutlineSnapshot = { handle: null, revision: 0 };
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { ...snapshot, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

export function setActiveEditorOutlineHandle(handle: EditorOutlineHandle | null): void {
  snapshot = { handle, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

export function notifyEditorOutlineChanged(): void {
  emit();
}

export function subscribeEditorOutline(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEditorOutlineSnapshot(): OutlineSnapshot {
  return snapshot;
}

