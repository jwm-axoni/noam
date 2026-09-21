import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { pool, resetDb } from "./helpers/db.js";
import {
  seedDeny,
  seedMember,
  seedOrg,
  seedShare,
  seedUser,
  seedVault,
  seedVaultGrant,
  seedNote,
  seedFolder,
} from "./helpers/seed.js";
import {
  backfillIndex,
  CATALOG_REPROJECTION_RETRY_DELAYS_MS,
  indexDoc,
  markKnowledgeCatalogStaleForVault,
  markKnowledgeIndexStale,
  purgeNoteIndex,
  reprojectKnowledgeCatalogForVault,
  scheduleIndex,
  scheduleKnowledgeCatalogReprojection,
} from "../src/index/indexer.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import { moveFolder, moveNote } from "../src/registry/tree-ops.js";
import {
  createKnowledgeQuery,
  KnowledgeQueryError,
} from "../src/knowledge/query.js";

async function put(docId: string, markdown: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, markdown);
  await appendUpdate(docId, Y.encodeStateAsUpdate(doc));
  doc.destroy();
  await indexDoc(docId);
}

async function openVault(name: string) {
  const org = await seedOrg(name, `${name.toLowerCase()}-${crypto.randomUUID()}`);
  const user = await seedUser(`${name.toLowerCase()}@example.com`);
  await seedMember(org, user, "member");
  const vault = await seedVault(org);
  await seedVaultGrant(org, "view");
  return { org, user, vault };
}

async function rows(table: string): Promise<unknown[]> {
  const result = await pool.query(`SELECT * FROM ${table} ORDER BY 1, 2, 3`);
  return result.rows;
}

const catalogMarkdown = `---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

\`\`\`json
${JSON.stringify({
  version: 1,
  properties: [
    { id: "workflow", key: "project_status", name: "Status", type: { kind: "text", cardinality: "one" } },
  ],
  labels: [],
  relationships: [],
})}
\`\`\``;

async function propertyIds(docId: string): Promise<string[]> {
  return pool.query<{ property_id: string }>(
    "SELECT property_id FROM note_property_values WHERE doc_id = $1 ORDER BY property_id",
    [docId],
  ).then((result) => result.rows.map((row) => row.property_id));
}

async function expectProjectionMatchesRebuild(docIds: string[]): Promise<void> {
  const tables = [
    "note_knowledge_identities",
    "note_property_values",
    "note_labels",
    "note_relationships",
  ];
  const incremental = Object.fromEntries(
    await Promise.all(tables.map(async (table) => [table, await rows(table)])),
  );
  await purgeNoteIndex(docIds);
  await backfillIndex();
  const rebuilt = Object.fromEntries(
    await Promise.all(tables.map(async (table) => [table, await rows(table)])),
  );
  expect(rebuilt).toEqual(incremental);
}

async function waitForCurrent(docIds: string[], timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ id: string; state: string | null }>(
      `SELECT n.id, ks.state FROM notes n
       LEFT JOIN note_knowledge_state ks ON ks.doc_id = n.id
       WHERE n.id = ANY($1::text[])`,
      [docIds],
    );
    if (result.rows.length === docIds.length && result.rows.every((row) => row.state === "current")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`knowledge projections did not become current: ${docIds.join(", ")}`);
}

function failCatalogReprojectionQueries(failures: number, afterCommit = false) {
  let active = !afterCommit;
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (...args: any[]) => {
          const result = await (client.query as any).apply(client, args);
          if (args[0] === "COMMIT") active = true;
          return result;
        },
        release: () => client.release(),
      };
    },
    query: (...args: any[]) => {
      if (
        active && failures > 0 &&
        String(args[0]).includes("ORDER BY CASE WHEN n.rel_path")
      ) {
        failures--;
        return Promise.reject(new Error("reprojection unavailable"));
      }
      return (pool.query as any).apply(pool, args);
    },
  };
}

function failCatalogReprojectionAfterCommit(failures: number) {
  return failCatalogReprojectionQueries(failures, true);
}

function failDocIndexAttempts(docId: string, failures: number) {
  const calls = new Map<string, number>();
  return {
    calls,
    db: {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (...args: any[]) => {
            const sql = String(args[0]);
            const indexedDocId = args[1]?.[0];
            if (sql.includes("SELECT vault_id, title, rel_path FROM notes") && indexedDocId) {
              calls.set(indexedDocId, (calls.get(indexedDocId) ?? 0) + 1);
              if (indexedDocId === docId && failures > 0) {
                failures--;
                throw new Error("peer reprojection unavailable");
              }
            }
            return (client.query as any).apply(client, args);
          },
          release: () => client.release(),
        };
      },
      query: (...args: any[]) => (pool.query as any).apply(pool, args),
    },
  };
}

describe("note knowledge index and bounded query", () => {
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it("normalizes typed properties, labels, tags, identities and outgoing relationships", async () => {
    const { vault } = await openVault("Projection");
    const doc = await seedNote(vault, null, "A.md");
    await put(doc, `---
noam_document_id: identity-a
status: Active
priority: 3
done: false
literal: "false"
due: 2026-09-19
tags: [alpha, "#beta"]
labels:
  - work
noam_relationships: ["owner:identity-b", "depends-on:identity-c"]
---
Body`);

    const properties = await pool.query<{
      property_id: string;
      value_type: string;
      text_value: string;
    }>(
      `SELECT property_id, value_type, text_value FROM note_property_values
        WHERE doc_id = $1 ORDER BY property_id, value_order`,
      [doc],
    );
    expect(properties.rows).toEqual([
      { property_id: "done", value_type: "boolean", text_value: "false" },
      { property_id: "due", value_type: "date", text_value: "2026-09-19" },
      { property_id: "labels", value_type: "text", text_value: "work" },
      { property_id: "literal", value_type: "text", text_value: "false" },
      { property_id: "priority", value_type: "number", text_value: "3" },
      { property_id: "status", value_type: "text", text_value: "Active" },
      { property_id: "tags", value_type: "text", text_value: "alpha" },
      { property_id: "tags", value_type: "text", text_value: "#beta" },
    ]);
    await expect(
      pool.query(
        `SELECT property_id, label, kind FROM note_labels
          WHERE doc_id = $1 ORDER BY property_id, label`,
        [doc],
      ).then((result) => result.rows),
    ).resolves.toEqual([
      { property_id: "labels", label: "work", kind: "label" },
      { property_id: "tags", label: "alpha", kind: "tag" },
      { property_id: "tags", label: "beta", kind: "tag" },
    ]);
    await expect(
      pool.query(
        `SELECT relationship_id, target_document_id FROM note_relationships
          WHERE from_doc = $1 ORDER BY value_order`,
        [doc],
      ).then((result) => result.rows),
    ).resolves.toEqual([
      { relationship_id: "owner", target_document_id: "identity-b" },
      { relationship_id: "depends-on", target_document_id: "identity-c" },
    ]);
    await expect(
      pool.query("SELECT document_id FROM note_knowledge_identities WHERE doc_id = $1", [doc])
        .then((result) => result.rows[0]?.document_id),
    ).resolves.toBe("identity-a");
  });

  it("uses catalog property ids and types while preserving unknown keys", async () => {
    const { vault } = await openVault("Catalog");
    const schema = await seedNote(vault, null, "_Noam/Knowledge schema.md");
    const note = await seedNote(vault, null, "Catalogued.md");
    await put(note, `---
project_status: in_progress
topic_names: [planning, unknown]
legacy_key: kept
---`);
    await put(schema, `---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

\`\`\`json
${JSON.stringify({
  version: 1,
  properties: [
    { id: "workflow", key: "project_status", name: "Status", type: { kind: "label", cardinality: "one" } },
    { id: "topics", key: "topic_names", name: "Topics", type: { kind: "tag", cardinality: "many" } },
  ],
  labels: [
    { id: "in_progress", name: "In progress" },
    { id: "planning", name: "Planning" },
  ],
  relationships: [],
})}
\`\`\``);

    await expect(pool.query(
      `SELECT property_id, text_value FROM note_property_values
        WHERE doc_id = $1 ORDER BY property_id, value_order`,
      [note],
    ).then((result) => result.rows)).resolves.toEqual([
      { property_id: "legacy_key", text_value: "kept" },
      { property_id: "topics", text_value: "planning" },
      { property_id: "topics", text_value: "unknown" },
      { property_id: "workflow", text_value: "in_progress" },
    ]);
    await expect(pool.query(
      `SELECT property_id, label, kind FROM note_labels
        WHERE doc_id = $1 ORDER BY property_id, label`,
      [note],
    ).then((result) => result.rows)).resolves.toEqual([
      { property_id: "topics", label: "planning", kind: "tag" },
      { property_id: "topics", label: "unknown", kind: "tag" },
      { property_id: "workflow", label: "in_progress", kind: "label" },
    ]);

    const incremental = await rows("note_property_values");
    await purgeNoteIndex([schema, note]);
    await expect(backfillIndex()).resolves.toBe(2);
    expect(await rows("note_property_values")).toEqual(incremental);
  });

  it("refreshes catalog projections when the schema file moves away and back", async () => {
    const { vault } = await openVault("CatalogFileMove");
    const noam = await seedFolder(vault, null, "_Noam", "_Noam");
    const schema = await seedNote(vault, noam, "_Noam/Knowledge schema.md");
    const note = await seedNote(vault, null, "A.md");
    await put(note, "---\nproject_status: Ready\n---\nA");
    await put(schema, catalogMarkdown);
    await expect(propertyIds(note)).resolves.toEqual(["workflow"]);

    await moveNote(pool, schema, { relPath: "Knowledge schema.md", folderId: null });
    await waitForCurrent([schema, note]);
    await expect(propertyIds(note)).resolves.toEqual(["project_status"]);
    await expectProjectionMatchesRebuild([schema, note]);

    await moveNote(pool, schema, { relPath: "_Noam/Knowledge schema.md", folderId: noam });
    await waitForCurrent([schema, note]);
    await expect(propertyIds(note)).resolves.toEqual(["workflow"]);
    await expectProjectionMatchesRebuild([schema, note]);
  });

  it("returns a committed note move and lets the same move retry repair reprojection", async () => {
    const { vault } = await openVault("CatalogFileMoveFailure");
    const noam = await seedFolder(vault, null, "_Noam", "_Noam");
    const schema = await seedNote(vault, noam, "_Noam/Knowledge schema.md");
    const note = await seedNote(vault, null, "A.md");
    await put(note, "---\nproject_status: Ready\n---\nA");
    await put(schema, catalogMarkdown);

    await expect(moveNote(
      failCatalogReprojectionAfterCommit(CATALOG_REPROJECTION_RETRY_DELAYS_MS.length + 1) as any,
      schema,
      { relPath: "Knowledge schema.md", folderId: null },
    )).resolves.toMatchObject({ relPath: "Knowledge schema.md" });
    await expect(pool.query<{ rel_path: string }>(
      "SELECT rel_path FROM notes WHERE id = $1",
      [schema],
    ).then((result) => result.rows[0]?.rel_path)).resolves.toBe("Knowledge schema.md");
    await expect(pool.query<{ state: string }>(
      "SELECT state FROM note_knowledge_state WHERE doc_id = $1",
      [note],
    ).then((result) => result.rows[0]?.state)).resolves.toBe("stale");

    await expect(moveNote(
      pool,
      schema,
      { relPath: "Knowledge schema.md", folderId: null },
    )).resolves.toMatchObject({ relPath: "Knowledge schema.md" });
    await waitForCurrent([schema, note]);
    await expect(propertyIds(note)).resolves.toEqual(["project_status"]);

    await pool.query("DELETE FROM note_knowledge_state WHERE doc_id = $1", [note]);
    await moveNote(pool, schema, { relPath: "Knowledge schema.md", folderId: null });
    await waitForCurrent([schema, note]);
  });

  it("refreshes catalog projections when the containing directory moves away and back", async () => {
    const { vault } = await openVault("CatalogFolderMove");
    const noam = await seedFolder(vault, null, "_Noam", "_Noam");
    const schema = await seedNote(vault, noam, "_Noam/Knowledge schema.md");
    const note = await seedNote(vault, null, "A.md");
    await put(note, "---\nproject_status: Ready\n---\nA");
    await put(schema, catalogMarkdown);
    await expect(propertyIds(note)).resolves.toEqual(["workflow"]);

    await moveFolder(pool, noam, { name: "Schema" });
    await waitForCurrent([schema, note]);
    await expect(propertyIds(note)).resolves.toEqual(["project_status"]);
    await expectProjectionMatchesRebuild([schema, note]);

    await moveFolder(pool, noam, { name: "_Noam" });
    await waitForCurrent([schema, note]);
    await expect(propertyIds(note)).resolves.toEqual(["workflow"]);
    await expectProjectionMatchesRebuild([schema, note]);
  });

  it("returns a committed folder move while scheduled reprojection recovers", async () => {
    const { vault } = await openVault("CatalogFolderMoveFailure");
    const noam = await seedFolder(vault, null, "_Noam", "_Noam");
    const schema = await seedNote(vault, noam, "_Noam/Knowledge schema.md");
    const note = await seedNote(vault, null, "A.md");
    await put(note, "---\nproject_status: Ready\n---\nA");
    await put(schema, catalogMarkdown);

    await expect(moveFolder(
      failCatalogReprojectionAfterCommit(1) as any,
      noam,
      { name: "Schema" },
    )).resolves.toMatchObject({ path: "Schema" });
    await expect(pool.query<{ path: string }>(
      "SELECT path FROM folders WHERE id = $1",
      [noam],
    ).then((result) => result.rows[0]?.path)).resolves.toBe("Schema");
    await waitForCurrent([schema, note]);
    await expect(propertyIds(note)).resolves.toEqual(["project_status"]);
  });

  it("retries one failed peer without blocking the rest of the vault", async () => {
    const { user, vault } = await openVault("CatalogPeerRecovery");
    const schema = await seedNote(vault, null, "_Noam/Knowledge schema.md");
    const peers = await Promise.all([
      seedNote(vault, null, "A.md"),
      seedNote(vault, null, "B.md"),
      seedNote(vault, null, "C.md"),
    ]);
    await put(schema, catalogMarkdown);
    for (const peer of peers) await put(peer, "---\nproject_status: Ready\n---");
    await markKnowledgeCatalogStaleForVault(vault);

    const failedPeer = [...peers].sort()[1]!;
    const injected = failDocIndexAttempts(failedPeer, 1);
    await reprojectKnowledgeCatalogForVault(vault, injected.db as any, [0]);

    await waitForCurrent([schema, ...peers]);
    expect(injected.calls.get(failedPeer)).toBe(2);
    for (const peer of peers.filter((id) => id !== failedPeer)) {
      expect(injected.calls.get(peer)).toBe(1);
    }
    const query = createKnowledgeQuery({ actorId: user, vaultId: vault });
    await expect(query({
      where: [{ propertyId: "workflow", op: "eq", value: "Ready" }],
    }).then((page) => page.items.map((item) => item.docId).sort())).resolves.toEqual(
      [...peers].sort(),
    );
  });

  it("keeps scheduled recovery alive after the bounded attempt ladder is exhausted", async () => {
    const { vault } = await openVault("CatalogDurableRecovery");
    const schema = await seedNote(vault, null, "_Noam/Knowledge schema.md");
    const note = await seedNote(vault, null, "A.md");
    await put(schema, catalogMarkdown);
    await put(note, "---\nproject_status: Ready\n---");
    await markKnowledgeCatalogStaleForVault(vault);

    const db = failCatalogReprojectionQueries(
      CATALOG_REPROJECTION_RETRY_DELAYS_MS.length + 2,
    );
    await scheduleKnowledgeCatalogReprojection(vault, db as any, [0]);

    await waitForCurrent([schema, note]);
    await expect(propertyIds(note)).resolves.toEqual(["workflow"]);
  });

  it("filters denied notes before text filtering and counts", async () => {
    const { org, user, vault } = await openVault("Denied");
    const visible = await seedNote(vault, null, "Visible.md");
    const hidden = await seedNote(vault, null, "Hidden.md");
    await put(visible, "---\nstatus: Active\n---\nneedle visible");
    await put(hidden, "---\nstatus: Active\n---\nneedle hidden");
    await seedDeny(org, "file", hidden, user);

    const query = createKnowledgeQuery({ actorId: user, vaultId: vault });
    const page = await query({ text: "needle", where: [{ propertyId: "status", op: "eq", value: "Active" }] });
    expect(page.count).toBe(1);
    expect(page.items.map((item) => item.docId)).toEqual([visible]);
    expect(JSON.stringify(page)).not.toContain("Hidden.md");
    expect(JSON.stringify(page)).not.toContain("needle hidden");
  });

  it("hides relationship endpoints and makes missing and unreadable starts identical", async () => {
    const org = await seedOrg("Edges", `edges-${crypto.randomUUID()}`);
    const user = await seedUser("edges@example.com");
    await seedMember(org, user, "member");
    const vault = await seedVault(org);
    const source = await seedNote(vault, null, "Source.md");
    const target = await seedNote(vault, null, "Target.md");
    await seedShare(org, "file", source, user, "view");
    await put(source, "---\nnoam_document_id: identity-source\nnoam_relationships: [\"related:identity-target\"]\n---\nsource");
    await put(target, "---\nnoam_document_id: identity-target\n---\ntarget secret");

    const query = createKnowledgeQuery({ actorId: user, vaultId: vault });
    const outgoing = await query({
      traverse: { fromDocId: source, relationshipIds: ["related"], direction: "outgoing", maxDepth: 1 },
    });
    expect(outgoing).toMatchObject({ count: 0, items: [] });

    const errors: Array<{ code: string; message: string }> = [];
    for (const fromDocId of [target, crypto.randomUUID()]) {
      try {
        await query({
          traverse: { fromDocId, relationshipIds: ["related"], direction: "outgoing", maxDepth: 1 },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(KnowledgeQueryError);
        errors.push({ code: (error as KnowledgeQueryError).code, message: (error as Error).message });
      }
    }
    expect(errors).toEqual([
      { code: "not_found", message: "The note was not found" },
      { code: "not_found", message: "The note was not found" },
    ]);

    await seedShare(org, "file", target, user, "view");
    const incoming = await query({
      traverse: { fromDocId: target, relationshipIds: ["related"], direction: "incoming", maxDepth: 1 },
    });
    expect(incoming.items.map((item) => item.docId)).toEqual([source]);
  });

  it("uses opaque keyset cursors and expires them after revocation", async () => {
    const org = await seedOrg("Pages", `pages-${crypto.randomUUID()}`);
    const user = await seedUser("pages@example.com");
    await seedMember(org, user, "member");
    const vault = await seedVault(org);
    const docs = await Promise.all(["A.md", "B.md", "C.md"].map((path) => seedNote(vault, null, path)));
    for (const doc of docs) {
      await seedShare(org, "file", doc, user, "view");
      await put(doc, `---\nrank: 1\n---\npage ${doc}`);
    }
    const query = createKnowledgeQuery({ actorId: user, vaultId: vault });
    const first = await query({ page: { limit: 1 } });
    expect(first.count).toBe(3);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toContain(first.items[0]!.docId);

    const second = await query({ page: { limit: 1, cursor: first.nextCursor! } });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.docId).not.toBe(first.items[0]!.docId);

    await pool.query(
      "DELETE FROM shares WHERE resource_type = 'file' AND resource_id = $1 AND principal_id = $2",
      [docs[2], user],
    );
    await expect(query({ page: { limit: 1, cursor: second.nextCursor! } })).rejects.toMatchObject({
      code: "cursor_expired",
    });
  });

  it("reports stale indexes explicitly and allows labeled stale evidence only on request", async () => {
    const { user, vault } = await openVault("Stale");
    const doc = await seedNote(vault, null, "Stale.md");
    await put(doc, "---\nstatus: Active\n---\ncurrent text");
    await markKnowledgeIndexStale(doc);
    const query = createKnowledgeQuery({ actorId: user, vaultId: vault });
    await expect(query({})).rejects.toMatchObject({ code: "stale_index" });
    const page = await query({ consistency: "allow-stale" });
    expect(page.items[0]).toMatchObject({ docId: doc, indexState: "stale" });
    expect(page.items[0]!.sourceRevision).toBe(page.items[0]!.indexRevision);
  });

  it("awaits one vault-wide stale marker across overlapping catalog schedules", async () => {
    const { user, vault } = await openVault("ScheduledStale");
    const schema = await seedNote(vault, null, "_Noam/Knowledge schema.md");
    const doc = await seedNote(vault, null, "Scheduled.md");
    await put(doc, "---\nstatus: Ready\n---\ncurrent text");
    await put(schema, catalogMarkdown);
    const before = await pool.query<{ doc_id: string; generation: string }>(
      `SELECT doc_id, generation FROM note_knowledge_state
        WHERE doc_id = ANY($1::text[]) ORDER BY doc_id`,
      [[schema, doc]],
    );

    await Promise.all([
      scheduleIndex(schema, 60_000, pool),
      scheduleIndex(schema, 60_000, pool),
    ]);

    const after = await pool.query<{ doc_id: string; generation: string; state: string }>(
      `SELECT doc_id, generation, state FROM note_knowledge_state
        WHERE doc_id = ANY($1::text[]) ORDER BY doc_id`,
      [[schema, doc]],
    );
    expect(after.rows).toEqual(before.rows.map((row) => ({
      doc_id: row.doc_id,
      generation: String(BigInt(row.generation) + 1n),
      state: "stale",
    })));
    const query = createKnowledgeQuery({ actorId: user, vaultId: vault });
    await expect(query({})).rejects.toMatchObject({ code: "stale_index" });
  });

  it("rebuilds the same normalized projection as incremental indexing", async () => {
    const { vault } = await openVault("Rebuild");
    const a = await seedNote(vault, null, "A.md");
    const b = await seedNote(vault, null, "B.md");
    await put(a, "---\nnoam_document_id: a-id\ntags: [one, two]\nscore: 4\nnoam_relationships: [\"depends-on:b-id\"]\n---\nA");
    await put(b, "---\nnoam_document_id: b-id\nstatus: Ready\n---\nB");
    const tables = [
      "note_knowledge_identities",
      "note_property_values",
      "note_labels",
      "note_relationships",
    ];
    const incremental = Object.fromEntries(
      await Promise.all(tables.map(async (table) => [table, await rows(table)])),
    );

    await purgeNoteIndex([a, b]);
    await expect(backfillIndex()).resolves.toBe(2);
    const rebuilt = Object.fromEntries(
      await Promise.all(tables.map(async (table) => [table, await rows(table)])),
    );
    expect(rebuilt).toEqual(incremental);
  });
});
