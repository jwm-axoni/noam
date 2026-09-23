// Word-level diff for rendering a suggestion as struck/inserted text.
//
// diff-match-patch diffs characters; a reviewer reads words. So we use the
// classic `diff_linesToChars_` trick with WORDS as the unit: map every distinct
// token (a word, a run of whitespace, or one punctuation mark) to a single
// private character, diff those strings, run semantic cleanup, then map back.
// Boundaries therefore always fall between tokens — never mid-word.

import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from "diff-match-patch";

export interface DiffSegment {
  type: "same" | "del" | "ins";
  text: string;
}

const TOKEN = /\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_]/gu;
/** dmp's own ceiling for its line trick; past it we fall back to a char diff. */
const MAX_TOKENS = 65535;

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

type Diff = [number, string];

export function diffSegments(before: string, after: string): DiffSegment[] {
  if (before === after) return before ? [{ type: "same", text: before }] : [];
  const dmp = new diff_match_patch();

  const vocabulary: string[] = [];
  const index = new Map<string, number>();
  let overflow = false;
  const encode = (text: string) => {
    let out = "";
    for (const token of tokenize(text)) {
      let i = index.get(token);
      if (i === undefined) {
        if (vocabulary.length >= MAX_TOKENS) {
          overflow = true;
          return "";
        }
        i = vocabulary.length;
        vocabulary.push(token);
        index.set(token, i);
      }
      out += String.fromCharCode(i);
    }
    return out;
  };

  let diffs: Diff[];
  const a = encode(before);
  const b = overflow ? "" : encode(after);
  if (overflow) {
    diffs = dmp.diff_main(before, after) as Diff[];
    dmp.diff_cleanupSemantic(diffs as never);
  } else {
    diffs = dmp.diff_main(a, b, false) as Diff[];
    dmp.diff_cleanupSemantic(diffs as never);
    diffs = diffs.map(([op, chars]) => [op, Array.from(chars, (c) => vocabulary[c.charCodeAt(0)]).join("")]);
  }

  const segments: DiffSegment[] = [];
  for (const [op, text] of diffs) {
    if (!text) continue;
    const type = op === DIFF_DELETE ? "del" : op === DIFF_INSERT ? "ins" : "same";
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += text;
    else segments.push({ type, text });
  }
  return segments;
}
