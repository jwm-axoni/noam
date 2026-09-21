import { describe, expect, it, vi } from "vitest";
import {
  hasRenameCollision,
  moveFailureMessage,
  moveFileTreeItem,
  moveFileTreeItems,
  renameCollisionMessage,
  type FileTreeRegistryFailure,
} from "./fileTreeFailures";
import { readItemOrder, writeItemOrder, type ItemOrder } from "../lib/ordering";

describe("file-tree failure feedback", () => {
  it.each(["disk", "server"])("persists successful moves and their subtree ranks when a later %s move fails", async (failureAt) => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    try {
      const initial: ItemOrder = {
        Source: ["Source/One", "Source/Two"],
        "Source/One": ["Source/One/z.md", "Source/One/a.md"],
        "Source/Two": ["Source/Two/keep.md"],
        Dest: ["Dest/Existing"],
      };
      writeItemOrder("fixture", initial);
      const onMoved = vi.fn(async () => {});
      const onFailure = vi.fn();
      const result = await moveFileTreeItems(
        ["Source/One", "Source/Two"],
        ["Dest/One", "Dest/Two"],
        { epoch: 7, destDir: "Dest", siblings: ["Dest/Existing"], index: 0, isDir: () => true, order: initial },
        {
          renameDisk: vi.fn(async (from) => {
            if (from === "Source/Two") {
              expect(readItemOrder("fixture")["Dest/One"]).toEqual([
                "Dest/One/z.md", "Dest/One/a.md",
              ]);
              if (failureAt === "disk") throw new Error("Permission denied");
            }
          }),
          renameServer: vi.fn(async (from, to) => from === "Source/Two"
            ? { ok: false as const, failure: { path: to, reason: "Permission denied", code: "no_write_access" } }
            : { ok: true as const }),
          setOrder: (order) => writeItemOrder("fixture", order),
          onMoved,
          onFailure,
        },
      );
      expect(result).toEqual({ movedOnDisk: true, refused: true });
      expect(onMoved).toHaveBeenCalledExactlyOnceWith("Source/One", "Dest/One");
      expect(onFailure).toHaveBeenCalledOnce();
      // Read the saved value as a fresh app session would, not an in-memory plan.
      expect(readItemOrder("fixture")).toEqual({
        Source: ["Source/Two"],
        "Dest/One": ["Dest/One/z.md", "Dest/One/a.md"],
        "Source/Two": ["Source/Two/keep.md"],
        Dest: ["Dest/One", "Dest/Existing"],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps later successes after an earlier refusal and does not pin the refused path", async () => {
    const setOrder = vi.fn();
    const onMoved = vi.fn(async () => {});
    await moveFileTreeItems(["A.md", "B.md"], ["Dest/A.md", "Dest/B.md"], {
      epoch: 7, destDir: "Dest", siblings: ["Dest/C.md"], index: 1,
      isDir: () => false, order: { "": ["A.md", "B.md"] },
    }, {
      renameDisk: vi.fn(async () => {}),
      renameServer: vi.fn(async (from, to) => from === "A.md"
        ? { ok: false as const, failure: { path: to, reason: "Refused", code: null } }
        : { ok: true as const }),
      setOrder, onMoved, onFailure: vi.fn(),
    });
    expect(setOrder).toHaveBeenLastCalledWith({ "": ["A.md"], Dest: ["Dest/C.md", "Dest/B.md"] });
    expect(onMoved).toHaveBeenCalledExactlyOnceWith("B.md", "Dest/B.md");
  });

  it("preserves a same-folder reorder without disk or server writes", async () => {
    const renameDisk = vi.fn();
    const renameServer = vi.fn();
    const setOrder = vi.fn();
    const result = await moveFileTreeItems(["B.md", "C.md"], ["B.md", "C.md"], {
      epoch: 7, destDir: "", siblings: ["A.md", "B.md", "C.md"], index: 0,
      isDir: () => false, order: {},
    }, { renameDisk, renameServer, setOrder, onMoved: vi.fn(), onFailure: vi.fn() });
    expect(result).toEqual({ movedOnDisk: false, refused: false });
    expect(renameDisk).not.toHaveBeenCalled();
    expect(renameServer).not.toHaveBeenCalled();
    expect(setOrder).toHaveBeenLastCalledWith({ "": ["B.md", "C.md", "A.md"] });
  });

  it("keeps ordering on the disk destination when a refused move cannot be restored", async () => {
    const setOrder = vi.fn();
    const onFailure = vi.fn();
    const onMoved = vi.fn();
    const result = await moveFileTreeItems(["A.md"], ["Dest/A.md"], {
      epoch: 7, destDir: "Dest", siblings: [], index: 0,
      isDir: () => false, order: { "": ["A.md"] },
    }, {
      renameDisk: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Disk unavailable")),
      renameServer: vi.fn().mockRejectedValue(new Error("Server unavailable")),
      setOrder, onMoved, onFailure,
    });
    expect(result).toEqual({ movedOnDisk: true, refused: true });
    expect(onMoved).toHaveBeenCalledExactlyOnceWith("A.md", "Dest/A.md");
    expect(setOrder).toHaveBeenCalledExactlyOnceWith({ "": [], Dest: ["Dest/A.md"] });
    expect(onFailure).toHaveBeenCalledWith("A.md", {
      ok: false, diskChanged: true, alreadyNotified: false,
      reason: "Server unavailable. Couldn't restore the local item: Disk unavailable",
    });
  });
  it("identifies an existing sibling and supplies the inline-title refusal", () => {
    const paths = ["Projects/First.md", "Projects/Taken.md"];

    expect(
      hasRenameCollision(paths, "Projects/First.md", "Projects/Taken.md"),
    ).toBe(true);
    expect(renameCollisionMessage("Taken", false)).toBe(
      'A note called "Taken" already exists here.',
    );
    // A case-only rename of the current item is not a sibling collision.
    expect(
      hasRenameCollision(paths, "Projects/First.md", "Projects/FIRST.md"),
    ).toBe(false);
  });

  it("rolls back a move the server refused and reports its reason", async () => {
    const renameDisk = vi.fn(async () => undefined);
    const renameServer = vi.fn(async (_from: string, to: string) => {
      const failure: FileTreeRegistryFailure = {
        path: to,
        reason: "You don't have write access.",
        code: "no_write_access",
      };
      return { ok: false as const, failure };
    });

    const result = await moveFileTreeItem(
      "Projects/Plan.md",
      "Archive/Plan.md",
      7,
      { renameDisk, renameServer },
    );

    expect(result).toEqual({
      ok: false,
      reason: "You don't have write access.",
      diskChanged: false,
      alreadyNotified: false,
    });
    expect(renameDisk.mock.calls).toEqual([
      ["Projects/Plan.md", "Archive/Plan.md", 7],
      ["Archive/Plan.md", "Projects/Plan.md", 7],
    ]);
    if (result.ok) throw new Error("expected the move to be refused");
    expect(moveFailureMessage("Projects/Plan.md", result.reason)).toBe(
      `Couldn't move "Plan.md" — You don't have write access.`,
    );
  });
});
