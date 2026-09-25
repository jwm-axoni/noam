// Build the native menu bar from `menuSpec.ts` and install it — as the
// application menu on macOS, as the window menu elsewhere. Built exactly once
// at startup (`main.tsx`); every item merely fires `noam:menu-action` and
// `menuActions.ts` does the work, so this file knows nothing about the app.

import { getVersion } from "@tauri-apps/api/app";
import {
  Menu,
  type MenuItemOptions,
  type PredefinedMenuItemOptions,
  type SubmenuOptions,
} from "@tauri-apps/api/menu";
import { platformClass } from "../lib/platform";
import {
  MENU_ACTION_EVENT,
  type MenuActionId,
  type MenuEntry,
  menuBarSpec,
} from "./menuSpec";

function fire(id: MenuActionId): void {
  window.dispatchEvent(new CustomEvent(MENU_ACTION_EVENT, { detail: id }));
}

function toOptions(entry: MenuEntry): MenuItemOptions | PredefinedMenuItemOptions {
  switch (entry.kind) {
    case "action":
      return {
        id: entry.id,
        text: entry.text,
        ...(entry.accelerator ? { accelerator: entry.accelerator } : {}),
        action: () => fire(entry.id),
      };
    case "predefined":
      return { item: entry.item, ...(entry.text ? { text: entry.text } : {}) };
    case "separator":
      return { item: "Separator" };
  }
}

let installed = false;

/** Idempotent: React StrictMode or a hot reload must not stack menu bars. */
export async function installNativeMenu(): Promise<void> {
  if (installed) return;
  installed = true;
  try {
    const platform = platformClass();
    const version = await getVersion().catch(() => undefined);
    const items: SubmenuOptions[] = menuBarSpec(platform, version).map((section) => ({
      text: section.text,
      items: section.entries.map(toOptions),
    }));
    const menu = await Menu.new({ items });
    if (platform === "macos") await menu.setAsAppMenu();
    else await menu.setAsWindowMenu();
  } catch (err) {
    // Outside Tauri (a bare Vite tab) there is no menu bar to install into;
    // the in-page shortcuts still work, so this is a note, not a failure.
    console.warn("native menu unavailable", err);
  }
}
