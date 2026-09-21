// Build a package file out of files that are already in the vault.
//
// The inverse of `previewImport`/`applyImport`, and the reason the import side
// can verify anything: the hash in the manifest is computed here, over the
// same decoded bytes the importer will re-hash.
//
// `.md` bodies travel as utf8 so a package stays readable and diffable;
// everything else travels as base64.

import {
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  WORKFLOW_SCHEMA_VERSION,
  type NoamPackage,
  type PackageEntry,
  type PackageEntryKind,
  type PackageHost,
  type PackageManifest,
  type WorkflowId,
} from "../contracts";
import { bytesToBase64, sha256Bytes, utf8Bytes } from "./bytes";
import { readWorkflowId } from "./noteFormat";
import { entryKindPathError, entryPathError } from "./paths";

export interface PackageSelectionEntry {
  path: string;
  kind: PackageEntryKind;
  /** Workflow id; read out of the note itself when omitted. */
  id?: WorkflowId;
}

export interface PackageSelection {
  id: string;
  name: string;
  version: string;
  description?: string;
  entries: PackageSelectionEntry[];
  dependencies?: PackageManifest["dependencies"];
}

const isText = (path: string) => path.toLowerCase().endsWith(".md");

export async function exportPackage(
  selection: PackageSelection,
  host: PackageHost,
): Promise<NoamPackage> {
  const entries: PackageEntry[] = [];
  const files: NoamPackage["files"] = {};

  for (const chosen of selection.entries) {
    const pathError = entryPathError(chosen.path) ?? entryKindPathError(chosen.path, chosen.kind);
    if (pathError) throw new Error(`${chosen.path}: ${pathError}`);
    if (files[chosen.path]) throw new Error(`${chosen.path}: selected twice`);

    if (isText(chosen.path)) {
      const text = await host.readText(chosen.path);
      if (text === null) throw new Error(`${chosen.path}: could not be read`);
      files[chosen.path] = { encoding: "utf8", content: text };
      entries.push({
        path: chosen.path,
        kind: chosen.kind,
        sha256: await sha256Bytes(utf8Bytes(text)),
        ...(chosen.kind === "workflow"
          ? { id: chosen.id ?? readWorkflowId(text) ?? undefined }
          : chosen.id
            ? { id: chosen.id }
            : {}),
      });
      continue;
    }

    const bytes = await host.readBytes(chosen.path);
    if (bytes === null) throw new Error(`${chosen.path}: could not be read`);
    files[chosen.path] = { encoding: "base64", content: bytesToBase64(bytes) };
    entries.push({ path: chosen.path, kind: chosen.kind, sha256: await sha256Bytes(bytes) });
  }

  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    id: selection.id,
    name: selection.name,
    version: selection.version,
    minAppVersion: host.appVersion(),
    workflowSchemaVersion: WORKFLOW_SCHEMA_VERSION,
    entries,
    ...(selection.description ? { description: selection.description } : {}),
    ...(selection.dependencies ? { dependencies: selection.dependencies } : {}),
  };

  return { manifest, files };
}

/** The bytes of a `.noam-package.json` file. */
export function serializePackage(pkg: NoamPackage): string {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Shape-check only — `validateManifest` (via `previewImport`) is what decides
 * whether the package is safe. This just answers "is this a package file".
 */
export function parsePackage(text: string): { pkg: NoamPackage } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `this file is not JSON: ${String(e)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "this file is not a Noam package" };
  }
  const candidate = parsed as Partial<NoamPackage>;
  if (!candidate.manifest || typeof candidate.manifest !== "object") {
    return { error: "this file has no package manifest" };
  }
  if (!candidate.files || typeof candidate.files !== "object") {
    return { error: "this package has no file bodies" };
  }
  return { pkg: candidate as NoamPackage };
}
