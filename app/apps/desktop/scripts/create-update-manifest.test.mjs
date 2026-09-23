import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeUpdateManifest } from "./create-update-manifest.mjs";

test("points the updater at the release archive with its signature", () => {
  const dir = mkdtempSync(join(tmpdir(), "noam-manifest-"));
  try {
    const signature = join(dir, "Noam.app.tar.gz.sig");
    writeFileSync(signature, "signed-test-value\n");
    const manifest = makeUpdateManifest({
      version: "0.1.60", archive: join(dir, "Noam.app.tar.gz"), signature,
      notes: "Graph and editor polish", date: "2026-09-22T00:00:00Z",
    });
    assert.deepEqual(manifest, {
      version: "0.1.60", notes: "Graph and editor polish", pub_date: "2026-09-22T00:00:00Z",
      platforms: { "darwin-aarch64": {
        signature: "signed-test-value",
        url: "https://github.com/jwm-axoni/noam/releases/download/v0.1.60/Noam.app.tar.gz",
      } },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
