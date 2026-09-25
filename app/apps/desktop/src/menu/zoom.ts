// Webview zoom, the pure half: the level ladder, the stepping rule and the
// keyboard fallback. Applying a level (`getCurrentWebview().setZoom`) lives in
// `menuActions.ts`, so this file runs under plain Node in tests.

export const ZOOM_LEVELS: readonly number[] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const DEFAULT_ZOOM = 1;

const STORAGE_KEY = "noam.zoom";

/**
 * The next level up or down from `current`, clamped to the ladder. A level
 * that is not on the ladder (a stale stored value) snaps to its nearest rung
 * first, so stepping is always ladder-to-ladder.
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  let nearest = 0;
  for (let i = 1; i < ZOOM_LEVELS.length; i++) {
    if (Math.abs(ZOOM_LEVELS[i] - current) < Math.abs(ZOOM_LEVELS[nearest] - current)) nearest = i;
  }
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, nearest + direction));
  return ZOOM_LEVELS[next];
}

export type ZoomAction = "view.zoom-in" | "view.zoom-out" | "view.zoom-reset";

type ZoomKeyEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

/**
 * ⌘= / ⌘+ zoom in, ⌘- zooms out, ⌘0 resets (Ctrl on other platforms). This is
 * the BACKUP for the menu accelerators, for platforms where a focused webview
 * keeps the key from the menu; on macOS the page sees the key first anyway,
 * and consuming it here keeps the menu from firing a second time.
 */
export function zoomActionForKey(event: ZoomKeyEvent): ZoomAction | null {
  // Exactly one primary modifier, like `matchGlobalShortcut`.
  if (event.metaKey === event.ctrlKey || event.altKey) return null;
  switch (event.key) {
    case "=":
    case "+":
      return "view.zoom-in";
    case "-":
      return "view.zoom-out";
    case "0":
      return event.shiftKey ? null : "view.zoom-reset";
    default:
      return null;
  }
}

/** The level saved by the last zoom, or the default. Never throws. */
export function readStoredZoom(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const level = raw == null ? NaN : Number(raw);
    return ZOOM_LEVELS.includes(level) ? level : DEFAULT_ZOOM;
  } catch {
    return DEFAULT_ZOOM;
  }
}

export function storeZoom(level: number): void {
  try {
    if (level === DEFAULT_ZOOM) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(level));
  } catch {
    // A device-local convenience; losing it costs one keystroke next launch.
  }
}
