/**
 * Wire document names encode scope: `vault:{vaultId}/note:{docId}` (spec 03 §2).
 * Authorization is at the doc (note) level; the vault segment lets the server
 * scope a membership check without a second round-trip.
 */
export interface ParsedDocName {
  vaultId: string;
  docId: string;
}

const RE = /^vault:([^/]+)\/note:(.+)$/;

export function parseDocName(name: string): ParsedDocName | null {
  const m = RE.exec(name);
  if (!m) return null;
  return { vaultId: m[1], docId: m[2] };
}

export function formatDocName(vaultId: string, docId: string): string {
  return `vault:${vaultId}/note:${docId}`;
}
