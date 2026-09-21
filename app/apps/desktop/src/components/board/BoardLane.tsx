// One lane: a heading, a count and its cards. The lane owns no behaviour —
// every key press is handled by the board, which is the only thing that knows
// what the lane to the left is.

import type { KeyboardEvent } from "react";
import type { ParsedCard, ParsedLane } from "../../lib/board";
import { BoardCardItem } from "./BoardCard";

export interface BoardLaneColumnProps {
  lane: ParsedLane;
  laneIndex: number;
  readOnly: boolean;
  /** Key of the board's single tab stop. */
  activeKey: string | null;
  cardKeyOf: (card: ParsedCard) => string;
  onCardKeyDown: (event: KeyboardEvent<HTMLDivElement>, laneIndex: number, cardIndex: number) => void;
  onCardFocus: (cardKey: string) => void;
  onToggle: (card: ParsedCard) => void;
  registerRef: (cardKey: string, element: HTMLDivElement | null) => void;
}

export function BoardLaneColumn({
  lane,
  laneIndex,
  readOnly,
  activeKey,
  cardKeyOf,
  onCardKeyDown,
  onCardFocus,
  onToggle,
  registerRef,
}: BoardLaneColumnProps) {
  return (
    <section
      className={`board-lane${lane.archive ? " archive" : ""}`}
      data-lane={lane.title}
      aria-label={`${lane.title}, ${lane.cards.length} card${lane.cards.length === 1 ? "" : "s"}`}
    >
      <header className="board-lane-head">
        <h3 className="board-lane-title">{lane.title}</h3>
        <span className="board-lane-count">{lane.cards.length}</span>
      </header>
      <ul className="board-lane-cards">
        {lane.cards.map((card, cardIndex) => {
          const key = cardKeyOf(card);
          return (
            <BoardCardItem
              key={key}
              card={card}
              cardKey={key}
              laneIndex={laneIndex}
              cardIndex={cardIndex}
              focused={key === activeKey}
              readOnly={readOnly}
              onKeyDown={onCardKeyDown}
              onFocus={onCardFocus}
              onToggle={onToggle}
              registerRef={registerRef}
            />
          );
        })}
      </ul>
    </section>
  );
}
