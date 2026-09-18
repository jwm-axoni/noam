import { describe, expect, it } from "vitest";
import { buildConnectLink, parseConnectLink } from "../connectLink";
import { parseNoteLink } from "../shareLink";

/**
 * Server-invite links — `noam://connect?server=<url>` (#91).
 *
 * A self-hosting admin sends one link instead of dictating a URL, which means
 * this parser reads a value that decides where a password gets posted. So the
 * tests pin both halves of the contract: every folding a platform might hand us
 * is accepted, and nothing but an http(s) address survives.
 */
describe("parseConnectLink", () => {
  it("round-trips a built link", () => {
    const link = buildConnectLink("https://notes.example.com");
    expect(link).toBe("noam://connect?server=https%3A%2F%2Fnotes.example.com");
    expect(parseConnectLink(link!)).toBe("https://notes.example.com");
  });

  it("accepts the Staging app's scheme (the two builds must not share one)", () => {
    expect(parseConnectLink("noam-staging://connect?server=https%3A%2F%2Fnotes.example.com")).toBe(
      "https://notes.example.com",
    );
  });

  it("accepts the path-folded form some platforms deliver", () => {
    expect(parseConnectLink("noam:///connect?server=https%3A%2F%2Fnotes.example.com")).toBe(
      "https://notes.example.com",
    );
  });

  it("keeps a reverse-proxy path prefix", () => {
    expect(
      parseConnectLink("noam://connect?server=https%3A%2F%2Fintranet.example.com%2Fthread"),
    ).toBe("https://intranet.example.com/thread");
  });

  it("gives a scheme-less host https rather than refusing it", () => {
    expect(parseConnectLink("noam://connect?server=notes.example.com")).toBe(
      "https://notes.example.com",
    );
  });

  it("refuses a server value that isn't an http(s) address", () => {
    for (const bad of [
      "noam://connect?server=javascript%3Aalert(1)",
      "noam://connect?server=ftp%3A%2F%2Ffiles.example.com",
      "noam://connect?server=file%3A%2F%2F%2Fetc%2Fpasswd",
      "noam://connect?server=",
    ]) {
      expect(parseConnectLink(bad)).toBeNull();
    }
  });

  it("returns null for malformed input rather than throwing", () => {
    for (const bad of [
      "",
      "not a url",
      "noam://connect",
      "noam://connect/extra?server=https%3A%2F%2Fx.com",
      "https://notes.example.com/open/connect",
      "otherapp://connect?server=https%3A%2F%2Fx.com",
    ]) {
      expect(parseConnectLink(bad)).toBeNull();
    }
  });

  it("does not claim note links, and note links still parse", () => {
    const note = "noam://note/org_1/doc_2";
    expect(parseConnectLink(note)).toBeNull();
    expect(parseNoteLink(note)).toEqual({ orgId: "org_1", docId: "doc_2" });
    // …and a connect link is not mistaken for a note.
    expect(parseNoteLink("noam://connect?server=https%3A%2F%2Fx.com")).toBeNull();
  });
});

describe("buildConnectLink", () => {
  it("normalizes before encoding", () => {
    expect(buildConnectLink(" notes.example.com/ ")).toBe(
      "noam://connect?server=https%3A%2F%2Fnotes.example.com",
    );
  });

  it("refuses to build a link around a non-address", () => {
    expect(buildConnectLink("javascript:alert(1)")).toBeNull();
  });
});
