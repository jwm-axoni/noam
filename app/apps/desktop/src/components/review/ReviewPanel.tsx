// The dock panel for suggestion review. Until ADR-1 lands there is no
// proposal source, so the panel feeds ReviewSurface from the in-memory demo
// source when the device-local `noam.flags.suggestionsV0` flag is on, and
// otherwise shows the empty state with a line saying why it is empty.
// Decisions are held in the surface only: nothing touches the note.

import { useMemo, useState } from "react";
import type { PanelBodyProps } from "../../layout/panelRegistry";
import { DEMO_DIGEST, demoSuggestions } from "../../lib/review/demoSource";
import { suggestionsV0Enabled } from "../../lib/review/flag";
import type { ReviewAuthor, Suggestion } from "../../lib/review/model";
import { useStore } from "../../store";
import { ReviewSurface } from "./ReviewSurface";

export const PHASE_2_HINT = "Suggestions arrive with Phase 2 (needs ADR-1).";
const DEMO_DOC_ID = "demo-note";
const NONE: Suggestion[] = [];
const noop = () => {};

export function ReviewPanel(_props: PanelBodyProps) {
  const [enabled] = useState(suggestionsV0Enabled);
  const suggestions = useMemo(() => (enabled ? demoSuggestions(DEMO_DOC_ID) : NONE), [enabled]);
  const user = useStore((s) => s.session?.user ?? null);
  const me = useMemo<ReviewAuthor>(
    () => ({
      participantId: user?.id ?? "local-user",
      displayName: user?.name || "You",
      color: "",
      kind: "human",
    }),
    [user],
  );
  return (
    <ReviewSurface
      suggestions={suggestions}
      me={me}
      docId={DEMO_DOC_ID}
      digest={enabled ? DEMO_DIGEST : undefined}
      emptyHint={enabled ? undefined : PHASE_2_HINT}
      onDecision={noop}
      onReveal={noop}
      onResolveConflict={noop}
    />
  );
}
