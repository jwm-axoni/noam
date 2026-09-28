import { describe, expect, it } from "vitest";
import type { ReviewAuthor, Suggestion } from "./model";
import { initialReviewState, reviewReducer, type ReviewAction, type ReviewState } from "./reducer";

const claude: ReviewAuthor = { participantId: "agent-claude", displayName: "Claude", color: "#009E73", kind: "agent" };
const codex: ReviewAuthor = { participantId: "agent-codex", displayName: "Codex", color: "#0072B2", kind: "agent" };
const me = { participantId: "user-john" };

function sug(id: string, over: Partial<Suggestion> = {}): Suggestion {
  return {
    id, docId: "doc-1", author: claude, kind: "replace", from: 0, to: 4,
    before: "old", after: "new", createdAt: 1, title: `T ${id}`, state: "pending", ...over,
  };
}

function run(state: ReviewState, ...actions: ReviewAction[]) {
  let effects: ReturnType<typeof reviewReducer>["effects"] = [];
  for (const a of actions) ({ state, effects } = reviewReducer(state, a));
  return { state, effects };
}

const loaded = (list: Suggestion[]) => run(initialReviewState(), { type: "load", suggestions: list }).state;
const stateOf = (s: ReviewState, id: string) => s.suggestions.find((x) => x.id === id)?.state;

describe("reviewReducer navigation", () => {
  it("load activates the first undecided item", () => {
    const s = loaded([sug("a", { state: "accepted" }), sug("b"), sug("c")]);
    expect(s.activeId).toBe("b");
  });

  it("next/prev skip decided items and wrap", () => {
    const s = loaded([sug("a"), sug("b", { state: "rejected" }), sug("c"), sug("d", { state: "accepted" })]);
    expect(s.activeId).toBe("a");
    const n1 = run(s, { type: "next" });
    expect(n1.state.activeId).toBe("c");
    expect(n1.effects).toContainEqual({ type: "reveal", id: "c" });
    expect(run(n1.state, { type: "next" }).state.activeId).toBe("a"); // wraps past d
    expect(run(s, { type: "prev" }).state.activeId).toBe("c"); // wraps backward past d
  });

  it("navigation lands on conflicts (they still need a human)", () => {
    const s = loaded([sug("a"), sug("b", { state: "conflict", mine: "x" })]);
    expect(run(s, { type: "next" }).state.activeId).toBe("b");
  });

  it("with nothing undecided, next clears the active item", () => {
    const s = loaded([sug("a", { state: "accepted" })]);
    expect(s.activeId).toBeNull();
    expect(run(s, { type: "next" }).state.activeId).toBeNull();
  });

  it("select moves the active item without deciding anything", () => {
    const s = loaded([sug("a"), sug("b")]);
    const r = run(s, { type: "select", id: "b" });
    expect(r.state.activeId).toBe("b");
    expect(r.state.suggestions.every((x) => x.state === "pending")).toBe(true);
  });
});

describe("reviewReducer decide", () => {
  it("accepting advances to the next undecided item and requests a reveal", () => {
    const s = loaded([sug("a"), sug("b", { state: "rejected" }), sug("c")]);
    const r = run(s, { type: "decide", id: "a", how: "accept", actor: me });
    expect(stateOf(r.state, "a")).toBe("accepted");
    expect(r.state.activeId).toBe("c");
    expect(r.effects).toContainEqual({ type: "decided", id: "a", how: "accept" });
    expect(r.effects).toContainEqual({ type: "reveal", id: "c" });
    expect(r.effects.some((e) => e.type === "announce")).toBe(true);
  });

  it("rejecting the last item leaves nothing active and announces caught up", () => {
    const s = loaded([sug("a")]);
    const r = run(s, { type: "decide", id: "a", how: "reject", actor: me });
    expect(stateOf(r.state, "a")).toBe("rejected");
    expect(r.state.activeId).toBeNull();
    expect(r.effects).toContainEqual({ type: "announce", text: "Nothing to review. You are caught up." });
    expect(r.effects.some((e) => e.type === "reveal")).toBe(false);
  });

  it("deciding a non-active item keeps the active one", () => {
    const s = loaded([sug("a"), sug("b"), sug("c")]);
    const r = run(s, { type: "decide", id: "c", how: "accept", actor: me });
    expect(r.state.activeId).toBe("a");
    expect(r.effects.some((e) => e.type === "reveal")).toBe(false);
  });

  it("refuses an author accepting their own proposal", () => {
    const s = loaded([sug("a")]);
    const r = run(s, { type: "decide", id: "a", how: "accept", actor: { participantId: claude.participantId } });
    expect(r.state).toBe(s);
    expect(r.effects).toEqual([{ type: "error", code: "self_accept" }]);
  });

  it("lets an author withdraw (reject) their own proposal", () => {
    const s = loaded([sug("a")]);
    const r = run(s, { type: "decide", id: "a", how: "reject", actor: { participantId: claude.participantId } });
    expect(stateOf(r.state, "a")).toBe("rejected");
  });

  it("never decides a conflict: it asks for a choice instead", () => {
    const s = loaded([sug("a", { state: "conflict", mine: "x" })]);
    for (const how of ["accept", "reject"] as const) {
      const r = run(s, { type: "decide", id: "a", how, actor: me });
      expect(r.state).toBe(s);
      expect(r.effects).toEqual([{ type: "announce", text: "This one needs a choice" }]);
    }
  });

  it("ignores an already decided or unknown id", () => {
    const s = loaded([sug("a", { state: "accepted" })]);
    expect(run(s, { type: "decide", id: "a", how: "reject", actor: me }).state).toBe(s);
    expect(run(s, { type: "decide", id: "zz", how: "reject", actor: me }).state).toBe(s);
  });
});

describe("reviewReducer batchAccept", () => {
  it("accepts one author's pending items and skips conflicts and other authors", () => {
    const s = loaded([
      sug("a"),
      sug("b", { author: codex }),
      sug("c", { state: "conflict", mine: "x" }),
      sug("d"),
      sug("e", { docId: "doc-2" }),
    ]);
    const r = run(s, { type: "batchAccept", authorId: claude.participantId, docId: "doc-1", actor: me });
    expect(stateOf(r.state, "a")).toBe("accepted");
    expect(stateOf(r.state, "d")).toBe("accepted");
    expect(stateOf(r.state, "b")).toBe("pending");
    expect(stateOf(r.state, "c")).toBe("conflict");
    expect(stateOf(r.state, "e")).toBe("pending"); // another note
    expect(r.effects.filter((e) => e.type === "decided").map((e) => (e as { id: string }).id)).toEqual(["a", "d"]);
    expect(r.state.activeId).toBe("b");
  });

  it("refuses an author batch-accepting their own proposals", () => {
    const s = loaded([sug("a")]);
    const r = run(s, { type: "batchAccept", authorId: claude.participantId, actor: { participantId: claude.participantId } });
    expect(r.state).toBe(s);
    expect(r.effects).toEqual([{ type: "error", code: "self_accept" }]);
  });
});

describe("reviewReducer resolveConflict", () => {
  const conflict = () => loaded([sug("t", { state: "conflict", mine: "Mine", target: "title" }), sug("b", { state: "conflict", mine: "Mine" }), sug("p")]);

  it("keep mine rejects the proposal", () => {
    const r = run(conflict(), { type: "resolveConflict", id: "t", choice: "mine", actor: me });
    expect(stateOf(r.state, "t")).toBe("rejected");
    expect(r.effects).toContainEqual({ type: "resolved", id: "t", choice: "mine" });
    expect(r.state.activeId).toBe("b");
  });

  it("keep theirs accepts the proposal", () => {
    const r = run(conflict(), { type: "resolveConflict", id: "b", choice: "theirs", actor: me });
    expect(stateOf(r.state, "b")).toBe("accepted");
  });

  it("keep both is allowed on body replace text", () => {
    const r = run(conflict(), { type: "resolveConflict", id: "b", choice: "both", actor: me });
    expect(stateOf(r.state, "b")).toBe("accepted");
    expect(r.effects).toContainEqual({ type: "resolved", id: "b", choice: "both" });
  });

  it("keep both is refused on a title and on non-replace kinds", () => {
    const s = conflict();
    const r = run(s, { type: "resolveConflict", id: "t", choice: "both", actor: me });
    expect(r.state).toBe(s);
    expect(r.effects).toEqual([{ type: "error", code: "both_unavailable" }]);
    const s2 = loaded([sug("i", { kind: "insert", state: "conflict", mine: "x" })]);
    expect(run(s2, { type: "resolveConflict", id: "i", choice: "both", actor: me }).state).toBe(s2);
  });

  it("the author cannot resolve their own conflict in their favour", () => {
    const s = conflict();
    const agent = { participantId: claude.participantId };
    expect(run(s, { type: "resolveConflict", id: "b", choice: "theirs", actor: agent }).effects).toEqual([{ type: "error", code: "self_accept" }]);
    expect(stateOf(run(s, { type: "resolveConflict", id: "b", choice: "mine", actor: agent }).state, "b")).toBe("rejected");
  });

  it("ignores a suggestion that is not in conflict", () => {
    const s = conflict();
    expect(run(s, { type: "resolveConflict", id: "p", choice: "theirs", actor: me }).state).toBe(s);
  });
});

describe("reviewReducer session and trust", () => {
  it("enter/leave session toggles the mode", () => {
    const s = loaded([sug("a")]);
    const inSession = run(s, { type: "enterSession" }).state;
    expect(inSession.sessionMode).toBe(true);
    expect(run(inSession, { type: "leaveSession" }).state.sessionMode).toBe(false);
  });

  it("setTrust records a tier per participant", () => {
    const s = run(loaded([]), { type: "setTrust", participantId: "agent-claude", tier: "auto-drafts" }).state;
    expect(s.trust).toEqual({ "agent-claude": "auto-drafts" });
    const s2 = run(s, { type: "setTrust", participantId: "agent-codex", tier: "auto-note" }).state;
    expect(s2.trust).toEqual({ "agent-claude": "auto-drafts", "agent-codex": "auto-note" });
  });

  it("load keeps trust and a still-undecided active item", () => {
    let s = loaded([sug("a"), sug("b")]);
    s = run(s, { type: "select", id: "b" }, { type: "setTrust", participantId: "x", tier: "auto-note" }).state;
    s = run(s, { type: "load", suggestions: [sug("a"), sug("b"), sug("c")] }).state;
    expect(s.activeId).toBe("b");
    expect(s.trust).toEqual({ x: "auto-note" });
  });
});
