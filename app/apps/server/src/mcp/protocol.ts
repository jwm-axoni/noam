import type { McpAuditOutcome } from "../audit/mcp-audit.js";
import { McpToolError, type McpContext, type McpToolErrorCode } from "./service.js";
import { TOOLS, TOOLS_BY_NAME } from "./tools.js";

/**
 * A minimal, spec-compliant MCP server over JSON-RPC 2.0, transport-agnostic.
 * The HTTP route (routes/mcp.ts) feeds us one parsed JSON-RPC message plus the
 * caller's McpContext; we return the JSON-RPC response object, or null for a
 * notification (which gets an HTTP 202 with no body).
 *
 * We implement the Streamable-HTTP request/response shape: a single JSON reply
 * per request, no SSE stream. That covers every CRUD interaction — the server
 * never needs to push unsolicited messages.
 */

const SERVER_INFO = { name: "noam", version: "0.1.0" } as const;
/** The protocol revision we implement; we echo a client's version when sane. */
const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ERR = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function fail(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** A tool result: text (always) + structuredContent (when the payload is data). */
function toolResult(data: unknown): Record<string, unknown> {
  const structured = Array.isArray(data) ? { results: data } : data;
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
}

function toolError(message: string, data?: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    ...(data !== undefined ? { structuredContent: data } : {}),
  };
}

/** Tools that draw on the per-token read budget (ADR 0003 item 6). */
const BUDGETED_TOOLS = new Set(["read_note", "search_notes"]);

/** How a tool refusal lands in the audit log. */
function outcomeFor(code: McpToolErrorCode): McpAuditOutcome {
  if (code === "forbidden") return "denied";
  if (code === "rate_limited") return "rate_limited";
  return "error";
}

/**
 * One audit row for one tools/call (ADR 0003 item 4). The sink is injected by
 * the route; it never throws, but a broken sink must not turn a completed
 * write into a failed call, so guard anyway.
 */
async function audit(
  ctx: McpContext,
  tool: string,
  args: Record<string, unknown>,
  outcome: McpAuditOutcome,
  bytesOut: number,
): Promise<void> {
  if (!ctx.audit) return;
  const docId = typeof args.docId === "string" ? args.docId : null;
  try {
    await ctx.audit.record({ auth: ctx.auth, tool, docId, outcome, bytesOut });
  } catch (err) {
    console.error(`[mcp] audit of ${tool} failed:`, err);
  }
}

/**
 * Audit a `tools/call` the route refused BEFORE dispatch (a token revoked
 * mid-batch), so the one-row-per-call trail covers attempted activity too.
 * Best-effort like `audit`; a malformed call is logged under its raw name.
 */
export async function auditRefusedCall(
  ctx: McpContext,
  msg: JsonRpcRequest,
  outcome: McpAuditOutcome,
): Promise<void> {
  const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = typeof params.name === "string" ? params.name : "tools/call";
  const args =
    params.arguments && typeof params.arguments === "object"
      ? (params.arguments as Record<string, unknown>)
      : {};
  await audit(ctx, name, args, outcome, 0);
}

/**
 * Handle one JSON-RPC message. Returns null for notifications (no id / methods
 * under `notifications/`). Never throws — protocol errors come back as JSON-RPC
 * error objects; tool failures come back as `isError` results.
 */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  ctx: McpContext,
): Promise<JsonRpcResponse | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return fail(msg?.id ?? null, ERR.invalidRequest, "Invalid JSON-RPC request");
  }

  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case "initialize": {
      const requested = (msg.params as { protocolVersion?: unknown })?.protocolVersion;
      return ok(msg.id, {
        protocolVersion:
          typeof requested === "string" ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }

    case "ping":
      return ok(msg.id, {});

    case "tools/list":
      return ok(msg.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      });

    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") {
        return fail(msg.id, ERR.invalidParams, "tools/call requires a string `name`");
      }
      const name = params.name;
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) {
        await audit(ctx, name, args, "error", 0);
        return ok(msg.id, toolError(`Unknown tool: ${name}`));
      }
      // The read budget is checked BEFORE the tool runs; a refused call does
      // no work and is logged `rate_limited` (which the budget never counts).
      // Check → run → record is serialized per budget key, so two parallel
      // reads cannot both observe the same pre-call count and both pass. The
      // catch lives INSIDE the serialized section: a `denied`/`error` row
      // counts against the budget too, so it must land before the lock frees.
      const budgeted = BUDGETED_TOOLS.has(name) && ctx.readBudget ? ctx.readBudget : null;
      const run = async (): Promise<JsonRpcResponse> => {
        try {
          if (budgeted) {
            const limited = await budgeted.check(ctx.auth);
            if (limited) {
              await audit(ctx, name, args, "rate_limited", 0);
              return ok(
                msg.id,
                toolError(
                  `Rate limited: the ${limited.budget} read budget (${limited.used}/${limited.limit}) is exhausted; retry after ${limited.resetAt}`,
                  limited,
                ),
              );
            }
          }
          const result = toolResult(await tool.handler(ctx, args));
          const text = (result.content as Array<{ text: string }>)[0].text;
          await audit(ctx, name, args, "ok", Buffer.byteLength(text, "utf8"));
          return ok(msg.id, result);
        } catch (err) {
          // Expected, user-facing failures (bad args, no access) → isError result.
          if (err instanceof McpToolError) {
            await audit(ctx, name, args, outcomeFor(err.code), 0);
            return ok(msg.id, toolError(err.message, err.data));
          }
          // Anything else is a bug on our side — log it, don't leak internals.
          console.error(`[mcp] tool ${name} failed:`, err);
          await audit(ctx, name, args, "error", 0);
          return ok(msg.id, toolError("Internal error running the tool"));
        }
      };
      return await (budgeted ? budgeted.serialize(ctx.auth, run) : run());
    }

    default:
      // Unknown notifications (e.g. notifications/initialized, cancelled) are
      // silently accepted; unknown requests get a proper method-not-found.
      if (isNotification) return null;
      return fail(msg.id, ERR.methodNotFound, `Unknown method: ${msg.method}`);
  }
}
