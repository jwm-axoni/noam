import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCE_INTERVAL_MS, AnnouncementDebouncer } from "../announcer";

describe("AnnouncementDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("announces nothing when idle", () => {
    const said: string[] = [];
    new AnnouncementDebouncer((m) => said.push(m));
    vi.advanceTimersByTime(60_000);
    expect(said).toEqual([]);
  });

  it("speaks the first message at once, then at most one per 5 s with the last one winning", () => {
    expect(ANNOUNCE_INTERVAL_MS).toBe(5_000);
    const said: string[] = [];
    const a = new AnnouncementDebouncer((m) => said.push(m));
    a.push("Maya joined");
    expect(said).toEqual(["Maya joined"]);

    a.push("Sam joined");
    a.push("Maya disconnected");
    vi.advanceTimersByTime(4_999);
    expect(said).toEqual(["Maya joined"]);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(["Maya joined", "Maya disconnected"]);

    // A burst right after a trailing flush waits out a full window too.
    a.push("2 people in this note");
    vi.advanceTimersByTime(4_999);
    expect(said).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(["Maya joined", "Maya disconnected", "2 people in this note"]);

    // Idle again: nothing more.
    vi.advanceTimersByTime(30_000);
    expect(said).toHaveLength(3);
  });

  it("never emits more than one announcement in any 5 s window under a flood", () => {
    const at: number[] = [];
    const a = new AnnouncementDebouncer(() => at.push(Date.now()));
    for (let i = 0; i < 200; i++) {
      a.push(`event ${i}`);
      vi.advanceTimersByTime(250);
    }
    vi.advanceTimersByTime(10_000);
    for (let i = 1; i < at.length; i++) {
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(ANNOUNCE_INTERVAL_MS);
    }
  });

  it("dispose drops a pending announcement", () => {
    const said: string[] = [];
    const a = new AnnouncementDebouncer((m) => said.push(m));
    a.push("one");
    a.push("two");
    a.dispose();
    vi.advanceTimersByTime(10_000);
    expect(said).toEqual(["one"]);
  });
});
