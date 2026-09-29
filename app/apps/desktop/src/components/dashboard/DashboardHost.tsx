// The dashboard's host: note text in, independent views out.
//
//   THE NOTE IS THE SPEC. The views are the note's `noam-view` blocks, parsed
//   from live text (the editor when open, the file otherwise) and re-parsed
//   whenever the note changes.
//   LIVE. Every watcher batch re-runs every view (debounced), because any note
//   in the vault may have started or stopped matching.
//   INDEPENDENT. Each view owns its own run, loading and error state, so one
//   slow or failing query never blanks another.
//   INDEX ONLY. Results come from the local index (`queryNotes` + one card
//   read), which holds only notes this user can read — a dashboard shared with
//   a teammate shows each of them only their own notes.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getActiveNoteRevision, subscribeActiveNote } from "../../lib/editor/activeView";
import * as ipc from "../../lib/ipc";
import { parseDashboard, type ViewDeps } from "../../lib/dashboard";
import {
  getKnowledgeCatalogSnapshot,
  loadKnowledgeCatalog,
  subscribeKnowledgeCatalog,
  withDefaultCatalogEntries,
} from "../../lib/knowledge";
import { queryNotes } from "../../lib/knowledge/noteTimes";
import { taskNoteText } from "../../lib/tasks";
import { useStore } from "../../store";
import { NearViewport, useNearViewportObserver } from "../gallery/NoteCard";
import { DashboardView } from "./DashboardView";
import "../gallery/gallery.css";
import "./dashboard.css";

/** Watcher batches settle this long before the views re-run. */
export const DASHBOARD_REFRESH_MS = 300;

export interface DashboardHostProps {
  path: string;
  onOpenNote?: (path: string) => void;
  /** Injected in tests; production reads the local index through Rust. */
  deps?: ViewDeps;
}

function productionDeps(epoch: () => ipc.VaultEpoch | undefined): ViewDeps {
  return {
    queryNotes: (query, page) => queryNotes(query, page),
    resolveWikilink: (name) => ipc.resolveWikilink(name),
    listNoteCards: (ids) => ipc.listNoteCards(ids, epoch()),
  };
}

export function DashboardHost({ path, onOpenNote, deps: injected }: DashboardHostProps) {
  const editorRevision = useSyncExternalStore(subscribeActiveNote, getActiveNoteRevision);
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const epoch = useStore((s) => s.vault?.epoch ?? null);
  const catalogSnapshot = useSyncExternalStore(subscribeKnowledgeCatalog, getKnowledgeCatalogSnapshot);
  const catalog = withDefaultCatalogEntries(catalogSnapshot.catalog);

  const epochRef = useRef(epoch);
  epochRef.current = epoch;
  const deps = useMemo(() => injected ?? productionDeps(() => epochRef.current ?? undefined), [injected]);
  const open = useCallback(
    (target: string) => {
      if (onOpenNote) onOpenNote(target);
      else void useStore.getState().openNoteByPath(target);
    },
    [onOpenNote],
  );

  useEffect(() => {
    void loadKnowledgeCatalog(epoch ?? undefined).catch(() => {});
  }, [epoch]);

  const [text, setText] = useState<string | null>(null);
  const [textTick, setTextTick] = useState(0);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await taskNoteText(path);
      if (!cancelled) setText(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [path, editorRevision, textTick]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void ipc
      .onFilesChanged((changes) => {
        if (changes.some((change) => change.path === path)) setTextTick((n) => n + 1);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => setRefresh((n) => n + 1), DASHBOARD_REFRESH_MS);
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {
        /* no Tauri runtime (tests) — the dashboard just does not live-refresh */
      });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [path]);

  const views = useMemo(() => (text === null ? null : parseDashboard(text).views), [text]);

  const scroller = useRef<HTMLDivElement | null>(null);
  const observe = useNearViewportObserver(scroller);

  return (
    <div className="dashboard-host" ref={scroller}>
      {views === null ? (
        <div className="board-loading">Loading dashboard…</div>
      ) : views.length === 0 ? (
        <div className="dashboard-empty">
          This dashboard has no views yet. Switch to Text and add a <code>```noam-view</code> block.
        </div>
      ) : (
        <NearViewport.Provider value={observe}>
          <div className="dashboard-views">
            {views.map((spec) => (
              <DashboardView
                // Position + text: an edit to one block restarts only that view.
                key={`${spec.index}:${spec.source}`}
                spec={spec}
                catalog={catalog}
                refresh={refresh}
                deps={deps}
                vaultPath={vaultPath}
                onOpen={open}
              />
            ))}
          </div>
        </NearViewport.Provider>
      )}
    </div>
  );
}
