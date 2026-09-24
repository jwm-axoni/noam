import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createMcpAudit, pruneMcpAudit } from "../src/audit/mcp-audit.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import {
  seedAgentParticipant,
  seedMember,
  seedOrg,
  seedUser,
  seedVault,
} from "./helpers/seed.js";
import { createAgentToken, createMcpToken } from "../src/mcp/tokens.js";
import { expandPreset } from "../src/permissions/token-scope.js";

/**
 * ADR 0003 item 4: every tools/call leaves exactly one `mcp_audit` row, written
 * by the protocol layer (never by a tool), attributed from the token.
 */

const audit = createMcpAudit();
const rec = recordingAppDeps({ mcpAudit: audit });
const app = createApp(rec.deps);

let rpcId = 0;
async function rpc(token: string, method: string, params?: unknown) {
  const res = await app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }),
  );
  return (await res.json()) as any;
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  return {
    isError: body.result?.isError ?? false,
    data: body.result?.structuredContent as any,
    text: (body.result?.content?.[0]?.text ?? "") as string,
  };
}

interface AuditRow {
  token_id: string | null;
  participant_id: string | null;
  user_id: string;
  organization_id: string;
  tool: string;
  doc_id: string | null;
  outcome: string;
  bytes_out: number;
}

async function auditRows(): Promise<AuditRow[]> {
  const { rows } = await pool.query<AuditRow>(
    `SELECT token_id, participant_id, user_id, organization_id, tool, doc_id, outcome, bytes_out
       FROM mcp_audit ORDER BY id`,
  );
  return rows;
}

async function humanParticipant(orgId: string, userId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM participants WHERE organization_id = $1 AND user_id = $2 AND kind = 'human'",
    [orgId, userId],
  );
  return rows[0].id;
}

async function ownerFixture(slug: string) {
  const owner = await seedUser(`owner@${slug}.com`);
  const org = await seedOrg("Acme", slug);
  await seedMember(org, owner, "owner");
  const vault = await seedVault(org);
  const { token, row } = await createMcpToken({ userId: owner, organizationId: org }, "test");
  return { owner, org, vault, token, tokenId: row.id, participant: await humanParticipant(org, owner) };
}

describe("MCP audit log", () => {
  beforeEach(async () => {
    await resetDb();
    // resetDb's TRUNCATE list predates mcp_audit (which has no FKs to cascade from).
    await pool.query("DELETE FROM mcp_audit");
    rec.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("every tool call writes exactly one row, attributed from the token", async () => {
    const f = await ownerFixture("audit-all");
    const expected: Array<Pick<AuditRow, "tool" | "doc_id" | "outcome">> = [];
    const expectOk = async (tool: string, args: Record<string, unknown>, docId: string | null) => {
      const res = await call(f.token, tool, args);
      expect(res.isError, `${tool}: ${res.text}`).toBe(false);
      expected.push({ tool, doc_id: docId, outcome: "ok" });
      expect(await auditRows(), tool).toHaveLength(expected.length);
      return res;
    };

    await expectOk("list_vaults", {}, null);
    await expectOk("list_folders", { vaultId: f.vault }, null);
    const created = await expectOk(
      "create_note",
      { vaultId: f.vault, relPath: "a.md", content: "hello wörld" },
      null,
    );
    const docId = created.data.docId as string;
    await expectOk("list_notes", { vaultId: f.vault }, null);
    await expectOk("read_note", { docId }, docId);
    await expectOk("search_notes", { vaultId: f.vault, query: "hello" }, null);
    await expectOk("query_knowledge", { vaultId: f.vault, consistency: "allow-stale" }, null);
    await expectOk("update_note", { docId, content: "replaced" }, docId);
    await expectOk("delete_note", { docId }, docId);

    const rows = await auditRows();
    expect(rows.map((r) => ({ tool: r.tool, doc_id: r.doc_id, outcome: r.outcome }))).toEqual(
      expected,
    );
    for (const r of rows) {
      expect(r).toMatchObject({
        token_id: f.tokenId,
        participant_id: f.participant,
        user_id: f.owner,
        organization_id: f.org,
      });
    }
  });

  it("read_note bytes_out is the utf8 length of the returned text", async () => {
    const f = await ownerFixture("audit-bytes");
    const created = await call(f.token, "create_note", {
      vaultId: f.vault,
      relPath: "b.md",
      content: "ünïcödé — ✓",
    });
    await pool.query("DELETE FROM mcp_audit");
    const read = await call(f.token, "read_note", { docId: created.data.docId });
    expect(read.isError).toBe(false);
    const [row] = await auditRows();
    expect(row.bytes_out).toBeGreaterThan(0);
    expect(row.bytes_out).toBe(Buffer.byteLength(read.text, "utf8"));
    expect(row.bytes_out).toBeGreaterThan(read.text.length); // multi-byte chars counted as bytes
  });

  it("an agent token's rows name the agent participant and the minting user", async () => {
    const f = await ownerFixture("audit-agent");
    const agent = await seedAgentParticipant(f.org, "Scribe", f.owner);
    const { token, row } = await createAgentToken({
      organizationId: f.org,
      mintedBy: f.owner,
      participantId: agent,
      name: "agent",
      scopes: expandPreset("reader", f.org),
    });
    expect((await call(token, "list_vaults")).isError).toBe(false);
    expect(await auditRows()).toEqual([
      {
        token_id: row.id,
        participant_id: agent,
        user_id: f.owner,
        organization_id: f.org,
        tool: "list_vaults",
        doc_id: null,
        outcome: "ok",
        bytes_out: expect.any(Number),
      },
    ]);
  });

  it("a permission refusal is 'denied'; an unknown note is 'error'", async () => {
    const f = await ownerFixture("audit-deny");
    const member = await seedUser("member@audit-deny.com");
    await seedMember(f.org, member, "member");
    const { token: memberToken } = await createMcpToken(
      { userId: member, organizationId: f.org },
      "m",
    );
    const created = await call(f.token, "create_note", {
      vaultId: f.vault,
      relPath: "secret.md",
      content: "secret",
    });
    const docId = created.data.docId as string;
    await pool.query("DELETE FROM mcp_audit");

    const denied = await call(memberToken, "read_note", { docId });
    expect(denied.isError).toBe(true);
    const missing = await call(f.token, "read_note", { docId: "no-such-note" });
    expect(missing.isError).toBe(true);

    const rows = await auditRows();
    expect(rows.map((r) => [r.user_id, r.tool, r.doc_id, r.outcome, r.bytes_out])).toEqual([
      [member, "read_note", docId, "denied", 0],
      [f.owner, "read_note", "no-such-note", "error", 0],
    ]);
  });

  it("initialize and tools/list are not audited; an unknown tool is, as 'error'", async () => {
    const f = await ownerFixture("audit-proto");
    await rpc(f.token, "initialize", {});
    await rpc(f.token, "tools/list");
    await rpc(f.token, "ping");
    expect(await auditRows()).toEqual([]);

    const unknown = await call(f.token, "drop_all_tables", { docId: "d1" });
    expect(unknown.isError).toBe(true);
    expect(await auditRows()).toEqual([
      expect.objectContaining({ tool: "drop_all_tables", outcome: "error", doc_id: "d1" }),
    ]);
  });

  it("pruneMcpAudit drops rows past retention and keeps the rest", async () => {
    await pool.query(
      `INSERT INTO mcp_audit (user_id, organization_id, tool, outcome, at) VALUES
         ('u', 'o', 'old', 'ok', now() - interval '181 days'),
         ('u', 'o', 'kept', 'ok', now() - interval '179 days')`,
    );
    expect(await pruneMcpAudit(pool, 180)).toBe(1);
    const { rows } = await pool.query<{ tool: string }>("SELECT tool FROM mcp_audit");
    expect(rows.map((r) => r.tool)).toEqual(["kept"]);
  });

  it("record prunes lazily: on the first record, then at most once per interval", async () => {
    let clock = new Date("2026-01-01T00:00:00Z").getTime();
    const sink = createMcpAudit({ retentionDays: 180, now: () => new Date(clock) });
    const auth = { userId: "u", organizationId: "o", kind: "user" as const, participantId: null };
    const seedOld = () =>
      pool.query(
        `INSERT INTO mcp_audit (user_id, organization_id, tool, outcome, at)
         VALUES ('u', 'o', 'old', 'ok', now() - interval '181 days')`,
      );
    const oldCount = async () =>
      (await pool.query("SELECT 1 FROM mcp_audit WHERE tool = 'old'")).rowCount;
    const rec1 = { auth, tool: "list_vaults", docId: null, outcome: "ok" as const, bytesOut: 1 };

    await seedOld();
    await sink.record(rec1); // first record → prunes
    expect(await oldCount()).toBe(0);

    await seedOld();
    clock += 30 * 60 * 1000; // +30 min: throttled
    await sink.record(rec1);
    expect(await oldCount()).toBe(1);

    clock += 31 * 60 * 1000; // +61 min since the last prune
    await sink.record(rec1);
    expect(await oldCount()).toBe(0);
    // The records themselves were all kept.
    expect((await pool.query("SELECT 1 FROM mcp_audit WHERE tool = 'list_vaults'")).rowCount).toBe(3);
  });

  it("record never throws, even when the insert fails", async () => {
    const broken = createMcpAudit({
      db: { query: async () => Promise.reject(new Error("db down")) } as never,
    });
    await expect(
      broken.record({
        auth: { userId: "u", organizationId: "o", kind: "user", participantId: null },
        tool: "read_note",
        docId: null,
        outcome: "ok",
        bytesOut: 0,
      }),
    ).resolves.toBeUndefined();
  });
});
