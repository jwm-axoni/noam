import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnnouncer } from "./announcer";

describe("createAnnouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("speaks once per 5s and ends on the latest message", () => {
    const said: string[] = [];
    const a = createAnnouncer((t) => said.push(t));
    a.announce("one");
    a.announce("two");
    a.announce("three");
    expect(said).toEqual(["one"]);
    vi.advanceTimersByTime(4999);
    expect(said).toEqual(["one"]);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(["one", "three"]);
    a.announce("four");
    expect(said).toEqual(["one", "three"]);
    vi.advanceTimersByTime(5000);
    expect(said).toEqual(["one", "three", "four"]);
    vi.advanceTimersByTime(6000);
    a.announce("five");
    expect(said).toEqual(["one", "three", "four", "five"]);
  });

  it("dispose drops a pending message", () => {
    const said: string[] = [];
    const a = createAnnouncer((t) => said.push(t));
    a.announce("one");
    a.announce("two");
    a.dispose();
    vi.advanceTimersByTime(10000);
    expect(said).toEqual(["one"]);
  });
});
