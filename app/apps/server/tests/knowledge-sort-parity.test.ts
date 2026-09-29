import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { pool, resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";
import { backfillIndex, indexDoc } from "../src/index/indexer.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import {
  createKnowledgeQuery,
  KnowledgeQueryError,
  type KnowledgeQuery,
} from "../src/knowledge/query.js";
import { parseKnowledgeArgs } from "../src/mcp/tools.js";
import { compareSorted, parseTimestamp, systemRange } from "../src/knowledge/system.js";

/**
 * The same fixture the desktop's Rust replays
 * (`src-tauri/tests/knowledge_sort_parity.rs`): same notes + same query ⇒ the
 * same ordered doc ids on both sides.
 */
interface Fixture {
  notes: Array<{
    docId: string;
    path: string;
    markdown: string;
    serverCreatedAt: string;
    modified: number;
  }>;
  cases: Array<{ name: string; query: Omit<KnowledgeQuery, "page">; expected: string[] }>;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../packages/contracts/fixtures/knowledge-sort-parity.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

async function put(docId: string, markdown: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, markdown);
  await appendUpdate(docId, Y.encodeStateAsUpdate(doc));
  doc.destroy();
  await indexDoc(docId);
}

async function seedFixture() {
  const org = await seedOrg("Parity", `parity-${crypto.randomUUID()}`);
  const user = await seedUser(`parity-${crypto.randomUUID()}@example.com`);
  await seedMember(org, user, "owner");
  const vault = await seedVault(org);
  for (const note of fixture.notes) {
    await seedNote(vault, null, note.path, user, note.docId);
    await pool.query(
      "UPDATE notes SET created_at = $2, last_edited_at = to_timestamp($3::double precision / 1000) WHERE id = $1",
      [note.docId, note.serverCreatedAt, note.modified],
    );
    await put(note.docId, note.markdown);
  }
  const ids = new Set(fixture.notes.map((note) => note.docId));
  const run = createKnowledgeQuery(
    { actorId: user, vaultId: vault },
    { readableDocs: async () => new Set(ids) },
  );
  return { run, vault, user };
}

async function allIds(
  run: (query: KnowledgeQuery) => Promise<{ items: Array<{ docId: string }>; nextCursor: string | null }>,
  query: Omit<KnowledgeQuery, "page">,
): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await run({ ...query, page: { limit: 2, ...(cursor ? { cursor } : {}) } });
    out.push(...page.items.map((item) => item.docId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

afterAll(async () => {
  await pool.end();
});

describe("query_knowledge sort parity with the desktop", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("orders the shared fixture exactly like the desktop index", async () => {
    const { run } = await seedFixture();
    for (const testCase of fixture.cases) {
      expect(await allIds(run, testCase.query), testCase.name).toEqual(testCase.expected);
    }
  });

  it("reports created (frontmatter beats the server row) and modified on evidence", async () => {
    const { run } = await seedFixture();
    const page = await run({ sort: { key: "created", direction: "asc" }, page: { limit: 50 } });
    const byId = new Map(page.items.map((item) => [item.docId, item]));
    expect(byId.get("n4")).toMatchObject({
      created: "2026-01-05T00:00:00.000Z",
      createdSource: "frontmatter",
      modified: new Date(1788300000000).toISOString(),
    });
    // `created: someday` does not parse, so the server's row answers.
    expect(byId.get("n5")).toMatchObject({
      created: "2025-12-31T23:59:59.999Z",
      createdSource: "server",
    });
    expect(page.count).toBe(6);
  });

  it("binds a cursor to its sort", async () => {
    const { run } = await seedFixture();
    const first = await run({ sort: { key: "created", direction: "asc" }, page: { limit: 2 } });
    expect(first.nextCursor).toBeTruthy();
    for (const sort of [
      { key: "created", direction: "desc" },
      { key: "name", direction: "asc" },
      undefined,
    ] as const) {
      await expect(run({
        ...(sort ? { sort } : {}),
        page: { limit: 2, cursor: first.nextCursor! },
      })).rejects.toMatchObject({ code: "cursor_expired" });
    }
    const second = await run({
      sort: { key: "created", direction: "asc" },
      page: { limit: 2, cursor: first.nextCursor! },
    });
    expect(second.items.map((item) => item.docId)).toEqual(["n2", "n6"]);
  });

  it("refuses contains and non-temporal values on system properties", async () => {
    const { run } = await seedFixture();
    for (const predicate of [
      { propertyId: "created", op: "contains", value: "2026" },
      { propertyId: "modified", op: "gt", value: "not a date" },
      { propertyId: "created", op: "eq", value: true },
    ] as const) {
      const error = await run({ where: [predicate] }).catch((reason) => reason);
      expect(error).toBeInstanceOf(KnowledgeQueryError);
      expect(error.code).toBe("schema_invalid");
    }
  });

  it("backfills frontmatter created for rows indexed before the column existed", async () => {
    const { run } = await seedFixture();
    await pool.query(
      "UPDATE note_knowledge_state SET frontmatter_created_ms = NULL, system_projection = 0 WHERE doc_id = 'n4'",
    );
    const stale = await run({ where: [{ propertyId: "created", op: "lt", value: "2026-02-01" }] });
    expect(stale.items.map((item) => item.docId)).toEqual(["n5"]);
    expect(await backfillIndex()).toBeGreaterThanOrEqual(1);
    const fixed = await run({ where: [{ propertyId: "created", op: "lt", value: "2026-02-01" }] });
    expect(fixed.items.map((item) => item.docId)).toEqual(["n4", "n5"]);
  });

  it("indexes the seeded `type` default as a label unless the catalog claims the key", async () => {
    const { vault } = await seedFixture();
    const labels = async () => (await pool.query(
      "SELECT property_id, label FROM note_labels WHERE doc_id = 'n4' ORDER BY 1",
    )).rows;
    expect(await labels()).toEqual([{ property_id: "type", label: "meeting" }]);

    const catalogId = await seedNote(vault, null, "_Noam/Knowledge schema.md");
    await put(catalogId, `---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

\`\`\`json
${JSON.stringify({
  version: 1,
  properties: [{ id: "kind", key: "type", name: "Kind", type: { kind: "text", cardinality: "one" } }],
  labels: [],
  relationships: [],
})}
\`\`\``);
    await indexDoc("n4");
    expect(await labels()).toEqual([]);
    const { rows } = await pool.query(
      "SELECT property_id FROM note_property_values WHERE doc_id = 'n4' AND text_value = 'meeting'",
    );
    expect(rows).toEqual([{ property_id: "kind" }]);
  });
});

describe("system property primitives", () => {
  it("parses the shared timestamp grammar", () => {
    expect(parseTimestamp("1970-01-01")).toEqual({ ms: 0, dateOnly: true });
    expect(parseTimestamp("2026-09-01")?.ms).toBe(1_788_220_800_000);
    expect(parseTimestamp("2026-09-01 10:30:15.1239Z")?.ms).toBe(1_788_220_800_000 + 37_815_123);
    expect(parseTimestamp("2026-09-01T12:30:00+02:00")?.ms)
      .toBe(parseTimestamp("2026-09-01T10:30:00Z")?.ms);
    expect(parseTimestamp("2026-09-01T05:30:00-0500")?.ms)
      .toBe(parseTimestamp("2026-09-01T10:30:00Z")?.ms);
    expect(parseTimestamp("2024-02-29")?.ms).toBe(1_709_164_800_000);
    expect(parseTimestamp("1969-12-31")?.ms).toBe(-86_400_000);
    for (const bad of [
      "", "2026", "2026-9-01", "2026-13-01", "2026-02-30", "2025-02-29",
      "2026-09-01T25:00", "2026-09-01T10:60", "2026-09-01T10:00:60",
      "2026-09-01T10", "2026-09-01T10:00:00.", "2026-09-01T10:00Zjunk",
      "2026-09-01T10:00+2", "2026-09-01t10:00", "yesterday", "2026-09-01x",
    ]) {
      expect(parseTimestamp(bad), bad).toBeNull();
    }
  });

  it("treats a date-only predicate as the whole UTC day", () => {
    const day = parseTimestamp("2026-09-01")!.ms;
    expect(systemRange("eq", "2026-09-01")).toEqual({ lo: day, hi: day + 86_400_000 });
    expect(systemRange("lte", "2026-09-01")).toEqual({ lo: null, hi: day + 86_400_000 });
    expect(systemRange("gt", 5)).toEqual({ lo: 6, hi: null });
    expect(systemRange("contains", "2026-09-01")).toBeNull();
  });

  it("puts missing values last in both directions and breaks ties by doc id", () => {
    const rows = [
      { key: null, docId: "a" },
      { key: { t: "n", v: 2 } as const, docId: "c" },
      { key: { t: "n", v: 2 } as const, docId: "b" },
      { key: { t: "s", v: "x" } as const, docId: "d" },
    ];
    const order = (direction: "asc" | "desc") =>
      [...rows].sort((a, b) => compareSorted(a, b, direction)).map((row) => row.docId);
    expect(order("asc")).toEqual(["b", "c", "d", "a"]);
    expect(order("desc")).toEqual(["d", "b", "c", "a"]);
  });

  it("parses the MCP sort argument", () => {
    expect(parseKnowledgeArgs({ vaultId: "v", sort: { key: "created" } }).query.sort)
      .toEqual({ key: "created", direction: "asc" });
    expect(parseKnowledgeArgs({
      vaultId: "v",
      sort: { key: { propertyId: "priority" }, direction: "desc" },
    }).query.sort).toEqual({ key: { propertyId: "priority" }, direction: "desc" });
    expect(() => parseKnowledgeArgs({ vaultId: "v", sort: { key: "title" } })).toThrow(/sort.key/);
    expect(() => parseKnowledgeArgs({ vaultId: "v", sort: { key: "name", direction: "up" } }))
      .toThrow(/direction/);
  });
});
