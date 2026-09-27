// THE central handler for the native menu: `noam:menu-action` → a real command.
// Every `MenuActionId` in `menuSpec.ts` has exactly one entry in `ACTIONS`
// (pinned by `menuSpec.test.ts`), so a menu item can never be dead.
//
// Two things the App shell owns are injected (`MenuActionHost`): closing the
// active tab (it needs the panel-close bookkeeping in App.tsx) and the reload
// that flushes the bridge first. Everything else is reached through the stores
// and the active-note registry, so this module has no React in it.
//
// Editor commands go through a LAZY import of `lib/editor/menuCommands.ts`:
// this file is loaded at startup, and CodeMirror must not be.

import type { EditorView } from "@codemirror/view";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { embedDroppedFile } from "../lib/attachments";
import { activeNoteEditable, getActiveNote, insertIntoActiveNote } from "../lib/editor/activeView";
import * as ipc from "../lib/ipc";
import { toast } from "../lib/toast";
import { useLayoutStore } from "../layout/store";
import { applyTilingAction, type TilingAction } from "../layout/workspaceActions";
import { useStore } from "../store";
import { MENU_ACTION_EVENT, type MenuActionId } from "./menuSpec";
import { DEFAULT_ZOOM, readStoredZoom, stepZoom, storeZoom, zoomActionForKey } from "./zoom";

export interface MenuActionHost {
  /** ⌘W: close the active tab of the focused group (note OR panel). */
  closeActiveTab: () => void | Promise<void>;
  /** Flush pending writes, then reload the webview. */
  reload: () => void | Promise<void>;
}

type EditorMenuCommandId = Extract<MenuActionId, `insert.${string}` | `format.${string}`>;

async function runInEditor(id: EditorMenuCommandId): Promise<void> {
  const note = getActiveNote();
  if (!note?.editable()) return;
  const { runEditorMenuCommand } = await import("../lib/editor/menuCommands");
  runEditorMenuCommand(note.editorView as EditorView, id);
}

const editor = (id: EditorMenuCommandId) => () => runInEditor(id);

/** Reading ⇄ Live, Source ⇄ Live, for the open markdown note. */
function toggleViewMode(mode: "reading" | "source"): void {
  const state = useStore.getState();
  if (!state.openNote?.path.toLowerCase().endsWith(".md")) return;
  state.setViewMode(state.viewMode === mode ? "live" : mode);
}

function toggleDock(zone: "left" | "right"): void {
  const layout = useLayoutStore.getState().layout;
  if (layout.zones[zone].groupIds.length === 0) return;
  useLayoutStore.getState().dispatch({
    type: "set-zone-collapsed",
    zone,
    collapsed: !layout.zones[zone].userCollapsed,
  });
}

/** Same measurement as the tab strip's tiling menu (`TabBar.tsx`). */
function split(action: TilingAction): void {
  const host = document.querySelector<HTMLElement>(".workspace-dock-center");
  const size = action === "split-below" ? host?.clientHeight : host?.clientWidth;
  useLayoutStore.getState().replace(applyTilingAction(action, size ?? 0));
}

let zoomLevel = DEFAULT_ZOOM;

async function applyZoom(level: number): Promise<void> {
  zoomLevel = level;
  storeZoom(level);
  await getCurrentWebview().setZoom(level);
}

async function insertAttachment(): Promise<void> {
  if (!activeNoteEditable()) return;
  const paths = await ipc.pickFiles();
  if (!paths?.length) return;
  try {
    const embeds = await Promise.all(paths.map(embedDroppedFile));
    insertIntoActiveNote(embeds.join("\n"));
  } catch (err) {
    console.error("attach (menu) failed", err);
    toast("Couldn't attach file", "error");
  }
}

const ACTIONS: Record<MenuActionId, (host: MenuActionHost) => void | Promise<void>> = {
  "app.preferences": () => {
    window.dispatchEvent(new CustomEvent("noam:open-settings"));
  },
  "file.new-note": () => void useStore.getState().createNoteIn(""),
  "file.close-tab": (host) => host.closeActiveTab(),
  "insert.internal-link": editor("insert.internal-link"),
  "insert.markdown-link": editor("insert.markdown-link"),
  "insert.callout": editor("insert.callout"),
  "insert.code-block": editor("insert.code-block"),
  "insert.table": editor("insert.table"),
  "insert.bullet-list": editor("insert.bullet-list"),
  "insert.numbered-list": editor("insert.numbered-list"),
  "insert.task-list": editor("insert.task-list"),
  "insert.attachment": insertAttachment,
  "format.heading-1": editor("format.heading-1"),
  "format.heading-2": editor("format.heading-2"),
  "format.heading-3": editor("format.heading-3"),
  "format.heading-4": editor("format.heading-4"),
  "format.heading-5": editor("format.heading-5"),
  "format.heading-6": editor("format.heading-6"),
  "format.body": editor("format.body"),
  "format.bold": editor("format.bold"),
  "format.italic": editor("format.italic"),
  "format.code": editor("format.code"),
  "format.highlight": editor("format.highlight"),
  "format.strikethrough": editor("format.strikethrough"),
  "format.comment": editor("format.comment"),
  "view.reading": () => toggleViewMode("reading"),
  "view.source": () => toggleViewMode("source"),
  "view.toggle-left-sidebar": () => toggleDock("left"),
  "view.toggle-right-sidebar": () => toggleDock("right"),
  "view.split-right": () => split("split-right"),
  "view.split-down": () => split("split-below"),
  "view.zoom-reset": () => applyZoom(DEFAULT_ZOOM),
  "view.zoom-in": () => applyZoom(stepZoom(zoomLevel, 1)),
  "view.zoom-out": () => applyZoom(stepZoom(zoomLevel, -1)),
  "view.force-reload": (host) => host.reload(),
  "view.fullscreen": async () => {
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
  },
  "help.documentation": () => openUrl("https://noamapp.io"),
};

export const MENU_ACTION_IDS = Object.keys(ACTIONS) as MenuActionId[];

export function isMenuActionId(id: unknown): id is MenuActionId {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(ACTIONS, id);
}

/**
 * Listen for menu actions and the zoom-key fallback; restore the saved zoom.
 * Returns the uninstaller (App's effect cleanup).
 */
export function installMenuActions(host: MenuActionHost): () => void {
  const run = (id: MenuActionId) => {
    Promise.resolve(ACTIONS[id](host)).catch((err) => console.error(`menu action ${id} failed`, err));
  };

  const onMenuAction = (event: Event) => {
    const id = (event as CustomEvent).detail;
    if (isMenuActionId(id)) run(id);
  };

  // The keyboard backup for zoom. Consuming the key here is deliberate: on
  // macOS a prevented keydown never reaches the menu accelerator, so each
  // press zooms exactly once whichever path fires first.
  let lastZoom = { id: "", at: 0 };
  const onKey = (event: KeyboardEvent) => {
    const id = zoomActionForKey(event);
    if (!id) return;
    event.preventDefault();
    if (id === lastZoom.id && event.timeStamp - lastZoom.at < 80) return;
    lastZoom = { id, at: event.timeStamp };
    run(id);
  };

  window.addEventListener(MENU_ACTION_EVENT, onMenuAction);
  window.addEventListener("keydown", onKey);

  // The in-memory level always mirrors what the webview shows: the saved
  // level on a fresh install, re-applied so a relaunch keeps the user's zoom.
  zoomLevel = readStoredZoom();
  if (zoomLevel !== DEFAULT_ZOOM) applyZoom(zoomLevel).catch(() => undefined);

  return () => {
    window.removeEventListener(MENU_ACTION_EVENT, onMenuAction);
    window.removeEventListener("keydown", onKey);
  };
}
