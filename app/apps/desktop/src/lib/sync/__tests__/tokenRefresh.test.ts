import { describe, expect, it, vi } from "vitest";
import { TokenRefreshScheduler, computeRefreshDelay } from "../tokenRefresh";
import { jwtExpSeconds, ttlFromToken } from "../syncManager";

describe("token refresh scheduling (spec 03 §7)", () => {
  it("refreshes leadMs before expiry", () => {
    // 600s TTL, 60s lead → 540s.
    expect(computeRefreshDelay(600, { leadMs: 60_000 })).toBe(540_000);
  });

  it("never schedules below the minimum delay (short/expired TTLs)", () => {
    expect(computeRefreshDelay(30, { leadMs: 60_000, minDelayMs: 5_000 })).toBe(5_000);
    expect(computeRefreshDelay(0, { leadMs: 60_000, minDelayMs: 5_000 })).toBe(5_000);
  });

  it("arms a timer and fires onRefresh at the computed delay", () => {
    let fired = 0;
    let scheduledMs = -1;
    const setTimeoutImpl = (fn: () => void, ms: number) => {
      scheduledMs = ms;
      fn(); // run synchronously for the test
      return 1;
    };
    const clearTimeoutImpl = vi.fn();
    const s = new TokenRefreshScheduler(() => fired++, {
      leadMs: 60_000,
      minDelayMs: 5_000,
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    s.schedule(600);
    expect(scheduledMs).toBe(540_000);
    expect(fired).toBe(1);
  });

  it("re-arming cancels the previous timer", () => {
    const clearTimeoutImpl = vi.fn();
    let id = 0;
    const s = new TokenRefreshScheduler(() => {}, {
      setTimeoutImpl: () => ++id,
      clearTimeoutImpl,
    });
    s.schedule(600);
    s.schedule(600);
    expect(clearTimeoutImpl).toHaveBeenCalledTimes(1);
    s.cancel();
    expect(clearTimeoutImpl).toHaveBeenCalledTimes(2);
    expect(s.isArmed).toBe(false);
  });
});

describe("JWT ttl extraction", () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
  }

  it("reads the exp claim", () => {
    const exp = 2_000_000_000;
    expect(jwtExpSeconds(makeJwt({ exp }))).toBe(exp);
  });

  it("returns the ttl in seconds from a fixed clock", () => {
    const nowMs = 1_000_000_000_000; // 1e12 ms = 1e9 s
    const token = makeJwt({ exp: 1_000_000_000 + 300 }); // +5 min
    expect(ttlFromToken(token, nowMs)).toBe(300);
  });

  it("falls back to the default TTL for a malformed token", () => {
    expect(jwtExpSeconds("not-a-jwt")).toBeNull();
    expect(ttlFromToken("not-a-jwt")).toBe(600);
  });

  it("floors ttl at 0 for an expired token", () => {
    const nowMs = 2_000_000_000_000;
    const token = makeJwt({ exp: 1_000 });
    expect(ttlFromToken(token, nowMs)).toBe(0);
  });
});
