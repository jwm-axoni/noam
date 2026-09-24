// @vitest-environment jsdom
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeApi, NodeRendererProps } from "react-arborist";
import type { TreeNode } from "../lib/ipc";
import { readItemOrder, writeItemOrder, type ItemOrder } from "../lib/ordering";

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  renameDisk: vi.fn(),
  renameServer: vi.fn(),
  remapTabs: vi.fn(),
  openNoteByPath: vi.fn(),
  refreshTree: vi.fn(),
  refreshTitles: vi.fn(),
  toast: vi.fn(),
  renameInline: vi.fn(),
  edit: vi.fn(),
  dragDrop: null as null | ((event: {
    payload: {
      type: "drop";
      paths: string[];
      position: { x: number; y: number };
    };
  }) => Promise<void>),
  readExternalFile: vi.fn(),
  pickPresentationSource: vi.fn(),
  savePresentationAsset: vi.fn(),
  activeNoteEditable: vi.fn(() => true),
  setActiveNotePresentation: vi.fn(),
  noteExists: vi.fn(),
  writeNoteIfMissing: vi.fn(),
  getNoteMeta: vi.fn(),
  setItemColor: vi.fn(),
  mutateBackgroundText: vi.fn(),
  toggle: vi.fn(),
  openParents: vi.fn(),
  scrollTo: vi.fn(async () => {}),
}));

vi.mock("../store", () => ({
  useStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}));
vi.mock("../lib/ipc", () => ({
  renamePath: mocks.renameDisk,
  readExternalFile: mocks.readExternalFile,
  noteExists: mocks.noteExists,
  writeNoteIfMissing: mocks.writeNoteIfMissing,
  getNoteMeta: mocks.getNoteMeta,
  revealLabel: () => "Reveal in Finder",
  openVaultLabel: () => "Open vault in Finder",
}));
vi.mock("../lib/presentation/assets", () => ({
  pickPresentationSource: mocks.pickPresentationSource,
  savePresentationAsset: mocks.savePresentationAsset,
}));
vi.mock("../lib/editor/activeView", () => ({
  activeNoteEditable: mocks.activeNoteEditable,
  insertIntoActiveNote: vi.fn(),
  setActiveNotePresentation: mocks.setActiveNotePresentation,
}));
vi.mock("../lib/sync/docSession", () => ({
  syncManager: {
    registry: { renamePath: mocks.renameServer },
    mutateBackgroundText: mocks.mutateBackgroundText,
  },
}));
vi.mock("../lib/toast", () => ({ toast: mocks.toast }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: NonNullable<typeof mocks.dragDrop>) => {
      mocks.dragDrop = handler;
      return () => {};
    },
  }),
}));

// Model Arborist's rows and edit API; run FileTree's real rename and drag handlers.
vi.mock("react-arborist", async () => {
  const { createElement, useImperativeHandle, useState } = await import("react");
  return {
    Tree: ({ data, children: Row, ref, onRename, width, height }: {
      width: number;
      height: number;
      data: TreeNode[];
      children: ComponentType<NodeRendererProps<TreeNode>>;
      ref: import("react").Ref<unknown>;
      onRename: (args: { id: string; name: string; node: NodeApi<TreeNode> }) => Promise<void>;
    }) => {
      const [editing, setEditing] = useState<string | null>(null);
      mocks.renameInline.mockImplementation(onRename);
      mocks.edit.mockImplementation((path: string) => setEditing(path));
      useImperativeHandle(ref, () => ({ edit: mocks.edit, openParents: mocks.openParents, scrollTo: mocks.scrollTo, idToIndex: { "A.md": 0 }, visibleStartIndex: 0, visibleStopIndex: 1 }));
      const render = (nodes: TreeNode[], depth = 0): ReturnType<typeof createElement>[] =>
        nodes.flatMap((data) => [
          createElement(Row, {
            key: data.path,
            node: {
              data,
              isOpen: true,
              isEditing: editing === data.path,
              // Row activation the icon picker must never reach.
              toggle: () => mocks.toggle(data.path),
              edit: () => mocks.edit(data.path),
            } as unknown as NodeApi<TreeNode>,
            style: { paddingLeft: depth * 16 },
            dragHandle: () => {},
            tree: {} as NodeRendererProps<TreeNode>["tree"],
          }),
          ...render(data.children ?? [], depth + 1),
        ]);
      return createElement("div", { "data-tree-height": height, "data-tree-width": width }, render(data));
    },
  };
});

import { FileTree } from "./FileTree";

function node(path: string, children?: TreeNode[]): TreeNode {
  return { id: path, path, name: path.split("/").pop()!, isDir: children !== undefined, children };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("FileTree refused move callbacks", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resize: (width: number, height: number) => void;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        resize = (width, height) => callback(
          [{ contentRect: { width, height } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      observe() {}
      disconnect() {}
    });
    mocks.state = {
      vault: { path: "t27-fixture", epoch: 7 },
      syncEnabled: false, locks: [], denies: [], lifts: [], vaultPresence: [], members: [],
      itemColors: {}, itemOrder: {}, rootFrozen: false, treeSort: "name", titles: [],
      docSyncState: {}, docIdByPath: {}, revealRequest: null,
      remapTabs: mocks.remapTabs,
      openNoteByPath: mocks.openNoteByPath,
      refreshTree: mocks.refreshTree,
      refreshTitles: mocks.refreshTitles,
      setItemColor: mocks.setItemColor,
      setItemOrder: (order: ItemOrder) => {
        mocks.state.itemOrder = order;
        writeItemOrder("t27-fixture", order);
      },
    };
    mocks.setItemColor.mockImplementation((path: string, color: string | null) => {
      const current = mocks.state.itemColors as Record<string, string>;
      if (color) current[path] = color;
      else delete current[path];
    });
    mocks.dragDrop = null;
    mocks.activeNoteEditable.mockReturnValue(true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("defers explicit reveals while hidden and does not replay them on later tab switches", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const flushFrames = async () => {
      for (let i = 0; i < 5; i++) await act(async () => { frames.splice(0).forEach(callback => callback(0)); });
    };
    mocks.state.tree = node("", [node("A.md")]);
    mocks.state.revealRequest = { path: "A.md", token: 1, edit: false };
    await act(async () => root.render(createElement(FileTree, { visible: false })));
    await flushFrames();
    expect(mocks.openParents).not.toHaveBeenCalled();
    expect(mocks.scrollTo).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(FileTree, { visible: true })));
    await flushFrames();
    expect(mocks.scrollTo).toHaveBeenCalledExactlyOnceWith("A.md", "smart");
    await act(async () => root.render(createElement(FileTree, { visible: false })));
    await act(async () => root.render(createElement(FileTree, { visible: true })));
    await flushFrames();
    expect(mocks.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("keeps the file list sized while its dock tab is hidden and restores the new size", async () => {
    mocks.state.tree = node("", [node("A.md"), node("B.md")]);
    await act(async () => root.render(createElement(FileTree)));
    await act(async () => resize(320, 900));
    const list = container.querySelector<HTMLElement>("[data-tree-height]")!;
    expect(Number(list.dataset.treeHeight)).toBe(866);
    // Switching to Workflows hides Files with display:none. ResizeObserver
    // reports zero for the mounted Files panel until the user switches back.
    await act(async () => resize(0, 0));
    expect(Number(list.dataset.treeHeight)).toBe(866);
    expect(Number(list.dataset.treeWidth)).toBe(320);
    await act(async () => resize(280, 700));
    expect(Number(list.dataset.treeHeight)).toBe(666);
    expect(Number(list.dataset.treeWidth)).toBe(280);
    expect(container.querySelector("[data-tree-height]")).toBe(list);
    expect(container.querySelectorAll("[data-tree-path]")).toHaveLength(2);
  });

  it("never gives the virtualized list a negative height in a short dock", async () => {
    mocks.state.tree = node("", [node("A.md")]);
    await act(async () => root.render(createElement(FileTree)));
    await act(async () => resize(280, 20));
    expect(Number(container.querySelector<HTMLElement>("[data-tree-height]")!.dataset.treeHeight)).toBeGreaterThanOrEqual(0);
  });

  /** Let React, a lazy chunk and a promise chain settle, bounded. */
  const settle = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 50 && !done(); attempt++) {
      await act(async () => {
        await new Promise((resume) => setTimeout(resume, 0));
      });
    }
    return done();
  };

  const pickerDialog = () =>
    document.querySelector<HTMLElement>('[role="dialog"][aria-label="Choose an icon"]');

  /** Take "Change icon…" from a row's Actions menu, as the user does. */
  const openIconPicker = async (path: string) => {
    const row = container.querySelector<HTMLElement>(`[data-tree-path="${path}"]`)!;
    const actions = row.querySelector<HTMLButtonElement>('[aria-label^="Actions for"]')!;
    await act(async () => {
      actions.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const changeIcon = Array.from(container.querySelectorAll<HTMLElement>(".context-menu li"))
      .find((item) => item.textContent?.includes("Change icon"));
    expect(changeIcon).not.toBeUndefined();
    await act(async () => {
      changeIcon!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(await settle(() => pickerDialog() != null)).toBe(true);
    return pickerDialog()!;
  };

  /** Click an option the way a pointer does: press, then click. */
  const pressOption = async (option: HTMLElement) => {
    await act(async () => {
      option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  type Plan = (source: string) =>
    | { ok: true; changes: Array<{ from: number; to: number; insert: string }> }
    | { ok: false; reason: string };

  /** Run a background-text plan over a note source, like the CRDT edit does. */
  const applyPlan = (plan: Plan, source = "") => {
    const result = plan(source);
    if (!result.ok) throw new Error(`plan refused: ${result.reason}`);
    let text = source;
    for (const change of [...result.changes].sort((a, b) => b.from - a.from)) {
      text = text.slice(0, change.from) + change.insert + text.slice(change.to);
    }
    return text;
  };

  const savedIcon = (call: unknown[] | undefined) => {
    expect(call).not.toBeUndefined();
    const [path, docId, epoch, plan] = call as [string, string, number, Plan];
    return { path, docId, epoch, source: applyPlan(plan) };
  };

  /** Nothing the picker does may reach the row underneath it. */
  const expectNoRowActivation = () => {
    expect(mocks.openNoteByPath).not.toHaveBeenCalled();
    expect(mocks.toggle).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(container.querySelector(".filetree")?.classList.contains("row-dragging")).toBe(false);
    expect(container.querySelector("input.tree-rename-input")).toBeNull();
  };

  // Deliberately the FIRST test in this file: nothing has imported the lazy
  // IconPicker chunk yet, so this is the session's first icon change — the case
  // that used to open the note in the editor instead of changing its icon.
  it("changes an unopened note's icon on first use without opening it", async () => {
    mocks.state.tree = node("", [node("A.md"), node("B.md")]);
    mocks.state.openNote = { path: "A.md", id: "doc-a" };
    mocks.state.titles = [
      { id: "doc-a", path: "A.md", title: "A" },
      { id: "doc-b", path: "B.md", title: "B" },
    ];
    mocks.state.docIdByPath = { "A.md": "doc-a", "B.md": "doc-b" };
    mocks.mutateBackgroundText.mockResolvedValue({ ok: true });
    await act(async () => root.render(createElement(FileTree)));

    const picker = await openIconPicker("B.md");
    await pressOption(picker.querySelector<HTMLElement>('[role="option"]')!);
    expect(await settle(() => mocks.mutateBackgroundText.mock.calls.length > 0)).toBe(true);

    expectNoRowActivation();
    const saved = savedIcon(mocks.mutateBackgroundText.mock.calls[0]);
    expect([saved.path, saved.docId, saved.epoch]).toEqual(["B.md", "doc-b", 7]);
    expect(saved.source).toContain('noam_icon: "lucide:');
    expect(mocks.state.openNote).toEqual({ path: "A.md", id: "doc-a" });
    // Success closes the picker and hands focus back to the row it belongs to.
    expect(await settle(() => pickerDialog() == null)).toBe(true);
    expect(document.activeElement).toBe(
      container.querySelector('[data-tree-path="B.md"] .tree-more'),
    );
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("patches the note already on screen through its live editor", async () => {
    mocks.state.tree = node("", [node("A.md")]);
    mocks.state.openNote = { path: "A.md", id: "doc-a" };
    mocks.state.titles = [{ id: "doc-a", path: "A.md", title: "A" }];
    mocks.setActiveNotePresentation.mockReturnValue(true);
    await act(async () => root.render(createElement(FileTree)));

    const picker = await openIconPicker("A.md");
    await pressOption(picker.querySelector<HTMLElement>('[role="option"]')!);
    expect(await settle(() => mocks.setActiveNotePresentation.mock.calls.length > 0)).toBe(true);

    expectNoRowActivation();
    // The open note keeps editor-native undo; no background write duplicates it.
    expect(mocks.setActiveNotePresentation.mock.calls[0]![0]).toBe("A.md");
    expect(mocks.mutateBackgroundText).not.toHaveBeenCalled();
    expect(await settle(() => pickerDialog() == null)).toBe(true);
  });

  it("chooses an emoji by keyboard without activating the row", async () => {
    mocks.state.tree = node("", [node("A.md"), node("B.md")]);
    mocks.state.openNote = { path: "A.md", id: "doc-a" };
    mocks.state.titles = [{ id: "doc-b", path: "B.md", title: "B" }];
    mocks.mutateBackgroundText.mockResolvedValue({ ok: true });
    await act(async () => root.render(createElement(FileTree)));

    const picker = await openIconPicker("B.md");
    const emojiTab = Array.from(picker.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent === "Emoji")!;
    await act(async () => {
      emojiTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const option = picker.querySelector<HTMLElement>('[role="option"]')!;
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(await settle(() => mocks.mutateBackgroundText.mock.calls.length > 0)).toBe(true);

    expectNoRowActivation();
    const saved = savedIcon(mocks.mutateBackgroundText.mock.calls[0]);
    expect(saved.path).toBe("B.md");
    expect(saved.source).toContain('noam_icon: "emoji:');
  });

  it("changes a folder's icon without toggling its row", async () => {
    mocks.state.tree = node("", [node("Folder", [node("Folder/Child.md")])]);
    mocks.state.titles = [{
      id: "folder-meta",
      path: "Folder/_noam-folder.md",
      title: "_noam-folder",
      kind: "folder-presentation",
    }];
    mocks.mutateBackgroundText.mockResolvedValue({ ok: true });
    await act(async () => root.render(createElement(FileTree)));

    const picker = await openIconPicker("Folder");
    await pressOption(picker.querySelector<HTMLElement>('[role="option"]')!);
    expect(await settle(() => mocks.mutateBackgroundText.mock.calls.length > 0)).toBe(true);

    expectNoRowActivation();
    const saved = savedIcon(mocks.mutateBackgroundText.mock.calls[0]);
    expect([saved.path, saved.docId, saved.epoch]).toEqual(["Folder/_noam-folder.md", "folder-meta", 7]);
    expect(saved.source).toContain('noam_icon: "lucide:');
    expect(await settle(() => pickerDialog() == null)).toBe(true);
  });

  it("keeps changing icons across rows without ever navigating", async () => {
    mocks.state.tree = node("", [node("A.md"), node("B.md"), node("Folder", [])]);
    mocks.state.openNote = { path: "A.md", id: "doc-a" };
    mocks.state.titles = [
      { id: "doc-a", path: "A.md", title: "A" },
      { id: "doc-b", path: "B.md", title: "B" },
      {
        id: "folder-meta",
        path: "Folder/_noam-folder.md",
        title: "_noam-folder",
        kind: "folder-presentation",
      },
    ];
    mocks.mutateBackgroundText.mockResolvedValue({ ok: true });
    await act(async () => root.render(createElement(FileTree)));

    for (const path of ["B.md", "Folder", "A.md"]) {
      const picker = await openIconPicker(path);
      const before = mocks.mutateBackgroundText.mock.calls.length;
      await pressOption(picker.querySelector<HTMLElement>('[role="option"]')!);
      expect(await settle(() => mocks.mutateBackgroundText.mock.calls.length > before)).toBe(true);
      expect(await settle(() => pickerDialog() == null)).toBe(true);
    }

    expectNoRowActivation();
    expect(mocks.mutateBackgroundText.mock.calls.map((call) => call[0])).toEqual([
      "B.md",
      "Folder/_noam-folder.md",
      "A.md",
    ]);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("resets a note's icon in place", async () => {
    mocks.state.tree = node("", [node("A.md"), node("B.md")]);
    mocks.state.openNote = { path: "A.md", id: "doc-a" };
    mocks.state.titles = [{ id: "doc-b", path: "B.md", title: "B", icon: "lucide:star" }];
    mocks.mutateBackgroundText.mockResolvedValue({ ok: true });
    await act(async () => root.render(createElement(FileTree)));

    const picker = await openIconPicker("B.md");
    const reset = Array.from(picker.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Reset to default")!;
    await pressOption(reset);
    expect(await settle(() => mocks.mutateBackgroundText.mock.calls.length > 0)).toBe(true);

    expectNoRowActivation();
    const saved = savedIcon(mocks.mutateBackgroundText.mock.calls[0]);
    expect(saved.path).toBe("B.md");
    expect(applyPlan(
      mocks.mutateBackgroundText.mock.calls[0]![3] as Plan,
      "---\nnoam_icon: lucide:star\n---\nbody\n",
    )).not.toContain("noam_icon:");
  });

  it("resolves a note the title snapshot has not caught up with", async () => {
    mocks.state.tree = node("", [node("Fresh.md")]);
    mocks.state.titles = [];
    mocks.getNoteMeta.mockResolvedValue({ id: "doc-fresh", sha256: "abc" });
    mocks.mutateBackgroundText.mockResolvedValue({ ok: true });
    await act(async () => root.render(createElement(FileTree)));

    const picker = await openIconPicker("Fresh.md");
    await pressOption(picker.querySelector<HTMLElement>('[role="option"]')!);
    expect(await settle(() => mocks.mutateBackgroundText.mock.calls.length > 0)).toBe(true);

    expectNoRowActivation();
    expect(mocks.getNoteMeta).toHaveBeenCalledWith("Fresh.md", 7);
    const saved = savedIcon(mocks.mutateBackgroundText.mock.calls[0]);
    expect([saved.path, saved.docId]).toEqual(["Fresh.md", "doc-fresh"]);
  });

  it("keeps the picker open and the note untouched when the save fails", async () => {
    mocks.state.tree = node("", [node("A.md"), node("B.md")]);
    mocks.state.openNote = { path: "A.md", id: "doc-a" };
    mocks.state.titles = [{ id: "doc-b", path: "B.md", title: "B" }];
    mocks.mutateBackgroundText.mockResolvedValue({ ok: false, reason: "write-failed" });
    await act(async () => root.render(createElement(FileTree)));

    const picker = await openIconPicker("B.md");
    await pressOption(picker.querySelector<HTMLElement>('[role="option"]')!);
    expect(await settle(() => mocks.toast.mock.calls.length > 0)).toBe(true);

    expectNoRowActivation();
    expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), "error");
    expect(pickerDialog()).not.toBeNull();
  });

  it("keeps an in-flight uploaded icon bound to the row it was opened for", async () => {
    const saved = deferred<{ path: string }>();
    mocks.state.tree = node("", [node("A.md"), node("B.md")]);
    mocks.state.openNote = { path: "A.md", id: "doc-a" };
    mocks.state.titles = [{ id: "doc-b", path: "B.md", title: "B" }];
    mocks.state.docIdByPath = { "B.md": "doc-b" };
    mocks.pickPresentationSource.mockImplementation(async (_kind: string, target: unknown) => ({
      name: "icon.png",
      bytes: Uint8Array.of(1, 2, 3),
      mime: "image/png",
      previewUrl: "blob:icon",
      target,
    }));
    mocks.savePresentationAsset.mockReturnValue(saved.promise);
    mocks.mutateBackgroundText.mockResolvedValue({ ok: true });
    await act(async () => root.render(createElement(FileTree)));

    const picker = await openIconPicker("B.md");
    const uploadTab = Array.from(picker.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent === "Upload")!;
    await act(async () => {
      uploadTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const choose = Array.from(picker.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Choose image…")!;
    await act(async () => {
      choose.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const use = await settle(() =>
      Array.from(picker.querySelectorAll<HTMLButtonElement>("button"))
        .some((button) => button.textContent === "Use icon"));
    expect(use).toBe(true);
    await act(async () => {
      Array.from(picker.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent === "Use icon")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The picker goes away while the upload is still running, and the next one
    // opens for a different row. The choice belongs to B.md either way: closing
    // must not lose the target, and reopening must not replace it.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(pickerDialog()).toBeNull();
    await openIconPicker("A.md");
    // `savePresentationAsset` re-checks this target while it writes the file,
    // so a false here is what dropped the image before it reached the note.
    const inFlight = mocks.savePresentationAsset.mock.calls[0]![3] as {
      isCurrent: () => boolean;
    };
    expect(inFlight.isCurrent()).toBe(true);
    saved.resolve({ path: "attachments/icon.png" });
    expect(await settle(() => mocks.mutateBackgroundText.mock.calls.length > 0)).toBe(true);

    expectNoRowActivation();
    expect(mocks.mutateBackgroundText).toHaveBeenCalledOnce();
    const applied = savedIcon(mocks.mutateBackgroundText.mock.calls[0]);
    expect(applied.path).toBe("B.md");
    expect(applied.source).toContain('noam_icon: "asset:attachments/icon.png"');
    // Still bounded by the vault it was captured in.
    mocks.state.vault = { path: "other-vault", epoch: 8 };
    expect(inFlight.isCurrent()).toBe(false);
  });

  it("keeps root and nested row content clear of the full-bleed pane frame", async () => {
    mocks.state.tree = node("", [node("Root.md"), node("Folder", [node("Folder/Nested.md")])]);
    await act(async () => root.render(createElement(FileTree)));

    const rootRow = container.querySelector<HTMLElement>('[data-tree-path="Root.md"]')!;
    const nestedRow = container.querySelector<HTMLElement>('[data-tree-path="Folder/Nested.md"]')!;
    expect(parseFloat(rootRow.style.paddingLeft)).toBeGreaterThanOrEqual(28);
    expect(parseFloat(nestedRow.style.paddingLeft) - parseFloat(rootRow.style.paddingLeft)).toBe(16);
  });

  it("does not offer note presentation controls for binary previews", async () => {
    mocks.state.tree = node("", [node("Sample.pdf"), node("Note.md")]);
    await act(async () => root.render(createElement(FileTree)));

    const openMenu = async (path: string) => {
      const row = container.querySelector<HTMLElement>(`[data-tree-path="${path}"]`)!;
      await act(async () => {
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
      });
      return container.querySelector<HTMLElement>(".context-menu")!;
    };

    expect((await openMenu("Sample.pdf")).textContent).not.toContain("Change icon");
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect((await openMenu("Note.md")).textContent).toContain("Change icon");
  });

  it("portals toolbar popovers outside the clipped Files panel", async () => {
    mocks.state.tree = node("", [node("Note.md")]);
    await act(async () => root.render(createElement(FileTree)));

    const sortButton = container.querySelector<HTMLButtonElement>('[aria-label="Sort notes"]')!;
    await act(async () => {
      sortButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const sortMenu = document.querySelector<HTMLElement>(".tree-sort-menu");
    expect(sortMenu).not.toBeNull();
    expect(container.contains(sortMenu)).toBe(false);
  });

  it("dismisses the folder icon picker and restores its row action focus", async () => {
    // FileTree loads this component lazily. Preload that chunk so the test owns
    // the dismissal behavior rather than Suspense scheduling.
    await import("./IconPicker");
    mocks.state.tree = node("", [node("Folder", [])]);
    await act(async () => root.render(createElement(FileTree)));

    const row = container.querySelector<HTMLElement>('[data-tree-path="Folder"]')!;
    const rowAction = row.querySelector<HTMLButtonElement>('[aria-label="Actions for Folder"]')!;
    const openPicker = async () => {
      rowAction.blur();
      expect(document.activeElement).toBe(document.body);
      await act(async () => {
        row.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 40,
          clientY: 40,
        }));
      });
      const changeIcon = Array.from(container.querySelectorAll<HTMLElement>(".context-menu li"))
        .find((item) => item.textContent?.includes("Change icon"));
      expect(changeIcon).not.toBeUndefined();
      await act(async () => {
        changeIcon?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const dialog = document.querySelector('[role="dialog"][aria-label="Choose an icon"]');
      expect(dialog).not.toBeNull();
      expect(container.contains(dialog)).toBe(false);
    };

    await openPicker();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"][aria-label="Choose an icon"]')).toBeNull();
    expect(document.activeElement).toBe(rowAction);

    await openPicker();
    expect(document.querySelector('[aria-label="Close icon picker"]')).not.toBeNull();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Close icon picker"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"][aria-label="Choose an icon"]')).toBeNull();
    expect(document.activeElement).toBe(rowAction);

    await openPicker();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"][aria-label="Choose an icon"]')).toBeNull();
  });

  it("restores a folder's local color when companion creation collides", async () => {
    mocks.state.tree = node("", [node("Folder", [])]);
    // Model the narrow stale-index window where the row already knows its icon
    // but the hidden companion has not entered the title index yet.
    mocks.state.titles = [{ path: "Folder", icon: "lucide:folder" }];
    mocks.noteExists.mockResolvedValue(true);
    await act(async () => root.render(createElement(FileTree)));

    const row = container.querySelector<HTMLElement>('[data-tree-path="Folder"]')!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
    });
    const violet = container.querySelector<HTMLElement>('[title="Violet"]')!;
    await act(async () => {
      violet.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.noteExists).toHaveBeenCalledWith("Folder/_noam-folder.md", 7);
    expect(mocks.setItemColor.mock.calls).toEqual([
      ["Folder", "violet"],
      ["Folder", null],
    ]);
    expect(mocks.state.itemColors).toEqual({});
    expect(mocks.writeNoteIfMissing).not.toHaveBeenCalled();
  });

  it("keeps an asynchronous cover drop bound to its original note", async () => {
    const saved = deferred<{ path: string }>();
    mocks.state.openNote = { path: "A.md" };
    mocks.state.tree = node("", [node("A.md"), node("B.md")]);
    mocks.readExternalFile.mockResolvedValue(Uint8Array.of(1, 2, 3));
    mocks.savePresentationAsset.mockReturnValue(saved.promise);
    const cover = document.createElement("div");
    cover.dataset.coverDrop = "";
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => cover),
    });

    await act(async () => root.render(createElement(FileTree)));
    expect(mocks.dragDrop).not.toBeNull();
    let drop!: Promise<void>;
    await act(async () => {
      drop = mocks.dragDrop!({
        payload: { type: "drop", paths: ["/tmp/cover.png"], position: { x: 500, y: 500 } },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    mocks.state.openNote = { path: "B.md" };
    saved.resolve({ path: ".attachments/cover.png" });
    await act(async () => drop);

    expect(mocks.setActiveNotePresentation).not.toHaveBeenCalled();
  });

  it("keeps a cover upload bound to its original vault", async () => {
    const saved = deferred<{ path: string }>();
    mocks.state.openNote = { path: "A.md", id: "doc-a" };
    mocks.state.tree = node("", [node("A.md")]);
    mocks.readExternalFile.mockResolvedValue(Uint8Array.of(1, 2, 3));
    mocks.savePresentationAsset.mockReturnValue(saved.promise);
    const cover = document.createElement("div");
    cover.dataset.coverDrop = "";
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => cover),
    });

    await act(async () => root.render(createElement(FileTree)));
    let drop!: Promise<void>;
    await act(async () => {
      drop = mocks.dragDrop!({
        payload: { type: "drop", paths: ["/tmp/cover.png"], position: { x: 500, y: 500 } },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    const target = mocks.savePresentationAsset.mock.calls[0]?.[3];
    expect(target).toMatchObject({ vaultEpoch: 7 });

    mocks.state.vault = { path: "other-vault", epoch: 8 };
    mocks.state.openNote = { path: "A.md", id: "doc-a" };
    expect(target.isCurrent()).toBe(false);
    saved.resolve({ path: ".attachments/cover.png" });
    await act(async () => drop);

    expect(mocks.setActiveNotePresentation).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it.each([
    { folder: false, rollbackFails: false },
    { folder: false, rollbackFails: true },
    { folder: true, rollbackFails: false },
    { folder: true, rollbackFails: true },
  ])("reconciles inline rename, folder=$folder rollbackFails=$rollbackFails", async ({ folder, rollbackFails }) => {
    vi.useFakeTimers();
    const from = folder ? "Source/Group" : "Source/A.md";
    const to = folder ? "Source/Renamed" : "Source/Renamed.md";
    const activePath = folder ? `${from}/A.md` : from;
    const movedActivePath = folder ? `${to}/A.md` : to;
    let diskPath = from;
    const freshTree = () => node("", [node("Source", [
      node("Source/Existing.md"),
      node(diskPath, folder ? [node(`${diskPath}/A.md`)] : undefined),
    ])]);
    const initial: ItemOrder = {
      Source: ["Source/Existing.md", from],
      ...(folder ? { [from]: [`${from}/A.md`] } : {}),
    };
    const expectedOrder = rollbackFails ? {
      Source: ["Source/Existing.md", to],
      ...(folder ? { [to]: [`${to}/A.md`] } : {}),
    } : initial;
    mocks.state.tree = freshTree();
    mocks.state.itemOrder = initial;
    mocks.state.openNote = { path: activePath };
    writeItemOrder("t27-fixture", initial);
    mocks.renameDisk.mockImplementation(async (oldPath: string, newPath: string) => {
      expect(oldPath).toBe(diskPath);
      if (oldPath === to && rollbackFails) throw new Error("Disk unavailable");
      diskPath = newPath;
    });
    mocks.renameServer.mockResolvedValue({
      ok: false, failure: { path: to, reason: "Permission denied", code: "no_write_access" },
    });
    mocks.openNoteByPath.mockImplementation(async (path: string) => {
      expect(readItemOrder("t27-fixture")).toEqual(expectedOrder);
      expect(path).toBe(movedActivePath);
      mocks.state.openNote = { path };
    });
    mocks.refreshTree.mockImplementation(async () => { mocks.state.tree = freshTree(); });

    await act(async () => root.render(createElement(FileTree)));
    await act(async () => mocks.renameInline({
      id: from, name: "Renamed", node: { data: node(from, folder ? [] : undefined) },
    }));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    const survivingPath = rollbackFails ? to : from;
    expect(mocks.renameDisk.mock.calls).toEqual([[from, to, 7], [to, from, 7]]);
    expect(mocks.renameServer).toHaveBeenCalledExactlyOnceWith(from, to);
    expect(diskPath).toBe(survivingPath);
    expect(mocks.edit).toHaveBeenCalledExactlyOnceWith(survivingPath);
    const survivingRow = container.querySelector(`[data-tree-path="${survivingPath}"]`)!;
    expect(survivingRow).not.toBeNull();
    expect(survivingRow.querySelector("input")?.value).toBe("Renamed");
    expect(survivingRow.querySelector('[role="alert"]')?.textContent).toBe(
      `Permission denied${rollbackFails ? ". Couldn't restore the local item: Disk unavailable" : ""}`,
    );
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(mocks.toast).not.toHaveBeenCalled();
    if (rollbackFails) {
      expect(mocks.remapTabs).toHaveBeenCalledExactlyOnceWith(from, to);
      expect(mocks.openNoteByPath).toHaveBeenCalledExactlyOnceWith(movedActivePath);
      expect(mocks.refreshTree).toHaveBeenCalledOnce();
      expect(mocks.refreshTitles).toHaveBeenCalledOnce();
    } else {
      expect(mocks.remapTabs).not.toHaveBeenCalled();
      expect(mocks.openNoteByPath).not.toHaveBeenCalled();
    }
    expect(mocks.state.openNote).toEqual({ path: rollbackFails ? movedActivePath : activePath });
    expect(readItemOrder("t27-fixture")).toEqual(expectedOrder);

    // Refresh, then remount with persisted ordering and a fresh disk listing.
    await act(async () => {
      await mocks.refreshTree();
      root.render(createElement(FileTree));
    });
    expect(container.querySelector(`[data-tree-path="${survivingPath}"] [role="alert"]`)).not.toBeNull();
    await act(async () => root.unmount());
    mocks.state.itemOrder = readItemOrder("t27-fixture");
    mocks.state.tree = freshTree();
    root = createRoot(container);
    await act(async () => root.render(createElement(FileTree)));
    const paths = Array.from(container.querySelectorAll<HTMLElement>("[data-tree-path]"), row => row.dataset.treePath);
    expect(paths).toContain(survivingPath);
    expect(paths).not.toContain(rollbackFails ? from : to);
    expect(paths.indexOf("Source/Existing.md")).toBeLessThan(paths.indexOf(survivingPath));
    expect(readItemOrder("t27-fixture")).toEqual(expectedOrder);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it.each([
    { folder: false, rollbackFails: false },
    { folder: false, rollbackFails: true },
    { folder: true, rollbackFails: false },
    { folder: true, rollbackFails: true },
  ])("keeps tabs at the disk path, folder=$folder rollbackFails=$rollbackFails", async ({ folder, rollbackFails }) => {
    const from = folder ? "Source/Group" : "Source/A.md";
    const to = folder ? "Dest/Group" : "Dest/A.md";
    const activePath = folder ? `${from}/A.md` : from;
    const movedActivePath = folder ? `${to}/A.md` : to;
    let diskPath = from;
    const freshTree = () => {
      const item = node(diskPath, folder ? [node(`${diskPath}/A.md`)] : undefined);
      return node("", [
        node("Source", diskPath === from ? [item] : []),
        node("Dest", [node("Dest/Existing", []), ...(diskPath === to ? [item] : [])]),
      ]);
    };
    const initial: ItemOrder = {
      Source: [from], Dest: ["Dest/Existing"],
      ...(folder ? { [from]: [`${from}/A.md`] } : {}),
    };
    mocks.state.tree = freshTree();
    mocks.state.itemOrder = initial;
    mocks.state.openNote = { path: activePath };
    writeItemOrder("t27-fixture", initial);
    mocks.renameDisk.mockImplementation(async (oldPath: string, newPath: string) => {
      expect(oldPath).toBe(diskPath);
      if (oldPath === to && rollbackFails) throw new Error("Disk unavailable");
      diskPath = newPath;
    });
    mocks.renameServer.mockResolvedValue({
      ok: false, failure: { path: to, reason: "Permission denied", code: "no_write_access" },
    });
    mocks.openNoteByPath.mockImplementation(async (path: string) => {
      expect(readItemOrder("t27-fixture").Dest).toContain(to);
      expect(path).toBe(movedActivePath);
      mocks.state.openNote = { path };
    });
    mocks.refreshTree.mockImplementation(async () => { mocks.state.tree = freshTree(); });

    await act(async () => root.render(createElement(FileTree)));
    const source = container.querySelector<HTMLElement>(`[data-tree-path="${from}"]`)!;
    const dest = container.querySelector<HTMLElement>('[data-tree-path="Dest"]')!;
    vi.spyOn(container.querySelector(".filetree")!, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 240, 400));
    vi.spyOn(dest, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 240, 28));
    await act(async () => {
      source.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 40, clientY: 50 }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 114 }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 40, clientY: 114 }));
    });

    expect(mocks.renameDisk.mock.calls).toEqual([[from, to, 7], [to, from, 7]]);
    expect(mocks.renameServer).toHaveBeenCalledExactlyOnceWith(from, to);
    expect(diskPath).toBe(rollbackFails ? to : from);
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(
      `Couldn't move "${from.split("/").pop()}" — Permission denied${rollbackFails ? ". Couldn't restore the local item: Disk unavailable" : ""}`,
      "error",
    );
    if (rollbackFails) {
      expect(mocks.remapTabs).toHaveBeenCalledExactlyOnceWith(from, to);
      expect(mocks.openNoteByPath).toHaveBeenCalledExactlyOnceWith(movedActivePath);
    } else {
      expect(mocks.remapTabs).not.toHaveBeenCalled();
      expect(mocks.openNoteByPath).not.toHaveBeenCalled();
    }
    expect(mocks.refreshTree).toHaveBeenCalledOnce();
    expect(mocks.refreshTitles).toHaveBeenCalledOnce();
    expect(mocks.state.openNote).toEqual({ path: rollbackFails ? movedActivePath : activePath });
    expect(readItemOrder("t27-fixture")).toEqual(rollbackFails ? {
      Source: [], Dest: ["Dest/Existing", to],
      ...(folder ? { [to]: [`${to}/A.md`] } : {}),
    } : initial);

    // Reload ordering and remount against a new tree derived from the disk fixture.
    await act(async () => root.unmount());
    mocks.state.itemOrder = readItemOrder("t27-fixture");
    mocks.state.tree = freshTree();
    root = createRoot(container);
    await act(async () => root.render(createElement(FileTree)));
    const paths = Array.from(container.querySelectorAll<HTMLElement>("[data-tree-path]"), (row) => row.dataset.treePath);
    expect(paths).toContain(rollbackFails ? to : from);
    expect(paths).not.toContain(rollbackFails ? from : to);
    expect(paths.indexOf("Dest/Existing")).toBeLessThan(paths.indexOf(rollbackFails ? to : from));
    expect(mocks.toast).toHaveBeenCalledOnce();
  });
});
