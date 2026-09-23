import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { config } from "../config.js";
import { orgRole } from "../permissions/lookup.js";
import {
  insertScopes,
  loadScopes,
  normalizeScopes,
  type TokenScope,
} from "../permissions/token-scope.js";

/**
 * MCP access tokens (migrations 006, 009, 028).
 *
 * Two kinds, one table:
 *
 *  - `user`  — the original shape: authenticates an AI client AS one user
 *              WITHIN one vault. Every row that predates migration 028 is one.
 *              Labelled "acts as you" in Settings, ends at
 *              `config.mcpUserTokenSunset`, and cannot be minted new; the
 *              migrate action below turns one into an agent token.
 *  - `agent` — bound to one agent participant row (migration 027). It acts as
 *              that participant, is capped by the grants of the user who minted
 *              it (`user_id`), and reaches only what its scope rows name
 *              (`permissions/token-scope.ts`). Expires (90 days by default),
 *              renewable and rotatable without touching the scopes.
 *
 * We persist only sha256(token) so a DB leak can't reveal live tokens; the
 * plaintext is shown to the human exactly once, at mint/rotate/migrate.
 */

type Queryable = Pick<pg.Pool, "query">;

const PREFIX = "mcp_";
/** How many leading chars we keep for display (prefix + a short peek). */
const DISPLAY_LEN = PREFIX.length + 6;

export type McpTokenKind = "user" | "agent";

export interface McpTokenRow {
  id: string;
  name: string;
  kind: McpTokenKind;
  organizationId: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** How many tool calls this connection has made (bumped per tools/call). */
  useCount: number;
  /** The last client's User-Agent, so the UI can name the connection. */
  lastClient: string | null;
  /** The user whose grants cap this token: its owner for `user`, its minter for `agent`. */
  userId: string;
  /** The agent participant an `agent` token acts as; null for `user` tokens. */
  participantId: string | null;
  participantName: string | null;
  /** When the token stops authenticating. `agent`: `expires_at`; `user`: the sunset date. */
  expiresAt: string | null;
  /** Unused for `config.mcpTokenStaleDays` (or never used and older than that). */
  stale: boolean;
  scopes: TokenScope[];
}

export interface McpAuth {
  /**
   * The user whose grants bound this call. For a `user` token or an OAuth
   * session that is the caller themself; for an `agent` token it is the
   * minter, whose `effectivePermission` caps every scope the token holds.
   */
  userId: string;
  organizationId: string;
  /**
   * The mcp_tokens row id when auth came from a minted token, so the request
   * handler can attribute tool-call usage back to the connection. Absent for
   * OAuth-authenticated requests (no token row exists for those).
   */
  tokenId?: string;
  /** `agent` for an agent token; `user` for a user token AND for OAuth. */
  kind: McpTokenKind;
  /**
   * Who the call is attributed to, server-resolved: the agent's participant
   * row for an `agent` token, the user's own live human row otherwise (null
   * when they have none). Never taken from the request.
   */
  participantId: string | null;
}

/** A mint/rotate/renew/migrate refusal the route turns into a 4xx. */
export class McpTokenError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A URL-safe opaque token: `mcp_` + 24 random bytes (base64url ≈ 32 chars). */
function generateToken(): string {
  return PREFIX + randomBytes(24).toString("base64url");
}

function agentExpiry(days: number = config.mcpAgentTokenDays): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

interface StoredToken {
  id: string;
  user_id: string;
  organization_id: string;
  name: string;
  kind: McpTokenKind;
  participant_id: string | null;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  last_client: string | null;
  expires_at: string | null;
  participant_name: string | null;
}

const ROW_COLUMNS = `t.id, t.user_id, t.organization_id, t.name, t.kind, t.participant_id,
                     t.token_prefix, t.created_at, t.last_used_at, t.use_count, t.last_client,
                     t.expires_at, p.display_name AS participant_name`;
const ROW_FROM = `FROM mcp_tokens t LEFT JOIN participants p ON p.id = t.participant_id`;

function isStale(row: Pick<StoredToken, "last_used_at" | "created_at">, now = Date.now()): boolean {
  const last = new Date(row.last_used_at ?? row.created_at).getTime();
  return now - last > config.mcpTokenStaleDays * 24 * 60 * 60 * 1000;
}

async function toRow(r: StoredToken, db: Queryable): Promise<McpTokenRow> {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    organizationId: r.organization_id,
    tokenPrefix: r.token_prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    // pg returns INTEGER as a JS number, but coerce defensively.
    useCount: Number(r.use_count ?? 0),
    lastClient: r.last_client,
    userId: r.user_id,
    participantId: r.participant_id,
    participantName: r.participant_name,
    expiresAt:
      r.kind === "agent"
        ? r.expires_at
          ? new Date(r.expires_at).toISOString()
          : null
        : config.mcpUserTokenSunset.toISOString(),
    stale: isStale(r),
    scopes: r.kind === "agent" ? await loadScopes(r.id, db) : [],
  };
}

async function readStored(id: string, db: Queryable): Promise<StoredToken | null> {
  const { rows } = await db.query<StoredToken>(`SELECT ${ROW_COLUMNS} ${ROW_FROM} WHERE t.id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
}

/** One token's public row (never the hash), or null. */
export async function findMcpToken(
  id: string,
  db: Queryable = defaultPool,
): Promise<McpTokenRow | null> {
  const r = await readStored(id, db);
  return r ? toRow(r, db) : null;
}

/**
 * Mint a USER token for (userId, organizationId): the pre-ADR-0003 shape, kept
 * for the tokens that already exist and for tests that exercise "acts as you".
 * No HTTP route calls this any more (`POST /api/mcp/tokens` refuses
 * `kind: "user"` with 410); it is not exported to the tool dispatch path either.
 */
export async function createMcpToken(
  auth: { userId: string; organizationId: string },
  name: string,
  db: Queryable = defaultPool,
): Promise<{ token: string; row: McpTokenRow }> {
  const token = generateToken();
  const id = randomUUID();
  const tokenPrefix = token.slice(0, DISPLAY_LEN) + "…";
  await db.query(
    `INSERT INTO mcp_tokens (id, user_id, organization_id, name, token_hash, token_prefix, kind)
     VALUES ($1, $2, $3, $4, $5, $6, 'user')`,
    [id, auth.userId, auth.organizationId, name, hashToken(token), tokenPrefix],
  );
  const row = (await findMcpToken(id, db))!;
  return { token, row };
}

/** The participant an agent token may be bound to: a LIVE agent row in this org. */
async function requireLiveAgent(
  organizationId: string,
  participantId: string,
  db: Queryable,
): Promise<void> {
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM participants
      WHERE id = $1 AND organization_id = $2 AND kind = 'agent' AND deactivated_at IS NULL`,
    [participantId, organizationId],
  );
  if (rows.length === 0) throw new McpTokenError("participant_not_found");
}

/** Run `fn` in one transaction on a fresh client. */
async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function insertAgentRow(
  client: Queryable,
  input: {
    id: string;
    token: string;
    userId: string;
    organizationId: string;
    name: string;
    participantId: string;
    scopes: TokenScope[];
    expiresAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO mcp_tokens
       (id, user_id, organization_id, name, token_hash, token_prefix, kind, participant_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'agent', $7, $8)`,
    [
      input.id,
      input.userId,
      input.organizationId,
      input.name,
      hashToken(input.token),
      input.token.slice(0, DISPLAY_LEN) + "…",
      input.participantId,
      input.expiresAt,
    ],
  );
  await insertScopes(input.id, input.scopes, client);
}

/**
 * Mint an AGENT token for one live agent participant. `mintedBy` is the
 * owner/admin doing the minting (the route enforces the role): their grants
 * cap the token for its whole life. `scopes` may be empty — the token then
 * lists vaults and nothing else. Returns the PLAINTEXT once plus the row.
 */
export async function createAgentToken(
  input: {
    organizationId: string;
    mintedBy: string;
    participantId: string;
    name: string;
    scopes: unknown;
    expiresInDays?: number;
  },
  pool: pg.Pool = defaultPool,
): Promise<{ token: string; row: McpTokenRow }> {
  await requireLiveAgent(input.organizationId, input.participantId, pool);
  const scopes = await normalizeScopes(input.organizationId, input.scopes, pool);
  const token = generateToken();
  const id = randomUUID();
  await inTransaction(pool, (client) =>
    insertAgentRow(client, {
      id,
      token,
      userId: input.mintedBy,
      organizationId: input.organizationId,
      name: input.name,
      participantId: input.participantId,
      scopes,
      expiresAt: agentExpiry(input.expiresInDays),
    }),
  );
  const row = (await findMcpToken(id, pool))!;
  return { token, row };
}

/**
 * The tokens a caller may see in one vault: their own, plus — for an owner or
 * admin — every AGENT token in the vault (those are team credentials, not
 * personal ones). Never returns hashes.
 */
export async function listMcpTokens(
  auth: { userId: string; organizationId: string; manager?: boolean },
  db: Queryable = defaultPool,
): Promise<McpTokenRow[]> {
  const { rows } = await db.query<StoredToken>(
    `SELECT ${ROW_COLUMNS} ${ROW_FROM}
      WHERE t.organization_id = $2
        AND (t.user_id = $1 OR ($3 AND t.kind = 'agent'))
      ORDER BY t.created_at DESC`,
    [auth.userId, auth.organizationId, auth.manager === true],
  );
  const out: McpTokenRow[] = [];
  for (const r of rows) out.push(await toRow(r, db));
  return out;
}

/** Delete a token row (scopes cascade). Returns true if a row was deleted. */
export async function revokeMcpToken(tokenId: string, db: Queryable = defaultPool): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM mcp_tokens WHERE id = $1", [tokenId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Renew an agent token: `expires_at` becomes now + `days` (default
 * `config.mcpAgentTokenDays`), scopes untouched. Null when no agent token matches.
 */
export async function renewMcpToken(
  tokenId: string,
  days: number = config.mcpAgentTokenDays,
  db: Queryable = defaultPool,
): Promise<McpTokenRow | null> {
  const { rowCount } = await db.query(
    "UPDATE mcp_tokens SET expires_at = $2 WHERE id = $1 AND kind = 'agent'",
    [tokenId, agentExpiry(days)],
  );
  if ((rowCount ?? 0) === 0) return null;
  return findMcpToken(tokenId, db);
}

/**
 * Rotate an agent token: mint a replacement with the same participant, name,
 * minter and scopes, and delete the old row — one transaction, so there is no
 * instant with two live tokens or none. Returns the new PLAINTEXT once.
 */
export async function rotateMcpToken(
  tokenId: string,
  pool: pg.Pool = defaultPool,
): Promise<{ token: string; row: McpTokenRow }> {
  const old = await readStored(tokenId, pool);
  if (!old) throw new McpTokenError("token_not_found");
  if (old.kind !== "agent" || !old.participant_id) throw new McpTokenError("not_an_agent_token");
  const scopes = await loadScopes(old.id, pool);
  const token = generateToken();
  const id = randomUUID();
  await inTransaction(pool, async (client) => {
    await insertAgentRow(client, {
      id,
      token,
      userId: old.user_id,
      organizationId: old.organization_id,
      name: old.name,
      participantId: old.participant_id!,
      scopes,
      expiresAt: agentExpiry(),
    });
    const { rowCount } = await client.query("DELETE FROM mcp_tokens WHERE id = $1", [old.id]);
    // Lost a race with a concurrent revoke: nothing to replace.
    if ((rowCount ?? 0) === 0) throw new McpTokenError("token_not_found");
  });
  const row = (await findMcpToken(id, pool))!;
  return { token, row };
}

/**
 * The user-token migration path (ADR 0003 item 1, review flag b): turn a
 * `user` token into an `agent` token bound to `participantId` with `scopes`,
 * and revoke the user token — one transaction, so an automation is never
 * left with two credentials or none. The new token keeps the OLD token's
 * `user_id` as its cap: the automation cannot gain reach by migrating, only
 * lose it to the scopes. Returns the new PLAINTEXT once.
 */
export async function migrateUserToken(
  tokenId: string,
  input: { participantId: string; scopes: unknown; name?: string },
  pool: pg.Pool = defaultPool,
): Promise<{ token: string; row: McpTokenRow }> {
  const old = await readStored(tokenId, pool);
  if (!old) throw new McpTokenError("token_not_found");
  if (old.kind !== "user") throw new McpTokenError("not_a_user_token");
  await requireLiveAgent(old.organization_id, input.participantId, pool);
  const scopes = await normalizeScopes(old.organization_id, input.scopes, pool);
  const token = generateToken();
  const id = randomUUID();
  await inTransaction(pool, async (client) => {
    await insertAgentRow(client, {
      id,
      token,
      userId: old.user_id,
      organizationId: old.organization_id,
      name: input.name?.trim() || old.name,
      participantId: input.participantId,
      scopes,
      expiresAt: agentExpiry(),
    });
    const { rowCount } = await client.query("DELETE FROM mcp_tokens WHERE id = $1", [old.id]);
    if ((rowCount ?? 0) === 0) throw new McpTokenError("token_not_found");
  });
  const row = (await findMcpToken(id, pool))!;
  return { token, row };
}

/** Longest client string we retain — a User-Agent, trimmed so it can't bloat the row. */
const CLIENT_MAX = 200;

/**
 * Resolve a presented token to its auth context. Returns null when the token is
 * unknown, expired (agent: `expires_at`; user: the sunset date), bound to a
 * participant that is no longer live, OR the capping user is no longer a
 * member of the vault (membership can be revoked out from under a live token).
 * Stamps last_used_at (and the client, when given) best-effort — this drives
 * the desktop's "active" indicator. This is the single gate every MCP request
 * passes through, and it re-reads the row on EVERY request: a revoked token
 * (row deleted) fails here on its next call.
 */
export async function verifyMcpToken(
  token: string,
  db: Queryable = defaultPool,
  meta?: { client?: string | null },
): Promise<McpAuth | null> {
  if (!token || !token.startsWith(PREFIX)) return null;
  const { rows } = await db.query<{
    id: string;
    user_id: string;
    organization_id: string;
    kind: McpTokenKind;
    participant_id: string | null;
    expires_at: string | null;
    participant_live: boolean | null;
    human_participant_id: string | null;
  }>(
    `SELECT t.id, t.user_id, t.organization_id, t.kind, t.participant_id, t.expires_at,
            (p.id IS NOT NULL AND p.deactivated_at IS NULL) AS participant_live,
            h.id AS human_participant_id
       FROM mcp_tokens t
       LEFT JOIN participants p ON p.id = t.participant_id
       LEFT JOIN participants h
         ON h.organization_id = t.organization_id AND h.user_id = t.user_id
        AND h.kind = 'human' AND h.deactivated_at IS NULL
      WHERE t.token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  if (row.kind === "agent") {
    if (!row.participant_id || !row.participant_live) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() <= now) return null;
  } else if (config.mcpUserTokenSunset.getTime() <= now) {
    return null;
  }

  // Membership can be revoked after the token was minted — re-check every time.
  const role = await orgRole(row.organization_id, row.user_id, db);
  if (!role) return null;

  // Best-effort activity stamp; never block the request on it. use_count is NOT
  // bumped here — that happens per tools/call via bumpMcpTokenUsage so the count
  // reflects real work, not initialize/tools-list handshakes.
  const client = meta?.client ? meta.client.slice(0, CLIENT_MAX) : null;
  db.query(
    "UPDATE mcp_tokens SET last_used_at = now(), last_client = COALESCE($2, last_client) WHERE id = $1",
    [row.id, client],
  ).catch(() => {});

  return {
    userId: row.user_id,
    organizationId: row.organization_id,
    tokenId: row.id,
    kind: row.kind,
    participantId: row.kind === "agent" ? row.participant_id : row.human_participant_id,
  };
}

/**
 * Is this token still live RIGHT NOW? Re-checked before every `tools/call` in
 * a batched request, because `verifyMcpToken` runs once per HTTP request and a
 * revoke that lands between two calls of one batch must stop the second.
 */
export async function isMcpTokenLive(tokenId: string, db: Queryable = defaultPool): Promise<boolean> {
  // The same three facts `verifyMcpToken` checks, minus the sunset: the row
  // exists and is unexpired, its agent participant (if any) is live, and the
  // capping user is still a member. One indexed query.
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM mcp_tokens t
       JOIN member m ON m."organizationId" = t.organization_id AND m."userId" = t.user_id
       LEFT JOIN participants p ON p.id = t.participant_id
      WHERE t.id = $1
        AND (t.expires_at IS NULL OR t.expires_at > now())
        AND (t.kind = 'user' OR (p.id IS NOT NULL AND p.deactivated_at IS NULL))
      LIMIT 1`,
    [tokenId],
  );
  return rows.length > 0;
}

/**
 * Attribute `count` tool calls to a token (best-effort; never blocks the reply).
 * Called by the MCP route after a request so the desktop's usage figure tracks
 * actual tool invocations rather than every JSON-RPC handshake message.
 */
export function bumpMcpTokenUsage(
  tokenId: string,
  count: number,
  db: Queryable = defaultPool,
): void {
  if (count <= 0) return;
  db.query("UPDATE mcp_tokens SET use_count = use_count + $2 WHERE id = $1", [
    tokenId,
    count,
  ]).catch(() => {});
}
