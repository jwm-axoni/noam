// One card. A div rather than a button because a card holds a checkbox and a
// body: the keyboard contract lives on the card itself (roving tabindex +
// `onKeyDown`), and the checkbox is taken OUT of the tab order so the board is
// one tab stop, not one per control.

import type { KeyboardEvent } from "react";
import type { ParsedCard } from "../../lib/board";

export interface BoardCardItemProps {
  card: ParsedCard;
  cardKey: string;
  laneIndex: number;
  cardIndex: number;
  /** The single tab stop of the whole board. */
  focused: boolean;
  readOnly: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, laneIndex: number, cardIndex: number) => void;
  onFocus: (cardKey: string) => void;
  onToggle: (card: ParsedCard) => void;
  registerRef: (cardKey: string, element: HTMLDivElement | null) => void;
}

export function BoardCardItem({
  card,
  cardKey,
  laneIndex,
  cardIndex,
  focused,
  readOnly,
  onKeyDown,
  onFocus,
  onToggle,
  registerRef,
}: BoardCardItemProps) {
  const done = card.task.status === "done";
  const label = card.task.text || "Empty card";
  return (
    <li className="board-card-row">
      <div
        className={`board-card${done ? " done" : ""}`}
        role="button"
        tabIndex={focused ? 0 : -1}
        aria-label={label}
        data-card-key={cardKey}
        data-lane-index={laneIndex}
        data-card-index={cardIndex}
        ref={(element) => {
          registerRef(cardKey, element);
        }}
        onKeyDown={(event) => onKeyDown(event, laneIndex, cardIndex)}
        onFocus={() => onFocus(cardKey)}
      >
        <input
          type="checkbox"
          className="board-card-check"
          checked={done}
          disabled={readOnly}
          tabIndex={-1}
          aria-label={done ? `Mark "${label}" not done` : `Mark "${label}" done`}
          onChange={() => onToggle(card)}
        />
        <span className="board-card-text">{label}</span>
        {card.body.length > 0 && (
          <span className="board-card-body">{card.body.join("\n").trim()}</span>
        )}
      </div>
    </li>
  );
}
