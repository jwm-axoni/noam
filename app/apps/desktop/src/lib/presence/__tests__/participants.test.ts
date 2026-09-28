import { describe, expect, it } from "vitest";
import { ParticipantDirectory, type Participant } from "../participants";

const maya: Participant = {
  id: "p-maya",
  kind: "human",
  displayName: "Maya",
  color: "#2981fb",
  harness: null,
  createdAt: "2026-09-01T00:00:00Z",
};

describe("ParticipantDirectory", () => {
  it("resolves a known participant to its registry name and color", () => {
    const dir = new ParticipantDirectory([maya]);
    expect(dir.get("p-maya")).toBe(maya);
    expect(dir.resolve("p-maya", { name: "spoofed", color: "#000000" })).toEqual({
      name: "Maya",
      color: "#2981fb",
    });
  });

  it("falls back to the asserted values for an unknown or absent id", () => {
    const dir = new ParticipantDirectory([maya]);
    const fallback = { name: "Ada", color: "#047e67" };
    expect(dir.resolve("p-unknown", fallback)).toEqual(fallback);
    expect(dir.resolve(undefined, fallback)).toEqual(fallback);
    expect(new ParticipantDirectory([]).resolve("p-maya", fallback)).toEqual(fallback);
  });
});
