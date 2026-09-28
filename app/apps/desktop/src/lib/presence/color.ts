// Deterministic presence colors (spec 04 §5). A user's cursor/selection color is
// derived from their stable id so it's identical across every client and every
// session — no server round-trip, no per-connection randomness.

import type { ActivityStatus } from "../prefs";

/**
 * The eight participant identity colors. Designed and verified colorblind-safe,
 * and deliberately free of reds/oranges (a red ring reads as an error, not a
 * person). The server assigns registry colors with the same FNV-1a hash onto
 * this same ordered list, so the offline fallback below agrees with the
 * registry. Reordering or editing it breaks that agreement.
 */
export const PRESENCE_PALETTE = [
  "#696713",
  "#b4bf2c",
  "#789c5b",
  "#047e67",
  "#2fc5fa",
  "#2981fb",
  "#982f93",
  "#b976a0",
] as const;

/** Reserved for Noam's own actions. Never assigned to a participant. */
export const NOAM_VIOLET = "#7f73ff";

/** Neutral gray used for a peer's ring when they're offline / not live. */
export const PRESENCE_OFFLINE = "#94a3b8";

/** Stable 32-bit FNV-1a hash of a string. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in unsigned range.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Pick a deterministic palette color for a user id. */
export function colorForUser(userId: string): string {
  if (!userId) return PRESENCE_PALETTE[0];
  const idx = hashString(userId) % PRESENCE_PALETTE.length;
  return PRESENCE_PALETTE[idx];
}

/** WCAG relative luminance of a `#rrggbb` color. */
function relativeLuminance(hex: string): number {
  const n = parseInt(hex.replace(/^#/, ""), 16);
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  );
}

/**
 * The label color for text drawn ON a participant color: white when it reaches
 * WCAG AA (4.5:1) against the fill, near-black otherwise.
 */
export function textOn(hex: string): "#111111" | "#ffffff" {
  const contrastWithWhite = 1.05 / (relativeLuminance(hex) + 0.05);
  return contrastWithWhite >= 4.5 ? "#ffffff" : "#111111";
}

/** The awareness `user` field every client publishes for cursors + avatars. */
export interface PresenceUser {
  id: string;
  /** Registry participant id, when this client knows its own row. */
  participantId?: string;
  name: string;
  color: string;
  /** The user's chosen activity status, so peers can show it beside cursors. */
  status?: ActivityStatus;
}

export function presenceUser(
  userId: string,
  name: string,
  status?: ActivityStatus,
): PresenceUser {
  return { id: userId, name, color: colorForUser(userId), ...(status ? { status } : {}) };
}

/**
 * The visual tone of a presence indicator — the shared vocabulary the account
 * avatar light and the note-roster rings both speak. It folds the four chosen
 * availability states down to how *present* someone reads: `online`/`busy` are
 * live (their unique ring colour shows), while `away`/`invisible` read as
 * not-at-the-keyboard (a muted, neutral ring). This is what "the status depends
 * on whether the user is active" means in practice.
 */
export type PresenceTone = "online" | "away" | "busy" | "offline";

/** Fold a chosen availability status into a presence tone. */
export function statusTone(status: ActivityStatus | undefined): PresenceTone {
  switch (status) {
    case "away":
      return "away";
    case "busy":
      return "busy";
    // "Invisible" is meant to read as offline to teammates.
    case "invisible":
      return "offline";
    default:
      return "online";
  }
}

/** Whether a ring should show the user's unique colour (vs. neutral gray). */
export function ringShowsColor(tone: PresenceTone): boolean {
  return tone === "online" || tone === "busy";
}
