// @vitest-environment jsdom
//
// The contract between the three menu files: every item the bar can show has
// a handler (no dead menu items), no handler is orphaned, accelerators do not
// collide, and the window event + the zoom-key fallback actually reach the
// commands. The stores and Tauri APIs are faked; the wiring is what is pinned.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setZoom: vi.fn(async () => undefined),
  setFullscreen: vi.fn(async () => undefined),
  isFullscreen: vi.fn(async () => false),
  openUrl: vi.fn(async () => undefined),
  createNoteIn: vi.fn(async () => null),
  setViewMode: vi.fn(),
  storeState: {} as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: mocks.setZoom }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFullscreen: mocks.setFullscreen, isFullscreen: mocks.isFullscreen }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("../lib/attachments", () => ({ embedDroppedFile: vi.fn() }));
vi.mock("../lib/ipc", () => ({ pickFiles: vi.fn(async () => null) }));
vi.mock("../lib/toast", () => ({ toast: vi.fn() }));
vi.mock("../lib/editor/activeView", () => ({
  activeNoteEditable: () => false,
  getActiveNote: () => null,
  insertIntoActiveNote: () => false,
}));
vi.mock("../layout/store", () => ({
  useLayoutStore: { getState: () => ({ layout: { zones: { left: { groupIds: [] }, right: { groupIds: [] } } }, dispatch: vi.fn(), replace: vi.fn() }) },
}));
vi.mock("../layout/workspaceActions", () => ({ applyTilingAction: vi.fn() }));
vi.mock("../store", () => ({
  useStore: { getState: () => mocks.storeState },
}));

import { MENU_ACTION_EVENT, menuActionIds, menuBarSpec, type Platform } from "./menuSpec";
import { installMenuActions, MENU_ACTION_IDS } from "./menuActions";

const PLATFORMS: Platform[] = ["macos", "windows", "linux", "other"];

describe("menu spec ↔ handlers", () => {
  it("every menu item on every platform has a handler (no dead items)", () => {
    for (const platform of PLATFORMS) {
      for (const id of menuActionIds(platform)) {
        expect(MENU_ACTION_IDS, `${platform}: ${id}`).toContain(id);
      }
    }
  });

  it("every handler is reachable from at least one platform's bar", () => {
    const shown = new Set(PLATFORMS.flatMap(menuActionIds));
    for (const id of MENU_ACTION_IDS) expect(shown.has(id), id).toBe(true);
  });

  it("accelerators are unique within a platform's bar", () => {
    for (const platform of PLATFORMS) {
      const seen = new Map<string, string>();
      for (const section of menuBarSpec(platform)) {
        for (const entry of section.entries) {
          if (entry.kind !== "action" || !entry.accelerator) continue;
          const key = entry.accelerator.toLowerCase();
          expect(seen.get(key), `${platform}: ${entry.accelerator}`).toBeUndefined();
          seen.set(key, entry.id);
        }
      }
    }
  });

  it("carries the requested zoom shortcuts", () => {
    const view = menuBarSpec("macos").find((section) => section.text === "View")!;
    const accel = (id: string) =>
      view.entries.find((entry) => entry.kind === "action" && entry.id === id) as { accelerator?: string };
    expect(accel("view.zoom-in").accelerator).toBe("CmdOrCtrl+=");
    expect(accel("view.zoom-out").accelerator).toBe("CmdOrCtrl+-");
    expect(accel("view.zoom-reset").accelerator).toBe("CmdOrCtrl+0");
  });

  it("puts the application menu first on macOS only", () => {
    expect(menuBarSpec("macos")[0].text).toBe("Noam");
    expect(menuBarSpec("windows")[0].text).toBe("File");
  });
});

describe("installMenuActions", () => {
  const host = { closeActiveTab: vi.fn(), reload: vi.fn() };
  let uninstall: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    // The saved zoom is real persistence; start each case from the default.
    try {
      localStorage.clear();
    } catch {
      // No storage in this environment (Node 26 shadows jsdom's) — nothing saved.
    }
    mocks.storeState.createNoteIn = mocks.createNoteIn;
    mocks.storeState.setViewMode = mocks.setViewMode;
    mocks.storeState.openNote = { path: "Notes/a.md" };
    mocks.storeState.viewMode = "live";
    uninstall = installMenuActions(host);
  });
  afterEach(() => uninstall());

  const fire = (detail: unknown) =>
    window.dispatchEvent(new CustomEvent(MENU_ACTION_EVENT, { detail }));
  const press = (key: string, mods: Partial<KeyboardEventInit> = {}) => {
    const event = new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true, ...mods });
    window.dispatchEvent(event);
    return event;
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("routes host-owned actions to the host", async () => {
    fire("file.close-tab");
    fire("view.force-reload");
    await flush();
    expect(host.closeActiveTab).toHaveBeenCalledTimes(1);
    expect(host.reload).toHaveBeenCalledTimes(1);
  });

  it("New Note uses the shared create path", async () => {
    fire("file.new-note");
    await flush();
    expect(mocks.createNoteIn).toHaveBeenCalledWith("");
  });

  it("Reading View toggles reading ⇄ live for the open markdown note", async () => {
    fire("view.reading");
    expect(mocks.setViewMode).toHaveBeenCalledWith("reading");
    mocks.storeState.viewMode = "reading";
    fire("view.reading");
    expect(mocks.setViewMode).toHaveBeenLastCalledWith("live");
    mocks.storeState.openNote = { path: "Notes/page.html" };
    mocks.setViewMode.mockClear();
    fire("view.reading");
    expect(mocks.setViewMode).not.toHaveBeenCalled();
  });

  it("ignores unknown or malformed action ids", async () => {
    fire("nope.nothing");
    fire(42);
    fire(undefined);
    await flush();
    expect(host.closeActiveTab).not.toHaveBeenCalled();
    expect(mocks.setZoom).not.toHaveBeenCalled();
  });

  it("zooms through the webview: menu events step the ladder, ⌘0 resets", async () => {
    fire("view.zoom-in");
    await flush();
    expect(mocks.setZoom).toHaveBeenLastCalledWith(1.1);
    fire("view.zoom-in");
    await flush();
    expect(mocks.setZoom).toHaveBeenLastCalledWith(1.25);
    fire("view.zoom-reset");
    await flush();
    expect(mocks.setZoom).toHaveBeenLastCalledWith(1);
    fire("view.zoom-out");
    await flush();
    expect(mocks.setZoom).toHaveBeenLastCalledWith(0.9);
  });

  it("the keydown fallback zooms and consumes the key", async () => {
    const event = press("=");
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.setZoom).toHaveBeenLastCalledWith(1.1);
    press("0");
    await flush();
    expect(mocks.setZoom).toHaveBeenLastCalledWith(1);
    const bare = press("=", { metaKey: false });
    await flush();
    expect(bare.defaultPrevented).toBe(false);
  });

  it("Documentation opens the website through the opener plugin", async () => {
    fire("help.documentation");
    await flush();
    expect(mocks.openUrl).toHaveBeenCalledWith("https://noamapp.io");
  });

  it("uninstall stops listening", async () => {
    uninstall();
    fire("file.close-tab");
    await flush();
    expect(host.closeActiveTab).not.toHaveBeenCalled();
    uninstall = () => undefined;
  });
});
