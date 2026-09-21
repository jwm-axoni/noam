export type GlobalShortcut = "new-note" | "graph" | "action-picker";

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
  // ⌘⇧P / Ctrl+Shift+P opens the workflow action picker. It is the one built-in
  // that WANTS Shift, so it is matched ahead of the no-modified-variants guard.
  if (
    event.metaKey !== event.ctrlKey &&
    !event.altKey &&
    event.shiftKey &&
    event.key.toLowerCase() === "p"
  ) {
    return "action-picker";
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
