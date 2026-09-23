import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import {
  seedAgentParticipant,
  seedFolder,
  seedMember,
  seedNote,
  seedOrg,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { createAgentToken, createMcpToken } from "../src/mcp/tokens.js";
import { expandPreset, type TokenScope } from "../src/permissions/token-scope.js";

/**
 * ADR 0003 decision 2: agent tokens are default-deny. Every answer is
 * min(minter's effectivePermission, token scope) — a scope can only narrow.
 */

const rec = recordingAppDeps();
// A no-op audit sink: this suite is about scopes, not the audit log (workstream D).
const app = createApp({
  ...rec.deps,
  mcpAudit: { record: async () => {}, check: async () => null, serialize: (_auth, fn) => fn() },
});
const mem = rec.docWriter;

let rpcId = 0;
async function rpc(token: string | null, method: string, params?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }),
  );
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  const body = (await res.json()) as {
    result?: { structuredContent?: unknown; isError?: boolean; content?: Array<{ text: string }> };
  };
  return {
    status: res.status,
    isError: body.result?.isError ?? false,
    data: body.result?.structuredContent as any,
    text: body.result?.content?.[0]?.text ?? "",
  };
}

async function userToken(userId: string, orgId: string): Promise<string> {
  const { token } = await createMcpToken({ userId, organizationId: orgId }, "test");
  return token;
}

async function agentToken(orgId: string, minter: string, scopes: TokenScope[]): Promise<string> {
  const participantId = await seedAgentParticipant(orgId, `Agent ${++rpcId}`, minter);
  const { token } = await createAgentToken({
    organizationId: orgId,
    mintedBy: minter,
    participantId,
    name: "agent",
    scopes,
  });
  return token;
}

/** Index a note so search_notes / query_knowledge have something to find. */
async function indexNote(docId: string, vaultId: string, content: string) {
  await pool.query(
    "INSERT INTO note_index (doc_id, vault_id, title, content) VALUES ($1, $2, $3, $4)",
    [docId, vaultId, "t", content],
  );
}

/**
 * An owner in an OPEN vault (org-wide edit grant), so the minter can do
 * everything and any refusal below is the token's scope talking.
 *
 *   root.md
 *   Projects/plan.md
 *   Projects/Deep/nested.md
 *   Other/secret.md
 */
async function openVault(slug: string) {
  const owner = await seedUser(`owner@${slug}.com`);
  const org = await seedOrg("Acme", slug);
  await seedMember(org, owner, "owner");
  await seedVaultGrant(org, "edit");
  const vault = await seedVault(org);
  const projects = await seedFolder(vault, null, "Projects", "Projects", owner);
  const deep = await seedFolder(vault, projects, "Deep", "Projects/Deep", owner);
  const other = await seedFolder(vault, null, "Other", "Other", owner);
  const root = await seedNote(vault, null, "root.md", owner);
  const plan = await seedNote(vault, projects, "Projects/plan.md", owner);
  const nested = await seedNote(vault, deep, "Projects/Deep/nested.md", owner);
  const secret = await seedNote(vault, other, "Other/secret.md", owner);
  for (const [id, text] of [
    [root, "root alpha"],
    [plan, "plan alpha"],
    [nested, "nested alpha"],
    [secret, "secret alpha"],
  ]) {
    mem.store.set(id, text);
    await indexNote(id, vault, text);
  }
  return { owner, org, vault, projects, deep, other, root, plan, nested, secret };
}

describe("MCP agent-token scopes (ADR 0003 item 2)", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("no scopes: list_vaults only; everything else is empty or refused", async () => {
    const v = await openVault("agent-noscope");
    const token = await agentToken(v.org, v.owner, []);

    const vaults = await call(token, "list_vaults");
    expect(vaults.isError).toBe(false);
    expect(vaults.data.results.map((r: any) => r.vaultId)).toEqual([v.vault]);

    const folders = await call(token, "list_folders", { vaultId: v.vault });
    expect(folders.isError).toBe(false);
    expect(folders.data.results).toEqual([]);

    const notes = await call(token, "list_notes", { vaultId: v.vault });
    expect(notes.isError).toBe(false);
    expect(notes.data.results).toEqual([]);

    const read = await call(token, "read_note", { docId: v.plan });
    expect(read.isError).toBe(true);
    expect(read.text).toMatch(/do not have access/);

    const search = await call(token, "search_notes", { vaultId: v.vault, query: "alpha" });
    expect(search.isError).toBe(false);
    expect(search.data.results).toEqual([]);

    const create = await call(token, "create_note", {
      vaultId: v.vault,
      relPath: "Projects/new.md",
      content: "x",
    });
    expect(create.isError).toBe(true);
    const rootCreate = await call(token, "create_note", { vaultId: v.vault, relPath: "new.md" });
    expect(rootCreate.isError).toBe(true);
    const { rows } = await pool.query("SELECT 1 FROM notes WHERE rel_path IN ('new.md','Projects/new.md')");
    expect(rows).toHaveLength(0);

    // Control: the minting owner's own user token reads the same note, and the
    // search sees every indexed note.
    const own = await userToken(v.owner, v.org);
    const ownRead = await call(own, "read_note", { docId: v.plan });
    expect(ownRead.isError).toBe(false);
    expect(ownRead.data.content).toBe("plan alpha");
    const ownSearch = await call(own, "search_notes", { vaultId: v.vault, query: "alpha" });
    expect(ownSearch.data.results).toHaveLength(4);
  });

  it("folder view scope: reads the subtree only, writes nothing", async () => {
    const v = await openVault("agent-fview");
    const token = await agentToken(v.org, v.owner, [
      { resourceType: "folder", resourceId: v.projects, permission: "view" },
    ]);

    const inside = await call(token, "read_note", { docId: v.plan });
    expect(inside.isError).toBe(false);
    expect(inside.data.permission).toBe("view");
    const nested = await call(token, "read_note", { docId: v.nested });
    expect(nested.isError).toBe(false);
    expect(nested.data.content).toBe("nested alpha");

    for (const docId of [v.secret, v.root]) {
      const out = await call(token, "read_note", { docId });
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/do not have access/);
    }

    const update = await call(token, "update_note", { docId: v.plan, content: "changed" });
    expect(update.isError).toBe(true);
    expect(update.text).toMatch(/read-only/);
    expect(mem.store.get(v.plan)).toBe("plan alpha");

    const folders = await call(token, "list_folders", { vaultId: v.vault });
    expect(folders.data.results.map((f: any) => f.path).sort()).toEqual([
      "Projects",
      "Projects/Deep",
    ]);

    const notes = await call(token, "list_notes", { vaultId: v.vault });
    expect(notes.data.results.map((n: any) => n.docId).sort()).toEqual(
      [v.plan, v.nested].sort(),
    );

    const search = await call(token, "search_notes", { vaultId: v.vault, query: "alpha" });
    expect(search.data.results.map((h: any) => h.docId).sort()).toEqual(
      [v.plan, v.nested].sort(),
    );

    // query_knowledge sees the same scoped readable set, not the minter's.
    const knowledge = await call(token, "query_knowledge", {
      vaultId: v.vault,
      text: "alpha",
      consistency: "allow-stale",
    });
    expect(knowledge.isError).toBe(false);
    expect(knowledge.data.count).toBe(2);
    expect(knowledge.data.items.map((i: any) => i.docId).sort()).toEqual(
      [v.plan, v.nested].sort(),
    );
  });

  it("folder edit scope: writes inside the folder, never at the root", async () => {
    const v = await openVault("agent-fedit");
    const token = await agentToken(v.org, v.owner, [
      { resourceType: "folder", resourceId: v.projects, permission: "edit" },
    ]);

    const update = await call(token, "update_note", { docId: v.plan, content: "rewritten" });
    expect(update.isError).toBe(false);
    expect(mem.store.get(v.plan)).toBe("rewritten");

    const created = await call(token, "create_note", {
      vaultId: v.vault,
      relPath: "Projects/Deep/draft.md",
      content: "draft",
    });
    expect(created.isError).toBe(false);
    expect(created.data.folderId).toBe(v.deep);

    const atRoot = await call(token, "create_note", { vaultId: v.vault, relPath: "loose.md" });
    expect(atRoot.isError).toBe(true);
    expect(atRoot.text).toMatch(/do not have edit access to create a note here/);
    const rootFolder = await call(token, "create_folder", {
      vaultId: v.vault,
      name: "Loose",
      path: "Loose",
    });
    expect(rootFolder.isError).toBe(true);

    // Moving a note OUT of the scope (to the root) or INTO an unscoped folder.
    const toRoot = await call(token, "move_note", { docId: v.plan, relPath: "plan.md" });
    expect(toRoot.isError).toBe(true);
    const toOther = await call(token, "move_note", { docId: v.plan, relPath: "Other/plan.md" });
    expect(toOther.isError).toBe(true);
    const { rows } = await pool.query<{ rel_path: string }>(
      "SELECT rel_path FROM notes WHERE id = $1",
      [v.plan],
    );
    expect(rows[0].rel_path).toBe("Projects/plan.md");

    // Control: the owner's user token may still create at the root.
    const own = await userToken(v.owner, v.org);
    expect((await call(own, "create_note", { vaultId: v.vault, relPath: "loose.md" })).isError).toBe(
      false,
    );

    const notes = await call(token, "list_notes", { vaultId: v.vault, folderId: v.projects });
    expect(notes.data.results).toHaveLength(1);
    expect(notes.data.results[0]).toMatchObject({ docId: v.plan, permission: "edit" });
  });

  it("a token narrower than its minter: vault view on an owner in an open vault", async () => {
    const v = await openVault("agent-narrow");
    const token = await agentToken(v.org, v.owner, [
      { resourceType: "vault", resourceId: v.org, permission: "view" },
    ]);

    const read = await call(token, "read_note", { docId: v.root });
    expect(read.isError).toBe(false);
    expect(read.data.permission).toBe("view");

    const update = await call(token, "update_note", { docId: v.root, content: "nope" });
    expect(update.isError).toBe(true);
    expect(mem.store.get(v.root)).toBe("root alpha");

    const folders = await call(token, "list_folders", { vaultId: v.vault });
    expect(folders.data.results).toHaveLength(3);
  });

  it("a token cannot exceed its minter: vault edit scope in a Read-only vault", async () => {
    const owner = await seedUser("owner@agent-ro.com");
    const org = await seedOrg("Acme", "agent-ro");
    await seedMember(org, owner, "owner");
    // Read-only posture: caps every shortcut (the owner's included) at view.
    await seedVaultGrant(org, "view");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "a.md", owner);
    mem.store.set(doc, "text");
    const token = await agentToken(org, owner, [
      { resourceType: "vault", resourceId: org, permission: "edit" },
    ]);

    const read = await call(token, "read_note", { docId: doc });
    expect(read.isError).toBe(false);
    expect(read.data.permission).toBe("view");
    const update = await call(token, "update_note", { docId: doc, content: "changed" });
    expect(update.isError).toBe(true);
    expect(mem.store.get(doc)).toBe("text");

    // The minter leaves the vault: the agent token itself stops authenticating.
    await pool.query(`DELETE FROM member WHERE "organizationId" = $1 AND "userId" = $2`, [
      org,
      owner,
    ]);
    const after = await rpc(token, "tools/call", { name: "list_vaults", arguments: {} });
    expect(after.status).toBe(401);
  });

  it("file scope: one note readable, its sibling refused", async () => {
    const v = await openVault("agent-file");
    const sibling = await seedNote(v.vault, v.projects, "Projects/sibling.md", v.owner);
    mem.store.set(sibling, "sibling");
    const token = await agentToken(v.org, v.owner, [
      { resourceType: "file", resourceId: v.plan, permission: "view" },
    ]);

    expect((await call(token, "read_note", { docId: v.plan })).isError).toBe(false);
    const refused = await call(token, "read_note", { docId: sibling });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/do not have access/);

    // A file scope reveals no folder.
    expect((await call(token, "list_folders", { vaultId: v.vault })).data.results).toEqual([]);
    const notes = await call(token, "list_notes", { vaultId: v.vault });
    expect(notes.data.results.map((n: any) => n.docId)).toEqual([v.plan]);
  });

  it("presets are just rows: drafter reads the vault, writes one folder", async () => {
    const v = await openVault("agent-drafter");
    const token = await agentToken(v.org, v.owner, expandPreset("drafter", v.org, v.projects));

    for (const docId of [v.root, v.plan, v.nested, v.secret]) {
      expect((await call(token, "read_note", { docId })).isError).toBe(false);
    }
    expect((await call(token, "update_note", { docId: v.nested, content: "ok" })).isError).toBe(
      false,
    );
    expect((await call(token, "update_note", { docId: v.secret, content: "no" })).isError).toBe(
      true,
    );
    expect((await call(token, "update_note", { docId: v.root, content: "no" })).isError).toBe(
      true,
    );
    expect(mem.store.get(v.secret)).toBe("secret alpha");
    expect(mem.store.get(v.root)).toBe("root alpha");

    expect(
      (await call(token, "create_note", { vaultId: v.vault, relPath: "Projects/d.md" })).isError,
    ).toBe(false);
    expect(
      (await call(token, "create_note", { vaultId: v.vault, relPath: "Other/d.md" })).isError,
    ).toBe(true);
    expect((await call(token, "delete_folder", { folderId: v.other })).isError).toBe(true);
  });

  it("list_folders never reveals a folder the minter cannot see (private-by-default vault)", async () => {
    // PR #16 round 2, finding 4: the token scope was the only filter, so a
    // vault-scoped agent enumerated every folder's name, path and parent —
    // including ones its minter had no grant on.
    const owner = await seedUser("owner@agent-folders.com");
    const admin = await seedUser("admin@agent-folders.com");
    const member = await seedUser("member@agent-folders.com");
    const org = await seedOrg("Acme", "agent-folders");
    await seedMember(org, owner, "owner");
    await seedMember(org, admin, "admin");
    await seedMember(org, member, "member");
    // Never shared: no vault-wide grant, so everyone sees only what they authored.
    const vault = await seedVault(org);
    const ownersFolder = await seedFolder(vault, null, "Owner Only", "Owner Only", owner);
    await seedFolder(vault, ownersFolder, "Deeper", "Owner Only/Deeper", owner);
    const adminsFolder = await seedFolder(vault, null, "Admin Stuff", "Admin Stuff", admin);

    // Vault-scoped editor token minted by the admin: only the admin's folder.
    const vaultScoped = await agentToken(org, admin, expandPreset("editor", org));
    const asAgent = await call(vaultScoped, "list_folders", { vaultId: vault });
    expect(asAgent.isError).toBe(false);
    expect(asAgent.data.results.map((f: any) => f.folderId)).toEqual([adminsFolder]);

    // A folder scope on the owner's folder does not lift the minter's cap either.
    const folderScoped = await agentToken(org, admin, [
      { resourceType: "folder", resourceId: ownersFolder, permission: "view" },
    ]);
    expect((await call(folderScoped, "list_folders", { vaultId: vault })).data.results).toEqual([]);

    // The same rule for a user token: a member with no grant sees nothing.
    const asMember = await call(await userToken(member, org), "list_folders", { vaultId: vault });
    expect(asMember.isError).toBe(false);
    expect(asMember.data.results).toEqual([]);
  });

});
