// Import preview: what WOULD happen, decided before anything is written.
//
// The load-bearing rule is the `duplicate` one — an unrelated note at a
// package's destination is never overwritten, it is written beside it under a
// renamed destination. `replace` is only ever offered for a file this device
// imported from THIS package and that nobody has touched since (the ledger),
// which is also what makes a re-import a no-op.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ImportPreview, NoamPackage } from "../contracts";
import { createMemoryHost } from "../packages/memoryHost";
import { PackageLedger, memoryLedgerStore } from "../packages/ledger";
import { previewImport } from "../packages/preview";
import { sha256Text } from "../packages/bytes";

const loadPackageFixture = (name: string): NoamPackage =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/packages/${name}.noam-package.json`, import.meta.url), "utf8"),
  ) as NoamPackage;

const valid = () => loadPackageFixture("valid");
const WORKFLOW_PATH = "Workflows/Daily note.md";
const TEMPLATE_PATH = "Templates/Daily.md";

const bodyOf = (pkg: NoamPackage, path: string) => pkg.files[path].content;
const itemFor = (preview: ImportPreview, path: string) =>
  preview.items.find((i) => i.entry.path === path)!;

describe("import preview decisions", () => {
  it("adds an entry whose destination is free", async () => {
    const host = createMemoryHost();
    const preview = await previewImport(valid(), host);

    expect(preview.errors).toEqual([]);
    expect(preview.items.map((i) => i.decision)).toEqual(["add", "add", "add"]);
    expect(itemFor(preview, WORKFLOW_PATH).destination).toBe(WORKFLOW_PATH);
    expect(preview.idempotent).toBe(false);
  });

  it("skips an entry whose destination is already byte-identical", async () => {
    const pkg = valid();
    const host = createMemoryHost({ files: { [TEMPLATE_PATH]: bodyOf(pkg, TEMPLATE_PATH) } });

    const item = itemFor(await previewImport(pkg, host), TEMPLATE_PATH);
    expect(item.decision).toBe("skip");
    expect(item.reason).toBe("identical");
  });

  it("replaces a prior copy of the same package entry", async () => {
    const pkg = valid();
    const older = "# Daily\n\nan older version of this template\n";
    const host = createMemoryHost({ files: { [TEMPLATE_PATH]: older } });
    const ledger = new PackageLedger(memoryLedgerStore());
    ledger.record({
      packageId: pkg.manifest.id,
      version: "1.0.0",
      importedAt: "2026-09-01T00:00:00.000Z",
      entries: [{ path: TEMPLATE_PATH, destination: TEMPLATE_PATH, sha256: await sha256Text(older) }],
    });

    const item = itemFor(await previewImport(pkg, host, { ledger }), TEMPLATE_PATH);
    expect(item.decision).toBe("replace");
    expect(item.destination).toBe(TEMPLATE_PATH);
    expect(item.existingSha256).toBe(await sha256Text(older));
  });

  it("never overwrites an unrelated note: it renames the destination instead", async () => {
    const pkg = valid();
    const mine = "# My own daily template\n";
    const host = createMemoryHost({ files: { [TEMPLATE_PATH]: mine } });

    const item = itemFor(await previewImport(pkg, host), TEMPLATE_PATH);
    expect(item.decision).toBe("duplicate");
    expect(item.destination).toBe("Templates/Daily (starter-pack).md");
    expect(await host.readText(TEMPLATE_PATH)).toBe(mine);
  });

  it("counts up when the renamed destination is taken too", async () => {
    const pkg = valid();
    const host = createMemoryHost({
      files: {
        [TEMPLATE_PATH]: "# mine\n",
        "Templates/Daily (starter-pack).md": "# an older import I kept\n",
        "Templates/Daily (starter-pack) 2.md": "# and another\n",
      },
    });

    expect(itemFor(await previewImport(pkg, host), TEMPLATE_PATH).destination).toBe(
      "Templates/Daily (starter-pack) 3.md",
    );
  });

  it("duplicates rather than replaces when the prior copy was edited locally", async () => {
    const pkg = valid();
    const imported = "# Daily\n\nthe version this device imported\n";
    const edited = `${imported}\n\nand then I added a line\n`;
    const host = createMemoryHost({ files: { [TEMPLATE_PATH]: edited } });
    const ledger = new PackageLedger(memoryLedgerStore());
    ledger.record({
      packageId: pkg.manifest.id,
      version: "1.0.0",
      importedAt: "2026-09-01T00:00:00.000Z",
      entries: [
        { path: TEMPLATE_PATH, destination: TEMPLATE_PATH, sha256: await sha256Text(imported) },
      ],
    });

    const item = itemFor(await previewImport(pkg, host, { ledger }), TEMPLATE_PATH);
    expect(item.decision).toBe("duplicate");
    expect(item.reason).toMatch(/changed since/i);
  });

  it("re-adds a prior copy that has since been deleted, at the destination it used", async () => {
    const pkg = valid();
    const ledger = new PackageLedger(memoryLedgerStore());
    ledger.record({
      packageId: pkg.manifest.id,
      version: "1.0.0",
      importedAt: "2026-09-01T00:00:00.000Z",
      entries: [
        {
          path: TEMPLATE_PATH,
          destination: "Templates/Daily (starter-pack).md",
          sha256: "0".repeat(64),
        },
      ],
    });

    const item = itemFor(await previewImport(pkg, createMemoryHost(), { ledger }), TEMPLATE_PATH);
    expect(item.decision).toBe("add");
    expect(item.destination).toBe("Templates/Daily (starter-pack).md");
  });

  it("marks an invalid entry unsupported and refuses the package", async () => {
    const preview = await previewImport(loadPackageFixture("traversal"), createMemoryHost());

    expect(preview.items[0].decision).toBe("unsupported");
    expect(preview.items[0].reason).toMatch(/traversal/i);
    expect(preview.errors.length).toBeGreaterThan(0);
    expect(preview.idempotent).toBe(false);
  });

  it("reports compatibility separately from the item list", async () => {
    const preview = await previewImport(
      loadPackageFixture("unsupported-version"),
      createMemoryHost({ appVersion: "0.1.59" }),
    );
    expect(preview.compatibility.ok).toBe(false);
    expect(preview.compatibility.message).toMatch(/Noam 99\.1\.0/);
  });

  it("is idempotent once every entry is already on disk", async () => {
    const pkg = valid();
    const host = createMemoryHost({
      files: {
        [WORKFLOW_PATH]: bodyOf(pkg, WORKFLOW_PATH),
        [TEMPLATE_PATH]: bodyOf(pkg, TEMPLATE_PATH),
      },
      base64Files: { "attachments/starter-logo.png": bodyOf(pkg, "attachments/starter-logo.png") },
    });

    const preview = await previewImport(pkg, host);
    expect(preview.items.every((i) => i.decision === "skip")).toBe(true);
    expect(preview.idempotent).toBe(true);
  });

  it("resolves dependencies against the package, the vault and the known workflow ids", async () => {
    const pkg = valid();
    pkg.manifest.dependencies = [
      { kind: "template", path: TEMPLATE_PATH }, // shipped by the package
      { kind: "template", path: "Templates/Elsewhere.md" }, // only in the vault
      { kind: "template", path: "Templates/Nowhere.md" }, // nowhere
      { kind: "workflow", id: "daily-note" }, // shipped by the package
      { kind: "workflow", id: "weekly-review" }, // registered in the vault
      { kind: "workflow", id: "missing-one" }, // nowhere
    ];
    const host = createMemoryHost({ files: { "Templates/Elsewhere.md": "# elsewhere\n" } });

    const preview = await previewImport(pkg, host, { existingWorkflowIds: ["weekly-review"] });
    expect(preview.dependencies).toEqual([
      { kind: "template", ref: TEMPLATE_PATH, satisfied: true },
      { kind: "template", ref: "Templates/Elsewhere.md", satisfied: true },
      { kind: "template", ref: "Templates/Nowhere.md", satisfied: false },
      { kind: "workflow", ref: "daily-note", satisfied: true },
      { kind: "workflow", ref: "weekly-review", satisfied: true },
      { kind: "workflow", ref: "missing-one", satisfied: false },
    ]);
  });

  it("does not let a rename steal another entry's own destination", async () => {
    const pkg = valid();
    // The package itself ships a file at the name a duplicate-rename would pick.
    const taken = "Templates/Daily (starter-pack).md";
    pkg.manifest.entries.push({ ...pkg.manifest.entries[1], path: taken });
    pkg.files[taken] = pkg.files[TEMPLATE_PATH];
    const host = createMemoryHost({ files: { [TEMPLATE_PATH]: "# mine\n" } });

    const preview = await previewImport(pkg, host);
    expect(itemFor(preview, TEMPLATE_PATH).destination).toBe("Templates/Daily (starter-pack) 2.md");
    expect(itemFor(preview, taken).destination).toBe(taken);
    const destinations = preview.items.map((i) => i.destination);
    expect(new Set(destinations).size).toBe(destinations.length);
  });
});
