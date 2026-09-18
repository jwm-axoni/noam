/**
 * Explicit-open token for the search input. The SearchPanel auto-focuses its
 * input only when a user deliberately opened search (activity bar, ⌘F) — not
 * when it merely becomes visible because a sibling tab closed or a split
 * changed the active tab ("geometry changes never steal focus").
 */
let requestedAt = 0;
const TOKEN_TTL_MS = 2000;

export function requestSearchInputFocus(): void {
  requestedAt = Date.now();
}

export function consumeSearchInputFocus(): boolean {
  if (Date.now() - requestedAt > TOKEN_TTL_MS) return false;
  requestedAt = 0;
  return true;
}
