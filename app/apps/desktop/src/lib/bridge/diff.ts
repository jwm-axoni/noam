// diff-match-patch helpers for the bridge. We diff the CRDT's *current*
// serialization against the incoming file text and replay the result as
// Y.Text insert/delete ops, so concurrent edits merge as operations rather
// than being clobbered by a blind overwrite (spec 03 §5).

import { diff_match_patch, DIFF_DELETE, DIFF_EQUAL } from "diff-match-patch";
import type * as Y from "yjs";

export type Diff = [number, string];

/** Minimal char-level diff from `oldText` to `newText`. */
export function computeDiff(oldText: string, newText: string): Diff[] {
  const dmp = new diff_match_patch();
  return dmp.diff_main(oldText, newText) as Diff[];
}

/**
 * Fraction of content that churns in this diff, relative to the combined size
 * of both versions. ~1.0 for a whole-file rewrite, ~0 for a tiny edit.
 */
export function changeRatio(diffs: Diff[], oldLen: number, newLen: number): number {
  let changed = 0;
  for (const [op, data] of diffs) {
    if (op !== DIFF_EQUAL) changed += data.length;
  }
  const base = oldLen + newLen;
  return base === 0 ? 0 : changed / base;
}

/**
 * Apply a diff to a Y.Text as insert/delete ops. Indices are UTF-16 code units,
 * which is exactly how both diff-match-patch and Y.Text count, so unicode /
 * surrogate pairs round-trip faithfully. Must be called inside `doc.transact`.
 */
export function applyDiff(text: Y.Text, diffs: Diff[]): void {
  let index = 0;
  for (const [op, data] of diffs) {
    if (op === DIFF_EQUAL) {
      index += data.length;
    } else if (op === DIFF_DELETE) {
      text.delete(index, data.length);
    } else {
      // DIFF_INSERT
      text.insert(index, data);
      index += data.length;
    }
  }
}
