import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { ancestorFolderIds, maxPermission, type Permission } from "./resolver.js";

/**
 * Agent-token scopes (ADR 0003 item 2; migration 028 `mcp_token_scopes`).
 *
 * An agent token's reach is the UNION of its scope rows, and every answer here
 * is then capped by the minting user's own `effectivePermission` in
 * `mcp-access.ts` — a scope can only NARROW, never widen. A token with no rows
 * resolves to `none` everywhere, which is what lets it list vaults and nothing
 * else.
 *
 * Resource ids follow `shares`: a `folders.id`, a doc id (`notes.id` /
 * `files.id`), or — for `vault` — the ORGANIZATION id (the user-facing vault).
 * A folder scope covers the folder and every descendant; a vault scope covers
 * everything in the organization, the root included; a file scope covers one
 * doc. The three presets are just row templates (`expandPreset`); nothing
 * downstream ever sees a preset name.
 */

type Queryable = Pick<pg.Pool, "query">;

export type ScopeResourceType = "folder" | "file" | "vault";
export type ScopePermission = "view" | "edit";

export interface TokenScope {
  resourceType: ScopeResourceType;
  resourceId: string;
  permission: ScopePermission;
}

export type ScopePreset = "reader" | "drafter" | "editor";
export const SCOPE_PRESETS: readonly ScopePreset[] = ["reader", "drafter", "editor"];

const RANK: Record<Permission, number> = { none: 0, view: 1, edit: 2 };

export function minPermission(a: Permission, b: Permission): Permission {
  return RANK[a] <= RANK[b] ? a : b;
}

/**
 * The three presets as scope rows. `drafter` = read the whole vault, write in
 * ONE folder, so it needs that folder. Templates only: the rows are what gets
 * stored and what every later check reads.
 */
export function expandPreset(
  preset: ScopePreset,
  organizationId: string,
  folderId?: string | null,
): TokenScope[] {
  switch (preset) {
    case "reader":
      return [{ resourceType: "vault", resourceId: organizationId, permission: "view" }];
    case "editor":
      return [{ resourceType: "vault", resourceId: organizationId, permission: "edit" }];
    case "drafter":
      if (!folderId) throw new ScopeError("preset_needs_folder");
      return [
        { resourceType: "vault", resourceId: organizationId, permission: "view" },
        { resourceType: "folder", resourceId: folderId, permission: "edit" },
      ];
  }
}

/** A scope list that cannot be stored: unknown shape, or a resource outside the org. */
export class ScopeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function isScopeShape(raw: unknown): raw is TokenScope {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as Record<string, unknown>;
  return (
    (s.resourceType === "folder" || s.resourceType === "file" || s.resourceType === "vault") &&
    typeof s.resourceId === "string" &&
    s.resourceId.length > 0 &&
    (s.permission === "view" || s.permission === "edit")
  );
}

/**
 * Validate + normalise scope rows for one organization. Refuses a resource the
 * org does not own (an agent must not be scoped into another team's folder by
 * id), collapses duplicates to the wider permission, and caps the count.
 */
export async function normalizeScopes(
  organizationId: string,
  raw: unknown,
  db: Queryable = defaultPool,
): Promise<TokenScope[]> {
  if (!Array.isArray(raw)) throw new ScopeError("invalid_scopes");
  if (raw.length > 64) throw new ScopeError("too_many_scopes");
  const merged = new Map<string, TokenScope>();
  for (const item of raw) {
    if (!isScopeShape(item)) throw new ScopeError("invalid_scopes");
    const key = `${item.resourceType}:${item.resourceId}`;
    const prev = merged.get(key);
    if (!prev || RANK[item.permission] > RANK[prev.permission]) {
      merged.set(key, {
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        permission: item.permission,
      });
    }
  }
  for (const s of merged.values()) {
    if (s.resourceType === "vault") {
      if (s.resourceId !== organizationId) throw new ScopeError("scope_outside_vault");
      continue;
    }
    const { rows } =
      s.resourceType === "folder"
        ? await db.query<{ ok: number }>(
            `SELECT 1 AS ok FROM folders f JOIN vaults v ON v.id = f.vault_id
              WHERE f.id = $1 AND v.organization_id = $2`,
            [s.resourceId, organizationId],
          )
        : await db.query<{ ok: number }>(
            `SELECT 1 AS ok FROM notes n JOIN vaults v ON v.id = n.vault_id
              WHERE n.id = $1 AND v.organization_id = $2 AND n.deleted_at IS NULL
             UNION ALL
             SELECT 1 FROM files f JOIN vaults v ON v.id = f.vault_id
              WHERE f.id = $1 AND v.organization_id = $2`,
            [s.resourceId, organizationId],
          );
    if (rows.length === 0) throw new ScopeError("scope_outside_vault");
  }
  return [...merged.values()];
}

export async function loadScopes(
  tokenId: string,
  db: Queryable = defaultPool,
): Promise<TokenScope[]> {
  const { rows } = await db.query<{
    resource_type: ScopeResourceType;
    resource_id: string;
    permission: ScopePermission;
  }>(
    `SELECT resource_type, resource_id, permission FROM mcp_token_scopes
      WHERE token_id = $1 ORDER BY resource_type, resource_id`,
    [tokenId],
  );
  return rows.map((r) => ({
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    permission: r.permission,
  }));
}

/** Insert scope rows for a token (inside the caller's transaction). */
export async function insertScopes(
  tokenId: string,
  scopes: TokenScope[],
  db: Queryable,
): Promise<void> {
  for (const s of scopes) {
    await db.query(
      `INSERT INTO mcp_token_scopes (token_id, resource_type, resource_id, permission)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_id, resource_type, resource_id) DO UPDATE SET permission = EXCLUDED.permission`,
      [tokenId, s.resourceType, s.resourceId, s.permission],
    );
  }
}

interface DocLoc {
  organizationId: string;
  vaultId: string;
  folderId: string | null;
}

async function locate(db: Queryable, docId: string): Promise<DocLoc | null> {
  const { rows } = await db.query<{
    organization_id: string;
    vault_id: string;
    folder_id: string | null;
  }>(
    `SELECT v.organization_id, n.vault_id, n.folder_id
       FROM notes n JOIN vaults v ON v.id = n.vault_id WHERE n.id = $1
     UNION ALL
     SELECT v.organization_id, f.vault_id, f.folder_id
       FROM files f JOIN vaults v ON v.id = f.vault_id WHERE f.id = $1
     LIMIT 1`,
    [docId],
  );
  const r = rows[0];
  return r ? { organizationId: r.organization_id, vaultId: r.vault_id, folderId: r.folder_id } : null;
}

/** The widest scope covering `docId` — file, any ancestor folder, or the vault. */
export async function scopePermission(
  tokenId: string,
  docId: string,
  db: Queryable = defaultPool,
): Promise<Permission> {
  const loc = await locate(db, docId);
  if (!loc) return "none";
  const folderIds = await ancestorFolderIds(db, loc.folderId);
  const { rows } = await db.query<{ permission: ScopePermission }>(
    `SELECT permission FROM mcp_token_scopes
      WHERE token_id = $1
        AND ((resource_type = 'vault'  AND resource_id = $2)
          OR (resource_type = 'file'   AND resource_id = $3)
          OR (resource_type = 'folder' AND resource_id = ANY($4::text[])))`,
    [tokenId, loc.organizationId, docId, folderIds],
  );
  return rows.reduce<Permission>((acc, r) => maxPermission(acc, r.permission), "none");
}

/**
 * The widest scope covering a FOLDER (the folder itself, an ancestor, or the
 * vault). `null` is the vault root, which only the vault scope reaches.
 */
export async function scopeFolderPermission(
  tokenId: string,
  organizationId: string,
  folderId: string | null,
  db: Queryable = defaultPool,
): Promise<Permission> {
  const folderIds = await ancestorFolderIds(db, folderId);
  const { rows } = await db.query<{ permission: ScopePermission }>(
    `SELECT permission FROM mcp_token_scopes
      WHERE token_id = $1
        AND ((resource_type = 'vault'  AND resource_id = $2)
          OR (resource_type = 'folder' AND resource_id = ANY($3::text[])))`,
    [tokenId, organizationId, folderIds],
  );
  return rows.reduce<Permission>((acc, r) => maxPermission(acc, r.permission), "none");
}

/**
 * Every doc id in one note collection that some scope row reaches (any
 * permission). `"all"` when a vault scope covers the collection's org, so a
 * caller can skip the intersection. Folder scopes expand to their whole
 * subtree via `folders.parent_id`.
 */
export async function listScopedDocsInVault(
  tokenId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<Set<string> | "all"> {
  const { rows: v } = await db.query<{ organization_id: string }>(
    "SELECT organization_id FROM vaults WHERE id = $1",
    [vaultId],
  );
  const orgId = v[0]?.organization_id;
  if (!orgId) return new Set();
  const scopes = await loadScopes(tokenId, db);
  if (scopes.some((s) => s.resourceType === "vault" && s.resourceId === orgId)) return "all";
  const folderIds = scopes.filter((s) => s.resourceType === "folder").map((s) => s.resourceId);
  const fileIds = scopes.filter((s) => s.resourceType === "file").map((s) => s.resourceId);
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE sub AS (
       SELECT id FROM folders WHERE vault_id = $1 AND id = ANY($2::text[])
       UNION
       SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
     )
     SELECT n.id FROM notes n
      WHERE n.vault_id = $1 AND n.deleted_at IS NULL
        AND (n.id = ANY($3::text[]) OR n.folder_id IN (SELECT id FROM sub))
     UNION
     SELECT f.id FROM files f
      WHERE f.vault_id = $1
        AND (f.id = ANY($3::text[]) OR f.folder_id IN (SELECT id FROM sub))`,
    [vaultId, folderIds, fileIds],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Folder ids in one collection that a token may SEE: a vault scope shows all,
 * a folder scope shows the folder and its subtree. File scopes reveal no folder.
 */
export async function listScopedFoldersInVault(
  tokenId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<Set<string> | "all"> {
  const { rows: v } = await db.query<{ organization_id: string }>(
    "SELECT organization_id FROM vaults WHERE id = $1",
    [vaultId],
  );
  const orgId = v[0]?.organization_id;
  if (!orgId) return new Set();
  const scopes = await loadScopes(tokenId, db);
  if (scopes.some((s) => s.resourceType === "vault" && s.resourceId === orgId)) return "all";
  const folderIds = scopes.filter((s) => s.resourceType === "folder").map((s) => s.resourceId);
  if (folderIds.length === 0) return new Set();
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE sub AS (
       SELECT id FROM folders WHERE vault_id = $1 AND id = ANY($2::text[])
       UNION
       SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
     )
     SELECT id FROM sub`,
    [vaultId, folderIds],
  );
  return new Set(rows.map((r) => r.id));
}
