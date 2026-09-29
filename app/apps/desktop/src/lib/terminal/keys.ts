// Which keystrokes the app keeps while a terminal has focus.
//
// Everything else belongs to the shell: vim, Claude Code and friends rely on
// Ctrl+F, Ctrl+R, Ctrl+W, Ctrl+N and the rest, so the app's global shortcuts
// step aside. What the app keeps:
//   - ⌘-anything on macOS (a shell never sees ⌘; ⌘C/⌘V copy and paste natively),
//   - Ctrl+` and Ctrl+Shift+` (the terminal's own shortcuts),
//   - Ctrl+Tab / Ctrl+Shift+Tab (walk the tab strip; no shell binds it).

type KeyInfo = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

export const TERMINAL_HOST_CLASS = "terminal-host";

/** Is focus (the event target) inside an embedded terminal? */
export function isTerminalTarget(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === "function" && el.closest(`.${TERMINAL_HOST_CLASS}`) != null;
}

/** `Ctrl+\`` (focus/open) or `Ctrl+Shift+\`` (new). Not ⌘: that cycles windows on macOS. */
export function matchTerminalShortcut(e: KeyInfo): "terminal" | "new-terminal" | null {
  if (!e.ctrlKey || e.metaKey || e.altKey) return null;
  // Shift+` is `~` on US layouts; accept both spellings of the key.
  if (e.key !== "`" && e.key !== "~") return null;
  return e.shiftKey ? "new-terminal" : "terminal";
}

/** Should the APP handle this key even though a terminal has focus? */
export function appKeepsKey(e: KeyInfo, isMac: boolean): boolean {
  if (matchTerminalShortcut(e)) return true;
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") return true;
  return isMac && e.metaKey;
}
