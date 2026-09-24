// Words for MCP token rows in Vault Settings → MCP (ADR 0003). Pure: the
// component supplies the resource names it can resolve and the date format.
import type { McpTokenScope } from "./api";

/** Resolve a scope's resource to a display path; null when this device can't. */
export interface ScopeNames {
  folder: (id: string) => string | null;
  file: (id: string) => string | null;
}

const PERM_WORD: Record<McpTokenScope["permission"], string> = { view: "read", edit: "edit" };

function count(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * One line for an agent token's reach, widest first: "Whole vault · read ·
 * Projects/ · edit", "1 note · read". Notes are counted (a list of paths does
 * not fit a row); folders are named when known, counted when not.
 */
export function summarizeScopes(scopes: readonly McpTokenScope[], names: ScopeNames): string {
  if (scopes.length === 0) return "No access — lists vaults only";
  const parts: string[] = [];
  for (const perm of ["view", "edit"] as const) {
    if (scopes.some((s) => s.resourceType === "vault" && s.permission === perm)) {
      parts.push(`Whole vault · ${PERM_WORD[perm]}`);
    }
  }
  for (const perm of ["view", "edit"] as const) {
    const folders = scopes.filter((s) => s.resourceType === "folder" && s.permission === perm);
    let unnamed = 0;
    for (const f of folders) {
      const path = names.folder(f.resourceId);
      if (path) parts.push(`${path.replace(/\/+$/, "")}/ · ${PERM_WORD[perm]}`);
      else unnamed++;
    }
    if (unnamed) parts.push(`${count(unnamed, "folder")} · ${PERM_WORD[perm]}`);
  }
  for (const perm of ["view", "edit"] as const) {
    const n = scopes.filter((s) => s.resourceType === "file" && s.permission === perm).length;
    if (n) parts.push(`${count(n, "note")} · ${PERM_WORD[perm]}`);
  }
  return parts.join(" · ");
}

/** The deprecation line every user ("acts as you") token carries. */
export function sunsetLabel(sunsetIso: string, formatDate: (iso: string) => string): string {
  return `Stops working on ${formatDate(sunsetIso)} — migrate to an agent token`;
}

export function expiryLabel(
  expiresAt: string | null,
  now: number,
  formatDate: (iso: string) => string,
): string {
  if (!expiresAt) return "Never expires";
  return `${Date.parse(expiresAt) <= now ? "Expired" : "Expires"} ${formatDate(expiresAt)}`;
}

export function staleLabel(stale: boolean): string | null {
  return stale ? "Stale · unused 30+ days" : null;
}
