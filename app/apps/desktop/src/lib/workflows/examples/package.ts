// The bundled examples, as an ordinary package file.
//
// Installing the examples is NOT a special path: the Workflows view builds
// this package, previews it and applies it through the same
// `previewImport`/`applyImport` pair any downloaded package goes through, so
// collision handling, the ledger and idempotence are identical. The only
// difference is where the bytes came from.
//
// `exportPackage` needs a `PackageHost` to read the bodies from; an in-memory
// one seeded with `EXAMPLE_FILES` is exactly that, and it keeps the hashes in
// the manifest computed by the same code that computes them for a real export.

import type { NoamPackage } from "../contracts";
import { exportPackage } from "../packages/export";
import { createMemoryHost } from "../packages/memoryHost";
import { EXAMPLE_FILES, EXAMPLES_PACKAGE_ID, EXAMPLES_PACKAGE_VERSION } from "./index";

export const EXAMPLES_PACKAGE_NAME = "Noam examples";

/**
 * Build the examples package. `appVersion` becomes the manifest's
 * `minAppVersion`, so pass the running build's version (`getVersion()` from
 * `@tauri-apps/api/app`, or the `package.json` string in tests).
 */
export function buildExamplesPackage(appVersion: string): Promise<NoamPackage> {
  const host = createMemoryHost({
    files: Object.fromEntries(EXAMPLE_FILES.map((file) => [file.path, file.content])),
    appVersion,
  });
  return exportPackage(
    {
      id: EXAMPLES_PACKAGE_ID,
      name: EXAMPLES_PACKAGE_NAME,
      version: EXAMPLES_PACKAGE_VERSION,
      description:
        "Example templates and workflows shipped with Noam. Every file says \"example\" so they never look like live data.",
      // Templates first: a workflow that names one in `requires` resolves
      // against a package entry, but the write order is the preview's order and
      // a reader scanning the vault mid-import should meet the template first.
      entries: EXAMPLE_FILES.map((file) => ({ path: file.path, kind: file.kind })),
    },
    host,
  );
}
