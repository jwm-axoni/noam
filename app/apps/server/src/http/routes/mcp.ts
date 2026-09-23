import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { config } from "../../config.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import type { DocWriter } from "../../mcp/doc-writer.js";
import { handleMcpMessage, type JsonRpcRequest } from "../../mcp/protocol.js";
import type { McpContext } from "../../mcp/service.js";
import { resolveOAuthMcpAuth } from "../../mcp/oauth.js";
import {
  McpTokenError,
  bumpMcpTokenUsage,
  createAgentToken,
  findMcpToken,
  isMcpTokenLive,
  listMcpTokens,
  migrateUserToken,
  renewMcpToken,
  revokeMcpToken,
  rotateMcpToken,
  verifyMcpToken,
  type McpTokenRow,
} from "../../mcp/tokens.js";
import { TOOLS } from "../../mcp/tools.js";
import type { McpAudit } from "../../audit/mcp-audit.js";
import {
  SCOPE_PRESETS,
  ScopeError,
  expandPreset,
  type ScopePreset,
} from "../../permissions/token-scope.js";

/**
 * The tool catalog every connection can reach (identical for all tokens; the
 * per-file ACL gates what each call actually touches). Surfaced to the desktop
 * so a connection card can show "which tools it has access to" without the UI
 * hard-coding the list. `access` classifies each tool for a compact badge.
 */
const TOOL_CATALOG = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  access: t.annotations?.destructiveHint
    ? ("destructive" as const)
    : t.annotations?.readOnlyHint
      ? ("read" as const)
      : ("write" as const),
}));

/**
 * Sent on every 401 from the MCP endpoint. Per the MCP auth spec (RFC 9728),
 * this points OAuth-capable clients (e.g. a Claude custom connector) at our
 * protected-resource metadata so they can discover the auth server and start
 * the OAuth flow instead of expecting a hand-pasted token.
 */
const WWW_AUTHENTICATE = `Bearer resource_metadata="${config.betterAuthUrl}/.well-known/oauth-protected-resource"`;

/**
 * The Model Context Protocol surface, part of the same server as everything
 * else (spec: MCP integration):
 *
 *   POST   /api/mcp          → the MCP endpoint AI clients connect to. Auth is a
 *                              minted MCP token (Bearer header or ?key=…). Speaks
 *                              JSON-RPC 2.0 / Streamable-HTTP (single JSON reply).
 *   GET/DELETE /api/mcp       → 405 (we don't offer a server→client SSE stream).
 *
 *   GET    /api/mcp/tokens             → the caller's tokens for the active vault
 *                                         (+ every agent token, for an owner/admin)
 *   POST   /api/mcp/tokens {kind:agent}  → mint an agent token (owner/admin; plaintext once).
 *                                         `kind: user` → 410: user tokens are sunset.
 *   DELETE /api/mcp/tokens/:id          → revoke (live: kicks sockets, retracts the chip)
 *   POST   /api/mcp/tokens/:id/renew    → push an agent token's expiry out, scopes untouched
 *   POST   /api/mcp/tokens/:id/rotate   → replace an agent token (same participant + scopes)
 *   POST   /api/mcp/tokens/:id/migrate  → turn a user token into an agent token (owner/admin)
 *
 * The token endpoints are session-authenticated (the desktop Settings page);
 * the /api/mcp endpoint is token-authenticated (the AI client).
 */

export interface McpDeps {
  docWriter: DocWriter;
  disconnectDoc: (vaultId: string, docId: string) => void;
  /** Broadcast a folder/note create/delete to connected apps. Same callback the
   *  registry routes use, so an AI's structural edit lands live exactly like a
   *  teammate's. */
  onRegistryChanged?: (vaultId: string, originId: string | null) => void;
  /** Agent-token revocation hooks — see `AppDeps` in `../app.ts`. */
  disconnectParticipant?: (participantId: string) => void;
  onParticipantGone?: (organizationId: string, participantId: string) => void;
  /** Audit sink + read budget, injected into every `McpContext`. */
  audit?: McpAudit;
}

/** Pull the MCP token from an Authorization: Bearer header or a ?key=/?token= query. */
function extractToken(c: {
  req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined };
}): string | null {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return c.req.query("key") ?? c.req.query("token") ?? null;
}

/** Active vault: the session's active org, else the user's sole membership. */
async function resolveActiveOrg(
  userId: string,
  activeOrganizationId: string | null,
): Promise<string | null> {
  if (activeOrganizationId) return activeOrganizationId;
  const { rows } = await pool.query<{ organizationId: string }>(
    `SELECT "organizationId" FROM member WHERE "userId" = $1`,
    [userId],
  );
  return rows.length === 1 ? rows[0].organizationId : null;
}

/** The scope presets Settings offers, each a template over `expandPreset`. */
const PRESETS: Array<{ name: ScopePreset; description: string }> = [
  { name: "reader", description: "Read every note in the vault; write nothing." },
  { name: "drafter", description: "Read the whole vault; write only inside one folder." },
  { name: "editor", description: "Read and write every note in the vault." },
];

const MANAGER_ROLES = new Set(["owner", "admin"]);

/** `expiresInDays`: absent → default; otherwise an integer in 1..365. */
function parseExpiry(raw: unknown): number | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 365) return "invalid";
  return raw;
}

/**
 * The scopes a mint/migrate body asks for: explicit `scopes` win, else the
 * preset expanded for this org. Neither → `invalid_preset` (an empty scope
 * list is still expressible as `scopes: []`). Throws `ScopeError`.
 */
function requestedScopes(
  body: { scopes?: unknown; preset?: unknown; folderId?: unknown },
  organizationId: string,
): unknown {
  if (body.scopes !== undefined) return body.scopes;
  if (!SCOPE_PRESETS.includes(body.preset as ScopePreset)) throw new ScopeError("invalid_preset");
  const folderId = typeof body.folderId === "string" ? body.folderId : null;
  return expandPreset(body.preset as ScopePreset, organizationId, folderId);
}

/** The 4xx a mint/renew/rotate/migrate refusal maps to, or null to rethrow. */
function refusal(err: unknown): { error: string; status: 400 | 404 } | null {
  if (err instanceof ScopeError) return { error: err.code, status: 400 };
  if (err instanceof McpTokenError) {
    const notFound = err.code === "participant_not_found" || err.code === "token_not_found";
    return { error: err.code, status: notFound ? 404 : 400 };
  }
  return null;
}

type Managed =
  | { ok: true; row: McpTokenRow; organizationId: string }
  | { ok: false; error: string; status: 401 | 403 | 404 };

/**
 * Who may revoke / renew / rotate a token: its own user (a user token they
 * hold, or an agent token they minted), or an owner/admin of the token's vault
 * for an AGENT token — those are team credentials. A manager can NOT act on
 * someone else's user token: that one acts as its holder, not as the team.
 */
async function loadManaged(
  session: { userId: string } | null,
  tokenId: string,
): Promise<Managed> {
  if (!session) return { ok: false, error: "Authentication required", status: 401 };
  const row = await findMcpToken(tokenId);
  if (!row) return { ok: false, error: "Token not found", status: 404 };
  const organizationId = row.organizationId;
  if (row.userId === session.userId) return { ok: true, row, organizationId };
  const role = await orgRole(organizationId, session.userId);
  if (row.kind === "agent" && role && MANAGER_ROLES.has(role)) {
    return { ok: true, row, organizationId };
  }
  return { ok: false, error: "forbidden", status: 403 };
}

export function createMcpRoutes(deps: McpDeps): Hono {
  const app = new Hono();

  // ── The MCP endpoint (token- OR OAuth-authenticated) ──────────────────────
  // Two ways in, both resolving to the SAME (user, vault) McpAuth:
  //   1. a minted `mcp_` token (Bearer header or ?key=) — desktop power users;
  //   2. an OAuth 2.1 access token (Bearer header) from the custom-connector
  //      flow — the vault comes from the user's consent-screen choice.
  app.post("/mcp", async (c) => {
    const token = extractToken(c);
    const client = c.req.header("user-agent") ?? c.req.header("User-Agent") ?? null;
    let auth = token ? await verifyMcpToken(token, undefined, { client }) : null;
    if (!auth) auth = await resolveOAuthMcpAuth(c.req.raw.headers);
    if (!auth) {
      c.header("WWW-Authenticate", WWW_AUTHENTICATE);
      c.header("Access-Control-Expose-Headers", "WWW-Authenticate");
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "Unauthorized: authentication required" },
        },
        401,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }

    const ctx: McpContext = {
      auth,
      docWriter: deps.docWriter,
      disconnectDoc: deps.disconnectDoc,
      // No origin to skip: an MCP client isn't a vault-channel subscriber, so
      // every connected app should hear about this write.
      onRegistryChanged: (vaultId) => deps.onRegistryChanged?.(vaultId, null),
      audit: deps.audit,
      readBudget: deps.audit,
    };

    // A batch (array) or a single message. Notifications yield no response.
    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    let toolCalls = 0;
    for (const m of messages) {
      if ((m as JsonRpcRequest)?.method === "tools/call") {
        // `verifyMcpToken` runs once per HTTP request, so a batch is the only
        // place a revoke can land between two calls. Re-checking before every
        // call after the first bounds the write-stop window to ONE in-flight
        // tool call (ADR 0003 item 5). Token-auth only: OAuth has no row.
        if (toolCalls > 0 && auth.tokenId && !(await isMcpTokenLive(auth.tokenId))) {
          responses.push({
            jsonrpc: "2.0" as const,
            id: (m as JsonRpcRequest).id ?? null,
            error: { code: -32001, message: "Unauthorized: token revoked" },
          });
          continue;
        }
        toolCalls++;
      }
      const res = await handleMcpMessage(m as JsonRpcRequest, ctx);
      if (res) responses.push(res);
    }

    // Attribute real tool work to the connection (token-auth only; OAuth has no row).
    if (auth.tokenId) bumpMcpTokenUsage(auth.tokenId, toolCalls);

    if (responses.length === 0) return c.body(null, 202); // notifications only
    return c.json(Array.isArray(body) ? responses : responses[0]);
  });

  // No server-initiated stream; be explicit so clients fall back to POST-only.
  const noStream = (c: { text: (t: string, s: 405) => Response }) =>
    c.text("Method Not Allowed", 405);
  app.get("/mcp", noStream);
  app.delete("/mcp", noStream);

  // ── Token management (session-authenticated; used by desktop Settings) ─────
  app.get("/mcp/tokens", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const org = await resolveActiveOrg(session.userId, session.activeOrganizationId);
    if (!org) return c.json({ error: "No active vault" }, 400);
    const role = await orgRole(org, session.userId);
    if (!role) return c.json({ error: "Not a member of this vault" }, 403);
    const tokens = await listMcpTokens({
      userId: session.userId,
      organizationId: org,
      manager: MANAGER_ROLES.has(role),
    });
    // `tools` is the catalog every connection can reach — the desktop shows it
    // as "tools it has access to" per connection.
    return c.json({
      tokens,
      tools: TOOL_CATALOG,
      presets: PRESETS,
      userTokenSunset: config.mcpUserTokenSunset.toISOString(),
    });
  });

  app.post("/mcp/tokens", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // ADR 0003 item 1: no new "acts as you" tokens once agent tokens ship.
    if (body.kind === undefined || body.kind === "user") {
      return c.json(
        {
          error: "user_tokens_sunset",
          sunsetAt: config.mcpUserTokenSunset.toISOString(),
          hint: "mint an agent token",
        },
        410,
      );
    }
    if (body.kind !== "agent") return c.json({ error: "invalid_kind" }, 400);

    const org = await resolveActiveOrg(session.userId, session.activeOrganizationId);
    if (!org) return c.json({ error: "No active vault" }, 400);
    const role = await orgRole(org, session.userId);
    if (!role) return c.json({ error: "Not a member of this vault" }, 403);
    if (!MANAGER_ROLES.has(role)) return c.json({ error: "owner_or_admin_required" }, 403);
    if (typeof body.participantId !== "string" || !body.participantId) {
      return c.json({ error: "participant_required" }, 400);
    }
    const expiresInDays = parseExpiry(body.expiresInDays);
    if (expiresInDays === "invalid") return c.json({ error: "invalid_expiry" }, 400);
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Agent token";

    try {
      const { token, row } = await createAgentToken({
        organizationId: org,
        mintedBy: session.userId,
        participantId: body.participantId,
        name,
        scopes: requestedScopes(body, org),
        expiresInDays,
      });
      // The plaintext token is returned exactly once.
      return c.json({ token, ...row }, 201);
    } catch (err) {
      const r = refusal(err);
      if (r) return c.json({ error: r.error }, r.status);
      throw err;
    }
  });

  app.delete("/mcp/tokens/:id", async (c) => {
    const found = await loadManaged(await getSession(c), c.req.param("id"));
    if (!found.ok) return c.json({ error: found.error }, found.status);
    const { row, organizationId } = found;
    if (!(await revokeMcpToken(row.id))) return c.json({ error: "Token not found" }, 404);

    // Live revocation (ADR 0003 item 5). The row is gone, so the next MCP
    // request fails `verifyMcpToken`; these close any doc socket bound to the
    // participant and retract its presence chip without waiting for decay.
    // A user token acts as its human, whose sockets and chip are their own.
    if (row.kind === "agent" && row.participantId) {
      deps.disconnectParticipant?.(row.participantId);
      deps.onParticipantGone?.(organizationId, row.participantId);
    }
    await deps.audit?.record({
      auth: {
        userId: row.userId,
        organizationId,
        tokenId: row.id,
        kind: row.kind,
        participantId: row.participantId,
      },
      tool: "token.revoke",
      docId: null,
      outcome: "revoked",
      bytesOut: 0,
    });
    return c.json({ revoked: row.id, kind: row.kind, participantId: row.participantId });
  });

  app.post("/mcp/tokens/:id/renew", async (c) => {
    const found = await loadManaged(await getSession(c), c.req.param("id"));
    if (!found.ok) return c.json({ error: found.error }, found.status);
    if (found.row.kind !== "agent") return c.json({ error: "not_an_agent_token" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const days = parseExpiry(body.expiresInDays);
    if (days === "invalid") return c.json({ error: "invalid_expiry" }, 400);
    const row = await renewMcpToken(found.row.id, days);
    if (!row) return c.json({ error: "Token not found" }, 404);
    return c.json(row);
  });

  app.post("/mcp/tokens/:id/rotate", async (c) => {
    const found = await loadManaged(await getSession(c), c.req.param("id"));
    if (!found.ok) return c.json({ error: found.error }, found.status);
    if (found.row.kind !== "agent") return c.json({ error: "not_an_agent_token" }, 400);
    try {
      const { token, row } = await rotateMcpToken(found.row.id);
      return c.json({ token, ...row }, 201);
    } catch (err) {
      const r = refusal(err);
      if (r) return c.json({ error: r.error }, r.status);
      throw err;
    }
  });

  // Binding a token to an agent participant is a manager act (the same gate as
  // minting one), so only an owner/admin of the token's vault may migrate —
  // even their own. The new token keeps the old one's user as its cap.
  app.post("/mcp/tokens/:id/migrate", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const id = c.req.param("id");
    const row = await findMcpToken(id);
    if (!row) return c.json({ error: "Token not found" }, 404);
    const organizationId = row.organizationId;
    const role = await orgRole(organizationId, session.userId);
    if (!role || !MANAGER_ROLES.has(role)) {
      return c.json({ error: "owner_or_admin_required" }, 403);
    }
    if (row.kind !== "user") return c.json({ error: "not_a_user_token" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.participantId !== "string" || !body.participantId) {
      return c.json({ error: "participant_required" }, 400);
    }
    try {
      const { token, row: next } = await migrateUserToken(id, {
        participantId: body.participantId,
        scopes: requestedScopes(body, organizationId),
        name: typeof body.name === "string" ? body.name : undefined,
      });
      return c.json({ token, ...next, migratedFrom: id }, 201);
    } catch (err) {
      const r = refusal(err);
      if (r) return c.json({ error: r.error }, r.status);
      throw err;
    }
  });

  return app;
}
