// Which surface a note gets: the text editor, or the board.
//
// A note whose frontmatter says `noam_kind: board` (or carries Obsidian
// Kanban's `kanban-plugin`) opens as a BOARD, with a segmented control back to
// the text. The choice is remembered per note path in `localStorage`, because
// "I want to see the markdown of this one board" is a property of that board,
// not a mode the whole app should sit in.
//
// Every other note is untouched: this component renders its children — the
// editor — and nothing else, not even the toggle.
//
// OPENING A CARD LANDS ON ITS LINE. `BoardHost` hands over the card's line;
// switching surfaces is only half of that promise, so the line is held until
// the (lazy) editor for this path registers itself, then the caret goes there.

import { Suspense, lazy, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { isBoardDocument } from "../../lib/board";
import {
  getActiveNoteRevision,
  revealLineInActiveNote,
  subscribeActiveNote,
} from "../../lib/editor/activeView";
import { taskNoteText } from "../../lib/tasks";
import "./boardHost.css";

const BoardHost = lazy(() => import("./BoardHost").then((m) => ({ default: m.BoardHost })));

type SurfaceView = "board" | "text";

const storageKey = (path: string) => `noam:board-view:${path}`;

function rememberedView(path: string): SurfaceView {
  try {
    return localStorage.getItem(storageKey(path)) === "text" ? "text" : "board";
  } catch {
    return "board";
  }
}

function remember(path: string, view: SurfaceView): void {
  try {
    localStorage.setItem(storageKey(path), view);
  } catch {
    // A denied storage quota is not a reason to refuse the toggle.
  }
}

export interface BoardSurfaceProps {
  path: string;
  /** The text editor. Rendered as-is for every note that is not a board. */
  children: ReactNode;
}

export function BoardSurface({ path, children }: BoardSurfaceProps) {
  const editorRevision = useSyncExternalStore(subscribeActiveNote, getActiveNoteRevision);
  const [isBoard, setIsBoard] = useState(false);
  const [view, setView] = useState<SurfaceView>(() => rememberedView(path));
  /** The line a card asked for, until the editor exists to show it. */
  const [pendingLine, setPendingLine] = useState<number | null>(null);

  useEffect(() => {
    setView(rememberedView(path));
    setPendingLine(null);
  }, [path]);

  // The editor is a lazy chunk: on the render that switches surfaces it is not
  // mounted yet. `editorRevision` ticks when it registers, which is when this
  // succeeds.
  useEffect(() => {
    if (view !== "text" || pendingLine === null) return;
    if (revealLineInActiveNote(path, pendingLine)) setPendingLine(null);
  }, [view, pendingLine, path, editorRevision]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const text = await taskNoteText(path);
      if (!cancelled) setIsBoard(text !== null && isBoardDocument(text));
    })();
    return () => {
      cancelled = true;
    };
  }, [path, editorRevision]);

  if (!isBoard) return <>{children}</>;

  const choose = (next: SurfaceView) => {
    setView(next);
    remember(path, next);
  };

  return (
    <div className="editor-surface">
      <div className="editor-surface-switch" role="group" aria-label="Note view">
        <button
          type="button"
          className={`surface-tab${view === "board" ? " active" : ""}`}
          aria-pressed={view === "board"}
          onClick={() => choose("board")}
        >
          Board
        </button>
        <button
          type="button"
          className={`surface-tab${view === "text" ? " active" : ""}`}
          aria-pressed={view === "text"}
          onClick={() => choose("text")}
        >
          Text
        </button>
      </div>
      {view === "board" ? (
        <Suspense fallback={<div className="board-loading">Loading board…</div>}>
          <BoardHost
            path={path}
            onOpenText={(line) => {
              setPendingLine(line);
              choose("text");
            }}
          />
        </Suspense>
      ) : (
        children
      )}
    </div>
  );
}
