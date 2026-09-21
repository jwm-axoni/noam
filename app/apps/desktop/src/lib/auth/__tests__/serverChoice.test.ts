import { describe, expect, it } from "vitest";
import {
  decideAuthStep,
  impliedServerChoice,
  normalizeServerUrl,
  serverHost,
} from "../serverChoice";

/**
 * The server-choice step's decision table (#91).
 *
 * There is no component-render harness in this workspace, so the rules that
 * decide WHERE the sign-in dialog opens — and what counts as a server address —
 * live in pure functions and get pinned here. The stake is not cosmetic: every
 * user self-hosts and a release build has no default server, so get
 * `decideAuthStep` wrong in the "never asked" direction and a fresh install
 * skips the step that asks for the address; get `normalizeServerUrl` wrong and
 * a deep link decides where a password is posted.
 */
describe("normalizeServerUrl", () => {
  it("prepends https to a bare host", () => {
    expect(normalizeServerUrl("notes.example.com")).toBe("https://notes.example.com");
  });

  it("strips trailing slashes but keeps a reverse-proxy path prefix", () => {
    expect(normalizeServerUrl("https://intranet.example.com/thread/")).toBe(
      "https://intranet.example.com/thread",
    );
    expect(normalizeServerUrl("https://api.noam.io///")).toBe("https://api.noam.io");
  });

  it("keeps an explicit port and honours http for a local server", () => {
    expect(normalizeServerUrl("http://localhost:3010")).toBe("http://localhost:3010");
    expect(normalizeServerUrl(" https://notes.example.com:8443 ")).toBe(
      "https://notes.example.com:8443",
    );
  });

  it("drops the default port and lowercases the host", () => {
    expect(normalizeServerUrl("https://Notes.Example.com:443")).toBe(
      "https://notes.example.com",
    );
  });

  it("refuses anything that isn't http(s)", () => {
    for (const bad of [
      "javascript:alert(1)",
      "javascript://alert(1)",
      "ftp://files.example.com",
      "file:///etc/passwd",
      "data:text/html,<script>",
    ]) {
      expect(normalizeServerUrl(bad)).toBeNull();
    }
  });

  it("refuses empty and malformed input", () => {
    for (const bad of ["", "   ", "https://", "http://", "://nope"]) {
      expect(normalizeServerUrl(bad)).toBeNull();
    }
  });
});

describe("serverHost", () => {
  it("names the host, with any path prefix that distinguishes two instances", () => {
    expect(serverHost("https://api.noam.io")).toBe("api.noam.io");
    expect(serverHost("http://localhost:3010")).toBe("localhost:3010");
    expect(serverHost("https://intranet.example.com/thread")).toBe(
      "intranet.example.com/thread",
    );
  });

  it("falls back to the raw string rather than rendering nothing", () => {
    expect(serverHost("not a url")).toBe("not a url");
  });
});

describe("impliedServerChoice", () => {
  // A release build has no default server, so anything non-empty is an answer.
  it("reads any configured URL as a self-host answer when there is no default", () => {
    expect(impliedServerChoice("https://notes.example.com", "")).toBe("custom");
    expect(impliedServerChoice("https://api.noam.io", "")).toBe("custom");
  });

  it("treats an empty/unconfigured server as no answer", () => {
    expect(impliedServerChoice("", "")).toBeNull();
    expect(impliedServerChoice("   ", "")).toBeNull();
  });

  it("still treats a device sitting on the (dev) default as no answer", () => {
    expect(
      impliedServerChoice("http://localhost:3010", "http://localhost:3010"),
    ).toBeNull();
    expect(
      impliedServerChoice("http://localhost:3010/", "http://localhost:3010"),
    ).toBeNull();
  });
});

describe("decideAuthStep", () => {
  it("asks on a first run with no server configured", () => {
    expect(
      decideAuthStep({ choice: null, serverUrl: "", defaultServerUrl: "" }),
    ).toBe("choose-server");
  });

  it("does not ask again once the question is answered", () => {
    expect(
      decideAuthStep({
        choice: "custom",
        serverUrl: "https://notes.example.com",
        defaultServerUrl: "",
      }),
    ).toBe("form");
    // A device carrying the legacy "managed" value still routes past the step.
    expect(
      decideAuthStep({
        choice: "managed",
        serverUrl: "https://api.noam.io",
        defaultServerUrl: "",
      }),
    ).toBe("form");
  });

  it("does not ask a device that already points at its own server", () => {
    // It answered through the old <details>; asking again would be needless.
    expect(
      decideAuthStep({
        choice: null,
        serverUrl: "https://notes.example.com",
        defaultServerUrl: "",
      }),
    ).toBe("form");
  });

  it("lets a pending invite link outrank every other step", () => {
    for (const choice of [null, "managed", "custom"] as const) {
      expect(
        decideAuthStep({
          choice,
          serverUrl: "",
          pendingServerLink: "https://notes.example.com",
          defaultServerUrl: "",
        }),
      ).toBe("confirm-link");
    }
  });

  it("ignores an empty pending link", () => {
    expect(
      decideAuthStep({
        choice: "custom",
        serverUrl: "https://notes.example.com",
        pendingServerLink: "",
        defaultServerUrl: "",
      }),
    ).toBe("form");
  });
});
