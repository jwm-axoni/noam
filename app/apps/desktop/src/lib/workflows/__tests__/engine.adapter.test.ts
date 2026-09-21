// The production host, with IPC, the store and the active-note registry mocked.
// The engine suites cover behaviour; this one covers the wiring decisions that
// only exist here — which write path an open note takes, where the revision
// comes from, and how permission is derived.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const ipcMock = vi.hoisted(() => ({
  readNote: vi.fn<(path: string, epoch?: unknown) => Promise<string>>(),
  writeNote: vi.fn<(path: string, content: string, epoch?: unknown) => Promise<void>>(),
  writeNoteIfMissing: vi.fn<(path: string, content: string, epoch?: unknown) => Promise<boolean>>(),
  writeNoteIfUnchanged:
    vi.fn<
      (path: string, expected: string, content: string, epoch?: unknown) =>
        Promise<{ ok: boolean; currentSha256: string }>
    >(),
  ensureFolder: vi.fn<(path: string, epoch?: unknown) => Promise<boolean>>(),
  getNoteMeta: vi.fn<(path: string, epoch?: unknown) => Promise<{ id: string } | null>>(),
  listTree: vi.fn(),
}));

const storeState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

const activeNote = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("../../ipc", () => ipcMock);
vi.mock("../../../store", () => ({
  useStore: { getState: () => storeState.current },
}));
vi.mock("../../editor/activeView", () => ({
  getActiveNote: () => activeNote.value,
  insertIntoActiveNote: vi.fn(() => true),
}));
vi.mock("../../locks", () => ({
  lockScopesByPath: () => new Map<string, string>(Object.entries(storeState.current.lockMap ?? {})),
  effectiveLockForPath: (map: Map<string, string>, path: string) => map.get(path) ?? null,
}));

const { createVaultCommandService, createWorkflowHost, permissionForPath } = await import("../adapter");

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/** A stand-in for the live CodeMirror view: just enough of the surface used. */
function fakeView(text: string, readOnly = false) {
  const dispatched: Array<{ from: number; to: number; insert: string }> = [];
  const view = {
    state: { doc: { toString: () => text, length: text.length }, readOnly },
    dispatch: (tr: { changes: { from: number; to: number; insert: string } }) => {
      dispatched.push(tr.changes);
      const next = text.slice(0, tr.changes.from) + tr.changes.insert + text.slice(tr.changes.to);
      text = next;
      view.state.doc.toString = () => text;
      view.state.doc.length = text.length;
    },
  };
  return { view, dispatched, current: () => text };
}

beforeEach(() => {
  vi.clearAllMocks();
  activeNote.value = null;
  storeState.current = {
    vault: { epoch: 7, path: "/vault" },
    syncEnabled: false,
    syncStatus: "offline",
    openNote: null,
    tree: null,
    locks: [],
    lifts: [],
    session: null,
    rootFrozen: false,
    openNoteByPath: vi.fn(async () => {}),
  };
  ipcMock.getNoteMeta.mockResolvedValue({ id: "doc-1" });
  ipcMock.ensureFolder.mockResolvedValue(true);
  ipcMock.writeNoteIfMissing.mockResolvedValue(true);
  ipcMock.writeNote.mockResolvedValue(undefined);
  ipcMock.writeNoteIfUnchanged.mockResolvedValue({ ok: true, currentSha256: "" });
});

describe("resolveTarget", () => {
  it("reports a closed note from disk, with the file's hash as the revision", async () => {
    ipcMock.readNote.mockResolvedValue("body\n");
    const target = await createWorkflowHost().resolveTarget("Notes/A.md");
    expect(target).toEqual({
      path: "Notes/A.md",
      docId: "doc-1",
      exists: true,
      permission: "edit",
      revision: sha("body\n"),
    });
    expect(ipcMock.readNote).toHaveBeenCalledWith("Notes/A.md", 7);
  });

  it("reports a missing note rather than throwing", async () => {
    ipcMock.readNote.mockRejectedValue(new Error("no such file"));
    const target = await createWorkflowHost().resolveTarget("Notes/Gone.md");
    expect(target.exists).toBe(false);
    expect(target.revision).toBeNull();
  });

  it("takes the revision from the LIVE document when the note is open", async () => {
    const { view } = fakeView("live text");
    activeNote.value = { path: "Notes/A.md", editorView: view };
    ipcMock.readNote.mockResolvedValue("stale file text");
    const target = await createWorkflowHost().resolveTarget("Notes/A.md");
    expect(target.revision).toBe(sha("live text"));
    expect(ipcMock.readNote).not.toHaveBeenCalled();
  });
});

describe("replaceRange", () => {
  it("dispatches a transaction on the live view for an open note", async () => {
    const { view, dispatched, current } = fakeView("one\ntwo\n");
    activeNote.value = { path: "Notes/A.md", editorView: view };
    const result = await createWorkflowHost().replaceRange("Notes/A.md", sha("one\ntwo\n"), 8, 8, "three\n");
    expect(result).toEqual({ ok: true, revision: sha("one\ntwo\nthree\n") });
    expect(dispatched).toEqual([{ from: 8, to: 8, insert: "three\n" }]);
    expect(current()).toBe("one\ntwo\nthree\n");
    // The live buffer is the source of truth while a note is open: no file write.
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
  });

  it("refuses a live write whose revision moved", async () => {
    const { view, dispatched } = fakeView("one\n");
    activeNote.value = { path: "Notes/A.md", editorView: view };
    const result = await createWorkflowHost().replaceRange("Notes/A.md", sha("something else"), 0, 0, "x");
    expect(result).toEqual({ ok: false, kind: "stale-target", message: expect.any(String) });
    expect(dispatched).toEqual([]);
  });

  it("refuses a live write into a read-only view", async () => {
    const { view } = fakeView("one\n", true);
    activeNote.value = { path: "Notes/A.md", editorView: view };
    const result = await createWorkflowHost().replaceRange("Notes/A.md", sha("one\n"), 0, 0, "x");
    expect(result).toMatchObject({ ok: false, kind: "read-only" });
  });

  it("writes the file for a closed note, conditionally on the revision", async () => {
    ipcMock.readNote.mockResolvedValue("one\n");
    const result = await createWorkflowHost().replaceRange("Notes/A.md", sha("one\n"), 4, 4, "two\n");
    expect(result).toEqual({ ok: true, revision: sha("one\ntwo\n") });
    // The guarded write, never the plain one: the compare and the write have to
    // be one operation or an external writer fits between them.
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
    expect(ipcMock.writeNoteIfUnchanged).toHaveBeenCalledWith(
      "Notes/A.md",
      sha("one\n"),
      "one\ntwo\n",
      7,
    );
  });

  it("refuses a file write whose revision moved, without writing", async () => {
    ipcMock.readNote.mockResolvedValue("someone else got here first\n");
    const result = await createWorkflowHost().replaceRange("Notes/A.md", sha("one\n"), 0, 0, "x");
    expect(result).toMatchObject({ ok: false, kind: "stale-target" });
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
    expect(ipcMock.writeNoteIfUnchanged).not.toHaveBeenCalled();
  });

  it("reports the write Rust refused as stale, and never writes twice", async () => {
    ipcMock.readNote.mockResolvedValue("one\n");
    // The file changed between this renderer's read and Rust taking the lock.
    ipcMock.writeNoteIfUnchanged.mockResolvedValue({
      ok: false,
      currentSha256: sha("theirs\n"),
    });
    const result = await createWorkflowHost().replaceRange("Notes/A.md", sha("one\n"), 4, 4, "two\n");
    expect(result).toMatchObject({ ok: false, kind: "stale-target" });
    expect(ipcMock.writeNoteIfUnchanged).toHaveBeenCalledTimes(1);
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
  });
});

describe("a host pinned to its vault", () => {
  /** Swap the store's vault the way `openVault` does mid-run. */
  const switchVault = () => {
    storeState.current.vault = { epoch: 8, path: "/other" };
  };

  beforeEach(() => {
    storeState.current.vault = { epoch: 7, path: "/vault" };
  });

  it("refuses a closed-note write after the vault changed", async () => {
    ipcMock.readNote.mockResolvedValue("one\n");
    const host = createWorkflowHost();
    switchVault();
    const result = await host.replaceRange("Notes/A.md", sha("one\n"), 4, 4, "two\n");
    expect(result).toMatchObject({ ok: false, kind: "stale-target" });
    expect(ipcMock.writeNoteIfUnchanged).not.toHaveBeenCalled();
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
  });

  it("refuses a live write after the vault changed", async () => {
    const { view, dispatched } = fakeView("one\n");
    activeNote.value = { path: "Notes/A.md", editorView: view };
    const host = createWorkflowHost();
    switchVault();
    const result = await host.replaceRange("Notes/A.md", sha("one\n"), 0, 0, "x");
    expect(result).toMatchObject({ ok: false, kind: "stale-target" });
    expect(dispatched).toEqual([]);
  });

  it("refuses a create after the vault changed", async () => {
    const host = createWorkflowHost();
    switchVault();
    await expect(host.createNote("Notes/A.md", "# hi\n")).rejects.toThrow(/vault/i);
    expect(ipcMock.writeNoteIfMissing).not.toHaveBeenCalled();
    expect(ipcMock.ensureFolder).not.toHaveBeenCalled();
  });

  it("resolves a target in another vault as forbidden, without reading it", async () => {
    const host = createWorkflowHost();
    switchVault();
    const target = await host.resolveTarget("Notes/A.md");
    expect(target).toMatchObject({ permission: "none", revision: null });
    expect(target.permissionReason).toMatch(/vault/i);
    expect(ipcMock.readNote).not.toHaveBeenCalled();
  });

  it("still passes the epoch it was built with to every call", async () => {
    ipcMock.readNote.mockResolvedValue("one\n");
    const host = createWorkflowHost();
    await host.resolveTarget("Notes/A.md");
    expect(ipcMock.readNote).toHaveBeenCalledWith("Notes/A.md", 7);
    expect(ipcMock.getNoteMeta).toHaveBeenCalledWith("Notes/A.md", 7);
  });
});

describe("permissionForPath", () => {
  it("is edit in a local vault, whatever the lock overlay says", () => {
    storeState.current.lockMap = { "Notes/A.md": "all" };
    expect(permissionForPath("Notes/A.md")).toBe("edit");
  });

  it("is view for a locked path in a synced vault", () => {
    storeState.current.syncEnabled = true;
    storeState.current.syncStatus = "synced";
    storeState.current.lockMap = { "Notes/A.md": "all" };
    expect(permissionForPath("Notes/A.md")).toBe("view");
    expect(permissionForPath("Notes/B.md")).toBe("edit");
  });

  // `syncStatus` is the OPEN note's verdict — a per-document view grant — not a
  // vault posture. A workflow triggered while reading a view-only note must
  // still be able to write to a different note this user may edit.
  it("applies a read-only sync status to the open note alone", () => {
    storeState.current.syncEnabled = true;
    storeState.current.syncStatus = "read-only";
    storeState.current.openNote = { path: "Notes/A.md" };
    expect(permissionForPath("Notes/A.md")).toBe("view");
    expect(permissionForPath("Notes/B.md")).toBe("edit");
  });

  it("applies a no-access sync status to the open note alone", () => {
    storeState.current.syncEnabled = true;
    storeState.current.syncStatus = "no-access";
    storeState.current.openNote = { path: "Notes/A.md" };
    expect(permissionForPath("Notes/B.md")).toBe("edit");
  });

  it("is none for the open note the server refused", () => {
    storeState.current.syncEnabled = true;
    storeState.current.syncStatus = "no-access";
    storeState.current.openNote = { path: "Notes/A.md" };
    expect(permissionForPath("Notes/A.md")).toBe("none");
  });
});

describe("createNote and preserveCapture", () => {
  it("makes the folder first and refuses to overwrite", async () => {
    const host = createWorkflowHost();
    await host.createNote("Journal/2026-03-09.md", "# hi\n");
    expect(ipcMock.ensureFolder).toHaveBeenCalledWith("Journal", 7);
    expect(ipcMock.writeNoteIfMissing).toHaveBeenCalledWith("Journal/2026-03-09.md", "# hi\n", 7);

    ipcMock.writeNoteIfMissing.mockResolvedValueOnce(false);
    await expect(host.createNote("Journal/2026-03-09.md", "x")).rejects.toThrow(/appeared/);
  });

  describe("while the vault's root is frozen", () => {
    beforeEach(() => {
      storeState.current.rootFrozen = true;
      storeState.current.tree = {
        path: "",
        isDir: true,
        children: [{ path: "Journal", isDir: true, children: [] }],
      };
    });

    it("refuses a root-level create as a permission failure the engine can report", async () => {
      ipcMock.readNote.mockRejectedValue(new Error("no such file"));
      const target = await createWorkflowHost().resolveTarget("Top.md");
      expect(target.permission).toBe("none");
      expect(target.permissionReason).toMatch(/root is frozen/i);

      await expect(createWorkflowHost().createNote("Top.md", "x")).rejects.toThrow(/root is frozen/i);
      expect(ipcMock.writeNoteIfMissing).not.toHaveBeenCalled();
    });

    it("refuses a create that would make a new top-level folder", async () => {
      await expect(
        createWorkflowHost().createNote("NewFolder/note.md", "x"),
      ).rejects.toThrow(/NewFolder/);
      expect(ipcMock.ensureFolder).not.toHaveBeenCalled();
      expect(ipcMock.writeNoteIfMissing).not.toHaveBeenCalled();
    });

    it("allows a create inside a folder that already exists", async () => {
      await createWorkflowHost().createNote("Journal/2026-03-09.md", "# hi\n");
      expect(ipcMock.writeNoteIfMissing).toHaveBeenCalledWith("Journal/2026-03-09.md", "# hi\n", 7);
      expect(permissionForPath("Journal/2026-03-09.md")).toBe("edit");
    });

    it("leaves an existing root note editable — the latch is about creating", async () => {
      ipcMock.readNote.mockResolvedValue("body\n");
      const target = await createWorkflowHost().resolveTarget("Top.md");
      expect(target.exists).toBe(true);
      expect(target.permission).toBe("edit");
    });
  });

  it("parks an unwritable capture under Captures/, create-only", async () => {
    const at = await createWorkflowHost().preserveCapture("daily-log", "- the text I typed");
    expect(at).toMatch(/^Captures\/Unsaved capture \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.md$/);
    const [, body] = ipcMock.writeNoteIfMissing.mock.calls[0]!;
    expect(body).toContain("workflow: daily-log");
    expect(body).toContain("- the text I typed");
  });

  it("takes the next suffix rather than overwriting an existing capture", async () => {
    ipcMock.writeNoteIfMissing.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const at = await createWorkflowHost().preserveCapture("daily-log", "x");
    expect(at).toMatch(/ 2\.md$/);
  });
});

describe("createVaultCommandService", () => {
  it("scans only .md files out of the Rust tree", async () => {
    ipcMock.listTree.mockResolvedValue({
      path: "",
      isDir: true,
      children: [
        { path: "Notes", isDir: true, children: [{ path: "Notes/A.md", isDir: false }] },
        { path: "image.png", isDir: false },
        { path: "Workflows/W.md", isDir: false },
      ],
    });
    ipcMock.readNote.mockResolvedValue("# not a workflow\n");
    const service = createVaultCommandService();
    await service.refresh();
    expect(ipcMock.readNote.mock.calls.map((c) => c[0])).toEqual(["Notes/A.md", "Workflows/W.md"]);
    expect(service.list()).toEqual([]);
  });
});
