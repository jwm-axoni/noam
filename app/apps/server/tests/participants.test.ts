import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth } from "../src/auth/auth.js";
import { createApp } from "../src/http/app.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  PALETTE,
  ensureHumanParticipant,
  participantColor,
} from "../src/registry/participants.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, bearerHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

/**
 * Participant registry (migration 027 + /api/orgs/:orgId/participants).
 * Acceptance criteria 1-7 of noam-phase01-spec.md, with the lead's decisions:
 * rows come from triggers on `member`, color is FNV-1a of the user id.
 */
const rec = recordingAppDeps();
const app = createApp(rec.deps);

interface Row {
  id: string;
  kind: string;
  user_id: string | null;
  display_name: string;
  color: string;
  deactivated_at: Date | null;
}

async function rowsFor(orgId: string): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT id, kind, user_id, display_name, color, deactivated_at
       FROM participants WHERE organization_id = $1 ORDER BY created_at, id`,
    [orgId],
  );
  return rows;
}

async function liveHuman(orgId: string, userId: string): Promise<Row[]> {
  return (await rowsFor(orgId)).filter(
    (r) => r.kind === "human" && r.user_id === userId && r.deactivated_at === null,
  );
}

/** Members with no live human participant row in their org. Must always be 0. */
async function orphanMembers(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM member m
      WHERE NOT EXISTS (
        SELECT 1 FROM participants p
         WHERE p.organization_id = m."organizationId" AND p.user_id = m."userId"
           AND p.kind = 'human' AND p.deactivated_at IS NULL)`,
  );
  return rows[0].n;
}

function get(user: TestUser | null, orgId: string) {
  return app.request(`/api/orgs/${orgId}/participants`, {
    headers: user ? authHeaders(user) : {},
  });
}

function post(user: TestUser, orgId: string, body: unknown) {
  return app.request(`/api/orgs/${orgId}/participants`, {
    method: "POST",
    headers: authHeaders(user),
    body: JSON.stringify(body),
  });
}

function patch(user: TestUser, orgId: string, id: string, body: unknown) {
  return app.request(`/api/orgs/${orgId}/participants/${id}`, {
    method: "PATCH",
    headers: authHeaders(user),
    body: JSON.stringify(body),
  });
}

interface ListBody {
  participants: Array<{
    id: string;
    kind: string;
    displayName: string;
    color: string;
    harness: string | null;
    createdAt: string;
  }>;
  self: string | null;
}

async function list(user: TestUser, orgId: string): Promise<ListBody> {
  const res = await get(user, orgId);
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

/** A signed-up user added to `orgId` as a member (fires the trigger). */
async function memberOf(orgId: string, email: string, role: "member" | "admin" = "member") {
  const user = await signUp(email);
  await seedMember(orgId, user.userId, role);
  return user;
}

describe("participant registry", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  describe("migration 027 (AC1, AC2)", () => {
    it("upgrades a database at 026 with existing orgs, members and vaults", async () => {
      // Roll this database back to 026: no participants objects, no record.
      await pool.query(`
        DELETE FROM _migrations WHERE name = '027_participants.sql';
        DROP TRIGGER IF EXISTS participants_member_insert ON member;
        DROP TRIGGER IF EXISTS participants_member_delete ON member;
        DROP TRIGGER IF EXISTS participants_user_rename ON "user";
        DROP TABLE IF EXISTS participants;
        DROP FUNCTION IF EXISTS participants_on_member_insert();
        DROP FUNCTION IF EXISTS participants_on_member_delete();
        DROP FUNCTION IF EXISTS participants_on_user_rename();
        DROP FUNCTION IF EXISTS participant_color(text);
        DROP FUNCTION IF EXISTS participant_human_name(text, text);
      `);

      const orgs = [
        await seedOrg("One", "up-one"),
        await seedOrg("Two", "up-two"),
        await seedOrg("Three", "up-three"),
      ];
      for (const o of orgs) await seedVault(o);
      const john1 = await seedUser("john@one.io");
      const john2 = await seedUser("john@two.io");
      const ada = await seedUser("ada@one.io");
      const blank = await seedUser("blank.name@three.io");
      const cy = await seedUser("cy@one.io");
      await pool.query(`UPDATE "user" SET name = 'John' WHERE id = ANY($1)`, [[john1, john2]]);
      await pool.query(`UPDATE "user" SET name = '  ' WHERE id = $1`, [blank]);

      // 7 member rows; john1 is in all three orgs.
      await seedMember(orgs[0], john1, "owner");
      await seedMember(orgs[1], john1, "owner");
      await seedMember(orgs[2], john1, "owner");
      await seedMember(orgs[0], john2, "member");
      await seedMember(orgs[1], ada, "admin");
      await seedMember(orgs[2], blank, "member");
      await seedMember(orgs[0], cy, "member");

      expect(await runMigrations()).toEqual(["027_participants.sql"]);

      // Exactly one live human row per member row, checked by count query.
      const { rows: perMember } = await pool.query<{ n: number }>(
        `SELECT count(p.id)::int AS n FROM member m
           LEFT JOIN participants p
             ON p.organization_id = m."organizationId" AND p.user_id = m."userId"
            AND p.kind = 'human' AND p.deactivated_at IS NULL
          GROUP BY m.id`,
      );
      expect(perMember).toHaveLength(7);
      expect(perMember.every((r) => r.n === 1)).toBe(true);
      expect(await orphanMembers()).toBe(0);
      const { rows: total } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM participants",
      );
      expect(total[0].n).toBe(7);

      const { rows } = await pool.query<{ user_id: string; display_name: string; color: string }>(
        "SELECT user_id, display_name, color FROM participants",
      );
      for (const r of rows) {
        expect(PALETTE).toContain(r.color);
        expect(r.color).toBe(participantColor(r.user_id));
      }
      const byUser = (id: string) => rows.filter((r) => r.user_id === id);
      // Same user, three orgs, one color.
      expect(new Set(byUser(john1).map((r) => r.color)).size).toBe(1);
      expect(byUser(john1).map((r) => r.display_name)).toEqual(["John", "John", "John"]);
      // Two different "John"s both got rows, each with their own id's color.
      expect(byUser(john2)).toHaveLength(1);
      expect(byUser(john2)[0].display_name).toBe("John");
      expect(byUser(john2)[0].color).toBe(participantColor(john2));
      expect(byUser(ada)[0].display_name).toBe("ada");
      // A blank account name falls back to the email local part.
      expect(byUser(blank)[0].display_name).toBe("blank.name");

      // Re-running is a no-op.
      expect(await runMigrations()).toEqual([]);
      const { rows: again } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM participants",
      );
      expect(again[0].n).toBe(7);
    });

    it("participant_color is deterministic and matches the TS/desktop FNV-1a", async () => {
      // fnv1a32("hello") = 1335831723 (0x4f9f2cab); 1335831723 % 8 = 3.
      const { rows: hello } = await pool.query<{ a: string; b: string }>(
        "SELECT participant_color('hello') AS a, participant_color('hello') AS b",
      );
      expect(hello[0].a).toBe(PALETTE[3]);
      expect(hello[0].b).toBe(PALETTE[3]);
      expect(participantColor("hello")).toBe(PALETTE[3]);

      const ids = Array.from({ length: 50 }, (_, i) =>
        i % 2 ? randomUUID() : randomBytes(16).toString("base64url"),
      );
      const { rows } = await pool.query<{ id: string; color: string }>(
        "SELECT id, participant_color(id) AS color FROM unnest($1::text[]) AS id",
        [ids],
      );
      expect(rows).toHaveLength(50);
      for (const r of rows) expect(r.color).toBe(participantColor(r.id));
      // Violet is Noam's own and is never assigned.
      expect(PALETTE).not.toContain("#7f73ff");
    });
  });

  describe("rows follow membership (AC3)", () => {
    it("accepting an invitation through Better Auth creates the row", async () => {
      const owner = await signUp("owner@ac3a.io");
      const org = await createOrg(owner, "Acme", "ac3a");
      const inv = (await auth.api.createInvitation({
        headers: bearerHeaders(owner),
        body: { email: "tee@ac3a.io", role: "member", organizationId: org.id },
      })) as { id: string };
      const tee = await signUp("tee@ac3a.io", "password12345", "Tee Teammate");
      await auth.api.acceptInvitation({
        headers: bearerHeaders(tee),
        body: { invitationId: inv.id },
      });
      const rows = await liveHuman(org.id, tee.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].display_name).toBe("Tee Teammate");
      expect(rows[0].color).toBe(participantColor(tee.userId));
    });

    it("joining by code creates the row", async () => {
      const owner = await signUp("owner@ac3b.io");
      const org = await createOrg(owner, "Acme", "ac3b");
      const codeRes = await app.request("/api/orgs/join-code", { headers: authHeaders(owner) });
      const { code } = (await codeRes.json()) as { code: string };
      const joiner = await signUp("joiner@ac3b.io");
      const res = await app.request("/api/orgs/join", {
        method: "POST",
        headers: authHeaders(joiner),
        body: JSON.stringify({ code }),
      });
      expect(res.status).toBe(200);
      expect(await liveHuman(org.id, joiner.userId)).toHaveLength(1);
    });

    it("creating an org gives the owner a row", async () => {
      const owner = await signUp("owner@ac3c.io");
      const org = await createOrg(owner, "Acme", "ac3c");
      expect(await liveHuman(org.id, owner.userId)).toHaveLength(1);
      expect(await orphanMembers()).toBe(0);
    });

    it("a rolled-back member insert leaves no participant row", async () => {
      const org = await seedOrg("Acme", "ac3d");
      const user = await seedUser("rollback@ac3d.io");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
           VALUES ($1, $2, $3, 'member', now())`,
          [randomUUID(), org, user],
        );
        // Same transaction: the row is already there before commit…
        const inside = await client.query(
          "SELECT 1 FROM participants WHERE organization_id = $1 AND user_id = $2",
          [org, user],
        );
        expect(inside.rowCount).toBe(1);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      // …and gone with it.
      expect(await rowsFor(org)).toHaveLength(0);
    });

    it("a second insert of the same membership never yields a second row", async () => {
      const org = await seedOrg("Acme", "ac3e");
      const user = await seedUser("twice@ac3e.io");
      await seedMember(org, user, "member");
      await expect(seedMember(org, user, "member")).rejects.toMatchObject({ code: "23505" });
      expect(await rowsFor(org)).toHaveLength(1);
      // The self-heal path is a no-op on top of the trigger.
      const healed = await ensureHumanParticipant(org, user);
      expect(await rowsFor(org)).toHaveLength(1);
      expect(healed?.id).toBe((await rowsFor(org))[0].id);
    });

    it("removing a member deactivates the row; rejoining makes a new live row, same color", async () => {
      const owner = await signUp("owner@rm.io");
      const org = await createOrg(owner, "Acme", "rm-org");
      const bo = await memberOf(org.id, "bo@rm.io");
      const [before] = await liveHuman(org.id, bo.userId);

      const res = await app.request(`/api/orgs/${org.id}/members/${bo.userId}`, {
        method: "DELETE",
        headers: authHeaders(owner),
      });
      expect(res.status).toBe(200);
      const { rowCount } = await pool.query(
        `SELECT 1 FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
        [org.id, bo.userId],
      );
      expect(rowCount).toBe(0);
      expect(await liveHuman(org.id, bo.userId)).toHaveLength(0);
      const old = (await rowsFor(org.id)).find((r) => r.id === before.id)!;
      expect(old.deactivated_at).not.toBeNull();
      expect(await orphanMembers()).toBe(0);

      await seedMember(org.id, bo.userId, "member");
      const [after] = await liveHuman(org.id, bo.userId);
      expect(after.id).not.toBe(before.id);
      expect(after.color).toBe(before.color);
    });

    it("a user rename follows into their live rows", async () => {
      const owner = await signUp("owner@rn.io");
      const orgA = await createOrg(owner, "A", "rn-a");
      const orgB = await createOrg(owner, "B", "rn-b");
      await pool.query(`UPDATE "user" SET name = 'Olive Renamed' WHERE id = $1`, [owner.userId]);
      expect((await liveHuman(orgA.id, owner.userId))[0].display_name).toBe("Olive Renamed");
      expect((await liveHuman(orgB.id, owner.userId))[0].display_name).toBe("Olive Renamed");
    });

    it("deleting a user cascades their rows and leaves others' attribution alone", async () => {
      const org = await seedOrg("Acme", "del-org");
      const vault = await seedVault(org);
      const keep = await seedUser("keep@del.io");
      const gone = await seedUser("gone@del.io");
      await seedMember(org, keep, "owner");
      await seedMember(org, gone, "member");
      const note = await seedNote(vault, null, "a.md", keep);
      await pool.query("UPDATE notes SET last_edited_by = $2 WHERE id = $1", [note, keep]);

      await pool.query(`DELETE FROM "user" WHERE id = $1`, [gone]);
      const rows = await rowsFor(org);
      expect(rows.map((r) => r.user_id)).toEqual([keep]);
      const { rows: n } = await pool.query<{ last_edited_by: string }>(
        "SELECT last_edited_by FROM notes WHERE id = $1",
        [note],
      );
      expect(n[0].last_edited_by).toBe(keep);
    });
  });

  describe("GET /api/orgs/:orgId/participants (AC4)", () => {
    it("401 without a session, 403 for a non-member", async () => {
      const owner = await signUp("owner@g1.io");
      const org = await createOrg(owner, "Acme", "g1");
      expect((await get(null, org.id)).status).toBe(401);
      const stranger = await signUp("stranger@g1.io");
      const res = await get(stranger, org.id);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "not_a_member" });
    });

    it("lists only this org's live rows, with no emails or user ids", async () => {
      const owner = await signUp("owner@g2.io", "password12345", "Olive");
      const org = await createOrg(owner, "Acme", "g2");
      const other = await createOrg(owner, "Other", "g2-other");
      const mem = await memberOf(org.id, "mem@g2.io");
      await memberOf(other.id, "elsewhere@g2.io");
      const agent = (await (
        await post(owner, org.id, { kind: "agent", displayName: "Claude", harness: "claude-code" })
      ).json()) as { id: string };
      const dead = (await (
        await post(owner, org.id, { kind: "agent", displayName: "Old", harness: "custom" })
      ).json()) as { id: string };
      expect((await patch(owner, org.id, dead.id, { deactivated: true })).status).toBe(200);

      const body = await list(mem, org.id);
      const ownerRow = (await liveHuman(org.id, owner.userId))[0];
      const memRow = (await liveHuman(org.id, mem.userId))[0];
      expect(body.self).toBe(memRow.id);
      expect(body.participants.map((p) => p.id).sort()).toEqual(
        [ownerRow.id, memRow.id, agent.id].sort(),
      );
      expect(body.participants.find((p) => p.id === ownerRow.id)).toEqual({
        id: ownerRow.id,
        kind: "human",
        displayName: "Olive",
        color: participantColor(owner.userId),
        harness: null,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      const raw = JSON.stringify(body);
      expect(raw).not.toMatch(/email|userId|user_id|@g2\.io/i);
      expect(raw).not.toContain(owner.userId);
      expect(raw).not.toContain(mem.userId);
    });

    it("self-heals a member whose row is missing (and is a no-op otherwise)", async () => {
      const owner = await signUp("owner@g3.io");
      const org = await createOrg(owner, "Acme", "g3");
      const before = (await liveHuman(org.id, owner.userId))[0];
      // Normal path: nothing inserted.
      expect((await list(owner, org.id)).self).toBe(before.id);
      expect(await rowsFor(org.id)).toHaveLength(1);

      await pool.query("DELETE FROM participants WHERE id = $1", [before.id]);
      const body = await list(owner, org.id);
      const healed = await liveHuman(org.id, owner.userId);
      expect(healed).toHaveLength(1);
      expect(body.self).toBe(healed[0].id);
      expect(healed[0].color).toBe(before.color);
    });
  });

  describe("POST /api/orgs/:orgId/participants (AC5)", () => {
    it("enforces kind, role, name, harness and name uniqueness", async () => {
      const owner = await signUp("owner@p1.io");
      const org = await createOrg(owner, "Acme", "p1");
      const mem = await memberOf(org.id, "mem@p1.io");
      const admin = await memberOf(org.id, "admin@p1.io", "admin");
      const agent = { kind: "agent", displayName: "Claude", harness: "claude-code" };

      const human = await post(owner, org.id, { ...agent, kind: "human" });
      expect(human.status).toBe(400);
      expect(await human.json()).toEqual({ error: "human_rows_are_created_on_join" });

      const denied = await post(mem, org.id, agent);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "owner_or_admin_required" });

      const created = await post(owner, org.id, { ...agent, displayName: "  Claude  " });
      expect(created.status).toBe(201);
      const row = (await created.json()) as Record<string, unknown>;
      expect(row).toMatchObject({ kind: "agent", displayName: "Claude", harness: "claude-code" });
      expect(Object.keys(row).sort()).toEqual(
        ["color", "createdAt", "displayName", "harness", "id", "kind"],
      );

      const dup = await post(admin, org.id, { ...agent, displayName: "CLAUDE" });
      expect(dup.status).toBe(409);
      expect(await dup.json()).toEqual({ error: "duplicate_agent_name" });

      for (const displayName of ["", "   ", "x".repeat(65), "bad\nname", "tab\tname", 42]) {
        const res = await post(owner, org.id, { ...agent, displayName });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_display_name" });
      }
      expect((await post(owner, org.id, { ...agent, displayName: "y".repeat(64) })).status).toBe(201);

      for (const harness of ["cursor", "", null, undefined]) {
        const res = await post(owner, org.id, { ...agent, displayName: "Codex", harness });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_harness" });
      }
      const stranger = await signUp("stranger@p1.io");
      expect((await post(stranger, org.id, agent)).status).toBe(403);
    });

    it("eight agents get eight distinct colors; a ninth reuses the least used", async () => {
      // Seed an org with no humans so only agents compete for colors.
      const owner = await signUp("owner@p2.io");
      const org = await createOrg(owner, "Acme", "p2");
      const ownerColor = (await liveHuman(org.id, owner.userId))[0].color;

      const colors: string[] = [];
      for (let i = 0; i < 7; i++) {
        const res = await post(owner, org.id, {
          kind: "agent",
          displayName: `Agent ${i}`,
          harness: "custom",
        });
        expect(res.status).toBe(201);
        colors.push(((await res.json()) as { color: string }).color);
      }
      // Owner + 7 agents: all 8 palette colors used exactly once.
      expect(new Set([ownerColor, ...colors]).size).toBe(8);
      expect(colors).not.toContain(ownerColor);
      // Least-used, ties by palette order: agents fill the palette in order,
      // skipping the owner's color.
      expect(colors).toEqual(PALETTE.filter((c) => c !== ownerColor));

      // Eighth agent: every color used once → first palette entry.
      const eighth = (await (
        await post(owner, org.id, { kind: "agent", displayName: "Agent 7", harness: "custom" })
      ).json()) as { color: string };
      expect(eighth.color).toBe(PALETTE[0]);
      // Ninth: PALETTE[0] now used twice, so the next least-used is PALETTE[1].
      const ninth = (await (
        await post(owner, org.id, { kind: "agent", displayName: "Agent 8", harness: "custom" })
      ).json()) as { color: string };
      expect(ninth.color).toBe(PALETTE[1]);
    });
  });

  describe("PATCH /api/orgs/:orgId/participants/:id (AC6)", () => {
    async function setup(slug: string) {
      const owner = await signUp(`owner@${slug}.io`);
      const org = await createOrg(owner, "Acme", slug);
      const mem = await memberOf(org.id, `mem@${slug}.io`);
      const agent = (await (
        await post(owner, org.id, { kind: "agent", displayName: "Claude", harness: "claude-code" })
      ).json()) as { id: string };
      const memRow = (await liveHuman(org.id, mem.userId))[0];
      return { owner, org, mem, agent, memRow };
    }

    it("deactivating an agent removes it from the very next GET", async () => {
      const { owner, org, agent } = await setup("pa1");
      const res = await patch(owner, org.id, agent.id, { deactivated: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; deactivatedAt: string | null };
      expect(body.id).toBe(agent.id);
      expect(body.deactivatedAt).not.toBeNull();
      expect((await list(owner, org.id)).participants.map((p) => p.id)).not.toContain(agent.id);
      // One-way and then gone: a second PATCH cannot find it.
      expect((await patch(owner, org.id, agent.id, { deactivated: true })).status).toBe(404);
      // The name is free again for a new live agent.
      expect(
        (await post(owner, org.id, { kind: "agent", displayName: "claude", harness: "custom" }))
          .status,
      ).toBe(201);
    });

    it("deactivating a human keeps the member row and attribution", async () => {
      const { owner, org, mem, memRow } = await setup("pa2");
      const vault = await seedVault(org.id);
      const note = await seedNote(vault, null, "n.md", mem.userId);
      await pool.query("UPDATE notes SET last_edited_by = $2 WHERE id = $1", [note, mem.userId]);

      expect((await patch(owner, org.id, memRow.id, { deactivated: true })).status).toBe(200);
      expect((await list(owner, org.id)).participants.map((p) => p.id)).not.toContain(memRow.id);
      const m = await pool.query(
        `SELECT 1 FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
        [org.id, mem.userId],
      );
      expect(m.rowCount).toBe(1);
      const { rows } = await pool.query<{ last_edited_by: string }>(
        "SELECT last_edited_by FROM notes WHERE id = $1",
        [note],
      );
      expect(rows[0].last_edited_by).toBe(mem.userId);
    });

    it("a roster read never resurrects a deactivated human (one-way until Phase 3)", async () => {
      const { owner, org, mem, memRow } = await setup("pa7");
      expect((await patch(owner, org.id, memRow.id, { deactivated: true })).status).toBe(200);

      // The deactivated member is still a member, so the GET passes the
      // membership check and reaches the self-heal — which must not insert a
      // second, live row beside the deactivated one.
      const body = await list(mem, org.id);
      expect(body.self).toBeNull();
      expect(body.participants.map((p) => p.id)).not.toContain(memRow.id);
      expect(await liveHuman(org.id, mem.userId)).toHaveLength(0);
      const rows = (await rowsFor(org.id)).filter((r) => r.user_id === mem.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].deactivated_at).not.toBeNull();

      // Same through the helper itself, and it stays a no-op on repeat.
      expect(await ensureHumanParticipant(org.id, mem.userId)).toBeNull();
      expect((await rowsFor(org.id)).filter((r) => r.user_id === mem.userId)).toHaveLength(1);
      // The owner's own live row is untouched by any of this.
      expect((await list(owner, org.id)).self).not.toBeNull();
    });

    it("refuses re-activation, color changes and human renames", async () => {
      const { owner, org, agent, memRow } = await setup("pa3");
      const cases: Array<[unknown, string]> = [
        [{ deactivated: false }, "reactivation_unsupported"],
        [{ deactivatedAt: null }, "reactivation_unsupported"],
        [{ color: "#2981fb" }, "color_immutable"],
        [{ displayName: "X", color: "#2981fb" }, "color_immutable"],
        [{}, "invalid_body"],
      ];
      for (const [body, error] of cases) {
        const res = await patch(owner, org.id, agent.id, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toEqual({ error });
      }
      const human = await patch(owner, org.id, memRow.id, { displayName: "Someone Else" });
      expect(human.status).toBe(400);
      expect(await human.json()).toEqual({ error: "human_name_follows_account" });
    });

    it("renames an agent, 409 on a taken name, 400 on an invalid one", async () => {
      const { owner, org, agent } = await setup("pa4");
      await post(owner, org.id, { kind: "agent", displayName: "Codex", harness: "codex-cli" });

      const ok = await patch(owner, org.id, agent.id, { displayName: "Claude 2" });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { displayName: string }).displayName).toBe("Claude 2");
      const taken = await patch(owner, org.id, agent.id, { displayName: "codex" });
      expect(taken.status).toBe(409);
      expect(await taken.json()).toEqual({ error: "duplicate_agent_name" });
      expect((await patch(owner, org.id, agent.id, { displayName: "" })).status).toBe(400);
      // Renaming to its own name in another case is not a collision with itself.
      expect((await patch(owner, org.id, agent.id, { displayName: "CLAUDE 2" })).status).toBe(200);
    });

    it("only a human deactivation announces an ACL change (every vault of the org); agent edits and refusals announce none", async () => {
      const { owner, org, agent, memRow } = await setup("pa6");
      const v1 = await seedVault(org.id, "One");
      const v2 = await seedVault(org.id, "Two");
      const other = await createOrg(owner, "Other", "pa6-other");
      await seedVault(other.id, "Elsewhere");

      rec.reset();
      expect((await patch(owner, org.id, memRow.id, { displayName: "No" })).status).toBe(400);
      expect((await patch(owner, org.id, agent.id, { deactivated: false })).status).toBe(400);
      expect(rec.aclBroadcasts).toEqual([]);

      expect((await patch(owner, org.id, memRow.id, { deactivated: true })).status).toBe(200);
      expect([...rec.aclBroadcasts].sort()).toEqual([v1, v2].sort());

      // Agent rows have no presence in Phase 1: renaming or deactivating one must
      // not make every connected member re-mint their open note.
      rec.reset();
      expect((await patch(owner, org.id, agent.id, { displayName: "Claude 3" })).status).toBe(200);
      expect(rec.aclBroadcasts).toEqual([]);
      expect((await patch(owner, org.id, agent.id, { deactivated: true })).status).toBe(200);
      expect(rec.aclBroadcasts).toEqual([]);
    });

    it("404 for an unknown or cross-org id, 403 for a non-admin", async () => {
      const { owner, org, mem, agent } = await setup("pa5");
      const otherOrg = await createOrg(owner, "Other", "pa5-other");
      const foreign = (await (
        await post(owner, otherOrg.id, { kind: "agent", displayName: "Gemini", harness: "gemini-cli" })
      ).json()) as { id: string };

      expect((await patch(owner, org.id, "no-such-id", { deactivated: true })).status).toBe(404);
      expect((await patch(owner, org.id, foreign.id, { deactivated: true })).status).toBe(404);
      // The foreign row is untouched.
      expect((await list(owner, otherOrg.id)).participants.map((p) => p.id)).toContain(foreign.id);

      const denied = await patch(mem, org.id, agent.id, { deactivated: true });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "owner_or_admin_required" });
    });
  });
});
