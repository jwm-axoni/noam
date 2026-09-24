// Device-local feature flag for the v0 suggestion review surface. Default OFF:
// there is no proposal source until ADR-1, so the panel only shows sample
// suggestions when someone opts in with
//   localStorage.setItem("noam.flags.suggestionsV0", "1")

export const SUGGESTIONS_V0_FLAG = "noam.flags.suggestionsV0";

export function suggestionsV0Enabled(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    const v = storage?.getItem(SUGGESTIONS_V0_FLAG);
    return v === "1" || v === "true";
  } catch {
    return false; // storage unavailable (privacy mode) — stay off
  }
}
