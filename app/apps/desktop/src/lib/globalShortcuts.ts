export type GlobalShortcut = "new-note" | "graph" | "action-picker" | "presence";

type ShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

/**
 * Match app-wide shortcuts that must not consume a modified variant. Command
 * and Control are alternative primary modifiers, so holding both is not an
 * exact shortcut either.
 */
export function matchGlobalShortcut(event: ShortcutEvent): GlobalShortcut | null {
  // ⌘⇧P / Ctrl+Shift+P opens the workflow action picker and ⌘⇧U / Ctrl+Shift+U
  // toggles the People panel. They WANT Shift, so they are matched ahead of the
  // no-modified-variants guard.
  if (event.metaKey !== event.ctrlKey && !event.altKey && event.shiftKey) {
    switch (event.key.toLowerCase()) {
      case "p":
        return "action-picker";
      case "u":
        return "presence";
    }
  }
  if (event.metaKey === event.ctrlKey || event.altKey || event.shiftKey) {
    return null;
  }

  switch (event.key.toLowerCase()) {
    case "n":
      return "new-note";
    case "g":
      return "graph";
    default:
      return null;
  }
}
