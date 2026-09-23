// Phase 1 presence (People panel, registry identity, auto-open) behind a
// device-local kill switch. Default ON; set `noam.flags.presenceV1` to "off"
// (or "false"/"0") to fall back to local hash colors and hide the panel.
// Pre-existing cursors and sidebar dots are not gated.

export const PRESENCE_V1_FLAG_KEY = "noam.flags.presenceV1";

export function presenceV1Enabled(): boolean {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(PRESENCE_V1_FLAG_KEY) ?? null;
  } catch {
    return true;
  }
  if (raw == null) return true;
  return !["off", "false", "0"].includes(raw.trim().toLowerCase());
}
