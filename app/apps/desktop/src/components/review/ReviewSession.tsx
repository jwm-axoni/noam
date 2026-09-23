// Variant B, the optional focus mode: one decision at a time over the whole
// window. Entered explicitly, left with Escape (handled by the surface's key
// grammar) or the close button. Focus moves in on open, is contained while
// open, and returns to where it was on close.

import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { isUndecided, type ConflictChoice, type ReviewAuthor } from "../../lib/review/model";
import { CAUGHT_UP, type ReviewState } from "../../lib/review/reducer";
import { AuthorAvatar } from "./AuthorAvatar";
import { ConflictCard } from "./ConflictCard";
import { SELF_ACCEPT_HINT } from "./SuggestionCard";

export interface ReviewSessionProps {
  state: ReviewState;
  me: ReviewAuthor;
  justAcceptedId: string | null;
  onPrev: () => void;
  onNext: () => void;
  onDecide: (id: string, how: "accept" | "reject") => void;
  onResolve: (id: string, choice: ConflictChoice) => void;
  onLeave: () => void;
}

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ReviewSession(p: ReviewSessionProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !rootRef.current) return;
    const items = Array.from(rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === rootRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const list = p.state.suggestions;
  const total = list.length;
  const open = list.filter(isUndecided);
  const decided = total - open.length;
  const active = list.find((s) => s.id === p.state.activeId && isUndecided(s)) ?? null;
  const pos = active ? open.indexOf(active) + 1 : 0;
  const canAccept = active ? active.author.participantId !== p.me.participantId : false;

  return createPortal(
    <div
      ref={rootRef}
      className="review-session"
      data-review-zone="session"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="review-session-top">
        <h2 id={titleId}>Review session</h2>
        <span className="review-muted">{active ? `${pos} of ${open.length} waiting` : "All decided"}</span>
        <div
          className="review-progress"
          role="progressbar"
          aria-label="Decided"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={decided}
        >
          <i style={{ width: total ? `${(decided / total) * 100}%` : "0%" }} />
        </div>
        <button type="button" className="review-btn review-btn--ghost" onClick={p.onLeave}>
          <kbd>Esc</kbd> Back to the note
        </button>
      </header>

      <div className="review-session-stage">
        {!active ? (
          <div className="review-session-card">
            <p className="review-empty">{CAUGHT_UP}</p>
          </div>
        ) : (
          <div className={`review-session-card${active.id === p.justAcceptedId ? " review-card--accepted" : ""}`}>
            <div className="review-session-agent">
              <AuthorAvatar author={active.author} size="lg" />
              <span className="review-session-who">{active.author.displayName}</span>
              <span className="review-badge">{active.state === "conflict" ? "Needs your call" : "Proposed diff"}</span>
            </div>
            <p className="review-session-title">{active.title}</p>
            {active.state === "conflict" ? (
              <ConflictCard suggestion={active} canTakeTheirs={canAccept} onResolve={(c) => p.onResolve(active.id, c)} large />
            ) : (
              <>
                {active.before && (
                  <>
                    <span className="review-tag">Before</span>
                    <p className="review-session-old">{active.before}</p>
                  </>
                )}
                {active.after && (
                  <>
                    <span className="review-tag">{active.before ? "After" : "Proposed addition"}</span>
                    <p className="review-session-new">{active.after}</p>
                  </>
                )}
                {!active.after && <span className="review-tag">Proposed deletion</span>}
              </>
            )}
            <div className="review-session-controls">
              <button type="button" className="review-btn review-btn--large" onClick={p.onPrev} aria-label="Previous suggestion">
                ←
              </button>
              {active.state === "pending" && (
                <>
                  <button type="button" className="review-btn review-btn--large" onClick={() => p.onDecide(active.id, "reject")}>
                    Reject <kbd>R</kbd>
                  </button>
                  <button
                    type="button"
                    className="review-btn review-btn--large review-btn--accept"
                    onClick={() => p.onDecide(active.id, "accept")}
                    disabled={!canAccept}
                    title={canAccept ? undefined : SELF_ACCEPT_HINT}
                  >
                    Accept <kbd>A</kbd>
                  </button>
                </>
              )}
              <button type="button" className="review-btn review-btn--large" onClick={p.onNext} aria-label="Next suggestion">
                →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
