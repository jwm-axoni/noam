// Per-doc sync tokens are short-lived JWTs (default 10-min TTL, spec 03 §7).
// Hocuspocus historically doesn't re-authenticate on reconnect, so we proactively
// re-mint and reconnect BEFORE expiry. This module owns only the *scheduling*
// math + timer, kept pure/injectable so the timing logic is unit-testable.

export interface RefreshSchedulerOptions {
  /** Re-mint this many ms before the token would expire. Default 60s. */
  leadMs?: number;
  /** Never schedule sooner than this (avoids a hot loop on tiny TTLs). Default 5s. */
  minDelayMs?: number;
  /** Injectable timers (default global set/clearTimeout). */
  setTimeoutImpl?: (fn: () => void, ms: number) => number;
  clearTimeoutImpl?: (id: number) => void;
  /** Injectable clock (ms since epoch). Default Date.now. */
  now?: () => number;
}

/**
 * Compute the delay (ms from now) at which to refresh a token, given its TTL.
 * Refresh `leadMs` before expiry, clamped to at least `minDelayMs`.
 */
export function computeRefreshDelay(ttlSeconds: number, opts: RefreshSchedulerOptions = {}): number {
  const leadMs = opts.leadMs ?? 60_000;
  const minDelayMs = opts.minDelayMs ?? 5_000;
  const ttlMs = Math.max(0, ttlSeconds * 1000);
  return Math.max(minDelayMs, ttlMs - leadMs);
}

/**
 * A single-shot, re-armable timer that calls `onRefresh` shortly before the
 * current token expires. Call `schedule(ttlSeconds)` after each mint; call
 * `cancel()` on teardown.
 */
export class TokenRefreshScheduler {
  private timer: number | null = null;
  private readonly setT: (fn: () => void, ms: number) => number;
  private readonly clearT: (id: number) => void;
  private readonly opts: RefreshSchedulerOptions;

  constructor(
    private readonly onRefresh: () => void,
    opts: RefreshSchedulerOptions = {},
  ) {
    this.opts = opts;
    this.setT =
      opts.setTimeoutImpl ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
    this.clearT = opts.clearTimeoutImpl ?? ((id) => globalThis.clearTimeout(id));
  }

  /** (Re)arm the timer for a freshly minted token with the given TTL. */
  schedule(ttlSeconds: number): void {
    this.cancel();
    const delay = computeRefreshDelay(ttlSeconds, this.opts);
    this.timer = this.setT(() => {
      this.timer = null;
      this.onRefresh();
    }, delay);
  }

  cancel(): void {
    if (this.timer != null) {
      this.clearT(this.timer);
      this.timer = null;
    }
  }

  get isArmed(): boolean {
    return this.timer != null;
  }
}
