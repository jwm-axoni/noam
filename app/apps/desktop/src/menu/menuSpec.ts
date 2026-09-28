// The native menu bar, as DATA. Nothing here touches Tauri: `nativeMenu.ts`
// turns this into `@tauri-apps/api/menu` objects and `menuActions.ts` maps
// every action id to a real command. Keeping the three apart is what lets
// `menuSpec.test.ts` prove there is no dead item — every `action` entry below
// must have a handler, and every accelerator must be unique.
//
// Only items that map to something real are listed. Obsidian items with no
// Noam equivalent (New Tab, New Window, Open Quickly, Export to PDF, Math
// Block, Footnote) are deliberately absent rather than shipped disabled.
//
// Accelerators are advisory on macOS: WKWebView lets the page see the key
// first, and a keydown that calls `preventDefault()` (CodeMirror's ⌘B, the
// app's ⌘W …) never reaches the menu. The menu therefore mirrors shortcuts
// the page already owns, and takes over only when the page declines the key
// — which is exactly the zoom keys, which nothing else binds.

import type { PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import type { platformClass } from "../lib/platform";

/** Window event every menu item fires; `detail` is the `MenuActionId`. */
export const MENU_ACTION_EVENT = "noam:menu-action";

export type MenuActionId =
  | "app.preferences"
  | "file.new-note"
  | "file.close-tab"
  | "insert.internal-link"
  | "insert.markdown-link"
  | "insert.callout"
  | "insert.code-block"
  | "insert.table"
  | "insert.bullet-list"
  | "insert.numbered-list"
  | "insert.task-list"
  | "insert.attachment"
  | "format.heading-1"
  | "format.heading-2"
  | "format.heading-3"
  | "format.heading-4"
  | "format.heading-5"
  | "format.heading-6"
  | "format.body"
  | "format.bold"
  | "format.italic"
  | "format.code"
  | "format.highlight"
  | "format.strikethrough"
  | "format.comment"
  | "view.reading"
  | "view.source"
  | "view.toggle-left-sidebar"
  | "view.toggle-right-sidebar"
  | "view.split-right"
  | "view.split-down"
  | "view.zoom-reset"
  | "view.zoom-in"
  | "view.zoom-out"
  | "view.force-reload"
  | "view.fullscreen"
  | "help.documentation";

export type Platform = ReturnType<typeof platformClass>;

export type MenuEntry =
  | { kind: "action"; id: MenuActionId; text: string; accelerator?: string }
  | { kind: "predefined"; item: PredefinedMenuItemOptions["item"]; text?: string }
  | { kind: "separator" };

export interface MenuSection {
  text: string;
  entries: MenuEntry[];
}

const action = (id: MenuActionId, text: string, accelerator?: string): MenuEntry => ({
  kind: "action",
  id,
  text,
  ...(accelerator ? { accelerator } : {}),
});
const predefined = (item: PredefinedMenuItemOptions["item"], text?: string): MenuEntry => ({
  kind: "predefined",
  item,
  ...(text ? { text } : {}),
});
const separator = (): MenuEntry => ({ kind: "separator" });

/**
 * The whole bar for one platform. macOS gets the application menu (About,
 * Services, Hide …) and the OS's own Full Screen item; elsewhere Preferences
 * and Quit move into File, and full screen is our own window toggle.
 */
export function menuBarSpec(platform: Platform, version?: string): MenuSection[] {
  const mac = platform === "macos";
  const preferences = action("app.preferences", "Preferences…", "CmdOrCtrl+,");

  const sections: MenuSection[] = [];
  if (mac) {
    sections.push({
      text: "Noam",
      entries: [
        predefined({ About: { name: "Noam", version, website: "https://noamapp.io" } }, "About Noam"),
        separator(),
        preferences,
        separator(),
        predefined("Services"),
        separator(),
        predefined("Hide"),
        predefined("HideOthers"),
        predefined("ShowAll"),
        separator(),
        predefined("Quit"),
      ],
    });
  }

  sections.push({
    text: "File",
    entries: [
      action("file.new-note", "New Note", "CmdOrCtrl+N"),
      separator(),
      action("file.close-tab", "Close Tab", "CmdOrCtrl+W"),
      predefined("CloseWindow", "Close Window"),
      ...(mac ? [] : [separator(), preferences, separator(), predefined("Quit")]),
    ],
  });

  sections.push({
    text: "Edit",
    entries: [
      predefined("Undo"),
      predefined("Redo"),
      separator(),
      predefined("Cut"),
      predefined("Copy"),
      predefined("Paste"),
      predefined("SelectAll"),
    ],
  });

  sections.push({
    text: "Insert",
    entries: [
      action("insert.internal-link", "Internal Link"),
      action("insert.markdown-link", "Markdown Link", "CmdOrCtrl+K"),
      separator(),
      action("insert.callout", "Callout"),
      action("insert.code-block", "Code Block"),
      action("insert.table", "Table"),
      separator(),
      action("insert.bullet-list", "Bullet List"),
      action("insert.numbered-list", "Numbered List"),
      action("insert.task-list", "Task List", "CmdOrCtrl+L"),
      separator(),
      action("insert.attachment", "Attachment…"),
    ],
  });

  sections.push({
    text: "Format",
    entries: [
      ...([1, 2, 3, 4, 5, 6] as const).map((n) =>
        action(`format.heading-${n}`, `Heading ${n}`, `CmdOrCtrl+Alt+${n}`),
      ),
      action("format.body", "Body"),
      separator(),
      action("format.bold", "Bold", "CmdOrCtrl+B"),
      action("format.italic", "Italic", "CmdOrCtrl+I"),
      action("format.code", "Code"),
      action("format.highlight", "Highlight", "CmdOrCtrl+Shift+H"),
      action("format.strikethrough", "Strikethrough", "CmdOrCtrl+Shift+X"),
      action("format.comment", "Comment", "CmdOrCtrl+/"),
    ],
  });

  sections.push({
    text: "View",
    entries: [
      action("view.reading", "Reading View", "CmdOrCtrl+E"),
      action("view.source", "Source Mode"),
      separator(),
      action("view.toggle-left-sidebar", "Toggle Left Sidebar"),
      action("view.toggle-right-sidebar", "Toggle Right Sidebar"),
      separator(),
      action("view.split-right", "Split Right"),
      action("view.split-down", "Split Down"),
      separator(),
      action("view.zoom-reset", "Actual Size", "CmdOrCtrl+0"),
      action("view.zoom-in", "Zoom In", "CmdOrCtrl+="),
      action("view.zoom-out", "Zoom Out", "CmdOrCtrl+-"),
      separator(),
      action("view.force-reload", "Force Reload", "CmdOrCtrl+R"),
      mac
        ? predefined("Fullscreen", "Toggle Full Screen")
        : action("view.fullscreen", "Toggle Full Screen", "F11"),
    ],
  });

  sections.push({
    text: "Window",
    entries: [predefined("Minimize"), predefined("CloseWindow", "Close")],
  });

  sections.push({
    text: "Help",
    entries: [action("help.documentation", "Documentation")],
  });

  return sections;
}

/** Every action id the bar for `platform` can fire. */
export function menuActionIds(platform: Platform): MenuActionId[] {
  return menuBarSpec(platform).flatMap((section) =>
    section.entries.flatMap((entry) => (entry.kind === "action" ? [entry.id] : [])),
  );
}
