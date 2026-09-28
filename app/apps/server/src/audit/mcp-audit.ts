import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { config } from "../config.js";
import type { McpAuth } from "../mcp/tokens.js";

/**
 * The MCP audit log and the per-token read budget (ADR 0003 items 4 and 6).
 *
 * Lives OUTSIDE `src/mcp/` on purpose: `tests/mcp-tool-inventory.test.ts`
 * asserts by source inspection that nothing under `src/mcp/` contains SQL
 * against `mcp_audit`. The MCP protocol layer calls `record` around every
 * `tools/call` and `check` before a read tool runs; no tool implementation
 * sees either, so no tool can skip, forge or read its own rows.
 */

type Queryable = Pick<pg.Pool, "query">;

export type McpAuditOutcome = "ok" | "error" | "denied" | "rate_limited" | "revoked";

export interface McpAuditEntry {
  auth: McpAuth;
  tool: string;
  /** The doc the call named, when it named one. */
  docId: string | null;
  outcome: McpAuditOutcome;
  /** Size of the result handed back, in bytes (0 for refusals). */
  bytesOut: number;
}

export interface McpAuditSink {
  /** Insert one row. Never throws to the caller; a failed insert is logged. */
  record(entry: McpAuditEntry): Promise<void>;
}

/** The structured payload of a `rate_limited` tool error. */
export interface RateLimitedInfo {
  error: "rate_limited";
  /** Which budget was exhausted. */
  budget: "calls_per_minute" | "bytes_per_hour";
  limit: number;
  used: number;
  /** ISO instant at which the oldest counted call leaves the window. */
  resetAt: string;
}

export interface McpReadBudget {
  /**
   * May this caller run one more read tool now? `null` = yes; otherwise the
   * structured refusal. Keyed by `auth.tokenId`, or by `auth.userId` for the
   * OAuth path (no token row).
   */
  check(auth: McpAuth): Promise<RateLimitedInfo | null>;
  /**
   * Run `fn` with this caller's budget key held: check → tool → record happen
   * in sequence for one key, never interleaved with another call on the same
   * key. Without it N parallel reads all see the same pre-call count and all
   * pass, and a 120/min budget becomes 120 × (concurrency). Keyed exactly like
   * `check`; per process, like the doc writer's per-doc lock.
   */
  serialize<T>(auth: McpAuth, fn: () => Promise<T>): Promise<T>;
}

export type McpAudit = McpAuditSink & McpReadBudget;

export interface McpAuditOptions {
  db?: Queryable;
  retentionDays?: number;
  callsPerMinute?: number;
  bytesPerHour?: number;
  /** Clock override (tests). Drives only the prune throttle; the budget windows use the DB clock. */
  now?: () => Date;
  /** Minimum gap between two lazy retention prunes (default one hour). */
  pruneEveryMs?: number;
}

/** The tools that draw on the shared read budget (ADR 0003 item 6). */
export const READ_BUDGET_TOOLS = ["read_note", "search_notes"] as const;

/** Delete audit rows older than `retentionDays`. Returns how many went. */
export async function pruneMcpAudit(db: Queryable, retentionDays: number): Promise<number> {
  const { rowCount } = await db.query(
    "DELETE FROM mcp_audit WHERE at < now() - make_interval(days => $1)",
    [retentionDays],
  );
  return rowCount ?? 0;
}

export function createMcpAudit(opts: McpAuditOptions = {}): McpAudit {
  const db = opts.db ?? defaultPool;
  const retentionDays = opts.retentionDays ?? config.mcpAuditRetentionDays;
  const callsPerMinute = opts.callsPerMinute ?? config.mcpReadCallsPerMinute;
  const bytesPerHour = opts.bytesPerHour ?? config.mcpReadBytesPerHour;
  const now = opts.now ?? (() => new Date());
  const pruneEveryMs = opts.pruneEveryMs ?? 60 * 60 * 1000;
  // Per instance (one per process in production): null = never pruned, so the
  // first record prunes. Claimed BEFORE the delete so concurrent records don't
  // all prune at once.
  let lastPruneAt: number | null = null;

  async function maybePrune(): Promise<void> {
    const t = now().getTime();
    if (lastPruneAt !== null && t - lastPruneAt < pruneEveryMs) return;
    lastPruneAt = t;
    await pruneMcpAudit(db, retentionDays);
  }

  // One promise chain per budget key. Self-cleaning: an entry is removed once
  // its chain settles, so an idle key costs nothing.
  const chains = new Map<string, Promise<unknown>>();
  function budgetKey(auth: McpAuth): string {
    return auth.tokenId ? `token:${auth.tokenId}` : `user:${auth.userId}`;
  }

  return {
    async serialize(auth, fn) {
      const key = budgetKey(auth);
      const prev = chains.get(key) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      const chain = run.then(
        () => undefined,
        () => undefined,
      );
      chains.set(key, chain);
      try {
        return await run;
      } finally {
        if (chains.get(key) === chain) chains.delete(key);
      }
    },

    async record(entry) {
      try {
        await db.query(
          `INSERT INTO mcp_audit
             (token_id, participant_id, user_id, organization_id, tool, doc_id, outcome, bytes_out)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            entry.auth.tokenId ?? null,
            entry.auth.participantId ?? null,
            entry.auth.userId,
            entry.auth.organizationId,
            entry.tool,
            entry.docId,
            entry.outcome,
            Math.max(0, Math.floor(entry.bytesOut)),
          ],
        );
      } catch (err) {
        console.error(`[mcp-audit] failed to record ${entry.tool}:`, err);
      }
      try {
        await maybePrune();
      } catch (err) {
        console.error("[mcp-audit] retention prune failed:", err);
      }
    },

    async check(auth) {
      // Token calls are keyed by the token row; OAuth calls (no row) by user.
      const key = auth.tokenId
        ? { sql: "token_id = $1", param: auth.tokenId }
        : { sql: "token_id IS NULL AND user_id = $1", param: auth.userId };
      // A refused call (`rate_limited`) never counts, or a client hammering a
      // closed budget would keep it closed forever.
      const scope = `${key.sql} AND tool = ANY($2) AND outcome <> 'rate_limited'`;
      const tools = [...READ_BUDGET_TOOLS];

      const calls = await db.query<{ used: number; reset_at: Date | null }>(
        `SELECT count(*)::int AS used, min(at) + interval '60 seconds' AS reset_at
           FROM mcp_audit
          WHERE ${scope} AND at > now() - interval '60 seconds'`,
        [key.param, tools],
      );
      const c = calls.rows[0];
      if (c.used >= callsPerMinute) {
        return {
          error: "rate_limited",
          budget: "calls_per_minute",
          limit: callsPerMinute,
          used: c.used,
          resetAt: new Date(c.reset_at!).toISOString(),
        };
      }

      const bytes = await db.query<{ used: string; reset_at: Date | null }>(
        `SELECT COALESCE(sum(bytes_out), 0)::bigint AS used,
                min(at) + interval '3600 seconds' AS reset_at
           FROM mcp_audit
          WHERE ${scope} AND at > now() - interval '3600 seconds'`,
        [key.param, tools],
      );
      const b = bytes.rows[0];
      const usedBytes = Number(b.used);
      if (usedBytes >= bytesPerHour) {
        return {
          error: "rate_limited",
          budget: "bytes_per_hour",
          limit: bytesPerHour,
          used: usedBytes,
          resetAt: new Date(b.reset_at!).toISOString(),
        };
      }
      return null;
    },
  };
}
