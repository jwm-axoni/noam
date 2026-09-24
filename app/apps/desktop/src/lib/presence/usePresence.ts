// Small React hooks shared by the People panel and the always-mounted live
// region. Kept apart from PresencePanel.tsx so WorkspaceShell can mount the
// live region without pulling in the lazily loaded panel.

import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { viewingDocId } from "./viewingDocId";

/** Below this width the People panel renders nothing (desktop-only in Phase 1). */
export const PRESENCE_NARROW_QUERY = "(max-width: 699px)";

export function useMediaQuery(query: string): boolean {
  const read = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

/** The SERVER doc id of the open note — what peers' `docId` is compared to. */
export function useOpenNoteDocId(): string | null {
  const openNote = useStore((s) => s.openNote);
  const mapped = useStore((s) => (s.openNote ? s.docIdByPath[s.openNote.path] : undefined));
  return viewingDocId(openNote?.id, mapped);
}
