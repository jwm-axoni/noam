/**
 * Moving a card — the riskiest write in the release, and the reason this whole
 * module exists.
 *
 * THE RULE: a move is planned against the LIVE text, never against the
 * snapshot the board was painted from. Between the paint and the drop a
 * teammate may have typed in another card over CRDT, an AI may have rewritten a
 * lane through MCP, or the user may have edited the very card they are
 * dragging. So `planMove` re-parses the live text, re-finds the card (by its
 * `^t-` id first, then by exact source text nearest the line hint) and re-finds
 * the lane by heading, and only then computes the two spans it writes at.
 *
 * What follows from that:
 *   - an edit inside ANOTHER card is invisible to the plan and survives it;
 *   - an edit to the MOVED card's own line is `stale-target` and plans NOTHING,
 *     because the card the user grabbed is not the card that is there now;
 *   - two lines answering to the same id are `ambiguous-target`, never a coin
 *     toss between them.
 *
 * `toIndex` counts the destination lane's cards EXCLUDING the moved card, so
 * "put it third" means the same thing whether the card comes from this lane or
 * another one. It is still a number about the OLD board, so the drop is named
 * by an ANCHOR as well — `beforeCardRef`, the card the user saw the moved one
 * land above (`null` = the end of the lane). The anchor is re-found in the live
 * lane exactly like the moved card, so a teammate's insert above it shifts the
 * drop with it; only when the anchor itself is gone does `toIndex` decide,
 * clamped, and the plan says so with `anchorMissing`.
 *
 * The plan is ONE `SpanChange[]` — a delete of the source span and an insert at
 * the destination offset, both in live-text coordinates, returned from the end
 * backwards so applying them in sequence (or handing them to CodeMirror as a
 * single transaction) gives the same result, and one undo step.
 */

import type { SpanChange, TaskResolution } from "../tasks/contracts";
import { parseBoard, type ParsedBoard, type ParsedCard, type ParsedLane } from "./parse";

export interface CardRef {
  docId: string;
  /** The `^t-` block id when the card has one. */
  taskId?: string | null;
  /** HINT. The line the card was on when the board was painted. */
  lineHint: number;
  /** The card line as it was then. The staleness check. */
  sourceText: string;
}

export interface MoveInput {
  cardRef: CardRef;
  /** Destination lane HEADING — lanes have no ids, the heading is the name. */
  toLane: string;
  /**
   * Destination index among the lane's cards, the moved card excluded. A HINT:
   * it counts the board the UI painted, which the live text may have moved on
   * from. Only used when there is no anchor, or the anchor is gone.
   */
  toIndex: number;
  /**
   * The card the moved one should land BEFORE, as the UI saw it — the anchor
   * that makes the drop mean the same thing after a concurrent insert above it.
   * `null` is "the end of the lane"; absent means "no anchor, use `toIndex`".
   */
  beforeCardRef?: CardRef | null;
}

export type MoveFailure =
  | "stale-target"
  | "ambiguous-target"
  | "missing-target"
  | "missing-lane"
  /** Only `planMoveLive` can report this: the board cannot see a share. */
  | "read-only";

export type MoveResult =
  | {
      ok: true;
      changes: SpanChange[];
      /** The anchor card is no longer in the lane; `toIndex` decided the spot. */
      anchorMissing?: boolean;
    }
  | { ok: false; kind: MoveFailure; message: string };

const fail = (kind: MoveFailure, message: string): MoveResult => ({ ok: false, kind, message });

interface Located {
  lane: ParsedLane;
  card: ParsedCard;
}

function allCards(doc: ParsedBoard): Located[] {
  return doc.lanes.flatMap((lane) => lane.cards.map((card) => ({ lane, card })));
}

/**
 * Where a card inserted at `index` starts, in the lane's own coordinates.
 * `others` is the lane's cards without the moved one, so a same-lane reorder
 * and a cross-lane move share one calculation.
 */
function insertOffset(lane: ParsedLane, others: ParsedCard[], index: number): number {
  const at = Math.max(0, Math.min(index, others.length));
  if (others.length > 0) {
    return at < others.length ? others[at].from : others[others.length - 1].to;
  }
  // An empty lane: under the heading, after the blank line that normally
  // follows it, so the board keeps the shape Obsidian Kanban writes.
  const first = lane.blocks[0];
  if (first && first.kind === "text") {
    const nl = first.text.indexOf("\n");
    if (nl !== -1 && first.text.slice(0, nl).trim() === "") return first.from + nl + 1;
    return first.from;
  }
  return lane.to;
}

/**
 * Where the anchor card sits NOW among `others`, or `null` when it is gone.
 * Same identity rules as the moved card: the `^t-` id first, then exact source
 * text — and when two lines read the same, the one nearest the line the UI saw.
 */
function anchorIndex(others: ParsedCard[], anchor: CardRef): number | null {
  if (anchor.taskId) {
    const byId = others.findIndex((card) => card.task.id === anchor.taskId);
    if (byId !== -1) return byId;
  }
  let best: number | null = null;
  others.forEach((card, index) => {
    if (card.task.sourceText !== anchor.sourceText) return;
    if (
      best === null ||
      Math.abs(card.task.line - anchor.lineHint) < Math.abs(others[best].task.line - anchor.lineHint)
    ) {
      best = index;
    }
  });
  return best;
}

export function planMove(input: MoveInput, liveText: string): MoveResult {
  const { cardRef, toLane, toIndex, beforeCardRef } = input;
  const doc = parseBoard(liveText, { docId: cardRef.docId });
  const cards = allCards(doc);

  // 1. The card, re-found in live text.
  let found: Located;
  if (cardRef.taskId) {
    const byId = cards.filter((c) => c.card.task.id === cardRef.taskId);
    if (byId.length === 0) return fail("missing-target", `No card with id ${cardRef.taskId} is on this board.`);
    if (byId.length > 1) {
      return fail("ambiguous-target", `${byId.length} cards claim the id ${cardRef.taskId}; dedupe them first.`);
    }
    if (byId[0].card.task.sourceText !== cardRef.sourceText) {
      return fail("stale-target", "That card was edited while the board was open. Refreshing.");
    }
    found = byId[0];
  } else {
    const byText = cards.filter((c) => c.card.task.sourceText === cardRef.sourceText);
    if (byText.length > 1) {
      return fail("ambiguous-target", `${byText.length} cards read exactly the same; dedupe them first.`);
    }
    if (byText.length === 0) {
      const atHint = cards.some((c) => c.card.task.line === cardRef.lineHint);
      return atHint
        ? fail("stale-target", "That card was edited while the board was open. Refreshing.")
        : fail("missing-target", "That card is no longer on this board.");
    }
    found = byText[0];
  }

  // 2. The lane, re-found by heading.
  const destinations = doc.lanes.filter((lane) => lane.title === toLane);
  if (destinations.length === 0) return fail("missing-lane", `This board has no lane called "${toLane}".`);
  if (destinations.length > 1) {
    return fail("ambiguous-target", `This board has ${destinations.length} lanes called "${toLane}".`);
  }
  const lane = destinations[0];

  // 3. Where in the lane — the anchor as it stands NOW, `toIndex` only as a
  // fallback, because that index counts a board somebody may have typed into.
  const others = lane.cards.filter((card) => card !== found.card);
  let index = toIndex;
  let anchorMissing = false;
  if (beforeCardRef === null) {
    index = others.length;
  } else if (beforeCardRef) {
    const resolved = anchorIndex(others, beforeCardRef);
    if (resolved === null) anchorMissing = true;
    else index = resolved;
  }

  // 4. Two spans on ONE text.
  const at = insertOffset(lane, others, index);
  const sameLane = lane === found.lane;
  if (sameLane && (at === found.card.from || at === found.card.to)) {
    return anchorMissing ? { ok: true, changes: [], anchorMissing } : { ok: true, changes: [] };
  }

  let insert = found.card.raw;
  if (!insert.endsWith("\n")) insert += "\n";
  if (at > 0 && liveText[at - 1] !== "\n") insert = `\n${insert}`;

  const changes: SpanChange[] = [
    { from: found.card.from, to: found.card.to, insert: "" },
    { from: at, to: at, insert },
  ];
  const sorted = changes.sort((a, b) => b.from - a.from);
  return anchorMissing ? { ok: true, changes: sorted, anchorMissing } : { ok: true, changes: sorted };
}


// ---------------------------------------------------------------------------
// The seam to the rest of the app
// ---------------------------------------------------------------------------

/**
 * What a board move needs from the host, injected so this module stays pure.
 *
 * `resolve` is the task adapter's `resolveTask` (`src/lib/tasks/adapter.ts`),
 * typed here with the frozen `TaskResolution` contract. It answers the three
 * questions the board cannot: which note the card is on, the REVISION the
 * write will be checked against, and whether this note is read-only. The lane
 * structure still comes from the live text, which is why `liveText` is a
 * second call — the live view when the note is open, `ipc.readNote` when it is
 * not, exactly like `lib/workflows/adapter.ts`.
 *
 * The two reads can straddle an edit. That is safe in the only direction that
 * matters: `replaceRange` checks the revision and refuses, so the move is
 * reported stale instead of landing on text nobody saw.
 */
export interface BoardMoveHost {
  resolve: (ref: CardRef) => Promise<TaskResolution>;
  liveText: (path: string) => Promise<string>;
}

export type LiveMoveResult =
  | { ok: true; changes: SpanChange[]; path: string; revision: string; anchorMissing?: boolean }
  | { ok: false; kind: MoveFailure; message: string };

/** Resolve against live text, then plan. The only entry point a UI should use. */
export async function planMoveLive(
  input: MoveInput,
  host: BoardMoveHost,
): Promise<LiveMoveResult> {
  const resolution = await host.resolve(input.cardRef);
  if (!resolution.ok) return { ok: false, kind: resolution.kind, message: resolution.message };
  const { path, revision } = resolution.resolved;
  const plan = planMove(input, await host.liveText(path));
  return plan.ok
    ? { ok: true, changes: plan.changes, path, revision, anchorMissing: plan.anchorMissing }
    : plan;
}
