// Per-folder sort overrides: storage, and the path bookkeeping that stands in
// for a folder id (see the header of `folderSorts.ts`).
import { afterEach, describe, expect, it } from "vitest";
import {
  dropFolderSorts,
  readFolderSorts,
  remapFolderSorts,
  setFolderSortAt,
  writeFolderSorts,
} from "../folderSorts";
import { readTreeSort } from "../../prefs";
import { sortTree, type FolderSorts } from "../sort";
import type { TreeNode } from "../../ipc";

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  return store;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("global sort preference", () => {
  // An install from before the new modes saved one of these two strings; it
  // must come back as the same choice, not as the default.
  it("loads the legacy ids", () => {
    stubStorage({ "context.treeSort": "name" });
    expect(readTreeSort()).toBe("name");
    stubStorage({ "context.treeSort": "recent" });
    expect(readTreeSort()).toBe("recent");
  });

  it("loads the new ids, and falls back to newest-first for junk or nothing", () => {
    stubStorage({ "context.treeSort": "name-desc" });
    expect(readTreeSort()).toBe("name-desc");
    stubStorage({ "context.treeSort": "modified-asc" });
    expect(readTreeSort()).toBe("modified-asc");
    stubStorage({ "context.treeSort": "sideways" });
    expect(readTreeSort()).toBe("recent");
    stubStorage();
    expect(readTreeSort()).toBe("recent");
  });
});

describe("folder sort storage", () => {
  it("round-trips per vault, and vaults don't share overrides", () => {
    stubStorage();
    writeFolderSorts("/v/one", { Work: "name-desc" });
    expect(readFolderSorts("/v/one")).toEqual({ Work: "name-desc" });
    expect(readFolderSorts("/v/two")).toEqual({});
    expect(readFolderSorts(undefined)).toEqual({});
  });

  it("drops values that are not sorts we offer, and survives garbage", () => {
    stubStorage({
      "context.folderSorts:/v": JSON.stringify({ A: "name", B: "created-desc", C: 7 }),
      "context.folderSorts:/broken": "{not json",
    });
    expect(readFolderSorts("/v")).toEqual({ A: "name" });
    expect(readFolderSorts("/broken")).toEqual({});
  });
});

describe("setFolderSortAt", () => {
  it("sets, replaces and clears one folder", () => {
    let s: FolderSorts = {};
    s = setFolderSortAt(s, "Work", "name");
    s = setFolderSortAt(s, "Home", "recent");
    s = setFolderSortAt(s, "Work", "modified-asc");
    expect(s).toEqual({ Work: "modified-asc", Home: "recent" });
    expect(setFolderSortAt(s, "Work", null)).toEqual({ Home: "recent" });
  });

  it("returns the same object for a no-op", () => {
    const s: FolderSorts = { Work: "name" };
    expect(setFolderSortAt(s, "Work", "name")).toBe(s);
    expect(setFolderSortAt(s, "Other", null)).toBe(s);
  });
});

describe("remapFolderSorts — the override follows a rename or move", () => {
  const sorts: FolderSorts = {
    Work: "name-desc",
    "Work/Sub": "recent",
    "Workshop": "modified-asc",
    Home: "name",
  };

  it("re-points the folder and everything under it, and nothing else", () => {
    expect(remapFolderSorts(sorts, "Work", "Archive/Job")).toEqual({
      "Archive/Job": "name-desc",
      "Archive/Job/Sub": "recent",
      // A sibling that merely shares the prefix stays put.
      Workshop: "modified-asc",
      Home: "name",
    });
  });

  it("returns the same object when nothing matched (e.g. a note rename)", () => {
    expect(remapFolderSorts(sorts, "Work/a.md", "Work/b.md")).toBe(sorts);
  });

  it("still sorts the renamed folder by its override", () => {
    const child = (path: string, modified: number): TreeNode => ({
      id: path,
      name: path.split("/").pop()!,
      path,
      isDir: false,
      modified,
    });
    const renamed: TreeNode[] = [
      {
        id: "Job",
        name: "Job",
        path: "Job",
        isDir: true,
        childrenLoaded: true,
        children: [child("Job/a.md", 1), child("Job/b.md", 2)],
      },
    ];
    const moved = remapFolderSorts({ Work: "name-desc" }, "Work", "Job");
    expect(sortTree(renamed, "name", moved)[0].children!.map((n) => n.name)).toEqual([
      "b.md",
      "a.md",
    ]);
  });
});

describe("dropFolderSorts — a deleted folder takes its overrides with it", () => {
  it("drops the folder and its subtree only", () => {
    const sorts: FolderSorts = { Work: "name", "Work/Sub": "recent", Workshop: "name" };
    expect(dropFolderSorts(sorts, "Work")).toEqual({ Workshop: "name" });
  });

  it("returns the same object when nothing matched", () => {
    const sorts: FolderSorts = { Work: "name" };
    expect(dropFolderSorts(sorts, "Home")).toBe(sorts);
  });
});
