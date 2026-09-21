// Export → serialize → parse → import must be lossless.
//
// A package is a file people mail each other, so the only thing that makes it
// trustworthy is that the bytes that come out are the bytes that went in — the
// manifest hashes are checked on the way back in, and a binary asset has to
// survive the base64 hop untouched.

import { describe, expect, it } from "vitest";

import { applyImport } from "../packages/apply";
import { bytesToBase64, sha256Bytes, sha256Text } from "../packages/bytes";
import { exportPackage, parsePackage, serializePackage } from "../packages/export";
import { validateManifest } from "../packages/manifest";
import { createMemoryHost } from "../packages/memoryHost";
import { previewImport } from "../packages/preview";
import { serializeWorkflowNote } from "../packages/noteFormat";
import { PACKAGE_FILE_SUFFIX } from "../contracts";

const definition = {
  version: 1 as const,
  id: "weekly-review",
  name: "Weekly review",
  steps: [
    { type: "create-note" as const, path: "Reviews/{{date:YYYY-MM-DD}}.md", template: "Templates/Review.md" },
  ],
};
const workflowNote = serializeWorkflowNote(definition);
const template = "# Review\n\n## What went well\n";
const assetBytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f, 0x00]);

function sourceHost() {
  return createMemoryHost({
    files: { "Workflows/Weekly review.md": workflowNote, "Templates/Review.md": template },
    base64Files: { "attachments/seal.bin": bytesToBase64(assetBytes) },
  });
}

const selection = {
  id: "review-pack",
  name: "Review pack",
  description: "A weekly review workflow and its template.",
  version: "2.0.1",
  entries: [
    { path: "Workflows/Weekly review.md", kind: "workflow" as const, id: "weekly-review" },
    { path: "Templates/Review.md", kind: "template" as const },
    { path: "attachments/seal.bin", kind: "asset" as const },
  ],
};

describe("exporting a package", () => {
  it("builds a manifest this build would accept", async () => {
    const host = sourceHost();
    const pkg = await exportPackage(selection, host);

    expect(await validateManifest(pkg, host)).toEqual([]);
    expect(pkg.manifest.minAppVersion).toBe(host.appVersion());
    expect(pkg.manifest.formatVersion).toBe(1);
    expect(pkg.manifest.workflowSchemaVersion).toBe(1);
    expect(pkg.manifest.entries.map((e) => e.path)).toEqual(selection.entries.map((e) => e.path));
  });

  it("reads .md bodies as text and everything else as base64", async () => {
    const pkg = await exportPackage(selection, sourceHost());

    expect(pkg.files["Templates/Review.md"]).toEqual({ encoding: "utf8", content: template });
    expect(pkg.files["attachments/seal.bin"]).toEqual({
      encoding: "base64",
      content: bytesToBase64(assetBytes),
    });
    expect(pkg.manifest.entries[2].sha256).toBe(await sha256Bytes(assetBytes));
    expect(pkg.manifest.entries[1].sha256).toBe(await sha256Text(template));
  });

  it("takes the workflow id from the note when the selection omits it", async () => {
    const pkg = await exportPackage(
      { ...selection, entries: [{ path: "Workflows/Weekly review.md", kind: "workflow" }] },
      sourceHost(),
    );
    expect(pkg.manifest.entries[0].id).toBe("weekly-review");
  });

  it("refuses to export a file that is not there", async () => {
    await expect(
      exportPackage(
        { ...selection, entries: [{ path: "Templates/Gone.md", kind: "template" }] },
        sourceHost(),
      ),
    ).rejects.toThrow(/Templates\/Gone\.md/);
  });

  it("refuses a selection whose own paths are unsafe", async () => {
    await expect(
      exportPackage(
        { ...selection, entries: [{ path: "../escape.md", kind: "template" }] },
        sourceHost(),
      ),
    ).rejects.toThrow(/traversal/i);
  });

  it("round trips through the serialized file into another vault", async () => {
    const pkg = await exportPackage(selection, sourceHost());
    const text = serializePackage(pkg);
    expect(text.endsWith("\n")).toBe(true);
    expect(PACKAGE_FILE_SUFFIX).toBe(".noam-package.json");

    const parsed = parsePackage(text);
    expect("pkg" in parsed).toBe(true);
    if (!("pkg" in parsed)) throw new Error("unreachable");

    const target = createMemoryHost();
    const preview = await previewImport(parsed.pkg, target);
    expect(preview.errors).toEqual([]);
    const outcome = await applyImport(preview, parsed.pkg, target);
    expect(outcome.ok).toBe(true);

    expect(await target.readText("Workflows/Weekly review.md")).toBe(workflowNote);
    expect(await target.readText("Templates/Review.md")).toBe(template);
    expect(await target.readBytes("attachments/seal.bin")).toEqual(assetBytes);
  });

  it("rejects text that is not a package", () => {
    expect(parsePackage("not json at all")).toEqual({ error: expect.stringMatching(/JSON|parse/i) });
    expect(parsePackage("[1,2,3]")).toEqual({ error: expect.stringMatching(/package/i) });
    expect(parsePackage(JSON.stringify({ manifest: {} }))).toEqual({
      error: expect.stringMatching(/file bodies|files/i),
    });
  });
});
