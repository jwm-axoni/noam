// The ONE polite live region for presence ("Maya joined", "Maya disconnected",
// "2 people in this note"), plus the People panel's one-time auto-open for
// multi-member vaults. Mounted once, by WorkspaceShell.

import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { findPanelTab } from "../layout/operations";
import { useLayoutStore } from "../layout/store";
import {
  getPresenceAnnouncement,
  queueAnnouncement,
  subscribePresenceAnnouncement,
} from "../lib/presence/announcer";
import { presenceV1Enabled } from "../lib/presence/flag";
import { useOpenNoteDocId } from "../lib/presence/usePresence";
import { useStore } from "../store";

export const PRESENCE_AUTO_OPENED_PREFIX = "noam.presence.autoOpened.";

// Screen-reader only. Inline because the shared `.visually-hidden` rule lives in
// a stylesheet that only loads with the settings dialog.
const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

export function PresenceLiveRegion() {
  const message = useSyncExternalStore(
    subscribePresenceAnnouncement,
    getPresenceAnnouncement,
    getPresenceAnnouncement,
  );
  const noteDocId = useOpenNoteDocId();
  const inNote = useStore((s) =>
    noteDocId ? s.vaultPresence.filter((p) => p.docId === noteDocId && !p.stale).length : 0,
  );
  const lastCount = useRef(0);
  useEffect(() => {
    if (inNote === lastCount.current) return;
    lastCount.current = inNote;
    if (inNote > 0 && presenceV1Enabled()) {
      queueAnnouncement(`${inNote} ${inNote === 1 ? "person" : "people"} in this note`);
    }
  }, [inNote]);

  return (
    <div className="presence-live-region" style={SR_ONLY} role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}

/**
 * Open the People panel in the right dock ONCE per vault, the first time that
 * vault's layout is hydrated while its org has more than one member. The
 * localStorage mark makes the user's later choice (closing it) stick.
 */
export function usePresenceAutoOpen(vaultKey: string, hydrated: boolean): void {
  const memberCount = useStore((s) => {
    const orgId = s.session?.activeOrganizationId ?? null;
    // Only this org's roster: a switch leaves the previous org's list in place
    // until its refresh lands.
    return orgId ? s.members.filter((m) => m.organizationId === orgId).length : 0;
  });
  useEffect(() => {
    if (!hydrated || memberCount <= 1 || !presenceV1Enabled()) return;
    const key = `${PRESENCE_AUTO_OPENED_PREFIX}${vaultKey}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      return; // no storage, no way to remember: never auto-open
    }
    if (useLayoutStore.getState().vaultKey !== vaultKey) return;
    if (findPanelTab(useLayoutStore.getState().layout, "presence")) return;
    useLayoutStore.getState().dispatch({ type: "open-panel", panelType: "presence", zone: "right" });
  }, [vaultKey, hydrated, memberCount]);
}
