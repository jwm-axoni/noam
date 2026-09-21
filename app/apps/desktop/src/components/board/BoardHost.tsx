// The board's host: live text in, one span edit out.
//
// `BoardView` plans nothing and reads nothing. This file is what makes it a
// view OF a note:
//
//   LIVE TEXT, ALWAYS. The document is parsed from the live editor view when
//   the note is open and from the file otherwise (`taskNoteText`), and
//   re-parsed on every editor change, every watcher event for this path, and
//   after every write of our own. Offsets the view painted from are stale by
//   definition, which is why a move re-resolves before it plans.
//   ONE WRITE PATH. A move is planned by `planMoveLive` and applied by
//   `applyTaskEdit` against the revision the planner hashed; a toggle goes
//   through `editTask`. A `stale-target` refusal says so and RE-PARSES — it
//   never retries, because the second attempt is the one that would move
//   somebody else's card.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import * as ipc from "../../lib/ipc";
import { getActiveNoteRevision, subscribeActiveNote } from "../../lib/editor/activeView";
import { permissionForPath } from "../../lib/workflows/adapter";
import {
  parseBoard,
  planMoveLive,
  type MoveInput,
  type ParsedBoard,
  type ParsedCard,
} from "../../lib/board";
import {
  applyTaskEdit,
  contentTaskId,
  editTask,
  mergeChanges,
  planAssignId,
  planComplete,
  planSetDate,
  planSetStatus,
  resolveTask,
  taskNoteText,
  todayPlainDate,
  type TaskRef,
} from "../../lib/tasks";
import { BoardView } from "./BoardView";

const STALE_NOTICE = "The board changed, refresh and try again";
const ANCHOR_NOTICE =
  "The card you dropped this one above is gone, so it was placed by position — check where it landed";

export interface BoardHostProps {
  path: string;
  /** Leave the board and put the caret on this line of the text editor. */
  onOpenText: (line: number) => void;
}

const refOf = (card: ParsedCard): TaskRef => ({
  path: card.task.path,
  docId: card.task.docId,
  id: card.task.id,
  line: card.task.line,
  sourceText: card.task.sourceText,
});

function findCard(doc: ParsedBoard | null, sourceText: string, id?: string | null): ParsedCard | null {
  const cards = doc?.lanes.flatMap((lane) => lane.cards) ?? [];
  return (
    cards.find((card) => (id ? card.task.id === id : false)) ??
    cards.find((card) => card.task.sourceText === sourceText) ??
    null
  );
}

export function BoardHost({ path, onOpenText }: BoardHostProps) {
  // Every doc change in the open editor bumps this, which is the board's
  // "the text moved" signal while the note is live.
  const editorRevision = useSyncExternalStore(subscribeActiveNote, getActiveNoteRevision);
  const [reload, setReload] = useState(0);
  const [doc, setDoc] = useState<ParsedBoard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reparse = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const text = await taskNoteText(path);
      if (cancelled) return;
      setDoc(text === null ? null : parseBoard(text, { path }));
    })();
    return () => {
      cancelled = true;
    };
  }, [path, editorRevision, reload]);

  // The note may not be open in an editor at all (the board IS the surface),
  // so an external edit only reaches us through the watcher.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void ipc
      .onFilesChanged((changes) => {
        if (changes.some((change) => change.path === path)) reparse();
      })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [path, reparse]);

  const permission = permissionForPath(path);
  const readOnly =
    permission === "edit"
      ? null
      : { reason: `"${path}" is read-only; you have ${permission} access.` };

  const move = async (input: MoveInput) => {
    const card = findCard(doc, input.cardRef.sourceText, input.cardRef.taskId);
    if (!card) {
      setNotice(STALE_NOTICE);
      reparse();
      return;
    }
    const planned = await planMoveLive(input, {
      resolve: (ref) =>
        resolveTask({
          path,
          docId: ref.docId,
          id: ref.taskId ?? null,
          line: ref.lineHint,
          sourceText: ref.sourceText,
        }),
      liveText: async (target) => (await taskNoteText(target)) ?? "",
    });
    if (!planned.ok) {
      setNotice(planned.kind === "stale-target" ? STALE_NOTICE : planned.message);
      reparse();
      return;
    }
    // The same `replaceRange` contract every task write uses, guarded by the
    // revision the planner hashed the live text into.
    const result = await applyTaskEdit(
      {
        path: planned.path,
        docId: card.task.docId,
        from: card.task.from,
        to: card.task.to,
        sourceText: card.task.sourceText,
        task: card.task,
        revision: planned.revision,
      },
      planned.changes,
    );
    if (!result.ok) {
      setNotice(result.kind === "stale-target" ? STALE_NOTICE : result.message);
    } else {
      // The card it was dropped above left the lane between paint and drop, so
      // the position came from the old index. Say so rather than pretend.
      setNotice(planned.anchorMissing ? ANCHOR_NOTICE : null);
    }
    reparse();
  };

  const toggle = async (card: ParsedCard) => {
    // A recurrence that could not be extended still completes the card; the
    // reason no successor appeared is shown rather than swallowed.
    let warning: string | null = null;
    const result = await editTask(refOf(card), async (resolved) => {
      if (resolved.task.status === "done") {
        // The lazy `^t-` id rides along with the FIRST structured edit, so a
        // card stops depending on matching its own text.
        const changes = [
          ...planSetStatus(resolved.task, "todo"),
          ...planSetDate(resolved.task, "done", null),
        ];
        if (resolved.task.id !== null) return changes;
        return mergeChanges(planAssignId(resolved.task, changes, await contentTaskId(resolved.task)));
      }
      const text = (await taskNoteText(resolved.path)) ?? "";
      const plan = await planComplete(resolved.task, text, todayPlainDate());
      warning = plan.issues.find((issue) => issue.severity === "warning")?.message ?? null;
      return plan.changes;
    });
    if (!result.ok) {
      setNotice(
        result.kind === "stale-target" || result.kind === "ambiguous-target"
          ? STALE_NOTICE
          : result.message,
      );
    } else {
      setNotice(warning ? `Completed — ${warning}` : null);
    }
    reparse();
  };

  if (!doc) return <div className="board-host board-loading">Loading board…</div>;

  return (
    <div className="board-host" data-board-path={path}>
      {notice && (
        <div className="board-notice" role="alert">
          {notice}
        </div>
      )}
      <BoardView
        doc={doc}
        readOnly={readOnly}
        onMove={(input) => void move(input)}
        onToggle={(card) => void toggle(card)}
        onOpen={(card) => onOpenText(card.task.line)}
      />
    </div>
  );
}

export default BoardHost;
