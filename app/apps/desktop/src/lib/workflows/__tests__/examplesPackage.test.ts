// The bundled examples must be a package like any other: valid manifest,
// verifiable hashes, and — on an empty vault — nothing but `add` decisions.
// If this drifts, "Install examples" either refuses itself or quietly starts
// renaming its own files.

import { describe, expect, it } from "vitest";
import {
  buildExamplesPackage,
  EXAMPLE_FILES,
  EXAMPLES_PACKAGE_ID,
  EXAMPLES_PACKAGE_VERSION,
  parsePackage,
  previewImport,
  serializePackage,
  validatePackage,
} from "../index";
import { createMemoryHost } from "../packages/memoryHost";

const APP_VERSION = "0.1.59";

describe("buildExamplesPackage", () => {
  it("builds a valid package that names every example file", async () => {
    const pkg = await buildExamplesPackage(APP_VERSION);
    expect(pkg.manifest.id).toBe(EXAMPLES_PACKAGE_ID);
    expect(pkg.manifest.version).toBe(EXAMPLES_PACKAGE_VERSION);
    expect(pkg.manifest.minAppVersion).toBe(APP_VERSION);
    expect(pkg.manifest.entries.map((e) => e.path).sort()).toEqual(
      EXAMPLE_FILES.map((f) => f.path).sort(),
    );

    const host = createMemoryHost({ appVersion: APP_VERSION });
    const validation = await validatePackage(pkg, host);
    expect(validation.errors).toEqual([]);
    expect(validation.compatibility.ok).toBe(true);
  });

  it("gives every workflow entry the id from its own fence", async () => {
    const pkg = await buildExamplesPackage(APP_VERSION);
    const workflows = pkg.manifest.entries.filter((e) => e.kind === "workflow");
    expect(workflows.length).toBeGreaterThan(0);
    for (const entry of workflows) expect(entry.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("previews as all-add on an empty vault", async () => {
    const pkg = await buildExamplesPackage(APP_VERSION);
    const host = createMemoryHost({ appVersion: APP_VERSION });
    const preview = await previewImport(pkg, host);
    expect(preview.errors).toEqual([]);
    expect(preview.idempotent).toBe(false);
    expect(preview.items).toHaveLength(EXAMPLE_FILES.length);
    expect([...new Set(preview.items.map((i) => i.decision))]).toEqual(["add"]);
    expect(preview.items.map((i) => i.destination)).toEqual(
      pkg.manifest.entries.map((e) => e.path),
    );
  });

  it("round-trips through serialize/parse", async () => {
    const pkg = await buildExamplesPackage(APP_VERSION);
    const parsed = parsePackage(serializePackage(pkg));
    expect("pkg" in parsed).toBe(true);
    if (!("pkg" in parsed)) return;
    expect(parsed.pkg).toEqual(pkg);
  });
});
