// Manifest validation: the gate every other package operation sits behind.
//
// A package file arrives from outside the vault (a download, a teammate, a
// gist), so every path, hash and version in it is attacker-controlled input.
// These tests pin the refusals.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { NoamPackage } from "../contracts";
import { validateManifest, validatePackage, compareVersions } from "../packages/manifest";

const loadPackageFixture = (name: string): NoamPackage =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/packages/${name}.noam-package.json`, import.meta.url), "utf8"),
  ) as NoamPackage;

const host = (appVersion = "0.1.59") => ({ appVersion: () => appVersion });

const errorsFor = async (name: string, appVersion?: string) =>
  await validateManifest(loadPackageFixture(name), host(appVersion));

const joined = (errors: string[]) => errors.join("\n");

describe("package manifest validation", () => {
  it("accepts the valid fixture", async () => {
    expect(await errorsFor("valid")).toEqual([]);
  });

  it("rejects path traversal", async () => {
    expect(joined(await errorsFor("traversal"))).toMatch(/\.\.|traversal/i);
  });

  it("rejects absolute destinations", async () => {
    expect(joined(await errorsFor("absolute"))).toMatch(/absolute|leading/i);
  });

  it("rejects backslashes, `.context/`, empty segments and leading slashes", async () => {
    const text = joined(await errorsFor("bad-paths"));
    expect(text).toMatch(/backslash/i);
    expect(text).toMatch(/\.context/i);
    expect(text).toMatch(/empty segment/i);
    expect(text).toMatch(/absolute|leading/i);
  });

  it("rejects two entries writing the same destination", async () => {
    expect(joined(await errorsFor("duplicate-entries"))).toMatch(/duplicate entry/i);
  });

  it("rejects a mismatched hash, an entry with no body and a body with no entry", async () => {
    const text = joined(await errorsFor("bad-hash"));
    expect(text).toMatch(/sha256 mismatch/i);
    expect(text).toMatch(/has no body/i);
    expect(text).toMatch(/no entry/i);
  });

  it("rejects a format version, workflow schema version and app version it cannot read", async () => {
    const text = joined(await errorsFor("unsupported-version"));
    expect(text).toMatch(/format version/i);
    expect(text).toMatch(/workflow schema version/i);
    expect(text).toMatch(/needs Noam 99\.1\.0/i);
  });

  it("reports a minAppVersion above this build but accepts one at or below it", async () => {
    const pkg = loadPackageFixture("valid");
    pkg.manifest.minAppVersion = "0.2.0";
    expect(joined(await validateManifest(pkg, host("0.1.59")))).toMatch(/needs Noam 0\.2\.0/);
    expect(await validateManifest(pkg, host("0.2.0"))).toEqual([]);
    expect(await validateManifest(pkg, host("1.0.0"))).toEqual([]);
    expect(await validateManifest(pkg, host("0.10.0"))).toEqual([]);
  });

  it("compares dotted versions numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
  });

  it("rejects a bad package id and a non-semver version", async () => {
    const pkg = loadPackageFixture("valid");
    pkg.manifest.id = "Not An Id";
    pkg.manifest.version = "v1";
    const text = joined(await validateManifest(pkg, host()));
    expect(text).toMatch(/package id/i);
    expect(text).toMatch(/version/i);
  });

  it("rejects an unknown entry kind and a workflow entry with no id", async () => {
    const pkg = loadPackageFixture("valid");
    (pkg.manifest.entries[1] as { kind: string }).kind = "plugin";
    delete pkg.manifest.entries[0].id;
    const text = joined(await validateManifest(pkg, host()));
    expect(text).toMatch(/unknown kind/i);
    expect(text).toMatch(/workflow id/i);
  });

  it("refuses a binary asset outside attachments/ (the Rust binary-write boundary)", async () => {
    const pkg = loadPackageFixture("valid");
    pkg.manifest.entries[2].path = "Assets/starter-logo.png";
    pkg.files["Assets/starter-logo.png"] = pkg.files["attachments/starter-logo.png"];
    delete pkg.files["attachments/starter-logo.png"];
    expect(joined(await validateManifest(pkg, host()))).toMatch(/attachments\//i);
  });

  it("refuses a workflow or template destination that is not a .md file", async () => {
    const pkg = loadPackageFixture("valid");
    pkg.manifest.entries[1].path = "Templates/Daily.txt";
    pkg.files["Templates/Daily.txt"] = pkg.files["Templates/Daily.md"];
    delete pkg.files["Templates/Daily.md"];
    expect(joined(await validateManifest(pkg, host()))).toMatch(/\.md/);
  });

  it("rejects undecodable base64 and an unknown encoding", async () => {
    const pkg = loadPackageFixture("valid");
    pkg.files["attachments/starter-logo.png"] = { encoding: "base64", content: "not*base64!" };
    expect(joined(await validateManifest(pkg, host()))).toMatch(/base64/i);

    const other = loadPackageFixture("valid");
    (other.files["Templates/Daily.md"] as { encoding: string }).encoding = "rot13";
    expect(joined(await validateManifest(other, host()))).toMatch(/encoding/i);
  });

  it("rejects a shape that is not a package at all", async () => {
    expect(joined(await validateManifest({} as unknown as NoamPackage, host()))).toMatch(
      /manifest/i,
    );
  });

  it("reports per-entry problems by entry index for the preview UI", async () => {
    const result = await validatePackage(loadPackageFixture("bad-paths"), host());
    expect(result.entryErrors.get(0)).toMatch(/backslash/i);
    expect(result.entryErrors.get(1)).toMatch(/\.context/i);
    expect(result.compatibility.ok).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("separates compatibility from the rest of the errors", async () => {
    const result = await validatePackage(loadPackageFixture("unsupported-version"), host());
    expect(result.compatibility.ok).toBe(false);
    expect(result.compatibility.message).toMatch(/format version|Noam 99/i);
  });
});
