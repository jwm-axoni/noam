// The tab strip's contract, at the store level (the strip itself is a React
// component and this repo has no `@testing-library/react` — see
// docs/INTERACTIONS.md "Known gaps").
//
// Three things are pinned here:
//   1. layout note tabs keep their order and `closeTab` lands on the neighbour;
//      highlight does — and `closeTab` lands on the neighbour;
//   2. `createNoteIn` names a new note `Untitled`, `Untitled 1`, … reveals its
//      row, and arms the note's own inline title (`pendingTitleFocus`);
//   3. a reveal is an EVENT: the same path requested twice must re-fire, which is
//      what `revealRequest.token` is for.
//
// `authManager`, `docSession` and the Tauri IPC are faked, as in
// `bootStore.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authManager = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  init: vi.fn(async () => null as unknown),
  currentSession: vi.fn(async () => null as unknown),
  signOut: vi.fn(async () => {}),
  getServerUrl: () => "http://localhost:3010",
}));

vi.mock("../lib/auth/authManager", () => ({ authManager, api: {} }));

const sync = vi.hoisted(() => ({
  registry: {
    vaultId: null as string | null,
    getMapping: () => null,
    registerNote: vi.fn(async () => null),
    renamePath: vi.fn(async () => {}),
  },
  isSyncable: vi.fn(() => false),
  disable: vi.fn(), // `adoptOpenedVault` → `leaveVaultSync`
  setParticipantIdentity: vi.fn(), // …which also drops the registry identity
  setViewing: vi.fn(),
  handleRegistryChanged: vi.fn(),
  willSync: vi.fn(() => false),
}));

vi.mock("../lib/sync/docSession", () => ({ syncManager: sync }));

vi.mock("../lib/bridge", () => ({
  bridgeManager: { currentBridge: () => null },
}));

/** Files the fake vault holds — `createNote` refuses a duplicate, like Rust. */
const existing = new Set<string>();

const ipcMock = vi.hoisted(() => ({
  isVaultMismatch: () => false,
  peekVaultStamp: vi.fn(async () => null),
  getNoteMeta: vi.fn(async (path: string) => ({ path, id: `local-${path}`, title: path })),
  getBacklinks: vi.fn(async () => []),
  listChildren: vi.fn(async () => []),
  listTree: vi.fn(async () => ({
    id: "root",
    name: "vault",
    path: "",
    isDir: true,
    children: [],
    childrenLoaded: true,
  })),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  clearLastVault: vi.fn(async () => {}),
  getVaultEpoch: vi.fn(async () => 1),
  renamePath: vi.fn(async () => {}),
  createNote: vi.fn(async (dir: string, name: string) => {
    const path = dir === "" ? `${name}.md` : `${dir}/${name}.md`;
    if (existing.has(path)) throw new Error("a note with that name already exists");
    existing.add(path);
    return path;
  }),
}));

vi.mock("../lib/ipc", () => ipcMock);

import { useStore } from "../store";
import { useLayoutStore } from "../layout/store";
import { createDefaultLayout } from "../layout/types";
import { findPanelTab } from "../layout/operations";
import { documentTabs } from "../layout/workspaceActions";
import { readPropertiesCollapsed } from "../lib/prefs";

afterEach(() => vi.unstubAllGlobals());

describe("Wide editor toggle", () => {
  it("restores an existing custom width on the first toggle after upgrading", () => {
    const values = new Map([["context.editorMeasure", "100"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    useStore.setState({ editorMeasure: 100 });

    useStore.getState().toggleEditorWide();
    expect(useStore.getState().editorMeasure).toBe("full");
    // Choosing full width again must not erase the remembered normal width.
    useStore.getState().setEditorMeasure("full");
    useStore.getState().toggleEditorWide();
    expect(useStore.getState().editorMeasure).toBe(100);
    expect(values.get("context.editorMeasureNormal")).toBe("100");
  });

  it("preserves the chosen width in memory when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("Storage denied"); },
      setItem: () => { throw new Error("Storage denied"); },
    });
    useStore.getState().setEditorMeasure(104);
    useStore.getState().toggleEditorWide();
    expect(useStore.getState().editorMeasure).toBe("full");
    useStore.getState().toggleEditorWide();
    expect(useStore.getState().editorMeasure).toBe(104);
  });
});

describe("Properties preferences on confirmed moves", () => {
  it.each(["inline", "tree", "sync"])("remaps unopened preferences through the %s move path", async (route) => {
    const values = new Map([["context.propertiesCollapsed", JSON.stringify({
      version: 2,
      vaults: { "/fixture": { "folder/a.md": true, "folder/closed.md": true }, "/other": { "folder/a.md": true } },
    })]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    useStore.setState({ vault: { path: "/fixture", epoch: 1 } as never });
    if (route === "inline") await useStore.getState().renameNoteFileExact("Folder/a.md", "Folder/renamed.md");
    else if (route === "tree") useStore.getState().remapTabs("Folder/a.md", "Folder/renamed.md");
    else useStore.getState().followNoteRename("Folder/a.md", "Folder/renamed.md");
    useStore.getState().remapTabs("Folder", "Moved");
    expect(JSON.parse(values.get("context.propertiesCollapsed")!).vaults).toEqual({
      "/fixture": { "moved/renamed.md": true, "moved/closed.md": true },
      "/other": { "folder/a.md": true },
    });
    expect(readPropertiesCollapsed("/fixture", "Moved/renamed.md", "doc-a")).toBe(true);
    expect(readPropertiesCollapsed("/fixture", "Moved/closed.md", "doc-closed")).toBe(true);
    expect(JSON.parse(values.get("context.propertiesCollapsed")!).vaults["/fixture"]).toBeUndefined();
  });
});

const open = (path: string) => useStore.getState().openNoteByPath(path);
const tabPaths = () => documentTabs().map((tab) => tab.path);

/** `closeTab` activates the survivor through an un-awaited `openNoteByPath`. */
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.getNoteMeta.mockImplementation(async (path: string) => ({
    path,
    id: `local-${path}`,
    title: path,
  }));
  existing.clear();
  useLayoutStore.getState().replace(createDefaultLayout());
  useStore.setState({
    openNote: null,
    viewModeOverrides: {},
    defaultViewMode: "live",
    viewMode: "live",
    openingNotePath: null,
    openFolderIsSynced: null,
    revealRequest: null,
    revealedPath: null,
    rootFrozen: false,
    syncEnabled: false,
    authStatus: "signed-out",
    session: null,
    vault: null,
    tree: null,
  });
});

describe("file tree stays put on note navigation", () => {
  it("opens notes without issuing a file-tree reveal", async () => {
    await open("a.md");
    expect(useStore.getState().openNote?.path).toBe("a.md");
    expect(useStore.getState().revealRequest).toBeNull();
    useStore.getState().requestReveal("a.md");
    const explicit = useStore.getState().revealRequest;
    await open("b.md");
    expect(useStore.getState().revealRequest).toBe(explicit);
  });
});

describe("layout note-tab ordering", () => {
  it("appends new tabs and never moves an existing one when it is re-activated", async () => {
    await open("a.md");
    await open("b.md");
    await open("c.md");
    expect(tabPaths()).toEqual(["a.md", "b.md", "c.md"]);

    await open("a.md");
    expect(tabPaths()).toEqual(["a.md", "b.md", "c.md"]);
    expect(useStore.getState().openNote?.path).toBe("a.md");
  });

  it("never duplicates a tab when the same note is re-opened", async () => {
    await open("a.md");
    await open("a.md");
    expect(tabPaths()).toEqual(["a.md"]);
  });

  it("commits only the newest of two overlapping note opens", async () => {
    const first = deferred<{ path: string; id: string; title: string }>();
    const second = deferred<{ path: string; id: string; title: string }>();
    ipcMock.getNoteMeta
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const openA = open("a.md");
    const openB = open("b.md");
    second.resolve({ path: "b.md", id: "local-b.md", title: "b.md" });
    await openB;
    first.resolve({ path: "a.md", id: "local-a.md", title: "a.md" });
    await openA;

    expect(tabPaths()).toEqual(["b.md"]);
    expect(useStore.getState().openNote?.path).toBe("b.md");
    expect(useStore.getState().openingNotePath).toBeNull();
  });

  it("closing the active tab lands on its neighbour", async () => {
    await open("a.md");
    await open("b.md");
    await open("c.md");
    await open("b.md"); // active, in the middle: ["a", "b", "c"]
    useStore.getState().closeTab("b.md");
    await flush();
    expect(tabPaths()).toEqual(["a.md", "c.md"]);
    // The tab to its right slid into its slot.
    expect(useStore.getState().openNote?.path).toBe("c.md");
  });

  it("closing the last tab clears the editor", async () => {
    await open("a.md");
    useStore.getState().closeTab("a.md");
    expect(tabPaths()).toEqual([]);
    expect(useStore.getState().openNote).toBeNull();
  });

  it("closeTabsToRight keeps the anchor and everything before it", async () => {
    await open("a.md");
    await open("b.md");
    await open("c.md"); // ["a","b","c"], active "c"
    useStore.getState().closeTabsToRight("a.md");
    await flush();
    expect(tabPaths()).toEqual(["a.md"]);
    expect(useStore.getState().openNote?.path).toBe("a.md");
  });

  it("closing every tab in a focused tool group leaves the note editor open", async () => {
    await open("a.md");
    useLayoutStore.getState().dispatch({
      type: "open-panel",
      panelType: "graph",
      zone: "right",
    });
    const graph = findPanelTab(useLayoutStore.getState().layout, "graph")!;
    useLayoutStore.getState().dispatch({ type: "focus-group", groupId: graph.groupId });

    useStore.getState().closeAllTabs();

    expect(findPanelTab(useLayoutStore.getState().layout, "graph")).toBeNull();
    expect(tabPaths()).toEqual(["a.md"]);
    expect(useStore.getState().openNote?.path).toBe("a.md");
  });
});

describe("per-open-note view modes", () => {
  it("keeps an explicit mode with each open note for the session", async () => {
    await open("a.md");
    useStore.getState().setViewMode("source");
    expect(useStore.getState().viewModeOverrides).toEqual({ "a.md": "source" });

    await open("b.md");
    expect(useStore.getState().viewMode).toBe("live");
    useStore.getState().setViewMode("reading");

    await open("a.md");
    expect(useStore.getState().viewMode).toBe("source");
    await open("b.md");
    expect(useStore.getState().viewMode).toBe("reading");
  });

  it("uses the default for notes without overrides and updates an unoverridden note", async () => {
    await open("plain.md");
    useStore.getState().setDefaultViewMode("reading");
    expect(useStore.getState().defaultViewMode).toBe("reading");
    expect(useStore.getState().viewMode).toBe("reading");

    await open("new.md");
    expect(useStore.getState().viewMode).toBe("reading");
  });

  it("drops a note's override when its tab closes", async () => {
    await open("a.md");
    useStore.getState().setViewMode("source");
    useStore.getState().closeTab("a.md");
    expect(useStore.getState().viewModeOverrides).toEqual({});

    await open("a.md");
    expect(useStore.getState().viewMode).toBe("live");
  });

  it("does not recreate a closed tab's override during a deferred neighbour open", async () => {
    await open("a.md");
    await open("b.md");
    useStore.getState().setViewMode("source");
    const pending = deferred<{ path: string; id: string; title: string }>();
    ipcMock.getNoteMeta.mockImplementationOnce(() => pending.promise);

    useStore.getState().closeTab("b.md");
    useStore.getState().setViewMode("reading");
    expect(tabPaths()).toEqual(["a.md"]);
    expect(useStore.getState().viewModeOverrides).toEqual({});

    pending.resolve({ path: "a.md", id: "local-a.md", title: "a.md" });
    await flush();
    expect(useStore.getState().openNote?.path).toBe("a.md");
    expect(useStore.getState().viewMode).toBe("live");
    expect(useStore.getState().viewModeOverrides).toEqual({});
  });

  it("uses the surviving tab's mode for a rename collision regardless of override insertion order", async () => {
    await open("a.md");
    await open("b.md");
    useStore.getState().setViewMode("reading"); // B enters the object first.
    await open("a.md");
    useStore.getState().setViewMode("source");

    useStore.getState().followNoteRename("a.md", "b.md");
    expect(tabPaths()).toEqual(["b.md"]);
    expect(useStore.getState().viewModeOverrides).toEqual({ "b.md": "source" });
    expect(useStore.getState().openNote?.path).toBe("b.md");
    expect(useStore.getState().viewMode).toBe("source");
  });

  it("does not inherit a losing tab's override when the winning tab has none", async () => {
    await open("a.md");
    await open("b.md");
    useStore.getState().setViewMode("reading");
    await open("a.md");

    useStore.getState().followNoteRename("a.md", "b.md");
    expect(tabPaths()).toEqual(["b.md"]);
    expect(useStore.getState().viewModeOverrides).toEqual({});
    expect(useStore.getState().viewMode).toBe("live");
  });

  it("migrates ordinary note/folder overrides without crossing prefix boundaries", async () => {
    await open("Folder/a.md");
    useStore.getState().setViewMode("source");
    await open("Folderish/b.md");
    useStore.getState().setViewMode("reading");
    useStore.getState().followNoteRename("Folder", "Moved");
    expect(tabPaths()).toEqual(["Moved/a.md", "Folderish/b.md"]);
    expect(useStore.getState().viewModeOverrides).toEqual({
      "Moved/a.md": "source",
      "Folderish/b.md": "reading",
    });

    useStore.getState().pruneTabs(["Moved"]);
    expect(tabPaths()).toEqual(["Folderish/b.md"]);
    expect(useStore.getState().viewModeOverrides).toEqual({
      "Folderish/b.md": "reading",
    });
  });

  it("prunes overrides for close-others, close-right and vault switches", async () => {
    await open("a.md");
    useStore.getState().setViewMode("source");
    await open("b.md");
    useStore.getState().setViewMode("reading");
    await open("c.md");
    useStore.getState().setViewMode("source");

    useStore.getState().closeTabsToRight("b.md");
    expect(useStore.getState().viewModeOverrides).toEqual({
      "a.md": "source",
      "b.md": "reading",
    });
    useStore.getState().closeOtherTabs("a.md");
    expect(useStore.getState().viewModeOverrides).toEqual({ "a.md": "source" });

    await useStore.getState().adoptOpenedVault({
      path: "/vaults/next",
      name: "next",
      epoch: 2,
    });
    expect(tabPaths()).toEqual([]);
    expect(useStore.getState().viewModeOverrides).toEqual({});
  });
});

describe("createNoteIn / createNoteAt", () => {
  it("names the note Untitled, then Untitled 1 when that is taken", async () => {
    expect(await useStore.getState().createNoteIn("")).toBe("Untitled.md");
    expect(await useStore.getState().createNoteIn("")).toBe("Untitled 1.md");
    expect(await useStore.getState().createNoteIn("Work")).toBe("Work/Untitled.md");
  });

  it("opens the new note, reveals its row, and arms its inline title", async () => {
    const path = await useStore.getState().createNoteIn("");
    expect(useStore.getState().openNote?.path).toBe(path);
    // The row is revealed but NOT put into the sidebar's rename box: a new note
    // is created EMPTY and its name is its title, so the cursor waits in the
    // note's own inline title instead (consumed by `InlineTitle` on mount).
    expect(useStore.getState().revealRequest).toMatchObject({ path, edit: false });
    expect(useStore.getState().pendingTitleFocus).toBe(path);
  });

  it("refuses the vault root while the freeze latch is on, and creates nothing", async () => {
    useStore.setState({ rootFrozen: true });
    expect(await useStore.getState().createNoteIn("")).toBeNull();
    expect(await useStore.getState().createNoteAt("", "Named")).toBeNull();
    expect(ipcMock.createNote).not.toHaveBeenCalled();
    // …but a folder is still fair game.
    expect(await useStore.getState().createNoteAt("Work", "Named")).toBe("Work/Named.md");
  });

  it("takes the explicit-name path without arming a rename", async () => {
    // What a dangling `[[wikilink]]` does: the name is already chosen.
    const path = await useStore.getState().createNoteAt("", "Some New Note");
    expect(path).toBe("Some New Note.md");
    expect(useStore.getState().revealRequest).toMatchObject({ path, edit: false });
  });
});

describe("requestReveal", () => {
  it("bumps a token so the SAME path re-fires — a reveal is an event", async () => {
    useStore.getState().requestReveal("a.md");
    const first = useStore.getState().revealRequest!;
    expect(first.path).toBe("a.md");

    useStore.getState().requestReveal("a.md");
    const second = useStore.getState().revealRequest!;
    expect(second.path).toBe("a.md");
    expect(second.token).toBeGreaterThan(first.token);
    // A new object identity is what re-runs the FileTree effect.
    expect(second).not.toBe(first);
  });

  it("supports an explicit reveal of a nested note", () => {
    useStore.getState().requestReveal("Deep/Folder/note.md");
    expect(useStore.getState().revealRequest).toMatchObject({
      path: "Deep/Folder/note.md",
      edit: false,
    });
  });
});

describe("open gate after a vault switch", () => {
  // NonNullable: `setVault` accepts `VaultInfo | null`, `adoptOpenedVault` does
  // not, and both are called with this below.
  const vaultAt = (path: string) =>
    ({ path, epoch: 1, name: path.split("/").pop() }) as unknown as NonNullable<
      Parameters<ReturnType<typeof useStore.getState>["setVault"]>[0]
    >;

  it("answers 'never synced' for an unstamped folder so an open does not sit out the gate", async () => {
    useStore.setState({ authStatus: "signed-in", vault: null });
    ipcMock.peekVaultStamp.mockResolvedValueOnce(null);
    useStore.getState().setVault(vaultAt("/vaults/local"));
    await flush();
    expect(useStore.getState().openFolderIsSynced).toBe(false);

    // Signed in + not syncable used to mean "wait SYNC_GATE_MS (3s)" per open.
    const t0 = Date.now();
    await open("a.md");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(useStore.getState().openNote?.path).toBe("a.md");
  });

  it("answers for a vault adopted from the picker/create flow too (bypasses setVault)", async () => {
    useStore.setState({ authStatus: "signed-in", vault: null, openFolderIsSynced: true });
    ipcMock.peekVaultStamp.mockResolvedValueOnce(null);
    await useStore.getState().adoptOpenedVault(vaultAt("/vaults/brand-new"));
    await flush();
    // The previous vault's answer (`true`) must not survive the adoption.
    expect(useStore.getState().openFolderIsSynced).toBe(false);
    const t0 = Date.now();
    await open("a.md");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("keeps waiting for the prime when the folder IS stamped", async () => {
    useStore.setState({ authStatus: "signed-in", vault: null });
    ipcMock.peekVaultStamp.mockResolvedValueOnce({ organizationId: "org-1" } as never);
    useStore.getState().setVault(vaultAt("/vaults/synced"));
    await flush();
    expect(useStore.getState().openFolderIsSynced).toBe(true);
  });
});
