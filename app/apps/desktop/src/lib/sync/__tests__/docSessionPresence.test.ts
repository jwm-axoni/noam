// SyncManager's presence identity + vault roster decay (Phase 1).
//
// The registry is faked (as in docSessionVaultScope.test.ts) so `enable` makes
// no network calls and starts no vault engine; the engine and the local
// awareness are then substituted directly, since both are private seams.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

const fakeRegistry = vi.hoisted(() => ({
  vaultId: null as string | null,
  primeLocal: vi.fn(async () => false),
  reconcile: vi.fn(async () => ({ seeded: false })),
  pull: vi.fn(async () => true),
  reset: vi.fn(),
  getMapping: vi.fn(() => null),
  pathForDocId: vi.fn(() => null),
  allDocIds: vi.fn((): string[] => []),
  setProgressSink: vi.fn(),
  setMapListener: vi.fn(),
  setNoteMetaListener: vi.fn(),
  setColorListener: vi.fn(),
  setInboundHost: vi.fn(),
  mappedNotes: vi.fn((): Array<{ docId: string; relPath: string }> => []),
  isPushed: vi.fn(() => false),
  markPushed: vi.fn(),
  flushCheckpoint: vi.fn(async () => {}),
  failures: vi.fn((): unknown[] => []),
  hasFailures: vi.fn(() => false),
  limitCode: vi.fn((): string | null => null),
}));

vi.mock("../registry", () => ({
  VaultRegistry: class {
    constructor() {
      return fakeRegistry;
    }
  },
}));

import type { SessionInfo } from "../../api";
import { colorForUser } from "../../presence/color";
import { REMOVE_MS, STALE_MS, type PresenceFrame, type RosterEvents, type VaultPeer } from "../../presence/roster";
import { SyncManager } from "../docSession";
import type { LocalPresence } from "../vaultSyncEngine";
import { vaultScopes } from "../vaultScope";

const lastOf = <T,>(items: T[]): T => items[items.length - 1];

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
}

interface Internals {
  vaultEngine: { setPresence: (p: LocalPresence | null) => void; stop: () => void } | null;
  currentLocalAwareness: Awareness | null;
  handleVaultPresence: (frame: PresenceFrame) => void;
}

async function enabledManager() {
  const sm = new SyncManager();
  await sm.enable(session(), { orgId: "org-a", name: "a", path: "/vaults/a", epoch: 1 });
  const sent: Array<LocalPresence | null> = [];
  const internals = sm as unknown as Internals;
  internals.vaultEngine = { setPresence: (p) => sent.push(p), stop: () => {} };
  const awareness = new Awareness(new Y.Doc());
  internals.currentLocalAwareness = awareness;
  return { sm, sent, awareness, internals };
}

beforeEach(() => vaultScopes.end());
afterEach(() => vi.useRealTimers());

describe("SyncManager.setParticipantIdentity", () => {
  it("publishes the registry identity on awareness and the vault channel; null restores the fallback", async () => {
    const { sm, sent, awareness } = await enabledManager();

    sm.setParticipantIdentity({ participantId: "p-ann", name: "Ann R.", color: "#982f93" });
    expect(awareness.getLocalState()?.user).toEqual({
      id: "u1",
      participantId: "p-ann",
      name: "Ann R.",
      color: "#982f93",
      status: "online",
    });
    expect(lastOf(sent)).toEqual({ docId: null, name: "Ann R.", color: "#982f93", status: "online" });

    sm.setParticipantIdentity(null);
    expect(awareness.getLocalState()?.user).toEqual({
      id: "u1",
      name: "Ann",
      color: colorForUser("u1"),
      status: "online",
    });
    expect(lastOf(sent)).toEqual({ docId: null, name: "Ann", color: colorForUser("u1"), status: "online" });
  });

  it("keeps the identity across a status change and a viewing change", async () => {
    const { sm, sent, awareness } = await enabledManager();
    sm.setParticipantIdentity({ participantId: "p-ann", name: "Ann R.", color: "#982f93" });
    sm.setPresenceStatus("busy");
    expect(awareness.getLocalState()?.user).toMatchObject({ color: "#982f93", status: "busy" });
    sm.setViewing("doc-7");
    expect(lastOf(sent)).toEqual({ docId: "doc-7", name: "Ann R.", color: "#982f93", status: "busy" });
  });

  it("is a no-op on the wire while signed out", () => {
    const sm = new SyncManager();
    const sent: unknown[] = [];
    (sm as unknown as Internals).vaultEngine = { setPresence: (p) => sent.push(p), stop: () => {} };
    sm.setParticipantIdentity({ participantId: "p", name: "X", color: "#696713" });
    expect(sent).toEqual([]);
  });
});

describe("SyncManager vault roster", () => {
  const frame = (over: Partial<PresenceFrame> = {}): PresenceFrame => ({
    userId: "u2",
    participantId: "p2",
    docId: "doc-1",
    name: "Maya",
    color: "#2981fb",
    status: "online",
    ...over,
  });

  it("keeps a docId-null peer, drops it on gone, and never lists ourselves", async () => {
    const { sm, internals } = await enabledManager();
    const lists: VaultPeer[][] = [];
    sm.setVaultPresenceListener((peers) => lists.push(peers));
    internals.handleVaultPresence(frame());
    internals.handleVaultPresence(frame({ userId: "u1", name: "Ann" })); // self
    internals.handleVaultPresence(frame({ docId: null }));
    expect(lastOf(lists)).toEqual([expect.objectContaining({ userId: "u2", docId: null, stale: false })]);
    internals.handleVaultPresence(frame({ docId: null, gone: true }));
    expect(lastOf(lists)).toEqual([]);
    sm.disable();
  });

  it("decays a silent peer to stale at 30 s and removes it at 90 s on its own 5 s tick", async () => {
    vi.useFakeTimers();
    const { sm, internals } = await enabledManager();
    const calls: Array<{ peers: VaultPeer[]; events?: RosterEvents }> = [];
    sm.setVaultPresenceListener((peers, events) => calls.push({ peers, events }));
    internals.handleVaultPresence(frame());
    expect(lastOf(calls)!.events!.joined).toHaveLength(1);

    vi.advanceTimersByTime(STALE_MS + 5_000);
    const stale = lastOf(calls)!;
    expect(stale.peers[0].stale).toBe(true);
    expect(stale.events!.staleChanged).toHaveLength(1);

    vi.advanceTimersByTime(REMOVE_MS - STALE_MS);
    const gone = lastOf(calls)!;
    expect(gone.peers).toEqual([]);
    expect(gone.events!.left).toEqual([{ peer: expect.objectContaining({ userId: "u2" }), reason: "timeout" }]);

    // With nobody left the tick stops; nothing else is emitted.
    const n = calls.length;
    vi.advanceTimersByTime(60_000);
    expect(calls).toHaveLength(n);
    expect((sm as unknown as { rosterTick: unknown }).rosterTick).toBeNull();
    sm.disable();
  });

  it("disable clears the roster and its tick", async () => {
    vi.useFakeTimers();
    const { sm, internals } = await enabledManager();
    const lists: VaultPeer[][] = [];
    sm.setVaultPresenceListener((peers) => lists.push(peers));
    internals.handleVaultPresence(frame());
    sm.disable();
    expect(lastOf(lists)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
