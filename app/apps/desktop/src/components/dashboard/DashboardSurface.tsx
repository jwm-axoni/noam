// Which surface a note gets: the text editor, or the dashboard.
//
// A note whose FRONTMATTER says `noam_kind: dashboard` opens as a DASHBOARD,
// with a segmented control back to the text, remembered per note path (the
// Boards rule, `BoardSurface.tsx`). Every other note is untouched: this
// component renders its children — the editor — and nothing else.
//
// Composition in `App.tsx`: `BoardSurface > DashboardSurface > Editor`, so a
// note is a board OR a dashboard OR text.

import { Suspense, lazy, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { getActiveNoteRevision, subscribeActiveNote } from "../../lib/editor/activeView";
import {
  isDashboardDocument,
  rememberDashboardView,
  rememberedDashboardView,
  type DashboardSurfaceView,
} from "../../lib/dashboard";
import { taskNoteText } from "../../lib/tasks";
import * as ipc from "../../lib/ipc";
import "../board/boardHost.css";

const DashboardHost = lazy(() => import("./DashboardHost").then((m) => ({ default: m.DashboardHost })));

export interface DashboardSurfaceProps {
  path: string;
  /** The text editor. Rendered as-is for every note that is not a dashboard. */
  children: ReactNode;
  /** Open a note a view links to. Defaults to the store's `openNoteByPath`. */
  onOpenNote?: (path: string) => void;
}

export function DashboardSurface({ path, children, onOpenNote }: DashboardSurfaceProps) {
  const editorRevision = useSyncExternalStore(subscribeActiveNote, getActiveNoteRevision);
  const [isDashboard, setIsDashboard] = useState(false);
  const [view, setView] = useState<DashboardSurfaceView>(() => rememberedDashboardView(path));
  // The dashboard replaces the editor, so an edit to this note (a teammate, an
  // AI, the Text view of another window) only reaches us through the watcher.
  const [diskTick, setDiskTick] = useState(0);

  useEffect(() => setView(rememberedDashboardView(path)), [path]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void ipc
      .onFilesChanged((changes) => {
        if (changes.some((change) => change.path === path)) setDiskTick((n) => n + 1);
      })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {
        /* no Tauri runtime (tests) */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const text = await taskNoteText(path);
      if (!cancelled) setIsDashboard(text !== null && isDashboardDocument(text));
    })();
    return () => {
      cancelled = true;
    };
  }, [path, editorRevision, diskTick]);

  if (!isDashboard) return <>{children}</>;

  const choose = (next: DashboardSurfaceView) => {
    setView(next);
    rememberDashboardView(path, next);
  };

  return (
    <div className="editor-surface">
      <div className="editor-surface-switch" role="group" aria-label="Note view">
        <button
          type="button"
          className={`surface-tab${view === "dashboard" ? " active" : ""}`}
          aria-pressed={view === "dashboard"}
          onClick={() => choose("dashboard")}
        >
          Dashboard
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
      {view === "dashboard" ? (
        <Suspense fallback={<div className="board-loading">Loading dashboard…</div>}>
          <DashboardHost path={path} onOpenNote={onOpenNote} />
        </Suspense>
      ) : (
        children
      )}
    </div>
  );
}
