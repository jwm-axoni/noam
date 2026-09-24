// Variant A, the default surface: a queue of cards with the active one
// highlighted, batch accept, trust tiers and the "while you were away" digest.

import { useEffect, useId, useRef } from "react";
import { isUndecided, type ConflictChoice, type ReviewAuthor, type TrustTier } from "../../lib/review/model";
import type { ReviewState } from "../../lib/review/reducer";
import { agentAuthors, BatchButtons, batchableAuthors, TrustTiers } from "./ReviewControls";
import { SuggestionCard } from "./SuggestionCard";

export interface ReviewRailProps {
  state: ReviewState;
  me: ReviewAuthor;
  docId?: string;
  justAcceptedId: string | null;
  digest?: string;
  onSelect: (id: string) => void;
  onDecide: (id: string, how: "accept" | "reject") => void;
  onResolve: (id: string, choice: ConflictChoice) => void;
  onBatch: (authorId: string) => void;
  onTrust: (participantId: string, tier: TrustTier) => void;
}

export function ReviewRail(p: ReviewRailProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const digestHeading = useId();
  const pending = p.state.suggestions.filter(isUndecided).length;

  // Keep the active card visible in the queue; "nearest" only scrolls when it is off-screen.
  useEffect(() => {
    if (!p.state.activeId) return;
    const cards = listRef.current?.querySelectorAll<HTMLElement>("[data-suggestion-id]") ?? [];
    const card = Array.from(cards).find((el) => el.dataset.suggestionId === p.state.activeId);
    card?.scrollIntoView?.({ block: "nearest" });
  }, [p.state.activeId]);

  return (
    <div className="review-rail" data-review-zone="rail" role="region" aria-label="Review">
      <header className="review-rail-head">
        <h3>Review</h3>
        <span className="review-count">{pending} waiting</span>
      </header>
      <BatchButtons authors={batchableAuthors(p.state.suggestions, p.me, p.docId)} onBatch={p.onBatch} />
      {p.state.suggestions.length > 0 && (
        <ol className="review-queue" ref={listRef}>
          {p.state.suggestions.map((s) => (
            <li key={s.id}>
              <SuggestionCard
                suggestion={s}
                active={s.id === p.state.activeId}
                justAccepted={s.id === p.justAcceptedId}
                canAccept={s.author.participantId !== p.me.participantId}
                onSelect={() => p.onSelect(s.id)}
                onAccept={() => p.onDecide(s.id, "accept")}
                onReject={() => p.onDecide(s.id, "reject")}
                onResolve={(choice) => p.onResolve(s.id, choice)}
              />
            </li>
          ))}
        </ol>
      )}
      <TrustTiers agents={agentAuthors(p.state.suggestions)} trust={p.state.trust} onTrust={p.onTrust} />
      {p.digest && (
        <section className="review-panel-card review-digest" aria-labelledby={digestHeading}>
          <h4 id={digestHeading}>While you were away</h4>
          <p>{p.digest}</p>
        </section>
      )}
    </div>
  );
}
