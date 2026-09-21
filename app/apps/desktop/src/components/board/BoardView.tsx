/**
 * The board. Lanes across, cards down, and a keyboard that can do everything a
 * pointer can.
 *
 * KEYBOARD IS THE CONTRACT. The board is ONE tab stop (roving tabindex on the
 * cards); inside it:
 *   - arrows move focus, and never the card;
 *   - `[` / `]` or Shift+Arrow move the card to the previous / next lane;
 *   - Alt+Arrow reorders it inside its lane;
 *   - Enter opens it, Space toggles done.
 * Pointer dragging can be added later; it can never be the only way.
 *
 * THE VIEW PLANS NOTHING. It hands `onMove` a `MoveInput` — a card REFERENCE
 * (id, line hint, source text) and a destination named by lane heading and
 * index — and the host re-resolves both against LIVE text (`lib/board/move.ts`)
 * before anything is written. Offsets the view painted from are stale by
 * definition.
 *
 * `toIndex` counts the destination lane's cards with the moved card EXCLUDED,
 * which is the same number whether the card comes from this lane or another.
 * It travels with an ANCHOR — `beforeCardRef`, the card the user saw this one
 * land above, `null` at the end of a lane — because an index describes the
 * board we painted and the anchor describes what the user meant.
 *
 * FOCUS SURVIVES THE ROUND TRIP. A move re-parses the document upstream and
 * re-renders this component with a new `doc`; the card that moved keeps focus,
 * because losing it after every move makes the keyboard path unusable.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CardRef, MoveInput, ParsedBoard, ParsedCard, ParsedLane } from "../../lib/board";
import { BoardLaneColumn } from "./BoardLane";
import "./board.css";

export interface BoardViewProps {
  doc: ParsedBoard;
  onMove: (input: MoveInput) => void;
  onToggle: (card: ParsedCard) => void;
  onOpen: (card: ParsedCard) => void;
  /** Present when this note cannot be written: the reason is SHOWN, and every
   *  control that would write is disabled. */
  readOnly?: { reason: string } | null;
}

/** Stable across a move: the block id when there is one, else the card line. */
function cardKeyOf(card: ParsedCard): string {
  return card.task.id ?? card.task.sourceText;
}

export function BoardView({ doc, onMove, onToggle, onOpen, readOnly }: BoardViewProps) {
  const locked = Boolean(readOnly);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  /** Focus to restore after the host hands back a re-parsed document. */
  const afterMove = useRef<{ key: string; from: ParsedBoard } | null>(null);
  /** Focus to restore on this render (plain navigation). */
  const afterNav = useRef<string | null>(null);

  const cards = doc.lanes.flatMap((lane) => lane.cards);
  const firstKey = cards.length > 0 ? cardKeyOf(cards[0]) : null;
  const activeKey =
    focusKey && cards.some((card) => cardKeyOf(card) === focusKey) ? focusKey : firstKey;

  useEffect(() => {
    const nav = afterNav.current;
    if (nav) {
      refs.current.get(nav)?.focus();
      afterNav.current = null;
    }
    const moved = afterMove.current;
    if (!moved) return;
    refs.current.get(moved.key)?.focus();
    // Keep waiting until the host re-parses and hands back a new document —
    // that is the render where the card is in its new lane.
    if (moved.from !== doc) afterMove.current = null;
  });

  const registerRef = (key: string, element: HTMLDivElement | null) => {
    if (element) refs.current.set(key, element);
    else refs.current.delete(key);
  };

  const focusCard = (laneIndex: number, cardIndex: number) => {
    const lane = doc.lanes[laneIndex];
    if (!lane || lane.cards.length === 0) return;
    const card = lane.cards[Math.max(0, Math.min(cardIndex, lane.cards.length - 1))];
    const key = cardKeyOf(card);
    afterNav.current = key;
    setFocusKey(key);
  };

  const refOf = (card: ParsedCard): CardRef => ({
    docId: doc.docId,
    taskId: card.task.id,
    lineHint: card.task.line,
    sourceText: card.task.sourceText,
  });

  const requestMove = (card: ParsedCard, toLane: ParsedLane, toIndex: number) => {
    const key = cardKeyOf(card);
    afterMove.current = { key, from: doc };
    setFocusKey(key);
    // The card the user saw this one land ABOVE. `toIndex` alone is a number
    // about the board we painted; the anchor survives an edit that shifts it.
    const others = toLane.cards.filter((other) => other !== card);
    const before = others[toIndex] ?? null;
    onMove({
      cardRef: refOf(card),
      toLane: toLane.title,
      toIndex,
      beforeCardRef: before ? refOf(before) : null,
    });
  };

  const onCardKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    laneIndex: number,
    cardIndex: number,
  ) => {
    const lane = doc.lanes[laneIndex];
    const card = lane?.cards[cardIndex];
    if (!card) return;
    const { key, shiftKey, altKey } = event;

    if (key === "Enter") {
      event.preventDefault();
      onOpen(card);
      return;
    }
    if (key === " " || key === "Spacebar") {
      event.preventDefault();
      if (!locked) onToggle(card);
      return;
    }

    const sideways =
      key === "[" || (shiftKey && key === "ArrowLeft")
        ? -1
        : key === "]" || (shiftKey && key === "ArrowRight")
          ? 1
          : 0;
    if (sideways !== 0) {
      event.preventDefault();
      if (locked) return;
      const target = doc.lanes[laneIndex + sideways];
      if (!target) return;
      requestMove(card, target, Math.min(cardIndex, target.cards.length));
      return;
    }

    if (altKey && (key === "ArrowUp" || key === "ArrowDown")) {
      event.preventDefault();
      if (locked) return;
      const next = cardIndex + (key === "ArrowDown" ? 1 : -1);
      if (next < 0 || next > lane.cards.length - 1) return;
      requestMove(card, lane, next);
      return;
    }

    if (key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      focusCard(laneIndex, cardIndex + (key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      const step = key === "ArrowRight" ? 1 : -1;
      for (let at = laneIndex + step; at >= 0 && at < doc.lanes.length; at += step) {
        if (doc.lanes[at].cards.length > 0) {
          focusCard(at, cardIndex);
          return;
        }
      }
    }
  };

  return (
    <div className="board-view">
      {readOnly && (
        <p className="board-readonly" role="status">
          {readOnly.reason}
        </p>
      )}
      <div className="board-lanes">
        {doc.lanes.map((lane, laneIndex) => (
          <BoardLaneColumn
            key={`${lane.title}-${laneIndex}`}
            lane={lane}
            laneIndex={laneIndex}
            readOnly={locked}
            activeKey={activeKey}
            cardKeyOf={cardKeyOf}
            onCardKeyDown={onCardKeyDown}
            onCardFocus={setFocusKey}
            onToggle={onToggle}
            registerRef={registerRef}
          />
        ))}
      </div>
    </div>
  );
}
