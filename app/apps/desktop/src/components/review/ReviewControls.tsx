// Batch accept and per-agent trust tiers, shared by the rail and the chip drawer.

import { useId } from "react";
import { TRUST_TIERS, type ReviewAuthor, type Suggestion, type TrustTier } from "../../lib/review/model";
import { AuthorAvatar } from "./AuthorAvatar";

/** Authors (other than me) with at least one pending, non-conflict item. */
export function batchableAuthors(suggestions: Suggestion[], me: ReviewAuthor, docId?: string): ReviewAuthor[] {
  const seen = new Map<string, ReviewAuthor>();
  for (const s of suggestions) {
    if (s.state !== "pending") continue;
    if (docId !== undefined && s.docId !== docId) continue;
    if (s.author.participantId === me.participantId) continue;
    if (!seen.has(s.author.participantId)) seen.set(s.author.participantId, s.author);
  }
  return [...seen.values()];
}

export function BatchButtons({ authors, onBatch }: { authors: ReviewAuthor[]; onBatch: (authorId: string) => void }) {
  if (authors.length === 0) return null;
  return (
    <div className="review-batch">
      {authors.map((a) => (
        <button key={a.participantId} type="button" className="review-btn review-btn--primary" onClick={() => onBatch(a.participantId)}>
          Accept all from {a.displayName} in this note
        </button>
      ))}
    </div>
  );
}

export function agentAuthors(suggestions: Suggestion[]): ReviewAuthor[] {
  const seen = new Map<string, ReviewAuthor>();
  for (const s of suggestions) {
    if (s.author.kind === "agent" && !seen.has(s.author.participantId)) seen.set(s.author.participantId, s.author);
  }
  return [...seen.values()];
}

export function TrustTiers({
  agents,
  trust,
  onTrust,
}: {
  agents: ReviewAuthor[];
  trust: Record<string, TrustTier>;
  onTrust: (participantId: string, tier: TrustTier) => void;
}) {
  const heading = useId();
  if (agents.length === 0) return null;
  return (
    <section className="review-panel-card" aria-labelledby={heading}>
      <h4 id={heading}>Trust tiers</h4>
      <p className="review-muted">Relax per agent when the click ritual starts. Nothing auto-accepts yet.</p>
      {agents.map((a) => (
        <label key={a.participantId} className="review-trust-row">
          <AuthorAvatar author={a} size="sm" />
          <span className="review-trust-name">{a.displayName}</span>
          <select
            aria-label={`${a.displayName} trust tier`}
            value={trust[a.participantId] ?? "always-ask"}
            onChange={(e) => onTrust(a.participantId, e.target.value as TrustTier)}
          >
            {TRUST_TIERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      ))}
    </section>
  );
}
