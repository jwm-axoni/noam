// Execute a previewed import, atomically.
//
// Order of operations, and every one of them matters:
//
//   1. refuse outright if the preview reported errors (nothing is written);
//   1b. re-check every destination against what the PREVIEW saw there. The
//      decisions below were made against a vault the user then read on screen;
//      a destination that changed in between is a file this import was never
//      shown, and writing over it is the one thing a preview exists to stop;
//   2. read the CURRENT bytes of every path the import will touch;
//   3. write the recovery record — BEFORE the first write, so a crash in the
//      middle of step 5 always leaves a complete "here is what was there";
//   4. create the destination folders;
//   5. write the entries in preview order;
//   6. on any failure, put every path written so far back exactly as it was
//      (delete the ones that did not exist) and report `rolledBack: true`;
//      if the rollback itself fails, keep the record and hand back its path;
//   7. on success, delete the record and remember the import in the ledger.
//
// The recovery record is the reason this is safe rather than merely careful: a
// rollback that cannot run in-process (the app was killed) is still possible by
// hand from the record.

import type {
  ImportOutcome,
  ImportPreview,
  ImportPreviewItem,
  ImportRecoveryRecord,
  NoamPackage,
  PackageHost,
} from "../contracts";
import { bodyBytes, bytesToBase64, sha256Bytes, utf8Bytes, utf8Text } from "./bytes";
import type { PackageLedger } from "./ledger";
import { parentFolder } from "./paths";
import { hashOf } from "./preview";

export interface ApplyOptions {
  /** Updated on success so a re-import can decide `replace`/`skip`. */
  ledger?: PackageLedger;
  now?: () => Date;
}

const WRITTEN_DECISIONS = new Set(["add", "replace", "duplicate"]);

/** Text bodies are written as text; anything else goes through the binary path. */
function isTextEntry(item: ImportPreviewItem, pkg: NoamPackage): boolean {
  const body = pkg.files[item.entry.path];
  return body?.encoding === "utf8" && item.destination.toLowerCase().endsWith(".md");
}

interface Original {
  path: string;
  sha256: string | null;
  content: string | null;
  encoding: "utf8" | "base64";
  /** Kept out of the record: the exact bytes, for the rollback write. */
  bytes: Uint8Array | null;
}

async function readOriginal(host: PackageHost, path: string, asText: boolean): Promise<Original> {
  if (!(await host.exists(path))) {
    return { path, sha256: null, content: null, encoding: asText ? "utf8" : "base64", bytes: null };
  }
  if (asText) {
    const text = await host.readText(path);
    if (text !== null) {
      const bytes = utf8Bytes(text);
      return { path, sha256: await sha256Bytes(bytes), content: text, encoding: "utf8", bytes };
    }
  }
  const bytes = (await host.readBytes(path)) ?? new Uint8Array();
  return {
    path,
    sha256: await sha256Bytes(bytes),
    content: bytesToBase64(bytes),
    encoding: "base64",
    bytes,
  };
}

/**
 * What the preview observed at this item's destination — a hash, or null for
 * "nothing was there".
 *
 * `destinationSha256` is the answer when the preview recorded one. The fallback
 * is for a preview built by hand: `existingSha256` describes the destination
 * only for a `replace`; for a `duplicate` it describes the OTHER file, the one
 * that forced the rename, and the renamed destination was free.
 */
function previewedHash(item: ImportPreviewItem): string | null {
  if (item.destinationSha256 !== undefined) return item.destinationSha256;
  return item.decision === "replace" ? (item.existingSha256 ?? null) : null;
}

/** The first destination that is no longer what the preview described. */
async function firstMoved(
  targets: readonly ImportPreviewItem[],
  host: PackageHost,
): Promise<string | null> {
  for (const item of targets) {
    const expected = previewedHash(item);
    const present = await host.exists(item.destination).catch(() => true);
    if (present !== (expected !== null)) return item.destination;
    // A file that is there but cannot be hashed is not the one we measured.
    if (present && (await hashOf(host, item.destination)) !== expected) return item.destination;
  }
  return null;
}

export async function applyImport(
  preview: ImportPreview,
  pkg: NoamPackage,
  host: PackageHost,
  options: ApplyOptions = {},
): Promise<ImportOutcome> {
  if (preview.errors.length > 0) {
    return {
      ok: false,
      message: `this package cannot be imported: ${preview.errors[0]}`,
      rolledBack: false,
      recoveryRecord: null,
    };
  }

  const targets = preview.items.filter((i) => WRITTEN_DECISIONS.has(i.decision));
  const skipped = preview.items.filter((i) => i.decision === "skip").map((i) => i.destination);

  // 1b. The preview is only as good as the vault it described. Nothing has been
  //     written yet, so a stale one costs nothing but a second preview.
  const moved = await firstMoved(targets, host);
  if (moved !== null) {
    return {
      ok: false,
      message: `"${moved}" changed since the preview, so nothing was imported. Open the package again to see what importing it would do now.`,
      rolledBack: true, // nothing was written: the vault is exactly as it was
      recoveryRecord: null,
      failedAt: moved,
    };
  }

  // 2. Pre-import state of every path this will touch.
  const originals: Original[] = [];
  for (const item of targets) {
    originals.push(await readOriginal(host, item.destination, isTextEntry(item, pkg)));
  }
  const originalByPath = new Map(originals.map((o) => [o.path, o]));

  const record: ImportRecoveryRecord = {
    packageId: preview.manifest.id,
    startedAt: (options.now?.() ?? new Date()).toISOString(),
    originals: originals.map(({ path, sha256, content, encoding }) => ({
      path,
      sha256,
      content,
      encoding,
    })),
    written: [],
  };

  // 3. The record comes first. No record, no import.
  let recordPath: string;
  try {
    recordPath = await host.writeRecoveryRecord(record);
  } catch (e) {
    return {
      ok: false,
      message: `could not write the import recovery record, so nothing was imported: ${String(e)}`,
      rolledBack: false,
      recoveryRecord: null,
    };
  }

  const written: string[] = [];
  try {
    // 4. Folders, then 5. entries, in preview order.
    for (const item of targets) {
      const folder = parentFolder(item.destination);
      if (folder) await host.ensureFolder(folder);
    }
    for (const item of targets) {
      const body = pkg.files[item.entry.path];
      const decoded = bodyBytes(body);
      if ("error" in decoded) throw new Error(`${item.entry.path}: ${decoded.error}`);
      if (isTextEntry(item, pkg)) {
        await host.writeText(item.destination, utf8Text(decoded.bytes));
      } else {
        await host.writeBytes(item.destination, decoded.bytes);
      }
      written.push(item.destination);
      record.written = [...written];
      await host.writeRecoveryRecord(record);
    }
  } catch (failure) {
    const failedAt =
      targets[written.length]?.destination ?? targets[targets.length - 1]?.destination ?? undefined;
    // 6. Undo, newest first.
    const undoFailures: string[] = [];
    for (const path of [...written].reverse()) {
      const original = originalByPath.get(path);
      try {
        if (!original || original.bytes === null) {
          await host.remove(path);
        } else if (original.encoding === "utf8") {
          await host.writeText(path, utf8Text(original.bytes));
        } else {
          await host.writeBytes(path, original.bytes);
        }
      } catch (e) {
        undoFailures.push(`${path}: ${String(e)}`);
      }
    }
    if (undoFailures.length > 0) {
      return {
        ok: false,
        message: `import failed (${String(failure)}) and could not be undone: ${undoFailures.join("; ")}. The pre-import contents are in the recovery record.`,
        rolledBack: false,
        recoveryRecord: recordPath,
        failedAt,
      };
    }
    await host.deleteRecoveryRecord(recordPath).catch(() => undefined);
    return {
      ok: false,
      message: `import failed and was rolled back: ${String(failure)}`,
      rolledBack: true,
      recoveryRecord: null,
      failedAt,
    };
  }

  // 7. Done: the record is moot, and the ledger remembers what landed where.
  await host.deleteRecoveryRecord(recordPath).catch(() => undefined);
  if (options.ledger) {
    const existing = options.ledger.get(preview.manifest.id);
    const entries = new Map(
      (existing?.entries ?? []).map((e) => [e.path.toLowerCase(), e] as const),
    );
    for (const item of preview.items) {
      if (item.decision === "unsupported") continue;
      entries.set(item.entry.path.toLowerCase(), {
        path: item.entry.path,
        destination: item.destination,
        sha256: item.entry.sha256,
      });
    }
    options.ledger.record({
      packageId: preview.manifest.id,
      version: preview.manifest.version,
      importedAt: record.startedAt,
      entries: [...entries.values()],
    });
  }

  return { ok: true, written, skipped, recoveryRecord: null };
}
