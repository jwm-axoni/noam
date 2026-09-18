// Startup ordering (spec 03 §5, "prevents split-brain") as a pure decision so it
// is unit-testable in isolation.
//
// The rule: when the client is SIGNED IN, connect/pull from the server FIRST and
// wait for the initial SyncStep1/2 exchange, THEN seed a doc from the local
// markdown only if it's still empty (an orphan). Reversed, stale disk content
// seeds a doc with a fresh clientID, the server's SyncStep skips bootstrap, and
// the device diverges permanently.
//
// When NOT signed in (local-only), there is no server to pull from, so the
// bridge's normal seed-from-file is safe immediately.

export interface StartupInputs {
  /** Signed in AND this doc has sync access (a provider will/does connect). */
  signedIn: boolean;
  /** The network provider has completed its initial sync with the server. */
  serverSynced: boolean;
  /** The Y.Text is empty after applying local CRDT + any server sync. */
  docEmpty: boolean;
  /** The local .md file has non-empty content that could seed an orphan. */
  fileHasContent: boolean;
}

export type StartupDecision =
  | { action: "wait-for-server"; reason: string }
  | { action: "seed-from-file"; reason: string }
  | { action: "no-seed"; reason: string };

/**
 * Decide what the doc-open path should do about seeding from local markdown.
 */
export function decideSeed(inputs: StartupInputs): StartupDecision {
  const { signedIn, serverSynced, docEmpty, fileHasContent } = inputs;

  if (signedIn && !serverSynced) {
    // NEVER seed before the server bootstrap completes.
    return { action: "wait-for-server", reason: "signed in; awaiting initial server sync" };
  }

  if (!docEmpty) {
    return {
      action: "no-seed",
      reason: signedIn ? "doc has content after server sync" : "doc hydrated from local CRDT",
    };
  }

  if (!fileHasContent) {
    return { action: "no-seed", reason: "doc and file both empty" };
  }

  // Doc is empty and the file has content → it's an orphan; safe to seed now.
  return {
    action: "seed-from-file",
    reason: signedIn ? "orphan doc after server sync" : "orphan doc, local-only",
  };
}
