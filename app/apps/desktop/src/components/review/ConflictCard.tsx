// A suggestion whose base text changed underneath it. No silent merge and no
// silent clobber: the reviewer picks mine / theirs / (body text only) both.
// Keep both is never offered for a title — one line cannot hold two versions.

import { canKeepBoth, type ConflictChoice, type Suggestion } from "../../lib/review/model";

export function ConflictCard({
  suggestion,
  canTakeTheirs,
  onResolve,
  large = false,
}: {
  suggestion: Suggestion;
  /** False when the reviewer authored the proposal (they may not accept it). */
  canTakeTheirs: boolean;
  onResolve: (choice: ConflictChoice) => void;
  large?: boolean;
}) {
  const who = suggestion.author.displayName;
  const isTitle = suggestion.target === "title";
  const btn = `review-btn${large ? " review-btn--large" : ""}`;
  return (
    <div className={`review-conflict${large ? " review-conflict--large" : ""}`}>
      <p className="review-conflict-heading">
        {who}
        {isTitle ? " proposed a title change, then you edited the title" : " proposed a change, then you edited this text"}
      </p>
      <p className="review-muted">No silent merge. Pick which version wins.</p>
      <div className="review-conflict-cols">
        <div className="review-conflict-col">
          <span className="review-conflict-label">Yours, now</span>
          <span className="review-conflict-text">{suggestion.mine ?? ""}</span>
        </div>
        <div className="review-conflict-col">
          <span className="review-conflict-label">{who}</span>
          <span className="review-conflict-text">{suggestion.after}</span>
        </div>
      </div>
      <div className="review-actions">
        <button type="button" className={btn} onClick={() => onResolve("mine")}>
          Keep mine
        </button>
        <button type="button" className={btn} disabled={!canTakeTheirs} onClick={() => onResolve("theirs")}>
          Keep theirs
        </button>
        {canKeepBoth(suggestion) && (
          <button type="button" className={btn} disabled={!canTakeTheirs} onClick={() => onResolve("both")}>
            Keep both
          </button>
        )}
      </div>
    </div>
  );
}
