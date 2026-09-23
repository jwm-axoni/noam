// One proposal in the queue (rail) or the chip drawer. Decided items stay in
// place, dimmed, with the reversibility line; conflicts render ConflictCard.

import type { ConflictChoice, Suggestion } from "../../lib/review/model";
import { AuthorAvatar } from "./AuthorAvatar";
import { ConflictCard } from "./ConflictCard";
import { DiffText } from "./DiffText";

const KIND_LABEL: Record<Suggestion["kind"], string> = {
  replace: "proposed edit",
  insert: "proposed addition",
  delete: "proposed deletion",
};

export const SELF_ACCEPT_HINT = "You can't accept your own suggestion";

export function decidedLine(state: Suggestion["state"]): string | null {
  if (state === "accepted") return "Accepted · reversible for 30 days";
  if (state === "rejected") return "Rejected";
  return null;
}

export interface SuggestionCardProps {
  suggestion: Suggestion;
  active: boolean;
  justAccepted: boolean;
  /** False when the reviewer authored this proposal. */
  canAccept: boolean;
  onSelect: () => void;
  onAccept: () => void;
  onReject: () => void;
  onResolve: (choice: ConflictChoice) => void;
}

export function SuggestionCard({
  suggestion: s,
  active,
  justAccepted,
  canAccept,
  onSelect,
  onAccept,
  onReject,
  onResolve,
}: SuggestionCardProps) {
  const decided = decidedLine(s.state);
  const classes = [
    "review-card",
    active && "review-card--active",
    decided && "review-card--decided",
    justAccepted && "review-card--accepted",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <article className={classes} aria-current={active ? "true" : undefined} data-suggestion-id={s.id}>
      <button type="button" className="review-card-head" onClick={onSelect} aria-pressed={active}>
        <AuthorAvatar author={s.author} size="sm" />
        <span className="review-card-who">{s.author.displayName}</span>
        <span className="review-card-kind">{s.state === "conflict" ? "needs your call" : KIND_LABEL[s.kind]}</span>
      </button>
      <p className="review-card-title">{s.title}</p>
      {s.state === "conflict" ? (
        <ConflictCard suggestion={s} canTakeTheirs={canAccept} onResolve={onResolve} />
      ) : (
        <p className="review-card-diff">
          <DiffText before={s.before} after={s.after} />
        </p>
      )}
      {decided ? (
        <p className="review-decided">{decided}</p>
      ) : s.state === "pending" ? (
        <div className="review-actions">
          <button
            type="button"
            className="review-btn review-btn--accept"
            onClick={onAccept}
            disabled={!canAccept}
            title={canAccept ? undefined : SELF_ACCEPT_HINT}
          >
            Accept <kbd>A</kbd>
          </button>
          <button type="button" className="review-btn" onClick={onReject}>
            Reject <kbd>R</kbd>
          </button>
        </div>
      ) : null}
    </article>
  );
}
