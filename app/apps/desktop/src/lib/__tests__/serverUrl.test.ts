import { describe, it, expect } from "vitest";
import { resolveServerUrl, DEFAULT_SERVER_URL, LOCAL_SERVER_URL } from "../api";

// Vitest runs with import.meta.env.DEV === true, so the build default is the
// local stack. There is no managed instance to guard against — a release build
// has no default at all — so `resolveServerUrl` now just normalizes the
// persisted value and falls back to the default when there is none.
describe("resolveServerUrl (dev build)", () => {
  it("defaults to the local stack when nothing is persisted", () => {
    expect(DEFAULT_SERVER_URL).toBe(LOCAL_SERVER_URL);
    expect(resolveServerUrl(null)).toBe(LOCAL_SERVER_URL);
    expect(resolveServerUrl("")).toBe(LOCAL_SERVER_URL);
    expect(resolveServerUrl("   ")).toBe(LOCAL_SERVER_URL);
  });

  it("honours any persisted server, trailing slash stripped", () => {
    // No dev-guard: whatever was persisted is used as-is (once cleaned), so a
    // staging / LAN / self-host override from Settings keeps working.
    expect(resolveServerUrl("https://api.noam.io/")).toBe("https://api.noam.io");
  });

  it("honours any other persisted server", () => {
    // Staging / LAN / self-host overrides must keep working from Settings.
    expect(resolveServerUrl("https://staging.example.com")).toBe(
      "https://staging.example.com",
    );
    expect(resolveServerUrl("http://192.168.1.20:3010/")).toBe(
      "http://192.168.1.20:3010",
    );
    expect(resolveServerUrl("http://localhost:4000")).toBe("http://localhost:4000");
  });
});
