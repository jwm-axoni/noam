import { describe, expect, it } from "vitest";
import {
  expiryLabel,
  staleLabel,
  summarizeScopes,
  sunsetLabel,
  type ScopeNames,
} from "../mcpTokenLabels";

const ORG = "org-1";
const names: ScopeNames = {
  folder: (id) => (id === "f-projects" ? "Projects" : null),
  file: (id) => (id === "n-1" ? "Projects/Plan.md" : null),
};
// Pinned formatter: the helpers take the date format as an argument so the
// assertions don't depend on the test machine's locale or time zone.
const fmt = (iso: string) => iso.slice(0, 10);

describe("summarizeScopes", () => {
  it("reader: whole vault, read", () => {
    expect(
      summarizeScopes([{ resourceType: "vault", resourceId: ORG, permission: "view" }], names),
    ).toBe("Whole vault · read");
  });

  it("editor: whole vault, edit", () => {
    expect(
      summarizeScopes([{ resourceType: "vault", resourceId: ORG, permission: "edit" }], names),
    ).toBe("Whole vault · edit");
  });

  it("drafter: whole vault read plus one folder edit, vault first", () => {
    expect(
      summarizeScopes(
        [
          { resourceType: "folder", resourceId: "f-projects", permission: "edit" },
          { resourceType: "vault", resourceId: ORG, permission: "view" },
        ],
        names,
      ),
    ).toBe("Whole vault · read · Projects/ · edit");
  });

  it("a folder this device cannot name is counted, not dropped", () => {
    expect(
      summarizeScopes(
        [
          { resourceType: "vault", resourceId: ORG, permission: "view" },
          { resourceType: "folder", resourceId: "f-unknown", permission: "edit" },
        ],
        names,
      ),
    ).toBe("Whole vault · read · 1 folder · edit");
  });

  it("a single file scope reads as one note", () => {
    expect(
      summarizeScopes([{ resourceType: "file", resourceId: "n-1", permission: "view" }], names),
    ).toBe("1 note · read");
  });

  it("file scopes are counted per permission", () => {
    expect(
      summarizeScopes(
        [
          { resourceType: "file", resourceId: "n-1", permission: "view" },
          { resourceType: "file", resourceId: "n-2", permission: "view" },
          { resourceType: "file", resourceId: "n-3", permission: "edit" },
        ],
        names,
      ),
    ).toBe("2 notes · read · 1 note · edit");
  });

  it("no scope rows: the token can only list vaults", () => {
    expect(summarizeScopes([], names)).toBe("No access — lists vaults only");
  });
});

describe("sunsetLabel", () => {
  it("names the date and the way out", () => {
    expect(sunsetLabel("2026-12-31T12:00:00.000Z", fmt)).toBe(
      "Stops working on 2026-12-31 — migrate to an agent token",
    );
  });
});

describe("expiryLabel", () => {
  const now = Date.parse("2026-09-23T12:00:00.000Z");
  it("future expiry", () => {
    expect(expiryLabel("2026-12-22T12:00:00.000Z", now, fmt)).toBe("Expires 2026-12-22");
  });
  it("past expiry", () => {
    expect(expiryLabel("2026-09-01T12:00:00.000Z", now, fmt)).toBe("Expired 2026-09-01");
  });
  it("no expiry", () => {
    expect(expiryLabel(null, now, fmt)).toBe("Never expires");
  });
});

describe("staleLabel", () => {
  it("only a stale token gets the tag", () => {
    expect(staleLabel(true)).toBe("Stale · unused 30+ days");
    expect(staleLabel(false)).toBeNull();
  });
});
