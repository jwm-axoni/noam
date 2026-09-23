// Parsing and matching the `shortcut` field a workflow may declare.
//
// Three rules, and all three are the reason this is a module rather than an
// inline `if` in the keydown handler:
//
// 1. BUILT-INS WIN. `RESERVED_SHORTCUTS` is handed to
//    `createVaultCommandService`, which turns a collision into a validation
//    warning at scan time, and the app-wide handler below never even looks at
//    a reserved combination — a vault full of downloaded workflows cannot take
//    ⌘S away from you.
// 2. `mod` IS ONE KEY. ⌘ on macOS, Ctrl elsewhere (the contract's wording).
//    Holding BOTH is not the shortcut: the two are alternative primary
//    modifiers, exactly like `matchGlobalShortcut` treats them.
// 3. TYPING IS NOT A COMMAND. A workflow shortcut fires everywhere except
//    inside a text field that is not the CodeMirror content — the editor IS a
//    workflow surface (that is where `insert`/`{{selection}}` steps aim), a
//    rename box is not.

import type { RegisteredWorkflow } from "../../lib/workflows";

export interface ParsedShortcut {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** An explicit, non-`mod` Control. On macOS that is a separate modifier. */
  ctrl: boolean;
  /** Lowercase single character, or a named key (`enter`, `arrowup`, `f5`…). */
  key: string;
}

/** The subset of a `KeyboardEvent` a match needs (so tests can pass a literal). */
export type ShortcutEventLike = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

/**
 * Combinations the app itself owns. Passed to `createVaultCommandService`, and
 * refused here even if a workflow slipped one past validation.
 *
 * Keep in lockstep with `App.tsx`'s keydown handler and
 * `lib/editor/viewModeShortcut.ts`.
 */
export const RESERVED_SHORTCUTS: ReadonlySet<string> = new Set([
  "mod+n", // new note
  "mod+w", // close tab
  "mod+s", // flush pending writes
  "mod+g", // graph
  "mod+f", // search
  "mod+r", // reload
  "mod+e", // cycle view mode
  "mod+shift+p", // the action picker itself
  "mod+shift+u", // People (presence) panel
  "ctrl+tab",
  "ctrl+shift+tab",
]);

const ALIASES: Readonly<Record<string, string>> = {
  cmd: "mod",
  command: "mod",
  meta: "mod",
  super: "mod",
  win: "mod",
  control: "ctrl",
  option: "alt",
  opt: "alt",
  esc: "escape",
  return: "enter",
  space: " ",
  spacebar: " ",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
};

/**
 * `"mod+shift+m"` → its parts, or null when it is not a shortcut we can bind.
 * Exactly one non-modifier key is required; order does not matter.
 */
export function parseShortcut(raw: unknown): ParsedShortcut | null {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().toLowerCase().split("+").map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => p === "")) return null;

  const out: ParsedShortcut = { mod: false, shift: false, alt: false, ctrl: false, key: "" };
  for (const part of parts) {
    const token = ALIASES[part] ?? part;
    if (token === "mod") {
      if (out.mod) return null;
      out.mod = true;
    } else if (token === "shift") {
      if (out.shift) return null;
      out.shift = true;
    } else if (token === "alt") {
      if (out.alt) return null;
      out.alt = true;
    } else if (token === "ctrl") {
      if (out.ctrl) return null;
      out.ctrl = true;
    } else {
      // A second non-modifier is a chord, which nothing here supports.
      if (out.key !== "") return null;
      out.key = token;
    }
  }
  // A bare key with no modifier would swallow ordinary typing.
  if (out.key === "" || !(out.mod || out.ctrl || out.alt)) return null;
  return out;
}

/** The canonical spelling, for comparing against `RESERVED_SHORTCUTS`. */
export function canonicalShortcut(raw: unknown): string | null {
  const parsed = parseShortcut(raw);
  if (!parsed) return null;
  return [
    ...(parsed.mod ? ["mod"] : []),
    ...(parsed.ctrl ? ["ctrl"] : []),
    ...(parsed.alt ? ["alt"] : []),
    ...(parsed.shift ? ["shift"] : []),
    parsed.key,
  ].join("+");
}

export function isReservedShortcut(raw: unknown): boolean {
  const canonical = canonicalShortcut(raw);
  return canonical !== null && RESERVED_SHORTCUTS.has(canonical);
}

/** Does this keystroke mean `shortcut` on this platform? */
export function matchesShortcut(
  event: ShortcutEventLike,
  shortcut: ParsedShortcut,
  isMac: boolean,
): boolean {
  // On macOS `mod` and `ctrl` are two different physical keys; everywhere else
  // they are the same one, so a workflow asking for both gets Ctrl once.
  const wantCtrl = isMac ? shortcut.ctrl : shortcut.mod || shortcut.ctrl;
  const wantMeta = isMac ? shortcut.mod : false;
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.metaKey !== wantMeta) return false;
  if (event.shiftKey !== shortcut.shift) return false;
  if (event.altKey !== shortcut.alt) return false;
  return event.key.toLowerCase() === shortcut.key;
}

/**
 * True when a keystroke at this target may start a workflow. The editor counts
 * as "not typing" on purpose — the whole point of an editor-facing workflow is
 * that you fire it while the caret is in the note.
 */
export function allowsShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(".cm-editor")) return true;
  if (target.closest("input, textarea, select")) return false;
  return target.closest('[contenteditable="true"], [contenteditable="plaintext-only"]') == null;
}

/**
 * The workflow this keystroke starts, or null. Only runnable workflows bind,
 * and a reserved combination never does. The first match in `list()` order
 * (which is by name) wins, so two workflows claiming one key is stable rather
 * than dependent on scan order.
 */
export function findShortcutWorkflow(
  workflows: readonly RegisteredWorkflow[],
  event: ShortcutEventLike,
  isMac: boolean,
): RegisteredWorkflow | null {
  for (const workflow of workflows) {
    if (!workflow.runnable || !workflow.definition) continue;
    const raw = workflow.definition.shortcut;
    if (isReservedShortcut(raw)) continue;
    const parsed = parseShortcut(raw);
    if (parsed && matchesShortcut(event, parsed, isMac)) return workflow;
  }
  return null;
}

/** `⌘⇧M` on macOS, `Ctrl+Shift+M` elsewhere. Empty string when unparseable. */
export function shortcutLabel(raw: unknown, isMac: boolean): string {
  const parsed = parseShortcut(raw);
  if (!parsed) return "";
  const key = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key.replace(/^arrow/, "");
  if (isMac) {
    return `${parsed.ctrl ? "⌃" : ""}${parsed.alt ? "⌥" : ""}${parsed.shift ? "⇧" : ""}${
      parsed.mod ? "⌘" : ""
    }${key}`;
  }
  return [
    ...(parsed.mod || parsed.ctrl ? ["Ctrl"] : []),
    ...(parsed.alt ? ["Alt"] : []),
    ...(parsed.shift ? ["Shift"] : []),
    key.charAt(0).toUpperCase() + key.slice(1),
  ].join("+");
}
