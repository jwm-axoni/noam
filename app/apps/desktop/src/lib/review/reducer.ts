// The review queue as a pure reducer: `(state, action) -> { state, effects }`.
//
// Side effects are never performed here. Scrolling the editor, calling the
// decision callbacks and speaking to the live region are all REQUESTED as
// effects and carried out by the host (`components/review/ReviewSurface.tsx`),
// which is the only place that knows whether the next item is on screen.
//
// Rules this file owns:
// - Navigation visits only undecided items (pending + conflict) and wraps.
// - A decision advances the active item to the next undecided one.
// - A conflict is never accepted/rejected: only resolveConflict settles it,
//   and batch accept skips it.
// - An author can never accept their own proposal (client-side guard only;
//   the server rule arrives with ADR-1). Withdrawing (reject / keep mine) is fine.

import {
  canKeepBoth,
  isUndecided,
  type ConflictChoice,
  type Suggestion,
  type TrustTier,
} from "./model";

export interface ReviewActor {
  participantId: string;
}

export interface ReviewState {
  suggestions: Suggestion[];
  activeId: string | null;
  sessionMode: boolean;
  trust: Record<string, TrustTier>;
}

export type ReviewErrorCode = "self_accept" | "both_unavailable";

export type ReviewEffect =
  | { type: "reveal"; id: string }
  | { type: "announce"; text: string }
  | { type: "error"; code: ReviewErrorCode }
  | { type: "decided"; id: string; how: "accept" | "reject" }
  | { type: "resolved"; id: string; choice: ConflictChoice };

export type ReviewAction =
  | { type: "load"; suggestions: Suggestion[] }
  | { type: "next" }
  | { type: "prev" }
  | { type: "select"; id: string }
  | { type: "decide"; id: string; how: "accept" | "reject"; actor: ReviewActor }
  | { type: "resolveConflict"; id: string; choice: ConflictChoice; actor: ReviewActor }
  | { type: "batchAccept"; authorId: string; docId?: string; actor: ReviewActor }
  | { type: "enterSession" }
  | { type: "leaveSession" }
  | { type: "setTrust"; participantId: string; tier: TrustTier };

export interface ReviewResult {
  state: ReviewState;
  effects: ReviewEffect[];
}

export const CAUGHT_UP = "Nothing to review. You are caught up.";
export const NEEDS_CHOICE = "This one needs a choice";

export function initialReviewState(): ReviewState {
  return { suggestions: [], activeId: null, sessionMode: false, trust: {} };
}

/**
 * The first undecided item strictly after `fromIndex` in direction `dir`,
 * wrapping. `fromIndex` itself is visited last, so a lone undecided item is
 * found again. Returns null when nothing is undecided.
 */
function stepUndecided(list: Suggestion[], fromIndex: number, dir: 1 | -1): string | null {
  const n = list.length;
  for (let k = 1; k <= n; k++) {
    const i = (((fromIndex + dir * k) % n) + n) % n;
    if (isUndecided(list[i])) return list[i].id;
  }
  return null;
}

function undecidedCount(list: Suggestion[]): number {
  return list.filter(isUndecided).length;
}

function position(list: Suggestion[], id: string): string {
  const open = list.filter(isUndecided);
  const s = open.find((x) => x.id === id);
  if (!s) return "";
  return `${open.indexOf(s) + 1} of ${open.length}: ${s.title}, from ${s.author.displayName}`;
}

function withActive(state: ReviewState, activeId: string | null, effects: ReviewEffect[]): ReviewResult {
  if (activeId !== null && activeId !== state.activeId) effects.push({ type: "reveal", id: activeId });
  return { state: { ...state, activeId }, effects };
}

/** After `id` was settled: advance if it was the active item, else keep the active one. */
function advanceFrom(state: ReviewState, id: string, effects: ReviewEffect[]): ReviewResult {
  const list = state.suggestions;
  const activeStillOpen = list.some((s) => s.id === state.activeId && isUndecided(s));
  if (state.activeId !== id && activeStillOpen) return { state, effects };
  const idx = list.findIndex((s) => s.id === id);
  const next = idx < 0 ? stepUndecided(list, -1, 1) : stepUndecided(list, idx, 1);
  return withActive(state, next, effects);
}

function settle(list: Suggestion[], id: string, to: "accepted" | "rejected"): Suggestion[] {
  return list.map((s) => (s.id === id ? { ...s, state: to } : s));
}

function afterDecisionAnnouncement(list: Suggestion[], what: string): string {
  const left = undecidedCount(list);
  return left === 0 ? CAUGHT_UP : `${what}. ${left} left.`;
}

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewResult {
  const unchanged: ReviewResult = { state, effects: [] };
  switch (action.type) {
    case "load": {
      const list = action.suggestions;
      const keep = list.find((s) => s.id === state.activeId && isUndecided(s));
      const activeId = keep ? keep.id : (list.find(isUndecided)?.id ?? null);
      return { state: { ...state, suggestions: list, activeId }, effects: [] };
    }

    case "next":
    case "prev": {
      const list = state.suggestions;
      const idx = list.findIndex((s) => s.id === state.activeId);
      const dir = action.type === "next" ? 1 : -1;
      const start = idx >= 0 ? idx : dir === 1 ? -1 : list.length;
      const nextId = list.length ? stepUndecided(list, start, dir) : null;
      const effects: ReviewEffect[] = [];
      if (nextId) effects.push({ type: "announce", text: position(list, nextId) });
      return withActive(state, nextId, effects);
    }

    case "select": {
      if (!state.suggestions.some((s) => s.id === action.id)) return unchanged;
      return withActive(state, action.id, []);
    }

    case "decide": {
      const target = state.suggestions.find((s) => s.id === action.id);
      if (!target) return unchanged;
      if (target.state === "conflict") {
        return { state, effects: [{ type: "announce", text: NEEDS_CHOICE }] };
      }
      if (target.state !== "pending") return unchanged;
      if (action.how === "accept" && action.actor.participantId === target.author.participantId) {
        return { state, effects: [{ type: "error", code: "self_accept" }] };
      }
      const suggestions = settle(state.suggestions, target.id, action.how === "accept" ? "accepted" : "rejected");
      const verb = action.how === "accept" ? "Accepted" : "Rejected";
      const effects: ReviewEffect[] = [
        { type: "decided", id: target.id, how: action.how },
        { type: "announce", text: afterDecisionAnnouncement(suggestions, `${verb}: ${target.title}`) },
      ];
      return advanceFrom({ ...state, suggestions }, target.id, effects);
    }

    case "resolveConflict": {
      const target = state.suggestions.find((s) => s.id === action.id);
      if (!target || target.state !== "conflict") return unchanged;
      if (action.choice === "both" && !canKeepBoth(target)) {
        return { state, effects: [{ type: "error", code: "both_unavailable" }] };
      }
      if (action.choice !== "mine" && action.actor.participantId === target.author.participantId) {
        return { state, effects: [{ type: "error", code: "self_accept" }] };
      }
      const suggestions = settle(state.suggestions, target.id, action.choice === "mine" ? "rejected" : "accepted");
      const label = action.choice === "mine" ? "Kept yours" : action.choice === "theirs" ? "Kept theirs" : "Kept both";
      const effects: ReviewEffect[] = [
        { type: "resolved", id: target.id, choice: action.choice },
        { type: "announce", text: afterDecisionAnnouncement(suggestions, `${label}: ${target.title}`) },
      ];
      return advanceFrom({ ...state, suggestions }, target.id, effects);
    }

    case "batchAccept": {
      if (action.actor.participantId === action.authorId) {
        return { state, effects: [{ type: "error", code: "self_accept" }] };
      }
      const picked = state.suggestions.filter(
        (s) =>
          s.state === "pending" &&
          s.author.participantId === action.authorId &&
          (action.docId === undefined || s.docId === action.docId),
      );
      if (picked.length === 0) return unchanged;
      const ids = new Set(picked.map((s) => s.id));
      const suggestions = state.suggestions.map((s) => (ids.has(s.id) ? { ...s, state: "accepted" as const } : s));
      const who = picked[0].author.displayName;
      const effects: ReviewEffect[] = picked.map((s) => ({ type: "decided" as const, id: s.id, how: "accept" as const }));
      effects.push({
        type: "announce",
        text: afterDecisionAnnouncement(suggestions, `Accepted ${picked.length} from ${who}`),
      });
      const next = { ...state, suggestions };
      const activeOpen = suggestions.some((s) => s.id === state.activeId && isUndecided(s));
      if (activeOpen) return { state: next, effects };
      const idx = suggestions.findIndex((s) => s.id === state.activeId);
      return withActive(next, stepUndecided(suggestions, idx, 1), effects);
    }

    case "enterSession":
      if (state.sessionMode) return unchanged;
      return {
        state: { ...state, sessionMode: true, activeId: state.activeId ?? (state.suggestions.find(isUndecided)?.id ?? null) },
        effects: [],
      };

    case "leaveSession":
      if (!state.sessionMode) return unchanged;
      return { state: { ...state, sessionMode: false }, effects: [] };

    case "setTrust":
      return { state: { ...state, trust: { ...state.trust, [action.participantId]: action.tier } }, effects: [] };
  }
}
