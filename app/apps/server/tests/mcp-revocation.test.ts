import { EventEmitter } from "node:events";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import {
  seedAgentParticipant,
  seedMember,
  seedNote,
  seedOrg,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { createAgentToken, createMcpToken } from "../src/mcp/tokens.js";
import { expandPreset } from "../src/permissions/token-scope.js";
import { VaultChannel, type VaultChannelDeps } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import type { DocDiff } from "../src/yjs/persistence.js";

/**
 * ADR 0003 decision 5: revocation is live. Revoking an agent token deletes the
 * row (the next MCP request fails verification), closes the participant's doc
 * sockets, announces it `gone` on the vault channel, and is audited. Inside one
 * batched HTTP body, a revoke stops every call after the one in flight.
 */

/** When set, the docWriter's next write runs this first (the "revoke mid-batch" hook). */
let onWrite: (() => Promise<void>) | null = null;

const rec = recordingAppDeps();
const inner = rec.docWriter;
const app = createApp({
  ...rec.deps,
  docWriter: {
    ...inner,
    async editContent(...args: Parameters<typeof inner.editContent>) {
      const hook = onWrite;
      onWrite = null;
      await hook?.();
      return inner.editContent(...args);
    },
    async setContent(...args: Parameters<typeof inner.setContent>) {
      const hook = onWrite;
      onWrite = null;
      await hook?.();
      return inner.setContent(...args);
    },
  },
});

let rpcId = 0;
function mcp(token: string, body: unknown) {
  return app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
}
const toolCall = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: ++rpcId,
  method: "tools/call",
  params: { name, arguments: args },
});

function revoke(user: TestUser, id: string) {
  return app.request(`/api/mcp/tokens/${id}`, { method: "DELETE", headers: authHeaders(user) });
}

interface Org {
  org: string;
  vault: string;
  owner: TestUser;
  admin: TestUser;
  member: TestUser;
  agent: string;
}

async function setup(tag: string): Promise<Org> {
  const org = await seedOrg("Acme", `acme-${tag}`);
  const owner = await signUp(`owner-${tag}@rv.com`);
  const admin = await signUp(`admin-${tag}@rv.com`);
  const member = await signUp(`member-${tag}@rv.com`);
  await seedMember(org, owner.userId, "owner");
  await seedMember(org, admin.userId, "admin");
  await seedMember(org, member.userId, "member");
  const vault = await seedVault(org);
  // Shared with the team, so the minter's own grant does not cap the scopes.
  await seedVaultGrant(org, "edit");
  const agent = await seedAgentParticipant(org, `Bot ${tag}`, owner.userId);
  return { org, vault, owner, admin, member, agent };
}

async function agentToken(o: Org, mintedBy: string) {
  return createAgentToken({
    organizationId: o.org,
    mintedBy,
    participantId: o.agent,
    name: "agent",
    scopes: expandPreset("editor", o.org),
  });
}

describe("MCP token revocation", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
    onWrite = null;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("revoking an agent token is live: 401 next call, sockets kicked, chip retracted, audited", async () => {
    const o = await setup("a1");
    const { token, row } = await agentToken(o, o.owner.userId);
    const list = toolCall("list_vaults", {});
    expect((await mcp(token, list)).status).toBe(200);

    const res = await revoke(o.owner, row.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: row.id, kind: "agent", participantId: o.agent });

    expect((await mcp(token, toolCall("list_vaults", {}))).status).toBe(401);
    expect(rec.disconnectedParticipants).toEqual([o.agent]);
    expect(rec.participantGone).toEqual([{ organizationId: o.org, participantId: o.agent }]);

    const { rows } = await pool.query(
      `SELECT tool, outcome, participant_id, user_id, organization_id, bytes_out
         FROM mcp_audit WHERE token_id = $1 AND tool = 'token.revoke'`,
      [row.id],
    );
    expect(rows).toEqual([
      {
        tool: "token.revoke",
        outcome: "revoked",
        participant_id: o.agent,
        user_id: o.owner.userId,
        organization_id: o.org,
        bytes_out: 0,
      },
    ]);
  });

  it("a revoke landing mid-batch stops every later call in that batch", async () => {
    const o = await setup("b1");
    const noteA = await seedNote(o.vault, null, "a.md", o.owner.userId);
    const noteB = await seedNote(o.vault, null, "b.md", o.owner.userId);
    inner.store.set(noteA, "A before");
    inner.store.set(noteB, "B before");
    const { token, row } = await agentToken(o, o.owner.userId);

    // The first call's write revokes the token underneath the batch.
    onWrite = async () => {
      await pool.query("DELETE FROM mcp_tokens WHERE id = $1", [row.id]);
    };
    const batch = [
      toolCall("update_note", { docId: noteA, content: "A after" }),
      toolCall("update_note", { docId: noteB, content: "B after" }),
      toolCall("read_note", { docId: noteB }),
    ];
    const res = await mcp(token, batch);
    expect(res.status).toBe(200);
    const out = (await res.json()) as Array<{ id: number; result?: any; error?: any }>;
    expect(out).toHaveLength(3);

    expect(out[0].id).toBe(batch[0].id);
    expect(out[0].error).toBeUndefined();
    expect(out[0].result.isError ?? false).toBe(false);
    for (const [i, r] of out.slice(1).entries()) {
      expect(r.id).toBe(batch[i + 1].id);
      expect(r.error).toEqual({ code: -32001, message: "Unauthorized: token revoked" });
    }
    expect(inner.store.get(noteA)).toBe("A after");
    expect(inner.store.get(noteB)).toBe("B before");
  });

  it("authorization: members can't revoke agent tokens; managers can't revoke others' user tokens", async () => {
    const o = await setup("z1");
    const { row: ownersAgent } = await agentToken(o, o.owner.userId);
    const { row: adminsAgent } = await agentToken(o, o.admin.userId);
    const { row: adminsUser } = await createMcpToken(
      { userId: o.admin.userId, organizationId: o.org },
      "admin's own",
    );

    expect((await revoke(o.member, ownersAgent.id)).status).toBe(403);
    expect((await revoke(o.owner, adminsUser.id)).status).toBe(403);
    expect((await revoke(o.owner, adminsAgent.id)).status).toBe(200);
    expect((await revoke(o.owner, "no-such-token")).status).toBe(404);

    const { rows } = await pool.query("SELECT id FROM mcp_tokens ORDER BY id");
    expect(rows.map((r) => r.id).sort()).toEqual([ownersAgent.id, adminsUser.id].sort());
  });

  it("revoking a user token fires neither live hook", async () => {
    const o = await setup("u1");
    const { token, row } = await createMcpToken(
      { userId: o.member.userId, organizationId: o.org },
      "mine",
    );
    const res = await revoke(o.member, row.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: row.id, kind: "user", participantId: null });
    expect(rec.disconnectedParticipants).toEqual([]);
    expect(rec.participantGone).toEqual([]);
    expect((await mcp(token, toolCall("list_vaults", {}))).status).toBe(401);
  });
  it("every call refused after a mid-batch revoke still leaves one `revoked` audit row", async () => {
    // PR #16 round 2, finding 3: the refusal branch skipped the dispatcher, and
    // with it the one-row-per-call trail for what the dead credential tried next.
    const o = await setup("b2");
    const noteA = await seedNote(o.vault, null, "a.md", o.owner.userId);
    const noteB = await seedNote(o.vault, null, "b.md", o.owner.userId);
    inner.store.set(noteA, "A before");
    inner.store.set(noteB, "B before");
    const { token, row } = await agentToken(o, o.owner.userId);
    onWrite = async () => {
      await pool.query("DELETE FROM mcp_tokens WHERE id = $1", [row.id]);
    };
    const res = await mcp(token, [
      toolCall("update_note", { docId: noteA, content: "A after" }),
      toolCall("update_note", { docId: noteB, content: "B after" }),
      toolCall("search_notes", { vaultId: o.vault, query: "after" }),
    ]);
    expect(res.status).toBe(200);

    const { rows } = await pool.query<{ tool: string; doc_id: string | null; outcome: string }>(
      `SELECT tool, doc_id, outcome FROM mcp_audit
        WHERE token_id = $1 AND tool <> 'token.revoke' ORDER BY id`,
      [row.id],
    );
    expect(rows).toEqual([
      { tool: "update_note", doc_id: noteA, outcome: "ok" },
      { tool: "update_note", doc_id: noteB, outcome: "revoked" },
      { tool: "search_notes", doc_id: null, outcome: "revoked" },
    ]);
    const { rows: who } = await pool.query(
      "SELECT DISTINCT participant_id, user_id, organization_id FROM mcp_audit WHERE token_id = $1",
      [row.id],
    );
    expect(who).toEqual([{ participant_id: o.agent, user_id: o.owner.userId, organization_id: o.org }]);
  });

  it("revoking one of two tokens bound to the same participant keeps its sockets and chip until the last goes", async () => {
    // PR #16 round 2, finding 7: the sockets and the presence chip are the
    // participant's, so a live sibling token must keep both.
    const o = await setup("s1");
    const first = await agentToken(o, o.owner.userId);
    const second = await agentToken(o, o.admin.userId);

    expect((await revoke(o.owner, first.row.id)).status).toBe(200);
    expect(rec.disconnectedParticipants).toEqual([]);
    expect(rec.participantGone).toEqual([]);
    // The row itself is gone and the revoke is audited regardless.
    expect((await mcp(first.token, toolCall("list_vaults", {}))).status).toBe(401);
    expect((await mcp(second.token, toolCall("list_vaults", {}))).status).toBe(200);
    const { rows } = await pool.query(
      "SELECT outcome FROM mcp_audit WHERE token_id = $1 AND tool = 'token.revoke'",
      [first.row.id],
    );
    expect(rows).toEqual([{ outcome: "revoked" }]);

    expect((await revoke(o.owner, second.row.id)).status).toBe(200);
    expect(rec.disconnectedParticipants).toEqual([o.agent]);
    expect(rec.participantGone).toEqual([{ organizationId: o.org, participantId: o.agent }]);
  });

  it("an expired sibling token does not keep a revoked participant's sockets open", async () => {
    const o = await setup("s2");
    const live = await agentToken(o, o.owner.userId);
    const expired = await agentToken(o, o.owner.userId);
    await pool.query("UPDATE mcp_tokens SET expires_at = now() - interval '1 day' WHERE id = $1", [
      expired.row.id,
    ]);

    expect((await revoke(o.owner, live.row.id)).status).toBe(200);
    expect(rec.disconnectedParticipants).toEqual([o.agent]);
    expect(rec.participantGone).toEqual([{ organizationId: o.org, participantId: o.agent }]);
  });

});

// ── Chip retraction at the channel level ─────────────────────────────────────
// Proves the server half: `publishParticipantGone` reaches a subscribed client
// as a `gone` presence frame. The desktop roster's immediate removal on `gone`
// is covered by the desktop's roster tests.

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: unknown[] = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (!opts?.binary) this.sent.push(JSON.parse(data as string));
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent as Array<Record<string, unknown>>;
  }
}

async function until(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("participant gone on the vault channel", () => {
  it("a subscribed client receives a gone presence frame for the revoked agent", async () => {
    const pubsub = new InMemoryPubSub();
    try {
      const channel = new VaultChannel({
        pubsub,
        verifyToken: async (token: string) => ({ userId: `u-${token}`, vaultId: "v1" }),
        listReadableDocs: async () => new Set(["A"]),
        loadDiff: (async () => null as DocDiff | null) as VaultChannelDeps["loadDiff"],
        listEmpty: async () => ({ empty: [], truncated: false }),
        resolvePresenceIdentity: async () => ({
          participantId: "p-ada",
          name: "Ada",
          color: "#2981fb",
        }),
      });
      const ws = new FakeWs();
      channel.handleConnection(ws as never);
      ws.emit("message", Buffer.from(JSON.stringify({ t: "hello", token: "ada", manifest: {} })), false);
      await until(() => ws.controls().some((c) => c.t === "ready"));

      await channel.publishParticipantGone("v1", {
        participantId: "p-bot",
        name: "Bot",
        color: "#789c5b",
      });
      await until(() => ws.controls().some((c) => c.t === "presence" && c.gone === true));
      const frame = ws.controls().find((c) => c.t === "presence" && c.gone === true)!;
      expect(frame).toMatchObject({
        t: "presence",
        participantId: "p-bot",
        userId: "agent:p-bot",
        docId: null,
        gone: true,
      });
      ws.close();
    } finally {
      await pubsub.close();
    }
  });

});
