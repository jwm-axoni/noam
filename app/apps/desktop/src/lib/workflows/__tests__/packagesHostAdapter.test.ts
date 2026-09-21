// The production `PackageHost`: a thin map onto `src/lib/ipc.ts`.
//
// The one decision worth pinning here is where the recovery record goes. It
// must NOT go into the vault (it would show up in the sidebar, the index and
// the sync registry) and no IPC command can write an arbitrary file under
// `.context/` — `write_binary_file` refuses anything outside `attachments/`,
// and `write_note` would index what it wrote. So the record is device-local,
// in `localStorage`, and these tests assert that nothing reaches the disk.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  noteExists: vi.fn(),
  readNote: vi.fn(),
  readBinaryFile: vi.fn(),
  writeNote: vi.fn(),
  writeBinaryFile: vi.fn(),
  deleteFile: vi.fn(),
  ensureFolder: vi.fn(),
}));

/** The two things a Markdown write has to obey: the app's permissions, and the
 *  live editor when the destination is the note on screen. */
const app = vi.hoisted(() => ({
  permission: "edit" as "edit" | "view" | "none",
  activeNote: null as unknown,
}));

vi.mock("../../ipc", () => mocks);
vi.mock("../adapter", () => ({ permissionForPath: () => app.permission }));
vi.mock("../../editor/activeView", () => ({ getActiveNote: () => app.activeNote }));

import type { ImportRecoveryRecord } from "../contracts";
import {
  createPackageHost,
  listRecoveryRecords,
  memoryRecoveryStore,
} from "../packages/hostAdapter";

const record: ImportRecoveryRecord = {
  packageId: "starter-pack",
  startedAt: "2026-09-20T10:00:00.000Z",
  originals: [{ path: "Templates/Daily.md", sha256: null, content: null, encoding: "utf8" }],
  written: [],
};

/** Just enough of a CodeMirror view for the whole-document replacement. */
function fakeView(text: string, readOnly = false) {
  const dispatched: Array<{ from: number; to: number; insert: string }> = [];
  const view = {
    state: { doc: { toString: () => text, length: text.length }, readOnly },
    dispatch: (tr: { changes: { from: number; to: number; insert: string } }) => {
      dispatched.push(tr.changes);
      text = text.slice(0, tr.changes.from) + tr.changes.insert + text.slice(tr.changes.to);
    },
  };
  return { view, dispatched, current: () => text };
}

describe("the production package host", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    app.permission = "edit";
    app.activeNote = null;
  });

  it("maps every file operation onto the vault-scoped IPC commands", async () => {
    const host = createPackageHost({ appVersion: "0.1.59", epoch: 7 });
    mocks.noteExists.mockResolvedValue(true);
    mocks.readNote.mockResolvedValue("# hello\n");
    mocks.readBinaryFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mocks.writeNote.mockResolvedValue(undefined);
    mocks.writeBinaryFile.mockResolvedValue(undefined);
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.ensureFolder.mockResolvedValue(true);

    expect(await host.exists("Templates/Daily.md")).toBe(true);
    expect(await host.readText("Templates/Daily.md")).toBe("# hello\n");
    expect(await host.readBytes("attachments/a.png")).toEqual(new Uint8Array([1, 2, 3]));
    await host.writeText("Templates/Daily.md", "# hi\n");
    await host.writeBytes("attachments/a.png", new Uint8Array([4]));
    await host.remove("Templates/Daily.md");
    await host.ensureFolder("Templates");

    expect(mocks.noteExists).toHaveBeenCalledWith("Templates/Daily.md", 7);
    expect(mocks.writeNote).toHaveBeenCalledWith("Templates/Daily.md", "# hi\n", 7);
    expect(mocks.writeBinaryFile).toHaveBeenCalledWith("attachments/a.png", new Uint8Array([4]), 7);
    expect(mocks.deleteFile).toHaveBeenCalledWith("Templates/Daily.md", 7);
    expect(mocks.ensureFolder).toHaveBeenCalledWith("Templates", 7);
    expect(host.appVersion()).toBe("0.1.59");
  });

  it("answers null for a file it cannot read instead of throwing", async () => {
    const host = createPackageHost({ appVersion: "0.1.59" });
    mocks.readNote.mockRejectedValue(new Error("no such file"));
    mocks.readBinaryFile.mockRejectedValue(new Error("no such file"));
    mocks.noteExists.mockRejectedValue(new Error("no vault"));

    expect(await host.readText("Nope.md")).toBeNull();
    expect(await host.readBytes("Nope.png")).toBeNull();
    expect(await host.exists("Nope.md")).toBe(false);
  });

  it("refuses a Markdown write the app says is read-only, so the import rolls back", async () => {
    const host = createPackageHost({ appVersion: "0.1.59", epoch: 7 });
    app.permission = "view";

    await expect(host.writeText("Notes/Locked.md", "# imported\n")).rejects.toThrow(/read-only/i);
    expect(mocks.writeNote).not.toHaveBeenCalled();

    app.permission = "none";
    await expect(host.writeText("Notes/Locked.md", "# imported\n")).rejects.toThrow(/access/i);
    expect(mocks.writeNote).not.toHaveBeenCalled();
  });

  it("writes through the live editor when the destination is the open note", async () => {
    const host = createPackageHost({ appVersion: "0.1.59", epoch: 7 });
    const before = "# mine\n\nsomething I was typing\n";
    const { view, dispatched, current } = fakeView(before);
    app.activeNote = { path: "Templates/Daily.md", editorView: view };

    await host.writeText("Templates/Daily.md", "# imported\n");

    // ONE transaction over the whole document: Yjs, the bridge and every open
    // teammate see it as they see a keystroke.
    expect(dispatched).toEqual([{ from: 0, to: before.length, insert: "# imported\n" }]);
    expect(current()).toBe("# imported\n");
    expect(mocks.writeNote).not.toHaveBeenCalled();
  });

  it("refuses to write behind a read-only live editor", async () => {
    const host = createPackageHost({ appVersion: "0.1.59" });
    const { view, dispatched } = fakeView("# mine\n", true);
    app.activeNote = { path: "Templates/Daily.md", editorView: view };

    await expect(host.writeText("Templates/Daily.md", "x")).rejects.toThrow(/read-only/i);
    expect(dispatched).toEqual([]);
    expect(mocks.writeNote).not.toHaveBeenCalled();
  });

  it("writes the file for a Markdown note that is not the open one", async () => {
    const host = createPackageHost({ appVersion: "0.1.59", epoch: 7 });
    app.activeNote = { path: "Notes/Other.md", editorView: fakeView("x").view };
    mocks.writeNote.mockResolvedValue(undefined);

    await host.writeText("Templates/Daily.md", "# imported\n");

    expect(mocks.writeNote).toHaveBeenCalledWith("Templates/Daily.md", "# imported\n", 7);
  });

  it("keeps the recovery record device-local: nothing is written to the vault", async () => {
    const store = memoryRecoveryStore();
    const host = createPackageHost({ appVersion: "0.1.59", vaultKey: "vault-1", recoveryStore: store });

    const path = await host.writeRecoveryRecord(record);

    expect(path).toContain("starter-pack");
    expect(mocks.writeNote).not.toHaveBeenCalled();
    expect(mocks.writeBinaryFile).not.toHaveBeenCalled();
    expect(listRecoveryRecords(store)).toEqual([
      { path, record: expect.objectContaining({ packageId: "starter-pack" }) },
    ]);

    await host.deleteRecoveryRecord(path);
    expect(listRecoveryRecords(store)).toEqual([]);
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it("overwrites the record in place as the import proceeds", async () => {
    const store = memoryRecoveryStore();
    const host = createPackageHost({ appVersion: "0.1.59", recoveryStore: store });

    const first = await host.writeRecoveryRecord(record);
    const second = await host.writeRecoveryRecord({ ...record, written: ["Templates/Daily.md"] });

    expect(second).toBe(first);
    expect(listRecoveryRecords(store)).toHaveLength(1);
    expect(listRecoveryRecords(store)[0].record.written).toEqual(["Templates/Daily.md"]);
  });

  it("refuses a record it cannot store, so the import refuses too", async () => {
    const host = createPackageHost({
      appVersion: "0.1.59",
      recoveryStore: {
        read: () => null,
        write: () => {
          throw new Error("QuotaExceededError");
        },
        remove: () => undefined,
        keys: () => [],
      },
    });

    await expect(host.writeRecoveryRecord(record)).rejects.toThrow(/recovery record/i);
  });
});
