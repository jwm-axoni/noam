/**
 * Parts back into bytes.
 *
 * `serializeBoard` walks the pieces `parseBoard` kept — the preamble, each
 * lane's `before`/heading/blocks, the tail — and concatenates them. It never
 * reaches for the source text it was parsed from, which is what makes
 * `serialize(parse(t)) === t` a real assertion about the parse rather than a
 * tautology about a cached string.
 */

import type { SpanChange } from "../tasks/contracts";
import type { ParsedBoard } from "./parse";

export function serializeBoard(doc: ParsedBoard): string {
  let out = doc.preamble;
  for (const lane of doc.lanes) {
    out += lane.before + lane.heading;
    for (const block of lane.blocks) {
      out += block.kind === "card" ? block.card.raw : block.text;
    }
  }
  return out + doc.tail;
}

/**
 * Apply a plan to text. Every `SpanChange` is in the coordinates of the text it
 * was planned against, so they are applied from the END backwards — which is
 * also the order the planners return them in, and the order CodeMirror's
 * `ChangeSet.of` composes them in. Tests use this; production dispatches the
 * same changes as an editor transaction instead.
 */
export function applyChanges(text: string, changes: readonly SpanChange[]): string {
  const ordered = [...changes].sort((a, b) => b.from - a.from || b.to - a.to);
  let out = text;
  for (const change of ordered) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  }
  return out;
}
