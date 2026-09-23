import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { config } from "../src/config.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import {
  seedAgentParticipant,
  seedFolder,
  seedMember,
  seedOrg,
  seedVault,
} from "./helpers/seed.js";
import { createMcpToken, verifyMcpToken } from "../src/mcp/tokens.js";

/**
 * ADR 0003 decisions 1 and 7 over HTTP: agent mint (owner/admin, default-deny
 * scopes, 90-day expiry), the user-token sunset (410 on mint, 401 past the
 * date), listing with `stale`, and renew / rotate / migrate.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

const DAY = 24 * 60 * 60 * 1000;

function tokensApi(user: TestUser, path = "", init: { method?: string; body?: unknown } = {}) {
  return app.request(`/api/mcp/tokens${path}`, {
    method: init.method ?? "GET",
    headers: authHeaders(user),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const mint = (user: TestUser, body: Record<string, unknown>) =>
  tokensApi(user, "", { method: "POST", body: { kind: "agent", ...body } });

let rpcId = 0;
function rpc(token: string, method = "tools/list") {
  return app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method }),
    }),
  );
}

interface Org {
  org: string;
  owner: TestUser;
  admin: TestUser;
  member: TestUser;
  agent: string;
}

/** One org with an owner, an admin, a member (each in exactly this org, so it
 *  is their active vault) and one live agent participant. */
async function setup(tag: string): Promise<Org> {
  const org = await seedOrg("Acme", `acme-${tag}`);
  const owner = await signUp(`owner-${tag}@lc.com`);
  const admin = await signUp(`admin-${tag}@lc.com`);
  const member = await signUp(`member-${tag}@lc.com`);
  await seedMember(org, owner.userId, "owner");
  await seedMember(org, admin.userId, "admin");
  await seedMember(org, member.userId, "member");
  const agent = await seedAgentParticipant(org, `Bot ${tag}`, owner.userId);
  return { org, owner, admin, member, agent };
}

async function humanParticipant(org: string, userId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM participants WHERE organization_id = $1 AND user_id = $2 AND kind = 'human'",
    [org, userId],
  );
  return rows[0].id;
}

describe("MCP token lifecycle", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  describe("mint", () => {
    it("refuses user tokens with 410 and the sunset date", async () => {
      const { owner } = await setup("m1");
      for (const body of [{}, { kind: "user", name: "x" }]) {
        const res = await tokensApi(owner, "", { method: "POST", body });
        expect(res.status).toBe(410);
        expect(await res.json()).toEqual({
          error: "user_tokens_sunset",
          sunsetAt: config.mcpUserTokenSunset.toISOString(),
          hint: "mint an agent token",
        });
      }
    });

    it("gates on role, participant and scope validity", async () => {
      const { org, owner, member, agent } = await setup("m2");

      const asMember = await mint(member, { participantId: agent, preset: "reader" });
      expect(asMember.status).toBe(403);
      expect(await asMember.json()).toEqual({ error: "owner_or_admin_required" });

      const noParticipant = await mint(owner, { preset: "reader" });
      expect(noParticipant.status).toBe(400);
      expect(await noParticipant.json()).toEqual({ error: "participant_required" });

      const human = await mint(owner, {
        participantId: await humanParticipant(org, owner.userId),
        preset: "reader",
      });
      expect(human.status).toBe(404);
      expect(await human.json()).toEqual({ error: "participant_not_found" });

      const tooLong = await mint(owner, { participantId: agent, preset: "reader", expiresInDays: 400 });
      expect(tooLong.status).toBe(400);

      const drafter = await mint(owner, { participantId: agent, preset: "drafter" });
      expect(drafter.status).toBe(400);
      expect(await drafter.json()).toEqual({ error: "preset_needs_folder" });

      const badPreset = await mint(owner, { participantId: agent, preset: "god" });
      expect(badPreset.status).toBe(400);
      expect(await badPreset.json()).toEqual({ error: "invalid_preset" });

      // A folder that belongs to ANOTHER org cannot be named by id.
      const otherOrg = await seedOrg("Other", "other-m2");
      const otherFolder = await seedFolder(await seedVault(otherOrg), null, "X", "X");
      const outside = await mint(owner, {
        participantId: agent,
        scopes: [{ resourceType: "folder", resourceId: otherFolder, permission: "edit" }],
      });
      expect(outside.status).toBe(400);
      expect(await outside.json()).toEqual({ error: "scope_outside_vault" });

      // Nothing was stored by any refusal.
      const { rows } = await pool.query("SELECT 1 FROM mcp_tokens");
      expect(rows).toHaveLength(0);
    });

    it("mints a reader agent token: plaintext once, vault view scope, 90-day expiry", async () => {
      const { org, owner, agent } = await setup("m3");
      const res = await mint(owner, { participantId: agent, preset: "reader", name: "Reader" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.token).toMatch(/^mcp_/);
      expect(body.kind).toBe("agent");
      expect(body.participantId).toBe(agent);
      expect(body.userId).toBe(owner.userId);
      expect(body.name).toBe("Reader");
      expect(body.scopes).toEqual([{ resourceType: "vault", resourceId: org, permission: "view" }]);
      const expected = Date.now() + 90 * DAY;
      expect(Math.abs(new Date(body.expiresAt).getTime() - expected)).toBeLessThan(60_000);
      // The plaintext authenticates as the agent.
      const auth = await verifyMcpToken(body.token);
      expect(auth).toMatchObject({ kind: "agent", participantId: agent, userId: owner.userId });
    });
  });

  describe("list", () => {
    it("managers see every agent token; members see only their own tokens", async () => {
      const { org, owner, admin, member, agent } = await setup("l1");
      const byAdmin = (await (await mint(admin, { participantId: agent, preset: "reader" })).json()) as any;
      const { row: memberUser } = await createMcpToken(
        { userId: member.userId, organizationId: org },
        "mine",
      );

      const ownerList = (await (await tokensApi(owner)).json()) as any;
      expect(ownerList.tokens.map((t: any) => t.id)).toEqual([byAdmin.id]);
      expect(ownerList.userTokenSunset).toBe(config.mcpUserTokenSunset.toISOString());
      expect(ownerList.presets.map((p: any) => p.name)).toEqual(["reader", "drafter", "editor"]);
      for (const p of ownerList.presets) expect(typeof p.description).toBe("string");
      expect(Array.isArray(ownerList.tools)).toBe(true);

      const memberList = (await (await tokensApi(member)).json()) as any;
      expect(memberList.tokens.map((t: any) => t.id)).toEqual([memberUser.id]);
      expect(memberList.tokens[0].kind).toBe("user");
      expect(memberList.tokens[0].stale).toBe(false);
      expect(memberList.tokens[0].expiresAt).toBe(memberList.userTokenSunset);
    });

    it("reports a token unused for over 30 days as stale", async () => {
      const { owner, agent } = await setup("l2");
      const minted = (await (await mint(owner, { participantId: agent, preset: "reader" })).json()) as any;
      let list = (await (await tokensApi(owner)).json()) as any;
      expect(list.tokens[0].stale).toBe(false);

      await pool.query("UPDATE mcp_tokens SET last_used_at = now() - interval '31 days' WHERE id = $1", [
        minted.id,
      ]);
      list = (await (await tokensApi(owner)).json()) as any;
      expect(list.tokens[0].stale).toBe(true);
    });
  });

  describe("expiry + renew", () => {
    it("an expired agent token is 401 until renewed, with the same scopes", async () => {
      const { org, owner, agent } = await setup("e1");
      const minted = (await (await mint(owner, { participantId: agent, preset: "reader" })).json()) as any;
      expect((await rpc(minted.token)).status).toBe(200);

      await pool.query("UPDATE mcp_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [
        minted.id,
      ]);
      expect((await rpc(minted.token)).status).toBe(401);

      const renewed = await tokensApi(owner, `/${minted.id}/renew`, {
        method: "POST",
        body: { expiresInDays: 10 },
      });
      expect(renewed.status).toBe(200);
      const row = (await renewed.json()) as any;
      expect(row.id).toBe(minted.id);
      expect(row.scopes).toEqual([{ resourceType: "vault", resourceId: org, permission: "view" }]);
      expect(Math.abs(new Date(row.expiresAt).getTime() - (Date.now() + 10 * DAY))).toBeLessThan(60_000);
      expect((await rpc(minted.token)).status).toBe(200);

      const bad = await tokensApi(owner, `/${minted.id}/renew`, {
        method: "POST",
        body: { expiresInDays: 0 },
      });
      expect(bad.status).toBe(400);
    });

    it("renew refuses a user token", async () => {
      const { org, owner } = await setup("e2");
      const { row } = await createMcpToken({ userId: owner.userId, organizationId: org }, "u");
      const res = await tokensApi(owner, `/${row.id}/renew`, { method: "POST", body: {} });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "not_an_agent_token" });
    });
  });

  describe("rotate", () => {
    it("replaces the token: new plaintext works, old one is 401, binding unchanged", async () => {
      const { owner, agent } = await setup("r1");
      const old = (await (await mint(owner, { participantId: agent, preset: "editor", name: "Ed" })).json()) as any;

      const res = await tokensApi(owner, `/${old.id}/rotate`, { method: "POST" });
      expect(res.status).toBe(201);
      const next = (await res.json()) as any;
      expect(next.token).toMatch(/^mcp_/);
      expect(next.token).not.toBe(old.token);
      expect(next.id).not.toBe(old.id);
      expect(next.participantId).toBe(old.participantId);
      expect(next.scopes).toEqual(old.scopes);
      expect(next.name).toBe(old.name);
      expect(next.userId).toBe(old.userId);

      expect((await rpc(next.token)).status).toBe(200);
      expect((await rpc(old.token)).status).toBe(401);
      const { rows } = await pool.query("SELECT id FROM mcp_tokens WHERE participant_id = $1", [agent]);
      expect(rows).toEqual([{ id: next.id }]);
    });

    it("rotate refuses a user token", async () => {
      const { org, owner } = await setup("r2");
      const { row } = await createMcpToken({ userId: owner.userId, organizationId: org }, "u");
      const res = await tokensApi(owner, `/${row.id}/rotate`, { method: "POST" });
      expect(res.status).toBe(400);
    });
  });

  describe("migrate", () => {
    it("owner migrates their own user token to an editor agent token", async () => {
      const { org, owner, agent } = await setup("g1");
      const { token: oldPlain, row: old } = await createMcpToken(
        { userId: owner.userId, organizationId: org },
        "legacy",
      );
      const res = await tokensApi(owner, `/${old.id}/migrate`, {
        method: "POST",
        body: { participantId: agent, preset: "editor" },
      });
      expect(res.status).toBe(201);
      const next = (await res.json()) as any;
      expect(next.migratedFrom).toBe(old.id);
      expect(next.kind).toBe("agent");
      expect(next.name).toBe("legacy");
      expect(next.scopes).toEqual([{ resourceType: "vault", resourceId: org, permission: "edit" }]);

      expect(await verifyMcpToken(next.token)).toMatchObject({
        kind: "agent",
        participantId: agent,
        userId: owner.userId,
      });
      expect((await rpc(oldPlain)).status).toBe(401);
      const { rows } = await pool.query("SELECT 1 FROM mcp_tokens WHERE id = $1", [old.id]);
      expect(rows).toHaveLength(0);
    });

    it("a member's user token migrated by the owner keeps the member as its cap", async () => {
      const { org, owner, member, agent } = await setup("g2");
      const { row: old } = await createMcpToken({ userId: member.userId, organizationId: org }, "m");

      // The member cannot bind an agent themselves.
      const self = await tokensApi(member, `/${old.id}/migrate`, {
        method: "POST",
        body: { participantId: agent, preset: "reader" },
      });
      expect(self.status).toBe(403);

      const res = await tokensApi(owner, `/${old.id}/migrate`, {
        method: "POST",
        body: { participantId: agent, preset: "reader" },
      });
      expect(res.status).toBe(201);
      const next = (await res.json()) as any;
      expect(next.userId).toBe(member.userId);
      expect((await verifyMcpToken(next.token))?.userId).toBe(member.userId);
    });

    it("refuses to migrate an agent token", async () => {
      const { owner, agent } = await setup("g3");
      const minted = (await (await mint(owner, { participantId: agent, preset: "reader" })).json()) as any;
      const res = await tokensApi(owner, `/${minted.id}/migrate`, {
        method: "POST",
        body: { participantId: agent, preset: "reader" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "not_a_user_token" });
    });
  });

  describe("user-token sunset", () => {
    // `config` is read at import, so env vars can't move the date mid-run.
    // `as const` makes it readonly to the type checker only; the object itself
    // is writable, and `verifyMcpToken` reads the field on every request.
    const original = config.mcpUserTokenSunset;
    afterEach(() => {
      (config as { mcpUserTokenSunset: Date }).mcpUserTokenSunset = original;
    });

    it("a user token past the sunset is 401; an agent token is not", async () => {
      const { org, owner, agent } = await setup("s1");
      const { token: userPlain } = await createMcpToken(
        { userId: owner.userId, organizationId: org },
        "u",
      );
      const minted = (await (await mint(owner, { participantId: agent, preset: "reader" })).json()) as any;
      expect((await rpc(userPlain)).status).toBe(200);

      (config as { mcpUserTokenSunset: Date }).mcpUserTokenSunset = new Date(Date.now() - 1000);
      expect((await rpc(userPlain)).status).toBe(401);
      expect((await rpc(minted.token)).status).toBe(200);
    });
  });
});
