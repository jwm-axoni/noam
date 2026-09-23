import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { VaultChannel, type VaultChannelDeps } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import type { DocDiff } from "../src/yjs/persistence.js";

// Server-stamped presence identity (audit F5): the vault channel overwrites a
// client's name/color with its registry row and adds `participantId`; the
// close frame says `gone`; a user with no live row publishes nothing, and one
// deactivated mid-connection is announced gone. Fake socket + injected deps, no DB.

type Sent = { kind: "text"; value: unknown } | { kind: "binary"; bytes: Uint8Array };

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Sent[] = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) this.sent.push({ kind: "binary", bytes: data as Uint8Array });
    else this.sent.push({ kind: "text", value: JSON.parse(data as string) });
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  hello(token: string): void {
    this.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest: {} })), false);
  }
  presence(docId: string | null, name: string, color: string, status = "online"): void {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ t: "presence", docId, name, color, status })),
      false,
    );
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s) => s.kind === "text")
      .map((s) => (s as { value: Record<string, unknown> }).value);
  }
}

async function waitFor(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const pubsubs: InMemoryPubSub[] = [];
afterEach(async () => {
  await Promise.all(pubsubs.splice(0).map((p) => p.close()));
});

const REGISTRY: Record<string, { participantId: string; name: string; color: string }> = {
  "u-ada": { participantId: "p-ada", name: "Ada Lovelace", color: "#2981fb" },
  "u-bob": { participantId: "p-bob", name: "Bob", color: "#789c5b" },
};

function channel(
  resolve: VaultChannelDeps["resolvePresenceIdentity"] = async (userId) =>
    REGISTRY[userId] ?? null,
): VaultChannel {
  const pubsub = new InMemoryPubSub();
  pubsubs.push(pubsub);
  return new VaultChannel({
    pubsub,
    verifyToken: async (token: string) => ({ userId: `u-${token}`, vaultId: "v1" }),
    listReadableDocs: async () => new Set(["A"]),
    loadDiff: (async () => null as DocDiff | null) as VaultChannelDeps["loadDiff"],
    listEmpty: async () => ({ empty: [], truncated: false }),
    resolvePresenceIdentity: resolve,
  });
}

async function pair(ch: VaultChannel): Promise<{ ada: FakeWs; bob: FakeWs }> {
  const ada = new FakeWs();
  const bob = new FakeWs();
  ch.handleConnection(ada as never);
  ch.handleConnection(bob as never);
  ada.hello("ada");
  bob.hello("bob");
  await waitFor(() => ada.controls().some((c) => c.t === "ready"));
  await waitFor(() => bob.controls().some((c) => c.t === "ready"));
  return { ada, bob };
}

const presenceFrom = (ws: FakeWs, userId: string) =>
  ws.controls().filter((c) => c.t === "presence" && c.userId === userId);

describe("presence identity stamping", () => {
  it("overwrites a spoofed name/color with the registry row and adds participantId", async () => {
    const { ada, bob } = await pair(channel());
    ada.presence("A", "Not Ada", "#000000");
    await waitFor(() => presenceFrom(bob, "u-ada").some((c) => c.docId === "A"));
    expect(presenceFrom(bob, "u-ada").find((c) => c.docId === "A")).toEqual({
      t: "presence",
      userId: "u-ada",
      participantId: "p-ada",
      docId: "A",
      name: "Ada Lovelace",
      color: "#2981fb",
      status: "online",
    });
    // No frame anywhere carries the client's claim.
    const raw = JSON.stringify(bob.controls());
    expect(raw).not.toContain("Not Ada");
    expect(raw).not.toContain("#000000");
  });

  it("re-announces with the stamped identity when a newcomer asks", async () => {
    const ch = channel();
    const ada = new FakeWs();
    ch.handleConnection(ada as never);
    ada.hello("ada");
    await waitFor(() => ada.controls().some((c) => c.t === "ready"));
    ada.presence("A", "Not Ada", "#000000");

    const bob = new FakeWs();
    ch.handleConnection(bob as never);
    bob.hello("bob");
    await waitFor(() => bob.controls().some((c) => c.t === "ready"));
    bob.presence(null, "whatever", "#111111");
    await waitFor(() => presenceFrom(bob, "u-ada").length > 0);
    expect(presenceFrom(bob, "u-ada")[0]).toMatchObject({
      participantId: "p-ada",
      name: "Ada Lovelace",
      color: "#2981fb",
    });
  });

  it("the disconnect frame carries gone: true and docId: null", async () => {
    const { ada, bob } = await pair(channel());
    ada.presence("A", "Not Ada", "#000000");
    await waitFor(() => presenceFrom(bob, "u-ada").length > 0);
    // An explicit "no note open" is NOT gone.
    ada.presence(null, "Not Ada", "#000000");
    await waitFor(() => presenceFrom(bob, "u-ada").some((c) => c.docId === null));
    expect(presenceFrom(bob, "u-ada").some((c) => c.gone)).toBe(false);

    ada.close();
    await waitFor(() => presenceFrom(bob, "u-ada").some((c) => c.gone === true));
    expect(presenceFrom(bob, "u-ada").find((c) => c.gone)).toEqual({
      t: "presence",
      userId: "u-ada",
      participantId: "p-ada",
      docId: null,
      name: "Ada Lovelace",
      color: "#2981fb",
      status: "online",
      gone: true,
    });
  });

  it("a connection with no live row never appears to the other subscriber", async () => {
    const onlyBob = channel(async (userId) => (userId === "u-bob" ? REGISTRY["u-bob"] : null));
    const { ada, bob } = await pair(onlyBob);
    ada.presence("A", "Ada (client)", "#6366f1");
    ada.presence(null, "Ada (client)", "#6366f1");
    // Bob's own announce still flows, which proves the relay is live.
    bob.presence("A", "Bob", "#789c5b");
    await waitFor(() => presenceFrom(ada, "u-bob").length > 0);
    // Let any stray frame of Ada's land before asserting it never did.
    await new Promise((r) => setTimeout(r, 30));
    ada.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(presenceFrom(bob, "u-ada")).toEqual([]);
    expect(JSON.stringify(bob.controls())).not.toContain("Ada (client)");
  });

  it("a failing lookup publishes no presence but keeps the socket", async () => {
    const { ada, bob } = await pair(
      channel(async (userId) => {
        if (userId === "u-ada") throw new Error("db down");
        return REGISTRY[userId] ?? null;
      }),
    );
    ada.presence("A", "Ada (client)", "#6366f1");
    bob.presence("A", "Bob", "#789c5b");
    await waitFor(() => presenceFrom(ada, "u-bob").length > 0); // Ada still receives
    await new Promise((r) => setTimeout(r, 30));
    expect(presenceFrom(bob, "u-ada")).toEqual([]);
  });

  it("deactivation on a live socket: acl-changed flips the row to null and the peer sees gone", async () => {
    const rows = { ...REGISTRY };
    const ch = channel(async (userId) => rows[userId] ?? null);
    const { ada, bob } = await pair(ch);
    ada.presence("A", "x", "#000000");
    await waitFor(() => presenceFrom(bob, "u-ada").some((c) => c.docId === "A"));

    delete rows["u-ada"];
    await ch.publishAclChanged("v1");
    await waitFor(() => presenceFrom(bob, "u-ada").some((c) => c.gone === true));
    expect(presenceFrom(bob, "u-ada").find((c) => c.gone)).toMatchObject({
      participantId: "p-ada",
      docId: null,
      gone: true,
    });

    // From here on Ada publishes nothing, and her close emits no second gone.
    const before = presenceFrom(bob, "u-ada").length;
    ada.presence("A", "x", "#000000");
    ada.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(presenceFrom(bob, "u-ada")).toHaveLength(before);
  });

  it("a rename on a live socket re-publishes the stamped presence with the new name", async () => {
    const rows = { ...REGISTRY };
    const ch = channel(async (userId) => rows[userId] ?? null);
    const { ada, bob } = await pair(ch);
    ada.presence("A", "x", "#000000", "busy");
    await waitFor(() => presenceFrom(bob, "u-ada").some((c) => c.docId === "A"));

    rows["u-ada"] = { ...rows["u-ada"], name: "Ada King" };
    await ch.publishAclChanged("v1");
    await waitFor(() => presenceFrom(bob, "u-ada").some((c) => c.name === "Ada King"));
    expect(presenceFrom(bob, "u-ada").find((c) => c.name === "Ada King")).toEqual({
      t: "presence",
      userId: "u-ada",
      participantId: "p-ada",
      docId: "A",
      name: "Ada King",
      color: "#2981fb",
      status: "busy",
    });
  });

  it("an acl-changed that leaves the row unchanged re-publishes nothing", async () => {
    const ch = channel();
    const { ada, bob } = await pair(ch);
    ada.presence("A", "x", "#000000");
    await waitFor(() => presenceFrom(bob, "u-ada").some((c) => c.docId === "A"));
    const before = presenceFrom(bob, "u-ada").length;
    await ch.publishAclChanged("v1");
    await new Promise((r) => setTimeout(r, 30));
    expect(presenceFrom(bob, "u-ada")).toHaveLength(before);
  });
});
