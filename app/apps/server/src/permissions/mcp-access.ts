import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import type { McpAuth } from "../mcp/tokens.js";
import { effectivePermission, type Permission } from "./resolver.js";
import { listReadableDocsInVault } from "./vault-docs.js";
import {
  listScopedDocsInVault,
  listScopedFoldersInVault,
  minPermission,
  scopeFolderPermission,
  scopePermission,
} from "./token-scope.js";

/**
 * What an MCP caller may do, in one place (ADR 0003 item 2).
 *
 * For a `user` token or an OAuth session this is exactly `effectivePermission`
 * / `listReadableDocsInVault` for that user — nothing changes for them. For an
 * `agent` token every answer is
 *
 *     min(effectivePermission(minter, doc), scope(token, doc))
 *
 * so the token can never exceed what its minter could do, and can be narrower.
 * The minter's grant is re-resolved on every call (a demoted or removed minter
 * takes their agents' reach with them), and a token with no scope rows gets
 * `none` on everything, which is what leaves it `list_vaults` and nothing else.
 */

type Queryable = Pick<pg.Pool, "query">;

function agentTokenId(auth: McpAuth): string | null {
  return auth.kind === "agent" && auth.tokenId ? auth.tokenId : null;
}

/** The caller's permission on one doc: the user's grant, capped by the token's scope. */
export async function mcpDocPermission(
  auth: McpAuth,
  docId: string,
  db: Queryable = defaultPool,
): Promise<Permission> {
  const base = await effectivePermission(auth.userId, docId, db);
  const tokenId = agentTokenId(auth);
  if (!tokenId || base === "none") return base;
  return minPermission(base, await scopePermission(tokenId, docId, db));
}

/**
 * The docs in one collection the caller may READ: the user's readable set,
 * intersected with the token's scoped set for an agent.
 */
export async function mcpReadableDocsInVault(
  auth: McpAuth,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<Set<string>> {
  const base = await listReadableDocsInVault(auth.userId, vaultId, db);
  const tokenId = agentTokenId(auth);
  if (!tokenId) return base;
  const scoped = await listScopedDocsInVault(tokenId, vaultId, db);
  if (scoped === "all") return base;
  return new Set([...base].filter((id) => scoped.has(id)));
}

/**
 * The scope cap on a FOLDER (create/delete/move inside it; `null` = the vault
 * root). `edit` for non-agent callers, i.e. no cap: the caller's own folder
 * gate (`canEditFolder` / `vaultRootWritable`) is the whole answer for them.
 */
export async function mcpFolderScope(
  auth: McpAuth,
  folderId: string | null,
  db: Queryable = defaultPool,
): Promise<Permission> {
  const tokenId = agentTokenId(auth);
  if (!tokenId) return "edit";
  return scopeFolderPermission(tokenId, auth.organizationId, folderId, db);
}

/**
 * Which folders of one collection the caller may LIST. `"all"` for non-agent
 * callers and for a vault-scoped agent; otherwise the scoped subtrees only.
 */
export async function mcpVisibleFolders(
  auth: McpAuth,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<Set<string> | "all"> {
  const tokenId = agentTokenId(auth);
  if (!tokenId) return "all";
  return listScopedFoldersInVault(tokenId, vaultId, db);
}
