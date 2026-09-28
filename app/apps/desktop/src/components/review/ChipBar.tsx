// Variant C, used when the host is narrow: one chip per suggestion in a
// horizontally scrolling tablist, plus a drawer holding the focused diff and
// its actions. Chips follow the ARIA tabs pattern: one tab stop, arrows move.

import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { ConflictChoice, ReviewAuthor, TrustTier } from "../../lib/review/model";
import type { ReviewState } from "../../lib/review/reducer";
import { AuthorAvatar } from "./AuthorAvatar";
import { agentAuthors, BatchButtons, batchableAuthors, TrustTiers } from "./ReviewControls";
import { SuggestionCard } from "./SuggestionCard";

export interface ChipBarProps {
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

export function ChipBar(p: ChipBarProps) {
  const [open, setOpen] = useState(true);
  const drawerId = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const list = p.state.suggestions;
  if (list.length === 0) return null;

  const active = list.find((s) => s.id === p.state.activeId) ?? null;
  const tabStopId = active?.id ?? list[0].id;
  const activeBatch = active ? batchableAuthors(list, p.me, p.docId).filter((a) => a.participantId === active.author.participantId) : [];

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = list.findIndex((s) => s.id === tabStopId);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % list.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next < 0) return;
    e.preventDefault();
    p.onSelect(list[next].id);
    tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="review-chipbar" data-review-zone="chips">
      <div className="review-chipbar-row">
        <div className="review-chips" role="tablist" aria-label="Suggestions" ref={tabsRef} onKeyDown={onTabKey}>
          {list.map((s) => {
            const selected = s.id === p.state.activeId;
            const classes = [
              "review-chip",
              selected && "review-chip--active",
              (s.state === "accepted" || s.state === "rejected") && "review-chip--decided",
              s.state === "conflict" && "review-chip--conflict",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                className={classes}
                aria-selected={selected}
                aria-controls={drawerId}
                tabIndex={s.id === tabStopId ? 0 : -1}
                onClick={() => p.onSelect(s.id)}
              >
                <AuthorAvatar author={s.author} size="sm" />
                <span className="review-chip-title">{s.title}</span>
                {s.state === "conflict" && <span className="review-sr"> (needs your call)</span>}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="review-btn review-btn--ghost review-chipbar-toggle"
          aria-expanded={open}
          aria-controls={drawerId}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide details" : "Show details"}
        </button>
      </div>
      <div id={drawerId} role="tabpanel" className="review-drawer" hidden={!open}>
        {active && (
          <SuggestionCard
            suggestion={active}
            active
            justAccepted={active.id === p.justAcceptedId}
            canAccept={active.author.participantId !== p.me.participantId}
            onSelect={() => p.onSelect(active.id)}
            onAccept={() => p.onDecide(active.id, "accept")}
            onReject={() => p.onDecide(active.id, "reject")}
            onResolve={(choice) => p.onResolve(active.id, choice)}
          />
        )}
        <BatchButtons authors={activeBatch} onBatch={p.onBatch} />
        <TrustTiers agents={agentAuthors(list)} trust={p.state.trust} onTrust={p.onTrust} />
        {p.digest && (
          <p className="review-panel-card review-digest">
            <strong>While you were away: </strong>
            {p.digest}
          </p>
        )}
      </div>
    </div>
  );
}
