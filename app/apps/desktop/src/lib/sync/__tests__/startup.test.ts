import { describe, expect, it } from "vitest";
import { decideSeed } from "../startup";

describe("startup ordering — server-first-then-seed (spec 03 §5)", () => {
  it("signed in + not yet synced → wait, never seed prematurely", () => {
    const d = decideSeed({
      signedIn: true,
      serverSynced: false,
      docEmpty: true,
      fileHasContent: true,
    });
    expect(d.action).toBe("wait-for-server");
  });

  it("signed in + synced + server had content → no seed (avoids split-brain)", () => {
    const d = decideSeed({
      signedIn: true,
      serverSynced: true,
      docEmpty: false, // server content populated the doc
      fileHasContent: true,
    });
    expect(d.action).toBe("no-seed");
  });

  it("signed in + synced + empty doc + file has content → seed the orphan", () => {
    const d = decideSeed({
      signedIn: true,
      serverSynced: true,
      docEmpty: true,
      fileHasContent: true,
    });
    expect(d.action).toBe("seed-from-file");
  });

  it("signed in + synced + empty doc + empty file → nothing to seed", () => {
    const d = decideSeed({
      signedIn: true,
      serverSynced: true,
      docEmpty: true,
      fileHasContent: false,
    });
    expect(d.action).toBe("no-seed");
  });

  it("offline/local-only + empty doc + file content → seed immediately", () => {
    const d = decideSeed({
      signedIn: false,
      serverSynced: false,
      docEmpty: true,
      fileHasContent: true,
    });
    expect(d.action).toBe("seed-from-file");
  });

  it("offline/local-only + doc hydrated from local CRDT → no seed", () => {
    const d = decideSeed({
      signedIn: false,
      serverSynced: false,
      docEmpty: false,
      fileHasContent: true,
    });
    expect(d.action).toBe("no-seed");
  });
});
