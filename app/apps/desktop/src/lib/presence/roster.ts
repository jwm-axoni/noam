// Vault-wide presence roster with heartbeat decay. Pure: the caller supplies
// `now`, so the whole state machine is testable without timers.
//
//   gone: true            → removed at once (reason "gone")
//   status "invisible"    → removed / never added (invisible means invisible)
//   docId null, no gone   → kept: online with no note open
//   silent ≥ STALE_MS     → stale (dimmed; the UI admits uncertainty)
//   silent ≥ REMOVE_MS    → removed (reason "timeout")
//   any frame             → fresh again (un-stales a stale peer)
//
// Peers heartbeat every 10 s (vaultSyncEngine), so a healthy one never decays.

import type { ActivityStatus } from "../prefs";

export const STALE_MS = 30_000;
export const REMOVE_MS = 90_000;

/** One inbound vault-channel presence frame, as the engine parses it. */
export interface PresenceFrame {
  userId: string;
  /** Registry participant id, stamped by the server. */
  participantId?: string;
  /** The note they're currently viewing, or null when not on any note. */
  docId: string | null;
  name: string;
  color: string;
  status: ActivityStatus;
  /** The server saw this connection close. */
  gone?: boolean;
}

/** A teammate's live viewing state, surfaced to the UI. */
export interface VaultPeer {
  userId: string;
  participantId?: string;
  docId: string | null;
  name: string;
  color: string;
  status: ActivityStatus;
  /** Epoch ms of the last frame received from this peer. */
  lastSeenAt: number;
  /** No frame for STALE_MS: shown dimmed. */
  stale: boolean;
}

export type LeaveReason = "gone" | "timeout";

export interface RosterEvents {
  joined: VaultPeer[];
  left: { peer: VaultPeer; reason: LeaveReason }[];
  staleChanged: VaultPeer[];
}

const noEvents = (): RosterEvents => ({ joined: [], left: [], staleChanged: [] });

export function hasEvents(e: RosterEvents): boolean {
  return e.joined.length > 0 || e.left.length > 0 || e.staleChanged.length > 0;
}

export class PresenceRoster {
  // Keyed by userId: last write wins across one user's devices.
  private readonly peers = new Map<string, VaultPeer>();

  apply(frame: PresenceFrame, now: number): RosterEvents {
    const events = noEvents();
    const prev = this.peers.get(frame.userId);
    if (frame.gone || frame.status === "invisible") {
      if (prev) {
        this.peers.delete(frame.userId);
        events.left.push({ peer: prev, reason: "gone" });
      }
      return events;
    }
    const peer: VaultPeer = {
      userId: frame.userId,
      ...(frame.participantId ? { participantId: frame.participantId } : {}),
      docId: frame.docId,
      name: frame.name,
      color: frame.color,
      status: frame.status,
      lastSeenAt: now,
      stale: false,
    };
    this.peers.set(frame.userId, peer);
    if (!prev) events.joined.push(peer);
    else if (prev.stale) events.staleChanged.push(peer);
    return events;
  }

  tick(now: number): RosterEvents {
    const events = noEvents();
    for (const [userId, peer] of this.peers) {
      const silent = now - peer.lastSeenAt;
      if (silent >= REMOVE_MS) {
        this.peers.delete(userId);
        events.left.push({ peer, reason: "timeout" });
      } else if (silent >= STALE_MS && !peer.stale) {
        const next = { ...peer, stale: true };
        this.peers.set(userId, next);
        events.staleChanged.push(next);
      }
    }
    return events;
  }

  list(): VaultPeer[] {
    return [...this.peers.values()];
  }

  get size(): number {
    return this.peers.size;
  }

  clear(): void {
    this.peers.clear();
  }
}

/** The quiet panel note / announcement for a leave: a clean close vs. silence. */
export function leaveMessage(name: string, reason: LeaveReason): string {
  return reason === "gone" ? `${name} disconnected` : `${name} lost connection`;
}
