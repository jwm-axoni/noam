import { EditorState } from "@codemirror/state";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteBridge } from "../../bridge";
import { makeHarness, sha256Hex } from "../../bridge/__tests__/helpers";
import { BridgeManager } from "../../bridge/adapter";
import { createPortableIdentityPlan } from "../../knowledge/identityMutation";
import { planPresentationPatch } from "../../presentation/edit";
import { PRESENTATION_KEYS } from "../../presentation/types";
import { SyncManager } from "../docSession";
import { VaultDocStore } from "../vaultDocStore";
import { vaultScopes } from "../vaultScope";

const path = "Projects/_noam-folder.md";
const source = "---\nnoam_kind: folder-presentation\nnoam_presentation_version: 1\n---\n";

function iconPlan(markdown: string) {
  const state = EditorState.create({ doc: markdown });
  const plan = planPresentationPatch(state.doc, {
    [PRESENTATION_KEYS.icon]: { kind: "text", value: "lucide:leaf" },
  });
  return plan.ok ? plan : { ok: false as const, reason: "unsupported-yaml" as const };
}

afterEach(() => vaultScopes.end());

describe("background presentation mutation", () => {
  it("uses a headless bridge, flushes the minimal patch, and releases it", async () => {
    const { io, fs } = makeHarness({ [path]: source });
    vaultScopes.begin({ orgId: null, vaultPath: "/vaults/a", vaultEpoch: 7 });
    const manager = new SyncManager({ backgroundBridgeIO: io });

    await expect(manager.mutateBackgroundText(path, "folder-meta", 7, iconPlan)).resolves.toEqual({ ok: true });
    expect(fs.get(path)).toContain('noam_icon: "lucide:leaf"');
    expect(fs.writeCount).toBe(1);
    expect(fs.lastExpectedDocumentId).toBe("folder-meta");
    expect(fs.lastExpectedSourceRevision).toBe(sha256Hex(source));
    expect(fs.lastExpectedFileIdentity).toBe("0");

    // A second call must be able to open the persisted document again. A leaked
    // bridge would become a second writer and this call would duplicate content.
    await expect(manager.mutateBackgroundText(path, "folder-meta", 7, (markdown) => {
      const state = EditorState.create({ doc: markdown });
      const plan = planPresentationPatch(state.doc, {
        [PRESENTATION_KEYS.iconColor]: { kind: "text", value: "green" },
      });
      return plan.ok ? plan : { ok: false as const, reason: "unsupported-yaml" as const };
    })).resolves.toEqual({ ok: true });
    expect(fs.get(path)).toContain("noam_icon_color: green");
    expect(fs.get(path)?.match(/noam_kind:/g)).toHaveLength(1);
  });

  it("refuses a stale vault or a permission revoked before the transaction", async () => {
    const { io, fs } = makeHarness({ [path]: source });
    vaultScopes.begin({ orgId: null, vaultPath: "/vaults/a", vaultEpoch: 7 });
    const manager = new SyncManager({ backgroundBridgeIO: io });

    await expect(manager.mutateBackgroundText(path, "folder-meta", 8, iconPlan)).resolves.toEqual({
      ok: false,
      reason: "stale",
    });
    await expect(manager.mutateBackgroundText(path, "folder-meta", 7, iconPlan, () => false)).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
    await expect(manager.mutateBackgroundText(
      path,
      "folder-meta",
      7,
      iconPlan,
      () => true,
      async () => false,
    )).resolves.toEqual({ ok: false, reason: "forbidden" });
    expect(fs.get(path)).toBe(source);
    expect(fs.writeCount).toBe(0);
  });

  it("refuses to retarget a stale action to a replacement document", async () => {
    const { io, fs } = makeHarness({ [path]: source });
    vaultScopes.begin({ orgId: null, vaultPath: "/vaults/a", vaultEpoch: 7 });
    const manager = new SyncManager({ backgroundBridgeIO: io });
    vi.spyOn(manager.registry, "getMapping").mockReturnValue({
      docId: "replacement-meta",
      vaultId: "vault-a",
    });

    await expect(manager.mutateBackgroundText(path, "folder-meta", 7, iconPlan)).resolves.toEqual({
      ok: false,
      reason: "stale",
    });
    expect(fs.get(path)).toBe(source);
    expect(fs.writeCount).toBe(0);
  });

  it("keeps an existing resident bridge alive while a background lease awaits", async () => {
    const secondPath = "Projects/second.md";
    const { io } = makeHarness({ [path]: source, [secondPath]: "second" });
    const store = new VaultDocStore({
      io,
      hotCap: 1,
      resolvePath: (docId) => docId === "folder-meta" ? path : secondPath,
    });
    const resident = await store.promote("folder-meta", path, { seedFromFile: true });
    const lease = await store.acquireLease("folder-meta", path);

    await store.promote("second", secondPath, { seedFromFile: true, pin: true });
    expect(store.peekResident("folder-meta")).toBe(resident);
    expect(lease.bridge).toBe(resident);

    await lease.release();
    expect(store.peekResident("folder-meta")).toBeNull();
    expect(store.peekResident("second")).not.toBeNull();
    await store.demote("second");
  });

  it.each(["opening-first", "joining-first"] as const)(
    "retires a transient bridge after concurrent leases release %s",
    async (releaseOrder) => {
    const { io } = makeHarness({ [path]: source });
    const store = new VaultDocStore({ io, resolvePath: () => path });
    const [first, second] = await Promise.all([
      store.acquireLease("folder-meta", path, { seedFromFile: true }),
      store.acquireLease("folder-meta", path, { seedFromFile: true }),
    ]);
    expect(second.bridge).toBe(first.bridge);

    const [before, after] = releaseOrder === "opening-first"
      ? [first, second]
      : [second, first];
    await before.release();
    expect(store.peekResident("folder-meta")).toBe(first.bridge);
    await after.release();
    expect(store.peekResident("folder-meta")).toBeNull();
    },
  );

  it("defers an explicit demotion until an active lease releases", async () => {
    const { io } = makeHarness({ [path]: source });
    const store = new VaultDocStore({ io, resolvePath: () => path });
    const resident = await store.promote("folder-meta", path, { seedFromFile: true });
    const lease = await store.acquireLease("folder-meta", path);

    await store.demote("folder-meta");
    expect(store.peekResident("folder-meta")).toBe(resident);
    await lease.release();
    expect(store.peekResident("folder-meta")).toBeNull();
  });

  it("preserves a resident remote body edit while inserting identity", async () => {
    const notePath = "People/Ada.md";
    const note = "---\r\n# keep\r\ntitle: Ada\r\n---\r\nBody\r\n";
    const { io, fs } = makeHarness({ [notePath]: note });
    vaultScopes.begin({ orgId: null, vaultPath: "/vaults/a", vaultEpoch: 7 });
    const bridge = await NoteBridge.open(io, {
      docId: "server-ada",
      path: notePath,
      seedFromFile: true,
    });
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(bridge.doc));
    remote.getText("content").insert(remote.getText("content").length, "Remote edit\r\n");
    bridge.applyRemote(Y.encodeStateAsUpdate(remote, Y.encodeStateVector(bridge.doc)));

    const manager = new SyncManager({
      backgroundBridgeIO: io,
      currentBridge: () => bridge,
    });
    const identity = createPortableIdentityPlan(note, "server-ada");
    await expect(
      manager.mutateBackgroundText(notePath, "server-ada", 7, identity.plan),
    ).resolves.toEqual({ ok: true });

    expect(fs.get(notePath)).toBe(
      "---\r\n# keep\r\ntitle: Ada\r\nnoam_document_id: server-ada\r\n---\r\nBody\r\nRemote edit\r\n",
    );
    expect(identity.resolvedDocumentId()).toBe("server-ada");
    bridge.destroy();
    remote.destroy();
  });

  it("serializes repeated identity creation on one device", async () => {
    const notePath = "People/Ada.md";
    const note = "---\ntitle: Ada\n---\nBody\n";
    const { io, fs } = makeHarness({ [notePath]: note });
    vaultScopes.begin({ orgId: null, vaultPath: "/vaults/a", vaultEpoch: 7 });
    const manager = new SyncManager({ backgroundBridgeIO: io });
    const first = createPortableIdentityPlan(note, "server-ada");
    const second = createPortableIdentityPlan(note, "server-ada");

    await expect(Promise.all([
      manager.mutateBackgroundText(notePath, "server-ada", 7, first.plan),
      manager.mutateBackgroundText(notePath, "server-ada", 7, second.plan),
    ])).resolves.toEqual([{ ok: true }, { ok: true }]);

    expect(first.resolvedDocumentId()).toBe("server-ada");
    expect(second.resolvedDocumentId()).toBe("server-ada");
    expect(fs.get(notePath)?.match(/noam_document_id:/g)).toHaveLength(1);
    expect(fs.get(notePath)).toContain("noam_document_id: server-ada");
  });

  it("converges concurrent identity creation from two synced devices", async () => {
    const notePath = "People/Ada.md";
    const note = "---\ntitle: Ada\n---\nBody\n";
    const firstHarness = makeHarness({ [notePath]: note });
    const secondHarness = makeHarness({ [notePath]: note });
    const base = new Y.Doc();
    base.getText("content").insert(0, note);
    const baseUpdate = Y.encodeStateAsUpdate(base);
    const baseVector = Y.encodeStateVector(base);
    await firstHarness.persistence.appendUpdate("server-ada", baseUpdate);
    await secondHarness.persistence.appendUpdate("server-ada", baseUpdate);
    const firstBridge = await NoteBridge.open(firstHarness.io, {
      docId: "server-ada",
      path: notePath,
      seedFromFile: false,
    });
    const secondBridge = await NoteBridge.open(secondHarness.io, {
      docId: "server-ada",
      path: notePath,
      seedFromFile: false,
    });
    vaultScopes.begin({ orgId: "org-a", vaultPath: "/vaults/a", vaultEpoch: 7 });
    const firstManager = new SyncManager({
      backgroundBridgeIO: firstHarness.io,
      currentBridge: () => firstBridge,
    });
    const secondManager = new SyncManager({
      backgroundBridgeIO: secondHarness.io,
      currentBridge: () => secondBridge,
    });
    const firstIdentity = createPortableIdentityPlan(note, "server-ada");
    const secondIdentity = createPortableIdentityPlan(note, "server-ada");

    await Promise.all([
      firstManager.mutateBackgroundText(
        notePath,
        "server-ada",
        7,
        firstIdentity.plan,
        undefined,
        undefined,
        undefined,
        firstIdentity.reconcile,
      ),
      secondManager.mutateBackgroundText(
        notePath,
        "server-ada",
        7,
        secondIdentity.plan,
        undefined,
        undefined,
        undefined,
        secondIdentity.reconcile,
      ),
    ]);

    const firstInsertion = Y.encodeStateAsUpdate(firstBridge.doc, baseVector);
    const secondInsertion = Y.encodeStateAsUpdate(secondBridge.doc, baseVector);
    firstBridge.applyRemote(secondInsertion);
    secondBridge.applyRemote(firstInsertion);
    Y.applyUpdate(secondBridge.doc, Y.encodeStateAsUpdate(firstBridge.doc), "remote");
    Y.applyUpdate(firstBridge.doc, Y.encodeStateAsUpdate(secondBridge.doc), "remote");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.all([firstBridge.flushEgest(), secondBridge.flushEgest()]);

    expect(firstBridge.serialize()).toBe(secondBridge.serialize());
    expect(firstBridge.serialize().match(/noam_document_id:/g)).toHaveLength(1);
    expect(firstBridge.serialize()).toContain("noam_document_id: server-ada");
    expect(firstHarness.fs.get(notePath)).toBe(firstBridge.serialize());
    expect(secondHarness.fs.get(notePath)).toBe(secondBridge.serialize());
    firstBridge.destroy();
    secondBridge.destroy();
    base.destroy();
  });

  it("does not reconcile a remote duplicate after edit authorization is revoked", async () => {
    const notePath = "People/Ada.md";
    const note = "---\ntitle: Ada\n---\nBody\n";
    const { io } = makeHarness({ [notePath]: note });
    vaultScopes.begin({ orgId: "org-a", vaultPath: "/vaults/a", vaultEpoch: 7 });
    const bridge = await NoteBridge.open(io, {
      docId: "server-ada",
      path: notePath,
      seedFromFile: true,
    });
    const manager = new SyncManager({
      backgroundBridgeIO: io,
      currentBridge: () => bridge,
    });
    const identity = createPortableIdentityPlan(note, "server-ada");
    let allowed = true;
    const authorize = vi.fn(async () => allowed);
    await expect(manager.mutateBackgroundText(
      notePath,
      "server-ada",
      7,
      identity.plan,
      () => true,
      authorize,
      undefined,
      identity.reconcile,
    )).resolves.toEqual({ ok: true });

    const beforeRemote = Y.encodeStateVector(bridge.doc);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(bridge.doc));
    const remoteText = remote.getText("content");
    const close = remoteText.toString().indexOf("---\n", 4);
    remoteText.insert(close, "noam_document_id: server-ada\n");
    const duplicate = Y.encodeStateAsUpdate(remote, beforeRemote);
    const updatesBefore = bridge.updatesObserved;
    allowed = false;
    bridge.applyRemote(duplicate);
    await Promise.resolve();
    await Promise.resolve();

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(bridge.updatesObserved).toBe(updatesBefore + 1);
    expect(bridge.serialize().match(/noam_document_id:/g)).toHaveLength(2);
    bridge.destroy();
    remote.destroy();
  });

  it("creates a local identity without a sync VaultScope", async () => {
    const notePath = "People/Ada.md";
    const note = "---\ntitle: Ada\n---\nBody\n";
    const { io, fs } = makeHarness({ [notePath]: note });
    vaultScopes.end();
    const manager = new SyncManager({ backgroundBridgeIO: io });
    const identity = createPortableIdentityPlan(note, "local-ada");

    await expect(manager.mutateBackgroundText(
      notePath,
      "local-ada",
      7,
      identity.plan,
      () => true,
      undefined,
      undefined,
      identity.reconcile,
    )).resolves.toEqual({ ok: true });
    expect(fs.get(notePath)?.match(/noam_document_id:/g)).toHaveLength(1);
    expect(fs.get(notePath)).toContain("noam_document_id: local-ada");

    await expect(manager.mutateBackgroundText(
      notePath,
      "local-ada",
      7,
      identity.plan,
      () => false,
    )).resolves.toEqual({ ok: false, reason: "forbidden" });
    expect(fs.get(notePath)?.match(/noam_document_id:/g)).toHaveLength(1);
  });

  it("pins a no-scope mutation to its captured vault epoch", async () => {
    const notePath = "People/Ada.md";
    const note = "---\ntitle: Ada\n---\nBody\n";
    const intended = makeHarness({ [notePath]: note });
    const replacement = makeHarness({ [notePath]: note });
    const epochs: number[] = [];
    vaultScopes.end();
    const manager = new SyncManager({
      bridgeOwner: new BridgeManager(replacement.io),
      backgroundBridgeIOForEpoch: (epoch) => {
        epochs.push(epoch);
        return intended.io;
      },
    });
    const identity = createPortableIdentityPlan(note, "local-ada");

    await expect(manager.mutateBackgroundText(
      notePath,
      "local-ada",
      7,
      identity.plan,
    )).resolves.toEqual({ ok: true });
    expect(epochs).toEqual([7]);
    expect(intended.fs.get(notePath)).toContain("noam_document_id: local-ada");
    expect(replacement.fs.get(notePath)).toBe(note);
  });

  it("serializes a local identity mutation with opening the same note", async () => {
    const notePath = "People/Ada.md";
    const note = "---\ntitle: Ada\n---\nBody\n";
    const { io, fs } = makeHarness({ [notePath]: note });
    vaultScopes.begin({ orgId: null, vaultPath: "/vaults/a", vaultEpoch: 7 });
    const bridgeOwner = new BridgeManager(io);
    const manager = new SyncManager({ backgroundBridgeIO: io, bridgeOwner });
    const identity = createPortableIdentityPlan(note, "local-ada");

    const mutation = manager.mutateBackgroundText(notePath, "local-ada", 7, identity.plan);
    await Promise.resolve();
    const opening = bridgeOwner.openNote(notePath, "local-ada", { seedFromFile: true });
    const [result, opened] = await Promise.all([mutation, opening]);

    expect(result).toEqual({ ok: true });
    expect(opened.serialize()).toBe(fs.get(notePath));
    expect(opened.serialize().match(/noam_document_id:/g)).toHaveLength(1);
    await bridgeOwner.closeCurrent();
  });
});
