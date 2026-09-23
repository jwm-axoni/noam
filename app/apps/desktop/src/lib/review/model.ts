// The suggestion review ("diff loop") data model.
//
// There is no proposal source yet: ADR-1 (the CRDT staging primitive) is
// unsigned, so nothing produces these but `demoSource.ts`. The shape is the
// contract the UI renders; the binding to real proposals lands with Phase 2.
//
// Every string here that came from a participant (title, before/after, mine,
// displayName) is UNTRUSTED. Render it as React text children only — never
// through innerHTML, an href or a src (audit finding F12).

export interface ReviewAuthor {
  participantId: string;
  displayName: string;
  color: string;
  kind: "human" | "agent";
}

export type SuggestionKind = "replace" | "insert" | "delete";

export interface Suggestion {
  id: string;
  docId: string;
  author: ReviewAuthor;
  kind: SuggestionKind;
  /** Character range in the note body the suggestion targets (base revision). */
  from: number;
  to: number;
  before: string;
  after: string;
  createdAt: number;
  /** Short human label, e.g. "Stronger intro". */
  title: string;
  state: "pending" | "accepted" | "rejected" | "conflict";
  /** Present when state === "conflict": what the user's text says now. */
  mine?: string;
  /**
   * What the range belongs to. A single-line title cannot hold "both"
   * versions, so conflict resolution only offers Keep both on body text.
   * Absent means body.
   */
  target?: "body" | "title";
}

export type TrustTier = "always-ask" | "auto-drafts" | "auto-note";

export const TRUST_TIERS: readonly { value: TrustTier; label: string }[] = [
  { value: "always-ask", label: "Always ask" },
  { value: "auto-drafts", label: "Auto-accept in drafts" },
  { value: "auto-note", label: "Auto-accept in this note" },
];

export type ConflictChoice = "mine" | "theirs" | "both";

/** Still waiting on a human: pending proposals and unresolved conflicts. */
export function isUndecided(s: Suggestion): boolean {
  return s.state === "pending" || s.state === "conflict";
}

/** Keep both only makes sense when two versions of body text can sit side by side. */
export function canKeepBoth(s: Suggestion): boolean {
  return s.kind === "replace" && (s.target ?? "body") === "body";
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * An author colour goes into an inline style, so it is validated rather than
 * trusted: only a hex literal passes (no `url(...)` beacons, no `var()` games).
 */
export function safeColor(color: string): string {
  return HEX_COLOR.test(color) ? color : "var(--text-tertiary)";
}

/** First visible character of a display name, for the avatar monogram. */
export function monogram(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}
