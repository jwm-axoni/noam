// What importing this package would do — decided in full before a byte moves.
//
// The decision table:
//
//   destination free                        → add
//   destination identical to the entry      → skip     ("identical")
//   destination is this device's prior copy → replace  (ledger says so)
//   destination is anything else            → duplicate (renamed destination)
//   entry is invalid                        → unsupported (and the package is refused)
//
// `replace` is the only decision that destroys anything, and it is offered
// ONLY when the ledger says this device wrote that file from this package AND
// the bytes on disk are still the ones it wrote. An unrelated note — or a copy
// the user has edited since — is never overwritten; the entry lands beside it
// as `Name (package-id).md`.
//
// A second import of the same package therefore decides `skip` for everything:
// idempotence falls out of the hash comparison, it is not a special case.

import type {
  ImportPreview,
  ImportPreviewItem,
  NoamPackage,
  PackageEntry,
  PackageHost,
} from "../contracts";
import { sha256Bytes, utf8Bytes } from "./bytes";
import { PackageLedger } from "./ledger";
import { duplicateDestination } from "./paths";
import { validatePackage } from "./manifest";

export interface PreviewOptions {
  /** Device-local record of prior imports; without it nothing can be `replace`. */
  ledger?: PackageLedger;
  /**
   * Workflow ids already registered in this vault, for dependency resolution.
   * The UI passes `commandService.list()`; the host has no way to scan.
   */
  existingWorkflowIds?: Iterable<string>;
}

/**
 * Hash of what is on disk at `path`, or null when it cannot be read. Exported
 * so `apply.ts` re-checks a destination with the very same measurement the
 * preview took — two different hashings of "the file" could disagree over an
 * encoding and turn every import into a refusal.
 */
export async function hashOf(host: PackageHost, path: string): Promise<string | null> {
  const bytes = await host.readBytes(path).catch(() => null);
  if (bytes) return sha256Bytes(bytes);
  const text = await host.readText(path).catch(() => null);
  if (text === null) return null;
  return sha256Bytes(utf8Bytes(text));
}

export async function previewImport(
  pkg: NoamPackage,
  host: PackageHost,
  options: PreviewOptions = {},
): Promise<ImportPreview> {
  const validation = await validatePackage(pkg, host);
  const manifest = pkg.manifest;
  const entries: PackageEntry[] = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const items: ImportPreviewItem[] = [];

  // Every destination the package declares is reserved up front, so a rename
  // for one entry can never take the place another entry asked for.
  const claimed = new Set<string>();
  for (const entry of entries) {
    if (typeof entry?.path === "string") claimed.add(entry.path.toLowerCase());
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const entryError = validation.entryErrors.get(i);
    if (entryError) {
      items.push({
        entry,
        decision: "unsupported",
        destination: typeof entry?.path === "string" ? entry.path : "",
        reason: entryError,
      });
      continue;
    }

    const prior = options.ledger?.entry(manifest.id, entry.path) ?? null;
    const destination = prior?.destination ?? entry.path;
    const occupied = await host.exists(destination);
    // Unreadable but present counts as occupied by something unrelated: an
    // "add" over a file we could not hash is exactly the overwrite this
    // service exists to refuse.
    const existing = occupied ? await hashOf(host, destination) : null;

    if (!occupied) {
      claimed.add(destination.toLowerCase());
      items.push({ entry, decision: "add", destination, destinationSha256: null });
      continue;
    }
    if (existing !== null && existing === entry.sha256) {
      items.push({
        entry,
        decision: "skip",
        destination,
        existingSha256: existing,
        destinationSha256: existing,
        reason: "identical",
      });
      continue;
    }
    if (prior && existing !== null && existing === prior.sha256) {
      items.push({ entry, decision: "replace", destination, existingSha256: existing, destinationSha256: existing });
      continue;
    }

    // Anything else at that path is someone else's file — or this device's
    // copy after a local edit. Land beside it.
    let attempt = 1;
    let renamed = duplicateDestination(entry.path, manifest.id, attempt);
    while (claimed.has(renamed.toLowerCase()) || (await host.exists(renamed))) {
      attempt += 1;
      renamed = duplicateDestination(entry.path, manifest.id, attempt);
    }
    claimed.add(renamed.toLowerCase());
    items.push({
      entry,
      decision: "duplicate",
      destination: renamed,
      existingSha256: existing ?? undefined,
      // The renamed destination is free by construction (the loop above).
      destinationSha256: null,
      reason:
        existing === null
          ? "the file already there could not be read; keeping both"
          : prior
            ? "the imported copy changed since it was written; keeping both"
            : "a different file is already there; keeping both",
    });
  }

  const packagedWorkflowIds = new Set(
    entries.filter((e) => e?.kind === "workflow" && e.id).map((e) => String(e.id)),
  );
  const packagedPaths = new Set(entries.map((e) => String(e?.path).toLowerCase()));
  const vaultWorkflowIds = new Set(options.existingWorkflowIds ?? []);

  const dependencies: ImportPreview["dependencies"] = [];
  for (const dep of manifest?.dependencies ?? []) {
    if (dep?.kind === "workflow") {
      const ref = String(dep.id ?? "");
      dependencies.push({
        kind: "workflow",
        ref,
        satisfied: packagedWorkflowIds.has(ref) || vaultWorkflowIds.has(ref),
      });
    } else if (dep?.kind === "template") {
      const ref = String(dep.path ?? "");
      const satisfied = packagedPaths.has(ref.toLowerCase()) || (await host.exists(ref));
      dependencies.push({ kind: "template", ref, satisfied });
    }
  }

  return {
    manifest,
    items,
    dependencies,
    compatibility: validation.compatibility,
    errors: validation.errors,
    idempotent: items.length > 0 && items.every((i) => i.decision === "skip"),
  };
}
