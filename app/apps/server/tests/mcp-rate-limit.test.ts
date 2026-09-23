import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createMcpAudit } from "../src/audit/mcp-audit.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { seedMember, seedOrg, seedUser, seedVault } from "./helpers/seed.js";
import { createMcpToken } from "../src/mcp/tokens.js";

/**
 * ADR 0003 item 6: `read_note` and `search_notes` share a per-token budget
 * (calls per minute, bytes per hour), answered from `mcp_audit`. A refused call
 * does no work, returns a structured `rate_limited` error, and is audited
 * without counting against the budget.
 */

const BYTES_PER_HOUR = 2_000;
const rec = recordingAppDeps({
  mcpAudit: createMcpAudit({ callsPerMinute: 3, bytesPerHour: BYTES_PER_HOUR }),
});
const app = createApp(rec.deps);

let rpcId = 0;
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const body = (await res.json()) as any;
  return {
    isError: body.result?.isError ?? false,
    data: body.result?.structuredContent as any,
    text: (body.result?.content?.[0]?.text ?? "") as string,
  };
}

async function fixture(slug: string, content = "hello") {
  const owner = await seedUser(`owner@${slug}.com`);
  const org = await seedOrg("Acme", slug);
  await seedMember(org, owner, "owner");
  const vault = await seedVault(org);
  const { token, row } = await createMcpToken({ userId: owner, organizationId: org }, "t");
  const created = await call(token, "create_note", { vaultId: vault, relPath: "n.md", content });
  expect(created.isError).toBe(false);
  return { owner, org, vault, token, tokenId: row.id, docId: created.data.docId as string };
}

async function outcomes(tokenId: string): Promise<string[]> {
  const { rows } = await pool.query<{ tool: string; outcome: string }>(
    "SELECT tool, outcome FROM mcp_audit WHERE token_id = $1 ORDER BY id",
    [tokenId],
  );
  return rows.map((r) => `${r.tool}:${r.outcome}`);
}

describe("MCP read budget", () => {
  beforeEach(async () => {
    await resetDb();
    await pool.query("DELETE FROM mcp_audit");
    rec.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("the 4th read in a minute is refused with a structured calls_per_minute error", async () => {
    const f = await fixture("rl-calls");
    const before = Date.now();
    for (let i = 0; i < 3; i++) {
      expect((await call(f.token, "read_note", { docId: f.docId })).isError).toBe(false);
    }
    const refused = await call(f.token, "read_note", { docId: f.docId });
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({
      error: "rate_limited",
      budget: "calls_per_minute",
      limit: 3,
      used: 3,
    });
    const reset = Date.parse(refused.data.resetAt);
    expect(Number.isNaN(reset)).toBe(false);
    // Oldest counted call + 60 s: after now, and no more than ~60 s away.
    expect(reset).toBeGreaterThan(Date.now());
    expect(reset).toBeLessThanOrEqual(before + 60_000 + 2_000);
    expect(refused.text).toMatch(/calls_per_minute/);
    expect(refused.text).toContain(refused.data.resetAt);
    expect(refused.text).not.toContain("\n");

    // search_notes draws on the same budget.
    const search = await call(f.token, "search_notes", { vaultId: f.vault, query: "hello" });
    expect(search.data).toMatchObject({ error: "rate_limited", budget: "calls_per_minute" });

    // A non-read tool is not budgeted.
    const list = await call(f.token, "list_notes", { vaultId: f.vault });
    expect(list.isError).toBe(false);

    expect(await outcomes(f.tokenId)).toEqual([
      "create_note:ok",
      "read_note:ok",
      "read_note:ok",
      "read_note:ok",
      "read_note:rate_limited",
      "search_notes:rate_limited",
      "list_notes:ok",
    ]);
  });

  it("refused calls don't count: once the counted calls age out, reads succeed again", async () => {
    const f = await fixture("rl-window");
    for (let i = 0; i < 3; i++) await call(f.token, "read_note", { docId: f.docId });
    // Hammer the closed budget; these are audited but must not extend it.
    for (let i = 0; i < 5; i++) {
      expect((await call(f.token, "read_note", { docId: f.docId })).isError).toBe(true);
    }
    // Age the COUNTED calls out of the minute (not the refusals) instead of sleeping.
    await pool.query(
      `UPDATE mcp_audit SET at = at - interval '61 seconds'
        WHERE token_id = $1 AND outcome = 'ok'`,
      [f.tokenId],
    );
    const again = await call(f.token, "read_note", { docId: f.docId });
    expect(again.isError).toBe(false);
    expect(again.data.content).toBe("hello");
  });

  it("the budget is per token: another token of the same user is unaffected", async () => {
    const f = await fixture("rl-per-token");
    for (let i = 0; i < 3; i++) await call(f.token, "read_note", { docId: f.docId });
    expect((await call(f.token, "read_note", { docId: f.docId })).isError).toBe(true);
    const { token: other } = await createMcpToken({ userId: f.owner, organizationId: f.org }, "u");
    expect((await call(other, "read_note", { docId: f.docId })).isError).toBe(false);
  });

  it("reads past bytes_per_hour are refused with budget 'bytes_per_hour'", async () => {
    const f = await fixture("rl-bytes", "x".repeat(900));
    // Two reads (each > 900 bytes of JSON) push the hour past 2000 bytes; stay
    // under the per-minute cap by ageing each call out of the minute window.
    for (let i = 0; i < 3; i++) {
      const r = await call(f.token, "read_note", { docId: f.docId });
      if (r.isError) break;
      await pool.query(
        `UPDATE mcp_audit SET at = at - interval '2 minutes' WHERE token_id = $1`,
        [f.tokenId],
      );
    }
    const { rows } = await pool.query<{ total: string }>(
      "SELECT sum(bytes_out) AS total FROM mcp_audit WHERE token_id = $1 AND tool = 'read_note'",
      [f.tokenId],
    );
    expect(Number(rows[0].total)).toBeGreaterThanOrEqual(BYTES_PER_HOUR);

    const refused = await call(f.token, "read_note", { docId: f.docId });
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({
      error: "rate_limited",
      budget: "bytes_per_hour",
      limit: BYTES_PER_HOUR,
      used: Number(rows[0].total),
    });
    const reset = Date.parse(refused.data.resetAt);
    expect(reset).toBeGreaterThan(Date.now());
    expect(reset).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect((await outcomes(f.tokenId)).at(-1)).toBe("read_note:rate_limited");
  });

  it("parallel reads cannot outrun the budget: 6 concurrent calls → exactly 3 ok, 3 refused", async () => {
    // PR #16 round 2, findings 2 + 5: check → run → record used to interleave,
    // so every concurrent read saw the same pre-call count and all passed.
    const f = await fixture("rl-parallel");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => call(f.token, "read_note", { docId: f.docId })),
    );
    const ok = results.filter((r) => !r.isError);
    const refused = results.filter((r) => r.isError);
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r.data?.budget).toBe("calls_per_minute");

    const rows = await outcomes(f.tokenId);
    expect(rows.filter((r) => r === "read_note:ok")).toHaveLength(3);
    expect(rows.filter((r) => r === "read_note:rate_limited")).toHaveLength(3);
  });

});
