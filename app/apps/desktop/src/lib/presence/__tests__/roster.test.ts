import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceRoster, REMOVE_MS, STALE_MS, type PresenceFrame } from "../roster";

function frame(over: Partial<PresenceFrame> = {}): PresenceFrame {
  return {
    userId: "u-maya",
    participantId: "p-maya",
    docId: "doc-1",
    name: "Maya",
    color: "#2981fb",
    status: "online",
    ...over,
  };
}

describe("PresenceRoster", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  const now = () => Date.now();

  it("exports the decay thresholds", () => {
    expect(STALE_MS).toBe(30_000);
    expect(REMOVE_MS).toBe(90_000);
  });

  it("joins a new peer exactly once, carrying participantId", () => {
    const r = new PresenceRoster();
    const first = r.apply(frame(), now());
    expect(first.joined.map((p) => p.userId)).toEqual(["u-maya"]);
    expect(first.joined[0]).toMatchObject({ participantId: "p-maya", stale: false, lastSeenAt: now() });
    const again = r.apply(frame({ docId: "doc-2" }), now());
    expect(again).toEqual({ joined: [], left: [], staleChanged: [] });
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0].docId).toBe("doc-2");
  });

  it("keeps a peer with docId null online (no note open is not gone)", () => {
    const r = new PresenceRoster();
    r.apply(frame(), now());
    const ev = r.apply(frame({ docId: null }), now());
    expect(ev.left).toEqual([]);
    expect(r.list()).toEqual([expect.objectContaining({ userId: "u-maya", docId: null, stale: false })]);
    // …and a first frame with docId null is still a join.
    const r2 = new PresenceRoster();
    expect(r2.apply(frame({ docId: null }), now()).joined).toHaveLength(1);
  });

  it("removes immediately on gone, once", () => {
    const r = new PresenceRoster();
    r.apply(frame(), now());
    const ev = r.apply(frame({ docId: null, gone: true }), now());
    expect(ev.left).toEqual([{ peer: expect.objectContaining({ userId: "u-maya" }), reason: "gone" }]);
    expect(r.list()).toEqual([]);
    // A second gone for an absent peer says nothing.
    expect(r.apply(frame({ gone: true }), now())).toEqual({ joined: [], left: [], staleChanged: [] });
  });

  it("never adds an invisible peer and removes one that turns invisible", () => {
    const r = new PresenceRoster();
    expect(r.apply(frame({ status: "invisible", docId: null }), now()).joined).toEqual([]);
    expect(r.list()).toEqual([]);
    r.apply(frame(), now());
    const ev = r.apply(frame({ status: "invisible", docId: null }), now());
    expect(ev.left.map((l) => l.peer.userId)).toEqual(["u-maya"]);
    expect(r.list()).toEqual([]);
  });

  it("goes stale after 30 s of silence, once, and un-stales on the next frame", () => {
    const r = new PresenceRoster();
    r.apply(frame(), now());
    vi.advanceTimersByTime(STALE_MS - 1);
    expect(r.tick(now())).toEqual({ joined: [], left: [], staleChanged: [] });
    vi.advanceTimersByTime(1);
    const stale = r.tick(now());
    expect(stale.staleChanged).toEqual([expect.objectContaining({ userId: "u-maya", stale: true })]);
    expect(r.list()[0].stale).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(r.tick(now()).staleChanged).toEqual([]); // not re-emitted

    const back = r.apply(frame(), now());
    expect(back.joined).toEqual([]);
    expect(back.staleChanged).toEqual([expect.objectContaining({ userId: "u-maya", stale: false })]);
    expect(r.list()[0]).toMatchObject({ stale: false, lastSeenAt: now() });
  });

  it("removes after 90 s of silence with reason timeout, once", () => {
    const r = new PresenceRoster();
    r.apply(frame(), now());
    vi.advanceTimersByTime(STALE_MS);
    r.tick(now());
    vi.advanceTimersByTime(REMOVE_MS - STALE_MS);
    const ev = r.tick(now());
    expect(ev.left).toEqual([{ peer: expect.objectContaining({ userId: "u-maya" }), reason: "timeout" }]);
    expect(r.list()).toEqual([]);
    expect(r.tick(now())).toEqual({ joined: [], left: [], staleChanged: [] });
  });

  it("a peer that reconnects after a timeout joins again", () => {
    const r = new PresenceRoster();
    r.apply(frame(), now());
    vi.advanceTimersByTime(REMOVE_MS);
    expect(r.tick(now()).left).toHaveLength(1);
    const ev = r.apply(frame(), now());
    expect(ev.joined.map((p) => p.userId)).toEqual(["u-maya"]);
    expect(r.list()[0].stale).toBe(false);
  });

  it("a fresh frame resets the clock, so a heartbeating peer never decays", () => {
    const r = new PresenceRoster();
    r.apply(frame(), now());
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(10_000);
      r.apply(frame(), now());
      expect(r.tick(now())).toEqual({ joined: [], left: [], staleChanged: [] });
    }
  });

  it("returns fresh peer objects on change, so React sees updates", () => {
    const r = new PresenceRoster();
    r.apply(frame(), now());
    const before = r.list()[0];
    r.apply(frame({ docId: "doc-9" }), now());
    expect(r.list()[0]).not.toBe(before);
    expect(before.docId).toBe("doc-1");
  });

  it("clear drops everyone without emitting leave events", () => {
    const r = new PresenceRoster();
    r.apply(frame(), now());
    r.clear();
    expect(r.list()).toEqual([]);
  });
});
