// Vault-wide presence roster with heartbeat decay. Pure: the caller supplies
// `now`, so the whole state machine is testable without timers.
//
// One peer (userId) is often several CONNECTIONS — a laptop and a desktop, each
// its own socket. Frames carry the server-minted `connId` of the socket they
// describe, and the roster keeps one slot per connection under the user:
//
//   gone: true            → THAT connection is removed; the peer leaves only
//                           when it was their last one (reason "gone"), else
//                           the UI falls back to their most recent other device
//   status "invisible"    → same, per connection (invisible means invisible)
//   docId null, no gone   → kept: online with no note open
//   silent ≥ STALE_MS     → stale (dimmed; the UI admits uncertainty)
//   silent ≥ REMOVE_MS    → a connection that silent is dropped; the peer is
//                           removed once none remain (reason "timeout")
//   any frame             → that connection is fresh again (un-stales the peer)
//
// What the UI sees for a peer is their most recently heard connection (last
// write wins across devices). A frame without a `connId` (a server that
// predates it) shares one slot per user, which is exactly the old behaviour.
//
// Known gap, accepted: a connection whose server INSTANCE died (multi-instance
// behind Redis; a single instance takes every viewer's socket down with it)
// never publishes `gone`, so its slot can keep a user listed — dimmed after
// 30 s — until the 90 s timeout prunes it. Bounded, cosmetic, and the price of
// counting on the client, where the count is right across instances.
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
  /** The server-side connection this frame is about, stamped by the server.
   *  Absent from servers that predate it. */
  connId?: string;
  /** The note they're currently viewing, or null when not on any note. */
  docId: string | null;
  name: string;
  color: string;
  status: ActivityStatus;
  /** The server saw this connection (`connId`) close. */
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
  /** Epoch ms of the last frame received from this peer (any connection). */
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

/** What one of a peer's connections last said about itself. */
interface Conn {
  docId: string | null;
  status: ActivityStatus;
  lastSeenAt: number;
}

interface Entry {
  /** The peer as the UI sees it: always built from the connection heard from
   *  most recently, so `peer.lastSeenAt` is the max over `conns`. */
  peer: VaultPeer;
  /** Keyed by `connId`; `""` is the shared slot for frames without one. */
  conns: Map<string, Conn>;
}

/** The slot a frame addresses. */
const slotOf = (frame: PresenceFrame): string => frame.connId ?? "";

export class PresenceRoster {
  // Keyed by userId; each entry aggregates that user's connections.
  private readonly peers = new Map<string, Entry>();

  apply(frame: PresenceFrame, now: number): RosterEvents {
    const events = noEvents();
    const entry = this.peers.get(frame.userId);
    const slot = slotOf(frame);
    if (frame.gone || frame.status === "invisible") {
      if (!entry || !entry.conns.has(slot)) return events;
      entry.conns.delete(slot);
      if (entry.conns.size === 0) {
        this.peers.delete(frame.userId);
        events.left.push({ peer: entry.peer, reason: "gone" });
        return events;
      }
      // Another of their devices is still here: show that one instead. The
      // caller re-reads `list()` after every apply, so a changed docId needs no
      // event of its own; only the stale flag can flip in a way the UI must hear.
      const next = latestPeer(entry, now);
      if (next.stale !== entry.peer.stale) events.staleChanged.push(next);
      entry.peer = next;
      return events;
    }
    const conn: Conn = { docId: frame.docId, status: frame.status, lastSeenAt: now };
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
    if (!entry) {
      this.peers.set(frame.userId, { peer, conns: new Map([[slot, conn]]) });
      events.joined.push(peer);
      return events;
    }
    entry.conns.set(slot, conn);
    const prev = entry.peer;
    entry.peer = peer;
    if (prev.stale) events.staleChanged.push(peer);
    return events;
  }

  tick(now: number): RosterEvents {
    const events = noEvents();
    for (const [userId, entry] of this.peers) {
      for (const [slot, conn] of entry.conns) {
        if (now - conn.lastSeenAt >= REMOVE_MS) entry.conns.delete(slot);
      }
      if (entry.conns.size === 0) {
        this.peers.delete(userId);
        events.left.push({ peer: entry.peer, reason: "timeout" });
        continue;
      }
      // The shown connection is the most recent one, so it outlives every
      // pruned sibling and `peer.lastSeenAt` is still the right clock.
      const silent = now - entry.peer.lastSeenAt;
      if (silent >= STALE_MS && !entry.peer.stale) {
        const next = { ...entry.peer, stale: true };
        entry.peer = next;
        events.staleChanged.push(next);
      }
    }
    return events;
  }

  list(): VaultPeer[] {
    return [...this.peers.values()].map((e) => e.peer);
  }

  get size(): number {
    return this.peers.size;
  }

  clear(): void {
    this.peers.clear();
  }
}

/** The peer rebuilt from whichever remaining connection was heard from last. */
function latestPeer(entry: Entry, now: number): VaultPeer {
  let latest: Conn | null = null;
  for (const conn of entry.conns.values()) {
    if (!latest || conn.lastSeenAt > latest.lastSeenAt) latest = conn;
  }
  const conn = latest!;
  return {
    ...entry.peer,
    docId: conn.docId,
    status: conn.status,
    lastSeenAt: conn.lastSeenAt,
    stale: now - conn.lastSeenAt >= STALE_MS,
  };
}

/** The quiet panel note / announcement for a leave: a clean close vs. silence. */
export function leaveMessage(name: string, reason: LeaveReason): string {
  return reason === "gone" ? `${name} disconnected` : `${name} lost connection`;
}
