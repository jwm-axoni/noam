// Who may start a shell, and when one must die.
//
// Rust owns the processes (`src-tauri/src/terminal.rs`); this module owns the
// two decisions the UI makes about them:
//
//   1. SPAWN only on a user action. A terminal panel restored from the saved
//      layout at launch must NOT start a shell by itself — it shows "Session
//      ended" with a Restart button. So the action that creates a panel marks
//      its id here first, and the panel spawns only if it can consume that mark.
//
//   2. KILL when the panel is gone. A panel moving between docks keeps its
//      instance id (and its process). A panel that leaves `layout.panels` — a
//      closed tab, a vault switch that swaps the whole layout, a layout reset —
//      takes its shell with it.
//
// Pure apart from the two module-level sets, so it tests in plain Node.

import type { PanelInstance } from "../../layout/types";

const spawnRequests = new Set<string>();
const known = new Set<string>();

/** Record that the user asked for a NEW terminal in panel `id`. */
export function requestSpawn(id: string): void {
  spawnRequests.add(id);
}

/** True exactly once per request: the panel may start its shell. */
export function consumeSpawnRequest(id: string): boolean {
  return spawnRequests.delete(id);
}

/** A panel that attached to, or started, a Rust session this run. */
export function trackSession(id: string): void {
  known.add(id);
}

/** Sessions whose panel no longer exists as a terminal in `panels`. */
export function orphanedSessions(
  sessions: Iterable<string>,
  panels: Record<string, PanelInstance>,
): string[] {
  const out: string[] = [];
  for (const id of sessions) {
    if (panels[id]?.type !== "terminal") out.push(id);
  }
  return out;
}

/** Forget and return the tracked sessions that `panels` no longer holds. */
export function reapOrphans(panels: Record<string, PanelInstance>): string[] {
  const orphans = orphanedSessions(known, panels);
  for (const id of orphans) {
    known.delete(id);
    spawnRequests.delete(id);
  }
  return orphans;
}

/** Test seam. */
export function resetTerminalLifecycle(): void {
  spawnRequests.clear();
  known.clear();
}

/** A fresh, unguessable panel instance id for a new terminal. */
export function newTerminalInstanceId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `panel:terminal:${random.replace(/-/g, "").slice(0, 12)}`;
}
