// The suggestion review host. It owns the review reducer, picks the surface
// by the width IT is given (Rail at >= railMinWidth, else the chip bar — a
// ResizeObserver on the host, not the window, because it lives in a dock),
// runs the reducer's effects, and holds the one polite live region.
//
// Effects are the only way anything leaves the reducer: `decided`/`resolved`
// call the parent, `reveal` asks the parent to bring an item into view (the
// parent knows whether it is already on screen), `announce`/`error` speak.

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { createAnnouncer, type Announcer } from "../../lib/review/announcer";
import { focusContextOf, reviewKeyAction } from "../../lib/review/keys";
import { isUndecided, type ConflictChoice, type ReviewAuthor, type Suggestion, type TrustTier } from "../../lib/review/model";
import {
  initialReviewState,
  reviewReducer,
  type ReviewAction,
  type ReviewEffect,
  type ReviewErrorCode,
  type ReviewState,
} from "../../lib/review/reducer";
import { ChipBar } from "./ChipBar";
import { ReviewBar } from "./ReviewBar";
import { ReviewRail } from "./ReviewRail";
import { ReviewSession } from "./ReviewSession";
import { SELF_ACCEPT_HINT } from "./SuggestionCard";
import "./review.css";

// A dock panel is 320-400 px wide; the mock's 900 was about a whole window.
export const RAIL_MIN_WIDTH = 480;
const ACCEPT_POP_MS = 500;
/** Effects not yet drained are kept in a bounded, id-tagged queue. */
const EFFECT_QUEUE_CAP = 200;

export interface ReviewSurfaceHandle {
  enterSession: () => void;
}

export interface ReviewSurfaceProps {
  /** Keep this referentially stable: a new array re-loads the queue. */
  suggestions: Suggestion[];
  me: ReviewAuthor;
  onDecision: (id: string, how: "accept" | "reject") => void;
  onReveal: (id: string) => void;
  onResolveConflict?: (id: string, choice: ConflictChoice) => void;
  /** The note this surface reviews; scopes "Accept all from X in this note". */
  docId?: string;
  digest?: string;
  /** Extra line under the empty state. */
  emptyHint?: string;
  railMinWidth?: number;
  ref?: Ref<ReviewSurfaceHandle>;
}

const ERROR_TEXT: Record<ReviewErrorCode, string> = {
  self_accept: `${SELF_ACCEPT_HINT}.`,
  both_unavailable: "Keep both isn't available here.",
};

interface Box {
  state: ReviewState;
  queue: { seq: number; effect: ReviewEffect }[];
  seq: number;
}

function boxReducer(box: Box, action: ReviewAction): Box {
  const { state, effects } = reviewReducer(box.state, action);
  if (state === box.state && effects.length === 0) return box;
  let seq = box.seq;
  const queue = [...box.queue, ...effects.map((effect) => ({ seq: ++seq, effect }))];
  return { state, queue: queue.slice(-EFFECT_QUEUE_CAP), seq };
}

export function ReviewSurface({
  suggestions,
  me,
  onDecision,
  onReveal,
  onResolveConflict,
  docId,
  digest,
  emptyHint,
  railMinWidth = RAIL_MIN_WIDTH,
  ref,
}: ReviewSurfaceProps) {
  const [box, dispatch] = useReducer(boxReducer, suggestions, (initial) => ({
    state: reviewReducer(initialReviewState(), { type: "load", suggestions: initial }).state,
    queue: [],
    seq: 0,
  }));
  const { state } = box;

  // Re-load when the parent hands us a new list (skip the initial one).
  const loadedRef = useRef(suggestions);
  useEffect(() => {
    if (loadedRef.current === suggestions) return;
    loadedRef.current = suggestions;
    dispatch({ type: "load", suggestions });
  }, [suggestions]);

  // --- live region: one polite region, at most one announcement per 5 s ---
  const [liveText, setLiveText] = useState("");
  const announcerRef = useRef<Announcer | null>(null);
  useEffect(() => {
    const a = createAnnouncer(setLiveText);
    announcerRef.current = a;
    return () => {
      a.dispose();
      announcerRef.current = null;
    };
  }, []);

  // --- effects ---
  const [justAcceptedId, setJustAcceptedId] = useState<string | null>(null);
  const callbacks = useRef({ onDecision, onReveal, onResolveConflict });
  callbacks.current = { onDecision, onReveal, onResolveConflict };
  const drainedRef = useRef(0);
  useEffect(() => {
    for (const { seq, effect } of box.queue) {
      if (seq <= drainedRef.current) continue;
      drainedRef.current = seq;
      switch (effect.type) {
        case "reveal":
          callbacks.current.onReveal(effect.id);
          break;
        case "announce":
          announcerRef.current?.announce(effect.text);
          break;
        case "error":
          announcerRef.current?.announce(ERROR_TEXT[effect.code]);
          break;
        case "decided":
          callbacks.current.onDecision(effect.id, effect.how);
          if (effect.how === "accept") setJustAcceptedId(effect.id);
          break;
        case "resolved":
          callbacks.current.onResolveConflict?.(effect.id, effect.choice);
          if (effect.choice !== "mine") setJustAcceptedId(effect.id);
          break;
      }
    }
  }, [box.queue]);
  useEffect(() => {
    if (!justAcceptedId) return;
    const t = setTimeout(() => setJustAcceptedId(null), ACCEPT_POP_MS);
    return () => clearTimeout(t);
  }, [justAcceptedId]);

  // --- width: measure the host, not the window ---
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w > 0) setWidth(w);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = width !== null && width < railMinWidth;

  // --- actions ---
  const actor = { participantId: me.participantId };
  const enterSession = useCallback(() => dispatch({ type: "enterSession" }), []);
  useImperativeHandle(ref, () => ({ enterSession }), [enterSession]);

  const decide = (id: string, how: "accept" | "reject") => dispatch({ type: "decide", id, how, actor });
  const resolve = (id: string, choice: ConflictChoice) => dispatch({ type: "resolveConflict", id, choice, actor });
  const select = (id: string) => dispatch({ type: "select", id });
  const batch = (authorId: string) => dispatch({ type: "batchAccept", authorId, docId, actor });
  const trust = (participantId: string, tier: TrustTier) => dispatch({ type: "setTrust", participantId, tier });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const what = reviewKeyAction(
      {
        key: e.key,
        target: e.target,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        repeat: e.repeat,
        isComposing: e.nativeEvent.isComposing,
        defaultPrevented: e.defaultPrevented,
      },
      focusContextOf(e.target),
    );
    if (!what) return;
    e.preventDefault();
    if (what === "next") dispatch({ type: "next" });
    else if (what === "prev") dispatch({ type: "prev" });
    else if (what === "leave") dispatch({ type: "leaveSession" });
    else if (state.activeId) decide(state.activeId, what);
  };

  const open = state.suggestions.filter(isUndecided);
  const active = open.find((s) => s.id === state.activeId) ?? null;
  const shared = {
    state,
    me,
    docId,
    digest,
    justAcceptedId,
    onSelect: select,
    onDecide: decide,
    onResolve: resolve,
    onBatch: batch,
    onTrust: trust,
  };

  return (
    <div
      ref={hostRef}
      className={`review-surface ${narrow ? "review-surface--narrow" : "review-surface--wide"}`}
      data-review-layout={narrow ? "chips" : "rail"}
      onKeyDown={onKeyDown}
    >
      <div className="review-surface-body">{narrow ? <ChipBar {...shared} /> : <ReviewRail {...shared} />}</div>
      <ReviewBar
        pending={open.length}
        position={active ? open.indexOf(active) + 1 : 0}
        activeIsConflict={active?.state === "conflict"}
        canAccept={active ? active.author.participantId !== me.participantId : true}
        emptyHint={emptyHint}
        onPrev={() => dispatch({ type: "prev" })}
        onNext={() => dispatch({ type: "next" })}
        onAccept={() => active && decide(active.id, "accept")}
        onReject={() => active && decide(active.id, "reject")}
        onEnterSession={enterSession}
      />
      {state.sessionMode && (
        <ReviewSession
          state={state}
          me={me}
          justAcceptedId={justAcceptedId}
          onPrev={() => dispatch({ type: "prev" })}
          onNext={() => dispatch({ type: "next" })}
          onDecide={decide}
          onResolve={resolve}
          onLeave={() => dispatch({ type: "leaveSession" })}
        />
      )}
      <div className="review-sr" aria-live="polite" aria-atomic="true" data-testid="review-live">
        {liveText}
      </div>
    </div>
  );
}
