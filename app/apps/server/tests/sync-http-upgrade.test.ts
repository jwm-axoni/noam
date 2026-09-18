import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createSyncServer, type SyncContext } from "../src/sync/hocuspocus.js";
import { attachSyncUpgrade } from "../src/sync/http-upgrade.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { countUpdates } from "../src/yjs/persistence.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";

// Dedicated Hocuspocus port (mirrors production HOCUSPOCUS_PORT) plus a
// separate bare HTTP server standing in for the Hono app's http.Server, with
// the sync WebSocket ALSO attached at /sync — exactly the two-entry-point
// shape production runs (see src/index.ts).
const HOCUSPOCUS_PORT = 3989;
const VAULT = "vault-http-upgrade";

let sync: Server<SyncContext>;
let httpServer: ReturnType<typeof createServer>;
let httpPort: number;

function waitFor(cond: () => boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout: ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function connectViaHttpPort(docId: string, readOnly: boolean) {
  const token = await mintSyncToken({ docId, vaultId: VAULT, readOnly });
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${httpPort}/sync`,
    name: formatDocName(VAULT, docId),
    token,
    document: doc,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  await waitFor(() => provider.isSynced, 8000, "provider synced");
  return { provider, doc, text: doc.getText("content") };
}

describe("Hocuspocus sync also served on the HTTP port at /sync (single-port deploys)", () => {
  beforeAll(async () => {
    await resetDb();
    // Same shared instance as the dedicated HOCUSPOCUS_PORT listener.
    sync = createSyncServer(HOCUSPOCUS_PORT);
    await sync.listen();

    httpServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    attachSyncUpgrade(httpServer, sync);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    httpPort = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    await sync.destroy();
    await pool.end();
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("a client connecting through the HTTP port's /sync authenticates and syncs like a direct HOCUSPOCUS_PORT connection", async () => {
    const docId = "http-upgrade-sync";
    const a = await connectViaHttpPort(docId, false);
    a.text.insert(0, "hello via /sync");
    await waitFor(() => a.text.toString() === "hello via /sync");

    // Persistence runs through the same onChange hook as the dedicated port.
    await new Promise((r) => setTimeout(r, 300));
    expect(await countUpdates(docId)).toBeGreaterThan(0);

    a.provider.destroy();
  });

  it("a read-only client connected via /sync is still rejected by the shared server", async () => {
    const docId = "http-upgrade-readonly";
    const editor = await connectViaHttpPort(docId, false);
    editor.text.insert(0, "canonical");
    await waitFor(() => editor.text.toString() === "canonical");

    const viewer = await connectViaHttpPort(docId, true);
    await waitFor(() => viewer.text.toString() === "canonical", 8000, "viewer synced state");

    viewer.text.insert(0, "HACK ");
    await new Promise((r) => setTimeout(r, 800));
    expect(editor.text.toString()).toBe("canonical");

    editor.provider.destroy();
    viewer.provider.destroy();
  });

  it("rejects a WebSocket upgrade at any path other than /sync", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/not-sync`);
    const outcome = await new Promise<"open" | "closed-or-errored">((resolve) => {
      ws.once("open", () => resolve("open"));
      ws.once("error", () => resolve("closed-or-errored"));
      ws.once("close", () => resolve("closed-or-errored"));
    });
    expect(outcome).toBe("closed-or-errored");
  });
});
