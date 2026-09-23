import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createSyncServer, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { mintVaultToken } from "../src/tokens/vault-token.js";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { testAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * Phase 1 acceptance criteria 8 and 9 at the protocol level, wall-clock, against
 * real Postgres, the real sync server and the real vault channel. (The desktop
 * rendering half — a caret in CodeMirror, a dimmed chip — is the desktop's.)
 */

const PORT = 3995;
const app = createApp(testAppDeps());

interface Team {
  orgId: string;
  vaultId: string;
  docId: string;
  a: TestUser;
  b: TestUser;
}

async function team(slug: string): Promise<Team> {
  const a = await signUp(`ada@${slug}.io`, "password12345", "Ada");
  const b = await signUp(`bea@${slug}.io`, "password12345", "Bea");
  const org = await createOrg(a, "Acme", slug);
  await seedMember(org.id, b.userId, "member");
  const vaultId = await seedVault(org.id);
  await seedVaultGrant(org.id, "edit");
  const docId = await seedNote(vaultId, null, "shared.md", a.userId);
  return { orgId: org.id, vaultId, docId, a, b };
}

async function registrySelf(user: TestUser, orgId: string) {
  const res = await app.request(`/api/orgs/${orgId}/participants`, { headers: authHeaders(user) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    participants: Array<{ id: string; displayName: string; color: string }>;
    self: string;
  };
  return body.participants.find((p) => p.id === body.self)!;
}

function waitFor(cond: () => boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout: ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("presence end-to-end (AC8, AC9)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("AC8: B's cursor + registry identity reach A over per-doc awareness in under 2 s", async () => {
    const t = await team("ac8");
    const server: Server<SyncContext> = createSyncServer(PORT);
    await server.listen();
    const providers: HocuspocusProvider[] = [];
    try {
      const connect = async (user: TestUser) => {
        const token = await mintSyncToken({
          docId: t.docId,
          vaultId: t.vaultId,
          readOnly: false,
          userId: user.userId,
        });
        const provider = new HocuspocusProvider({
          url: `ws://127.0.0.1:${PORT}`,
          name: formatDocName(t.vaultId, t.docId),
          token,
          document: new Y.Doc(),
        });
        providers.push(provider);
        await waitFor(() => provider.isSynced, 8000, "provider synced");
        return provider;
      };
      const pa = await connect(t.a);
      const pb = await connect(t.b);
      const me = await registrySelf(t.b, t.orgId);

      const awA = pa.awareness!;
      const awB = pb.awareness!;
      const bId = awB.clientID;
      type BState = { user?: { participantId?: string }; cursor?: { head: number } };
      /** Resolves with the wall-clock time A's awareness first shows B at `head`. */
      const seenByA = (head: number) =>
        Promise.race([
          new Promise<number>((resolve) => {
            const onChange = () => {
              const s = awA.getStates().get(bId) as BState | undefined;
              if (s?.user?.participantId === me.id && s.cursor?.head === head) {
                awA.off("change", onChange);
                resolve(performance.now());
              }
            };
            awA.on("change", onChange);
          }),
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`AC8 timeout at head ${head}`)), 5000),
          ),
        ]);

      // First move also publishes B's identity; then four plain cursor moves.
      const latencies: number[] = [];
      for (let head = 1; head <= 5; head++) {
        const seen = seenByA(head);
        const t0 = performance.now();
        if (head === 1) {
          awB.setLocalStateField("user", {
            id: t.b.userId,
            participantId: me.id,
            name: me.displayName,
            color: me.color,
          });
        }
        awB.setLocalStateField("cursor", { anchor: 0, head });
        latencies.push((await seen) - t0);
      }
      console.log(
        `[AC8] B -> A awareness latency over ${latencies.length} moves (ms): ` +
          `${latencies.map((l) => l.toFixed(1)).join(", ")}; max ${Math.max(...latencies).toFixed(1)}`,
      );

      const state = awA.getStates().get(bId) as {
        user: { name: string; color: string; participantId: string };
        cursor: unknown;
      };
      expect(state.user).toMatchObject({ participantId: me.id, name: "Bea", color: me.color });
      expect(state.cursor).toEqual({ anchor: 0, head: 5 });
      // It travelled through the server: the server's copy of the doc's
      // awareness holds B's state too (the two providers share nothing locally).
      const serverDoc = server.hocuspocus.documents.get(formatDocName(t.vaultId, t.docId));
      expect(serverDoc?.awareness.getStates().get(bId)).toMatchObject({
        user: { participantId: me.id },
      });
      expect(Math.max(...latencies)).toBeLessThan(2000);
    } finally {
      for (const p of providers) p.destroy();
      await server.destroy();
    }
  });

  it("AC9: a peer that stops answering pings is reaped and announced gone within 4 ticks, then returns", async () => {
    const HEARTBEAT = 250;
    const t = await team("ac9");
    const pubsub = new InMemoryPubSub();
    const channel = new VaultChannel({ pubsub, heartbeatMs: HEARTBEAT });
    const stop = channel.startHeartbeat();
    try {
      const a = new PingWs();
      channel.handleConnection(a as never);
      a.hello(await mintVaultToken({ userId: t.a.userId, vaultId: t.vaultId }));
      a.presence(t.docId);
      await waitFor(() => a.controls().some((c) => c.t === "ready"), 8000, "A ready");

      const connectB = async () => {
        const b = new PingWs();
        channel.handleConnection(b as never);
        b.hello(await mintVaultToken({ userId: t.b.userId, vaultId: t.vaultId }));
        b.presence(t.docId, "Spoofed", "#000000");
        await waitFor(() => b.controls().some((c) => c.t === "ready"), 8000, "B ready");
        return b;
      };
      const bPresence = () => a.controls().filter((c) => c.t === "presence" && c.userId === t.b.userId);
      const bee = await registrySelf(t.b, t.orgId);

      const b = await connectB();
      await waitFor(() => bPresence().some((c) => c.docId === t.docId), 8000, "A sees B");
      expect(bPresence().at(-1)).toMatchObject({
        participantId: bee.id,
        name: "Bea",
        color: bee.color,
      });
      expect(channel.connectionCount()).toBe(2);

      // Kill B's network: no FIN, no close frame, pings simply go unanswered.
      const seenBefore = bPresence().length;
      b.responsive = false;
      const cut = performance.now();
      await waitFor(
        () => bPresence().slice(seenBefore).some((c) => c.gone === true),
        HEARTBEAT * 6,
        "A sees B gone",
      );
      const goneAfter = performance.now() - cut;
      console.log(
        `[AC9] B announced gone ${goneAfter.toFixed(0)} ms after its socket went silent ` +
          `(${(goneAfter / HEARTBEAT).toFixed(2)} ticks of ${HEARTBEAT} ms)`,
      );
      expect(goneAfter).toBeLessThan(HEARTBEAT * 4);
      const gone = bPresence().slice(seenBefore).find((c) => c.gone)!;
      expect(gone).toMatchObject({ docId: null, participantId: bee.id, gone: true });
      // Reaped: terminated outright, and the channel no longer tracks it.
      expect(b.terminated).toBe(true);
      expect(channel.connectionCount()).toBe(1);
      // A, which kept answering, is still alive.
      expect(a.terminated).toBe(false);

      // B comes back on a fresh socket and A sees it again.
      const seenGone = bPresence().length;
      const back = performance.now();
      await connectB();
      await waitFor(
        () => bPresence().slice(seenGone).some((c) => c.docId === t.docId && !c.gone),
        8000,
        "A sees B again",
      );
      console.log(`[AC9] B visible to A again ${(performance.now() - back).toFixed(0)} ms after reconnect`);
      expect(channel.connectionCount()).toBe(2);
    } finally {
      stop();
      await pubsub.close();
    }
  });
});

/** A fake vault-channel socket that answers the server's pings until told not to. */
class PingWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  responsive = true;
  terminated = false;
  readonly sent: Array<{ text?: Record<string, unknown> }> = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) this.sent.push({});
    else this.sent.push({ text: JSON.parse(data as string) as Record<string, unknown> });
  }
  ping(): void {
    if (this.responsive) setImmediate(() => this.emit("pong"));
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  hello(token: string): void {
    this.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest: {} })), false);
  }
  presence(docId: string | null, name = "client", color = "#123456"): void {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ t: "presence", docId, name, color, status: "online" })),
      false,
    );
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent.filter((s) => s.text).map((s) => s.text!);
  }
}
