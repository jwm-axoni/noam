import { describe, expect, it } from "vitest";
import { SUGGESTIONS_V0_FLAG, suggestionsV0Enabled } from "./flag";

const store = (v: string | null) => ({ getItem: (k: string) => (k === SUGGESTIONS_V0_FLAG ? v : null) });

describe("suggestionsV0Enabled", () => {
  it("is off by default and on only for 1/true", () => {
    expect(suggestionsV0Enabled(store(null))).toBe(false);
    expect(suggestionsV0Enabled(store("0"))).toBe(false);
    expect(suggestionsV0Enabled(store("1"))).toBe(true);
    expect(suggestionsV0Enabled(store("true"))).toBe(true);
    expect(suggestionsV0Enabled(undefined)).toBe(false);
  });

  it("stays off when storage throws", () => {
    expect(suggestionsV0Enabled({ getItem: () => { throw new Error("denied"); } })).toBe(false);
  });
});
