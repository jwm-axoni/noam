// Per-folder view mode (list | gallery): storage and the same path bookkeeping
// as the sort overrides (see the header of `folderViews.ts`).
import { afterEach, describe, expect, it } from "vitest";
import {
  dropFolderViews,
  folderViewOf,
  readFolderViews,
  remapFolderViews,
  setFolderViewAt,
  writeFolderViews,
  type FolderViews,
} from "../folderViews";

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

describe("folder view storage", () => {
  it("reads as all-list when nothing was ever saved (legacy absence)", () => {
    stubStorage();
    expect(readFolderViews("/vault")).toEqual({});
    expect(folderViewOf(readFolderViews("/vault"), "Anything")).toBe("list");
    expect(readFolderViews(undefined)).toEqual({});
  });

  it("round-trips per vault and drops values it does not know", () => {
    const store = stubStorage();
    writeFolderViews("/a", { Trips: "gallery" });
    expect(readFolderViews("/a")).toEqual({ Trips: "gallery" });
    expect(readFolderViews("/b")).toEqual({});
    store.set("noam.folderViews:/c", JSON.stringify({ X: "gallery", Y: "table", Z: 3 }));
    expect(readFolderViews("/c")).toEqual({ X: "gallery" });
    store.set("noam.folderViews:/d", "{not json");
    expect(readFolderViews("/d")).toEqual({});
  });

  it("survives storage that throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    });
    expect(readFolderViews("/v")).toEqual({});
    expect(() => writeFolderViews("/v", { A: "gallery" })).not.toThrow();
  });
});

describe("setFolderViewAt", () => {
  it("sets gallery and clears back to the list default", () => {
    const on = setFolderViewAt({}, "Trips", "gallery");
    expect(on).toEqual({ Trips: "gallery" });
    expect(folderViewOf(on, "Trips")).toBe("gallery");
    const off = setFolderViewAt(on, "Trips", "list");
    expect(off).toEqual({});
  });

  it("returns the same object when nothing changes", () => {
    const views: FolderViews = { Trips: "gallery" };
    expect(setFolderViewAt(views, "Trips", "gallery")).toBe(views);
    expect(setFolderViewAt(views, "Other", "list")).toBe(views);
  });
});

describe("rename and delete bookkeeping", () => {
  it("follows a folder rename, including its subfolders, and nothing else", () => {
    const views: FolderViews = { Work: "gallery", "Work/Sub": "gallery", Workshop: "gallery" };
    expect(remapFolderViews(views, "Work", "Job")).toEqual({
      Job: "gallery",
      "Job/Sub": "gallery",
      Workshop: "gallery",
    });
    expect(remapFolderViews(views, "Nope", "Else")).toBe(views);
  });

  it("drops a deleted folder's mode and its subtree only", () => {
    const views: FolderViews = { Work: "gallery", "Work/Sub": "gallery", Workshop: "gallery" };
    expect(dropFolderViews(views, "Work")).toEqual({ Workshop: "gallery" });
    expect(dropFolderViews(views, "Nope")).toBe(views);
  });
});
