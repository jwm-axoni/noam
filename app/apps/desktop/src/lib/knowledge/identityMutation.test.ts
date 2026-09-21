import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getNoteMeta: vi.fn(),
  inspectDocumentIdentity: vi.fn(),
  mutateBackgroundText: vi.fn(),
  readNote: vi.fn(),
  sha256Hex: vi.fn(),
  syncToken: vi.fn(),
}));

vi.mock("../ipc", () => ({
  getNoteMeta: mocks.getNoteMeta,
  inspectDocumentIdentity: mocks.inspectDocumentIdentity,
  readNote: mocks.readNote,
}));

vi.mock("../bridge/adapter", () => ({
  sha256Hex: mocks.sha256Hex,
}));

vi.mock("../sync/docSession", () => ({
  syncManager: { mutateBackgroundText: mocks.mutateBackgroundText },
}));

vi.mock("../auth/authManager", () => ({
  authManager: {
    api: { syncToken: mocks.syncToken },
    getServerUrl: () => "http://localhost",
  },
  api: { syncToken: mocks.syncToken },
}));

import { useStore } from "../../store";
import {
  createPortableIdentityPlan,
  ensureWritableDocumentIdentity,
} from "./identityMutation";

const input = {
  path: "People/Ada.md",
  expectedSourceRevision: "revision-1",
  expectedEpoch: 7,
};

describe("portable identity planning", () => {
  it("adopts a valid identity added after preflight", () => {
    const baseline = "---\ntitle: Ada\n---\nBody\n";
    const live = "---\ntitle: Ada\nnoam_document_id: chosen-id\n---\nBody\n";
    const identity = createPortableIdentityPlan(baseline, "local-ada");

    expect(identity.plan(live)).toEqual({ ok: true, changes: [] });
    expect(identity.resolvedDocumentId()).toBe("chosen-id");
    expect(identity.reconcile(live)).toEqual({ ok: true, changes: [] });
  });

  it("rejects conflicting identities added after preflight", () => {
    const baseline = "---\ntitle: Ada\n---\nBody\n";
    const live = [
      "---",
      "title: Ada",
      "noam_document_id: first-id",
      "noam_document_id: second-id",
      "---",
      "Body",
      "",
    ].join("\n");
    const identity = createPortableIdentityPlan(baseline, "local-ada");

    expect(identity.plan(live)).toEqual({ ok: false, reason: "conflict" });
    expect(identity.resolvedDocumentId()).toBeNull();
  });

  it("refuses to reconcile different valid identities", () => {
    const baseline = "---\ntitle: Ada\n---\nBody\n";
    const merged = [
      "---",
      "title: Ada",
      "noam_document_id: server-ada",
      "noam_document_id: chosen-id",
      "---",
      "Body",
      "",
    ].join("\n");
    const identity = createPortableIdentityPlan(baseline, "server-ada");

    expect(identity.plan(baseline)).toMatchObject({ ok: true });
    expect(identity.reconcile(merged)).toEqual({ ok: false, reason: "conflict" });
  });
});

describe("writable document identity", () => {
  beforeEach(() => {
    mocks.getNoteMeta.mockReset().mockResolvedValue({ id: "local-ada", sha256: "revision-1" });
    mocks.inspectDocumentIdentity.mockReset();
    mocks.mutateBackgroundText.mockReset();
    mocks.readNote.mockReset().mockResolvedValue("---\ntitle: Ada\n---\nBody\n");
    mocks.sha256Hex.mockReset().mockResolvedValue("revision-1");
    mocks.syncToken.mockReset();
    useStore.setState({
      vault: { path: "/vault-a", name: "vault-a", epoch: 7 },
      syncEnabled: true,
      docIdByPath: { "People/Ada.md": "server-ada" },
    });
  });

  it("rejects a stale local-only epoch before reading or writing the path", async () => {
    useStore.setState({
      vault: { path: "/vault-a", name: "vault-a", epoch: 8 },
      syncEnabled: false,
      docIdByPath: {},
    });

    await expect(ensureWritableDocumentIdentity(input)).rejects.toMatchObject({
      code: "stale_edit",
    });
    expect(mocks.getNoteMeta).not.toHaveBeenCalled();
    expect(mocks.mutateBackgroundText).not.toHaveBeenCalled();
  });

  it("allows a view-only relationship target when the identity already exists", async () => {
    mocks.inspectDocumentIdentity.mockResolvedValue({
      documentId: "portable-existing",
      sourceRevision: "revision-1",
      sourceFileIdentity: "file-1",
      insertionRequired: false,
    });

    await expect(ensureWritableDocumentIdentity(input)).resolves.toMatchObject({
      documentId: "portable-existing",
    });
    expect(mocks.syncToken).not.toHaveBeenCalled();
    expect(mocks.mutateBackgroundText).not.toHaveBeenCalled();
  });

  it("refuses a view-only target before mutating when an identity is missing", async () => {
    mocks.inspectDocumentIdentity.mockResolvedValue({
      documentId: "server-ada",
      sourceRevision: "revision-1",
      sourceFileIdentity: "file-1",
      insertionRequired: true,
    });
    mocks.syncToken.mockResolvedValue({
      token: "token",
      docId: "server-ada",
      vaultId: "vault-a",
      readOnly: true,
      permission: "view",
    });

    await expect(ensureWritableDocumentIdentity(input)).rejects.toMatchObject({
      code: "read_only",
    });
    expect(mocks.readNote).not.toHaveBeenCalled();
    expect(mocks.mutateBackgroundText).not.toHaveBeenCalled();
  });

  it("uses the mapped identity and shared writer after edit permission resolves", async () => {
    mocks.getNoteMeta
      .mockResolvedValueOnce({ id: "local-ada", sha256: "revision-1" })
      .mockResolvedValueOnce({ id: "local-ada", sha256: "revision-2" });
    mocks.inspectDocumentIdentity
      .mockResolvedValueOnce({
        documentId: "server-ada",
        sourceRevision: "revision-1",
        sourceFileIdentity: "file-1",
        insertionRequired: true,
      })
      .mockResolvedValueOnce({
        documentId: "server-ada",
        sourceRevision: "revision-2",
        sourceFileIdentity: "file-2",
        insertionRequired: false,
      });
    mocks.syncToken.mockResolvedValue({
      token: "token",
      docId: "server-ada",
      vaultId: "vault-a",
      readOnly: false,
      permission: "edit",
    });
    mocks.mutateBackgroundText.mockImplementation(
      async (_path, _docId, _epoch, plan, isAllowed, authorize) => {
        expect(await authorize()).toBe(true);
        expect(isAllowed()).toBe(true);
        const result = plan("---\ntitle: Ada\n---\nBody\n");
        expect(result).toMatchObject({ ok: true });
        return { ok: true };
      },
    );

    await expect(ensureWritableDocumentIdentity(input)).resolves.toMatchObject({
      documentId: "server-ada",
      sourceRevision: "revision-2",
    });
    expect(mocks.inspectDocumentIdentity).toHaveBeenNthCalledWith(
      1,
      "People/Ada.md",
      "local-ada",
      "server-ada",
      "revision-1",
      7,
    );
    expect(mocks.mutateBackgroundText).toHaveBeenCalledWith(
      "People/Ada.md",
      "server-ada",
      7,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      "file-1",
      expect.any(Function),
    );
  });

  it("uses the canonical local note id for both portable identity and Yjs persistence", async () => {
    useStore.setState({ syncEnabled: false, docIdByPath: {} });
    mocks.getNoteMeta
      .mockResolvedValueOnce({ id: "local-ada", sha256: "revision-1" })
      .mockResolvedValueOnce({ id: "local-ada", sha256: "revision-2" });
    mocks.inspectDocumentIdentity
      .mockResolvedValueOnce({
        documentId: "local-ada",
        sourceRevision: "revision-1",
        sourceFileIdentity: "file-1",
        insertionRequired: true,
      })
      .mockResolvedValueOnce({
        documentId: "local-ada",
        sourceRevision: "revision-2",
        sourceFileIdentity: "file-2",
        insertionRequired: false,
      });
    mocks.mutateBackgroundText.mockImplementation(async (_path, docId, _epoch, plan) => {
      expect(docId).toBe("local-ada");
      expect(plan("---\ntitle: Ada\n---\nBody\n")).toMatchObject({ ok: true });
      return { ok: true };
    });

    await expect(ensureWritableDocumentIdentity(input)).resolves.toMatchObject({
      documentId: "local-ada",
    });
    expect(mocks.inspectDocumentIdentity).toHaveBeenNthCalledWith(
      1,
      "People/Ada.md",
      "local-ada",
      null,
      "revision-1",
      7,
    );
  });

  it("rechecks synced edit authority after acquiring the shared writer", async () => {
    mocks.inspectDocumentIdentity.mockResolvedValue({
      documentId: "server-ada",
      sourceRevision: "revision-1",
      sourceFileIdentity: "file-1",
      insertionRequired: true,
    });
    mocks.syncToken
      .mockResolvedValueOnce({
        token: "token",
        docId: "server-ada",
        vaultId: "vault-a",
        readOnly: false,
        permission: "edit",
      })
      .mockResolvedValueOnce({
        token: "token",
        docId: "server-ada",
        vaultId: "vault-a",
        readOnly: true,
        permission: "view",
      });
    mocks.mutateBackgroundText.mockImplementation(
      async (_path, _docId, _epoch, _plan, _isAllowed, authorize) => (
        (await authorize()) ? { ok: true } : { ok: false, reason: "forbidden" }
      ),
    );

    await expect(ensureWritableDocumentIdentity(input)).rejects.toMatchObject({
      code: "read_only",
    });
    expect(mocks.syncToken).toHaveBeenCalledTimes(2);
  });
});
