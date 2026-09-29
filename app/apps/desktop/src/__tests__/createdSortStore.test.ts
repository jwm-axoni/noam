// The store half of the sidebar's Created sorts: `createdTimes` is read ONLY
// while some active sort (the default or any folder override) is a Created
// mode, is dropped when none is, and never lands for a vault we have left.

import { beforeEach, describe, expect, it, vi } from "vitest";

const knowledge = vi.hoisted(() => ({
  getNoteTimes: vi.fn(async (_filter?: unknown, _epoch?: unknown) => ({
    byPath: new Map([
      ["a.md", { created: 100 }],
      ["b.md", { created: null }],
    ]),
    byDocId: new Map(),
  })),
}));

vi.mock("../lib/knowledge/noteTimes", () => knowledge);

const sync = vi.hoisted(() => ({
  registry: { vaultId: null as string | null, getMapping: () => null },
  disable: vi.fn(),
  setViewing: vi.fn(),
  handleRegistryChanged: vi.fn(),
  setStatusListener: vi.fn(),
  setActivityListeners: vi.fn(),
  setRegistryListener: vi.fn(),
  setInboundListeners: vi.fn(),
  setMemberJoinedListener: vi.fn(),
  setVaultPresenceListener: vi.fn(),
  setParticipantIdentity: vi.fn(),
  setVoiceListener: vi.fn(),
  setSyncProgressListener: vi.fn(),
  setDocStateListener: vi.fn(),
  setRegistryMapListener: vi.fn(),
  setNoteMetaListener: vi.fn(),
}));

vi.mock("../lib/sync/docSession", () => ({ syncManager: sync }));

import { useStore } from "../store";

const VAULT = { path: "/v", name: "v", epoch: 3 } as never;

beforeEach(() => {
  knowledge.getNoteTimes.mockClear();
  useStore.setState({ vault: VAULT, treeSort: "recent", folderSorts: {}, createdTimes: null });
});

describe("store createdTimes", () => {
  it("does not read created times for a vault with no Created sort", async () => {
    await useStore.getState().refreshCreatedTimes();
    useStore.getState().setFolderSort("Work", "name-desc");
    useStore.getState().setTreeSort("modified-asc");
    await useStore.getState().refreshCreatedTimes();
    expect(knowledge.getNoteTimes).not.toHaveBeenCalled();
    expect(useStore.getState().createdTimes).toBeNull();
  });

  it("reads once, epoch-pinned, when the default becomes a Created mode", async () => {
    useStore.getState().setTreeSort("created-desc");
    await vi.waitFor(() => expect(useStore.getState().createdTimes).not.toBeNull());
    expect(knowledge.getNoteTimes).toHaveBeenCalledTimes(1);
    expect(knowledge.getNoteTimes).toHaveBeenCalledWith({}, 3);
    // Undated notes are simply absent: they sort last.
    expect([...useStore.getState().createdTimes!]).toEqual([["a.md", 100]]);
  });

  it("reads when only a folder override is a Created mode, and clears when it goes", async () => {
    useStore.getState().setFolderSort("Work", "created-asc");
    await vi.waitFor(() => expect(useStore.getState().createdTimes).not.toBeNull());
    useStore.getState().setFolderSort("Work", null);
    await vi.waitFor(() => expect(useStore.getState().createdTimes).toBeNull());
    expect(knowledge.getNoteTimes).toHaveBeenCalledTimes(1);
  });

  it("drops an answer for a vault it has since left", async () => {
    let release!: () => void;
    knowledge.getNoteTimes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ byPath: new Map([["a.md", { created: 1 }]]), byDocId: new Map() });
        }),
    );
    useStore.setState({ treeSort: "created-asc" });
    const pending = useStore.getState().refreshCreatedTimes();
    await vi.waitFor(() => expect(knowledge.getNoteTimes).toHaveBeenCalledTimes(1));
    useStore.setState({ vault: { ...(VAULT as object), epoch: 4 } as never });
    release();
    await pending;
    expect(useStore.getState().createdTimes).toBeNull();
  });
});
