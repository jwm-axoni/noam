// Applying an import is all-or-nothing.
//
// Two invariants carry the whole design: the recovery record — with the
// pre-import bytes of EVERY path the import will touch — is written before the
// first write, and any failure puts every touched path back exactly as it was.
// If the rollback itself cannot finish, the record path is handed back so a
// person can finish by hand; it is never silently discarded.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ImportRecoveryRecord, NoamPackage } from "../contracts";
import { applyImport } from "../packages/apply";
import { base64ToBytes, sha256Text } from "../packages/bytes";
import { PackageLedger, memoryLedgerStore } from "../packages/ledger";
import { createMemoryHost, type MemoryHostOptions } from "../packages/memoryHost";
import { previewImport } from "../packages/preview";

const loadPackageFixture = (name: string): NoamPackage =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/packages/${name}.noam-package.json`, import.meta.url), "utf8"),
  ) as NoamPackage;

const WORKFLOW_PATH = "Workflows/Daily note.md";
const TEMPLATE_PATH = "Templates/Daily.md";
const ASSET_PATH = "attachments/starter-logo.png";

const valid = () => loadPackageFixture("valid");
const firstWriteIndex = (log: string[]) => log.findIndex((l) => l.startsWith("write:"));

/** A vault where the template is a prior copy of this package's entry. */
async function hostWithPriorImport(options: MemoryHostOptions = {}) {
  const older = "# Daily\n\nthe version this device imported last time\n";
  const host = createMemoryHost({ ...options, files: { [TEMPLATE_PATH]: older, ...options.files } });
  const ledger = new PackageLedger(memoryLedgerStore());
  ledger.record({
    packageId: "starter-pack",
    version: "1.0.0",
    importedAt: "2026-09-01T00:00:00.000Z",
    entries: [{ path: TEMPLATE_PATH, destination: TEMPLATE_PATH, sha256: await sha256Text(older) }],
  });
  return { host, ledger, older };
}

describe("applying an import", () => {
  it("writes the recovery record before the first write and deletes it on success", async () => {
    const pkg = valid();
    const host = createMemoryHost();
    const preview = await previewImport(pkg, host);

    const outcome = await applyImport(preview, pkg, host);

    expect(outcome.ok).toBe(true);
    expect(host.log[0]).toBe("record:write");
    expect(host.log.indexOf("record:write")).toBeLessThan(firstWriteIndex(host.log));
    expect(host.log[host.log.length - 1]).toBe("record:delete");
    expect(host.records.size).toBe(0);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.written).toEqual([WORKFLOW_PATH, TEMPLATE_PATH, ASSET_PATH]);
    expect(outcome.recoveryRecord).toBeNull();
  });

  it("reproduces the package bodies on disk, binary included", async () => {
    const pkg = valid();
    const host = createMemoryHost();
    await applyImport(await previewImport(pkg, host), pkg, host);

    expect(await host.readText(TEMPLATE_PATH)).toBe(pkg.files[TEMPLATE_PATH].content);
    expect(await host.readText(WORKFLOW_PATH)).toBe(pkg.files[WORKFLOW_PATH].content);
    const asset = await host.readBytes(ASSET_PATH);
    expect(asset).toEqual(base64ToBytes(pkg.files[ASSET_PATH].content));
    expect(asset?.[0]).toBe(0x89); // PNG magic survived the base64 round trip
  });

  it("creates the destination folders before writing into them", async () => {
    const pkg = valid();
    const host = createMemoryHost();
    await applyImport(await previewImport(pkg, host), pkg, host);

    expect([...host.folders]).toEqual(expect.arrayContaining(["Workflows", "Templates", "attachments"]));
    expect(host.log.indexOf("folder:Workflows")).toBeLessThan(firstWriteIndex(host.log));
  });

  it("records the pre-import bytes of every path it will touch", async () => {
    const pkg = valid();
    const { host, ledger, older } = await hostWithPriorImport();
    const preview = await previewImport(pkg, host, { ledger });

    let captured: ImportRecoveryRecord | null = null;
    const spyHost = {
      ...host,
      writeRecoveryRecord: async (record: ImportRecoveryRecord) => {
        captured ??= structuredClone(record);
        return host.writeRecoveryRecord(record);
      },
    };
    await applyImport(preview, pkg, spyHost, { ledger });

    const originals = (captured as unknown as ImportRecoveryRecord).originals;
    expect(originals.map((o) => o.path).sort()).toEqual(
      [WORKFLOW_PATH, TEMPLATE_PATH, ASSET_PATH].sort(),
    );
    expect(originals.find((o) => o.path === TEMPLATE_PATH)?.content).toBe(older);
    expect(originals.find((o) => o.path === WORKFLOW_PATH)?.content).toBeNull();
  });

  it("rolls the whole vault back when a write fails part-way", async () => {
    const pkg = valid();
    const { host, ledger } = await hostWithPriorImport({ failOnWrite: 3 });
    const before = host.snapshot();
    const preview = await previewImport(pkg, host, { ledger });
    expect(preview.items.map((i) => i.decision)).toEqual(["add", "replace", "add"]);

    const outcome = await applyImport(preview, pkg, host, { ledger });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.failedAt).toBe(ASSET_PATH);
    expect(host.snapshot()).toEqual(before);
    expect(host.records.size).toBe(0); // the record is moot once the vault is back
    expect(outcome.recoveryRecord).toBeNull();
  });

  it("leaves the ledger untouched when the import was rolled back", async () => {
    const pkg = valid();
    const ledger = new PackageLedger(memoryLedgerStore());
    const host = createMemoryHost({ failOnWrite: 1 });
    await applyImport(await previewImport(pkg, host), pkg, host, { ledger });

    expect(ledger.get("starter-pack")).toBeNull();
    expect(host.snapshot()).toEqual({});
  });

  it("reports rolledBack:false with the record path when the rollback itself fails", async () => {
    const pkg = valid();
    const { host, ledger } = await hostWithPriorImport({
      failOnWrite: 3,
      failRemove: (path) => path === WORKFLOW_PATH,
    });
    const outcome = await applyImport(await previewImport(pkg, host, { ledger }), pkg, host, {
      ledger,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.recoveryRecord).toMatch(/recovery/);
    expect(host.records.size).toBe(1); // kept: a person needs it to finish by hand
    expect(outcome.message).toMatch(/could not be undone|rollback/i);
  });

  it("refuses to write when a destination appeared after the preview", async () => {
    const pkg = valid();
    const host = createMemoryHost();
    const preview = await previewImport(pkg, host);
    // Between the preview going on screen and Import being pressed, something
    // lands where the preview decided to `add`.
    await host.writeText(WORKFLOW_PATH, "# mine now\n");
    host.log.length = 0;

    const outcome = await applyImport(preview, pkg, host);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toMatch(/changed since the preview/i);
    expect(outcome.failedAt).toBe(WORKFLOW_PATH);
    expect(outcome.rolledBack).toBe(true); // nothing was written, so nothing to undo
    expect(outcome.recoveryRecord).toBeNull();
    expect(host.log).toEqual([]); // not even the recovery record
    expect(await host.readText(WORKFLOW_PATH)).toBe("# mine now\n");
  });

  it("refuses a replace whose bytes moved since the preview", async () => {
    const pkg = valid();
    const { host, ledger } = await hostWithPriorImport();
    const preview = await previewImport(pkg, host, { ledger });
    expect(preview.items.map((i) => i.decision)).toEqual(["add", "replace", "add"]);
    await host.writeText(TEMPLATE_PATH, "# Daily\n\nedited while the preview was up\n");
    const before = host.snapshot();

    const outcome = await applyImport(preview, pkg, host, { ledger });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failedAt).toBe(TEMPLATE_PATH);
    expect(outcome.message).toMatch(/changed since the preview/i);
    expect(host.snapshot()).toEqual(before);
    expect(ledger.get("starter-pack")?.entries.length).toBe(1); // the prior import only
  });

  it("refuses to apply a package with errors, without touching anything", async () => {
    const pkg = loadPackageFixture("traversal");
    const host = createMemoryHost();
    const outcome = await applyImport(await previewImport(pkg, host), pkg, host);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.recoveryRecord).toBeNull();
    expect(host.log).toEqual([]);
    expect(host.snapshot()).toEqual({});
  });

  it("re-importing the same package is a no-op: all skip, nothing written", async () => {
    const pkg = valid();
    const ledger = new PackageLedger(memoryLedgerStore());
    const host = createMemoryHost();
    await applyImport(await previewImport(pkg, host, { ledger }), pkg, host, { ledger });

    const second = await previewImport(pkg, host, { ledger });
    expect(second.idempotent).toBe(true);
    expect(second.items.every((i) => i.decision === "skip")).toBe(true);

    host.log.length = 0;
    const outcome = await applyImport(second, pkg, host, { ledger });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.written).toEqual([]);
    expect(outcome.skipped).toEqual([WORKFLOW_PATH, TEMPLATE_PATH, ASSET_PATH]);
    expect(host.log.some((l) => l.startsWith("write:"))).toBe(false);
  });

  it("remembers a renamed duplicate so the next import skips it instead of piling up", async () => {
    const pkg = valid();
    const ledger = new PackageLedger(memoryLedgerStore());
    const host = createMemoryHost({ files: { [TEMPLATE_PATH]: "# my own template\n" } });

    await applyImport(await previewImport(pkg, host, { ledger }), pkg, host, { ledger });
    expect(await host.exists("Templates/Daily (starter-pack).md")).toBe(true);
    expect(await host.readText(TEMPLATE_PATH)).toBe("# my own template\n");

    const second = await previewImport(pkg, host, { ledger });
    expect(second.idempotent).toBe(true);
  });

  it("refuses to apply when the recovery record cannot be written", async () => {
    const pkg = valid();
    const host = createMemoryHost({ failRecoveryWrite: true });
    const outcome = await applyImport(await previewImport(pkg, host), pkg, host);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toMatch(/recovery record/i);
    expect(host.log.some((l) => l.startsWith("write:"))).toBe(false);
  });
});
