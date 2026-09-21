/**
 * Clipboard READ, for the one place that is allowed to do it: the "Paste from
 * clipboard" button in the workflow prompt.
 *
 * The engine never reads the clipboard (a test installs a throwing getter on
 * `navigator` to prove it), so `{{clipboard}}` is only ever the text a person
 * deliberately pasted here. Nothing in this app may call this outside an
 * explicit user gesture.
 *
 * Native first, like `lib/clipboard.ts`'s write: WebKit ties
 * `navigator.clipboard.readText` to transient user activation and often
 * refuses it outright in a webview.
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    const text = await readText();
    if (typeof text === "string") return text;
  } catch {
    /* not running under Tauri (tests, plain browser) — fall through */
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
