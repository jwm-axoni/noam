import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createAgentToken, createMcpToken } from "../src/mcp/tokens.js";
import { createDocWriter } from "../src/mcp/doc-writer.js";
import { findLiveHuman } from "../src/registry/participants.js";
import { createSyncServer, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { createVersionCapture } from "../src/versions/capture.js";
import { recordingAppDeps } from "./helpers/app.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

/**
 * ADR 0003 decision 3: attribution is SERVER-stamped — from the token (MCP) or
 * the connection context (Hocuspocus) — and never from anything the request
 * body or a Yjs payload claims.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

let rpcId = 0;
async function call(token: string, name: string, args: Record<string, unknown>) {
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
  const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  return { status: res.status, isError: body.result?.isError ?? false, text: body.result?.content?.[0]?.text ?? "" };
}

async function insertAgent(orgId: string, name: string, createdBy: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO participants (id, organization_id, kind, display_name, color, harness, created_by)
     VALUES ($1, $2, 'agent', $3, '#2981fb', 'custom', $4)`,
    [id, orgId, name, createdBy],
  );
  return id;
}

/** Arguments a hostile caller adds to claim someone else's authorship. */
const FORGED = (participantId: string) => ({
  author: "Mallory",
  participantId,
  name: "Mallory",
});

function api(user: TestUser, path: string) {
  return app.fetch(
    new Request(`http://local${path}`, {
      headers: { "content-type": "application/json", authorization: `Bearer ${user.token}` },
    }),
  );
}

describe("server-stamped attribution (ADR 0003 decision 3)", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  // ── MCP: the actor comes from the token ──────────────────────────────────

  it("an agent token's write is attributed to the agent row, whatever the body claims", async () => {
    const owner = await seedUser("owner@attr1.com");
    const org = await seedOrg("Acme", "acme-attr1");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", owner);
    const agent = await insertAgent(org, "Claude", owner);
    const decoy = await insertAgent(org, "Mallory", owner);
    const { token } = await createAgentToken({
      organizationId: org,
      mintedBy: owner,
      participantId: agent,
      name: "agent",
      scopes: [{ resourceType: "vault", resourceId: org, permission: "edit" }],
    });

    const res = await call(token, "update_note", { docId, content: "by the agent", ...FORGED(decoy) });
    expect(res.isError, res.text).toBe(false);

    const write = rec.docWriter.writes.find((w) => w.docId === docId);
    expect(write?.content).toBe("by the agent");
    expect(write?.actor).toEqual({ userId: owner, participantId: agent });
  });

  it("a user token's write is attributed to the user's live human row", async () => {
    const owner = await seedUser("owner@attr2.com");
    const org = await seedOrg("Acme", "acme-attr2");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", owner);
    const decoy = await insertAgent(org, "Mallory", owner);
    const human = await findLiveHuman(org, owner);
    expect(human).not.toBeNull();
    const { token } = await createMcpToken({ userId: owner, organizationId: org }, "test");

    const res = await call(token, "update_note", { docId, content: "by the human", ...FORGED(decoy) });
    expect(res.isError, res.text).toBe(false);

    const write = rec.docWriter.writes.find((w) => w.docId === docId);
    expect(write?.actor).toEqual({ userId: owner, participantId: human!.id });
  });

  // ── versions + last-edited stamp carry the participant ───────────────────

  it("touch stamps last_edited_participant and the idle version's author_participant", async () => {
    const user = await signUp("attr3@t.com");
    const org = await seedOrg("Acme", "acme-attr3");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", user.userId);
    const agent = await insertAgent(org, "Claude", user.userId);
    rec.docWriter.store.set(docId, "agent text");

    const capture = createVersionCapture({ docWriter: rec.docWriter, idleMs: 60_000 });
    capture.touch(vault, docId, { userId: user.userId, participantId: agent });
    // The stamp is fire-and-forget inside touch(); let it land.
    await new Promise((r) => setTimeout(r, 100));
    await capture.flush(docId);
    capture.stop();

    const { rows: n } = await pool.query(
      "SELECT last_edited_by, last_edited_participant FROM notes WHERE id = $1",
      [docId],
    );
    expect(n[0]).toEqual({ last_edited_by: user.userId, last_edited_participant: agent });
    const { rows: v } = await pool.query(
      "SELECT author_id, author_participant FROM note_versions WHERE doc_id = $1",
      [docId],
    );
    expect(v).toEqual([{ author_id: user.userId, author_participant: agent }]);

    // Both surface over HTTP with the participant's registry name joined in.
    const notes = (await (await api(user, `/api/notes?vaultId=${vault}`)).json()) as {
      notes: Array<Record<string, unknown>>;
    };
    const note = notes.notes.find((x) => x.id === docId)!;
    expect(note.last_edited_participant).toBe(agent);
    expect(note.last_edited_participant_name).toBe("Claude");
    expect(note.last_edited_by).toBe(user.userId);

    const versions = (await (await api(user, `/api/notes/${docId}/versions`)).json()) as {
      versions: Array<Record<string, unknown>>;
    };
    expect(versions.versions[0].authorParticipant).toBe(agent);
    expect(versions.versions[0].authorParticipantName).toBe("Claude");
    expect(versions.versions[0].authorId).toBe(user.userId);
  });

  it("a participant change re-stamps immediately even when the userId is the same", async () => {
    const user = await signUp("attr4@t.com");
    const org = await seedOrg("Acme", "acme-attr4");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", user.userId);
    const agent = await insertAgent(org, "Claude", user.userId);
    const human = (await findLiveHuman(org, user.userId))!;
    rec.docWriter.store.set(docId, "x");

    const capture = createVersionCapture({ docWriter: rec.docWriter, idleMs: 60_000 });
    capture.touch(vault, docId, { userId: user.userId, participantId: human.id });
    await new Promise((r) => setTimeout(r, 100));
    // Same minter, different editor: must not be swallowed by the throttle.
    capture.touch(vault, docId, { userId: user.userId, participantId: agent });
    await new Promise((r) => setTimeout(r, 100));
    capture.stop();

    const { rows } = await pool.query(
      "SELECT last_edited_participant FROM notes WHERE id = $1",
      [docId],
    );
    expect(rows[0].last_edited_participant).toBe(agent);
  });

  // ── doc writer's detached path reports both ids ──────────────────────────

  it("the detached doc-writer path hands onDocWritten the full actor", async () => {
    const noLiveDocs = { hocuspocus: { documents: new Map() } } as unknown as Server<SyncContext>;
    const seen: unknown[] = [];
    const writer = createDocWriter(noLiveDocs, undefined, (vaultId, docId, actor) =>
      seen.push({ vaultId, docId, actor }),
    );
    await writer.setContent("vault-d", "doc-d", "hi", { userId: "u1", participantId: "p1" });
    expect(seen).toEqual([
      { vaultId: "vault-d", docId: "doc-d", actor: { userId: "u1", participantId: "p1" } },
    ]);
  });

  // ── Hocuspocus: the actor comes from the connection context ──────────────

  it("onChange reports the context's participant, and nothing for an anonymous origin", async () => {
    const edits: Array<{ docId: string; actor: unknown }> = [];
    const server = createSyncServer(
      0,
      undefined,
      (_vaultId, docId, actor) => edits.push({ docId, actor }),
      async () => {},
    );
    const onChange = server.hocuspocus.configuration.onChange;

    const update = () => {
      const doc = new Y.Doc();
      let captured: Uint8Array | null = null;
      doc.on("update", (u: Uint8Array) => (captured = u));
      doc.getText("content").insert(0, "text");
      doc.destroy();
      return captured!;
    };
    // The client's awareness/update may claim anything; only `context` counts.
    const ctx: SyncContext = {
      docId: "doc-h",
      vaultId: "vault-h",
      readOnly: false,
      userId: "user-h",
      participantId: "participant-h",
    };
    await onChange({
      documentName: formatDocName("vault-h", "doc-h"),
      update: update(),
      transactionOrigin: { source: "connection" },
      context: ctx,
    } as any);
    // A string origin or a Redis-replicated update: Hocuspocus hands `{}`.
    await onChange({
      documentName: formatDocName("vault-h", "doc-anon"),
      update: update(),
      transactionOrigin: "mcp",
      context: {},
    } as any);

    expect(edits).toEqual([
      { docId: "doc-h", actor: { userId: "user-h", participantId: "participant-h" } },
      { docId: "doc-anon", actor: { userId: null, participantId: null } },
    ]);
  });
});
