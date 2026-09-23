// The persistent review bar: where you are, the key grammar, and the four
// actions. Approvals live here, never in a toast.

import { CAUGHT_UP } from "../../lib/review/reducer";
import { SELF_ACCEPT_HINT } from "./SuggestionCard";

export interface ReviewBarProps {
  pending: number;
  /** 1-based position of the active item among the undecided ones (0 = none). */
  position: number;
  /** The active item is a conflict: it takes a choice, not accept/reject. */
  activeIsConflict: boolean;
  canAccept: boolean;
  emptyHint?: string;
  onPrev: () => void;
  onNext: () => void;
  onAccept: () => void;
  onReject: () => void;
  onEnterSession: () => void;
}

export function ReviewBar(p: ReviewBarProps) {
  if (p.pending === 0) {
    return (
      <div className="review-bar review-bar--empty" data-review-zone="bar" role="group" aria-label="Suggestion review">
        <p className="review-empty">{CAUGHT_UP}</p>
        {p.emptyHint && <p className="review-empty-hint">{p.emptyHint}</p>}
      </div>
    );
  }
  const decideDisabled = p.activeIsConflict || p.position === 0;
  return (
    <div className="review-bar" data-review-zone="bar" role="group" aria-label="Suggestion review">
      <span className="review-bar-pos">
        {p.position > 0 ? `${p.position} of ${p.pending} waiting` : `${p.pending} waiting`}
      </span>
      <span className="review-bar-hints" aria-hidden="true">
        <span><kbd>]</kbd> <kbd>[</kbd> move</span>
        <span><kbd>A</kbd> accept</span>
        <span><kbd>R</kbd> reject</span>
      </span>
      <span className="review-bar-actions">
        <button type="button" className="review-btn review-btn--ghost" onClick={p.onPrev} aria-label="Previous suggestion" aria-keyshortcuts="[">
          ← Prev
        </button>
        <button type="button" className="review-btn review-btn--ghost" onClick={p.onNext} aria-label="Next suggestion" aria-keyshortcuts="]">
          Next →
        </button>
        <button type="button" className="review-btn" onClick={p.onReject} disabled={decideDisabled} aria-keyshortcuts="R">
          Reject
        </button>
        <button
          type="button"
          className="review-btn review-btn--accept"
          onClick={p.onAccept}
          disabled={decideDisabled || !p.canAccept}
          title={!p.canAccept ? SELF_ACCEPT_HINT : p.activeIsConflict ? "This one needs a choice" : undefined}
          aria-keyshortcuts="A"
        >
          Accept
        </button>
        <button type="button" className="review-btn review-btn--ghost" onClick={p.onEnterSession}>
          Focus mode
        </button>
      </span>
    </div>
  );
}
