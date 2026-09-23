// Renders a suggestion's before/after as word-level struck/inserted text.
// Every segment is a React TEXT child — suggestion content is untrusted (F12).
// The visually hidden "Removed:"/"Added:" prefixes linearize the change for
// screen readers, most of which do not voice <del>/<ins> on their own.

import { useMemo } from "react";
import { diffSegments } from "../../lib/review/diffSegments";

export function DiffText({ before, after }: { before: string; after: string }) {
  const segments = useMemo(() => diffSegments(before, after), [before, after]);
  return (
    <span className="review-diff">
      {segments.map((s, i) =>
        s.type === "del" ? (
          <del key={i} className="review-del">
            <span className="review-sr">Removed: </span>
            {s.text}
          </del>
        ) : s.type === "ins" ? (
          <ins key={i} className="review-ins">
            <span className="review-sr">Added: </span>
            {s.text}
          </ins>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  );
}
