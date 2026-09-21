// Manifest validation — the gate `previewImport` and `applyImport` sit behind.
//
// Everything in a package file is untrusted input: the destinations, the
// hashes, the versions and the bodies. Nothing here writes, opens or evaluates
// anything; it only answers "would this be safe to apply, and does it say what
// it contains".
//
// Validation is ASYNC because the content hashes are verified with
// `crypto.subtle.digest`, which is promise-based. (The deliverable sketch said
// `validateManifest(pkg): string[]`; a synchronous version could not check the
// one thing that makes a package tamper-evident.)

import {
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  WORKFLOW_ID_PATTERN,
  WORKFLOW_SCHEMA_VERSION,
  type NoamPackage,
  type PackageEntry,
  type PackageEntryKind,
  type PackageManifest,
} from "../contracts";
import { bodyBytes, sha256Bytes } from "./bytes";
import { entryKindPathError, entryPathError } from "./paths";

/** The slice of `PackageHost` validation needs. */
export interface ManifestHostInfo {
  appVersion(): string;
}

export interface ManifestValidation {
  /** Fatal problems, user-readable. Non-empty ⇒ the package cannot be applied. */
  errors: string[];
  /** The subset of `errors` that belongs to one entry, by entry index. */
  entryErrors: Map<number, string>;
  /** Version compatibility on its own, so the UI can say "update Noam". */
  compatibility: { ok: boolean; message?: string };
}

const KINDS: readonly PackageEntryKind[] = ["workflow", "template", "asset"];
const HEX64 = /^[0-9a-f]{64}$/;
/** Semver-ish: `1`, `1.2`, `1.2.3`, `1.2.3-beta.1`. Build metadata is allowed. */
const VERSION_PATTERN = /^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Numeric dotted compare: `0.10.0 > 0.9.0`, `1.2 == 1.2.0`. A pre-release
 * suffix is ignored — "does this build understand the package" is a question
 * about the release line, not about -beta.3.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[-+]/, 1)[0]
      .split(".")
      .map((n) => (/^\d+$/.test(n) ? Number(n) : 0));
  const left = parts(a);
  const right = parts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Version compatibility alone: format, workflow schema and minimum app
 * version. All three are reported together — "update Noam" is a worse message
 * when it only names the first of three reasons.
 */
export function checkCompatibility(
  manifest: PackageManifest,
  appVersion: string,
): { ok: boolean; message?: string } {
  const issues: string[] = [];
  if (manifest?.formatVersion !== PACKAGE_FORMAT_VERSION) {
    issues.push(
      `unsupported package format version ${String(manifest?.formatVersion)} (this build reads ${PACKAGE_FORMAT_VERSION})`,
    );
  }
  if (manifest?.workflowSchemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    issues.push(
      `unsupported workflow schema version ${String(manifest?.workflowSchemaVersion)} (this build reads ${WORKFLOW_SCHEMA_VERSION})`,
    );
  }
  const min = manifest?.minAppVersion;
  if (typeof min !== "string" || !VERSION_PATTERN.test(min)) {
    issues.push(`minAppVersion "${String(min)}" is not a version`);
  } else if (compareVersions(min, appVersion) > 0) {
    issues.push(`this package needs Noam ${min}; this build is ${appVersion}`);
  }
  return issues.length === 0 ? { ok: true } : { ok: false, message: issues.join("; ") };
}

function entryShapeError(entry: PackageEntry): string | null {
  if (!entry || typeof entry !== "object") return "entry is not an object";
  const pathError = entryPathError(entry.path);
  if (pathError) return pathError;
  if (!KINDS.includes(entry.kind)) return `unknown kind "${String(entry.kind)}"`;
  const kindError = entryKindPathError(entry.path, entry.kind);
  if (kindError) return kindError;
  if (typeof entry.sha256 !== "string" || !HEX64.test(entry.sha256)) {
    return "sha256 must be 64 lowercase hex characters";
  }
  if (entry.kind === "workflow" && !(typeof entry.id === "string" && WORKFLOW_ID_PATTERN.test(entry.id))) {
    return "workflow entry needs a valid workflow id";
  }
  if (entry.id !== undefined && !WORKFLOW_ID_PATTERN.test(String(entry.id))) {
    return `"${String(entry.id)}" is not a valid workflow id`;
  }
  return null;
}

/** Full validation, with the per-entry detail the preview needs. */
export async function validatePackage(
  pkg: NoamPackage,
  host?: ManifestHostInfo,
): Promise<ManifestValidation> {
  const errors: string[] = [];
  const entryErrors = new Map<number, string>();
  const appVersion = host?.appVersion() ?? "0.0.0";

  if (!pkg || typeof pkg !== "object" || typeof pkg.manifest !== "object" || pkg.manifest === null) {
    return {
      errors: ["this file has no package manifest"],
      entryErrors,
      compatibility: { ok: false, message: "not a Noam package" },
    };
  }
  const manifest = pkg.manifest;
  const files = pkg.files;

  if (manifest.format !== PACKAGE_FORMAT) {
    errors.push(`not a Noam package (format "${String(manifest.format)}")`);
  }
  const compatibility = checkCompatibility(manifest, appVersion);
  if (!compatibility.ok && compatibility.message) errors.push(compatibility.message);

  if (typeof manifest.id !== "string" || !WORKFLOW_ID_PATTERN.test(manifest.id)) {
    errors.push(`"${String(manifest.id)}" is not a valid package id`);
  }
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    errors.push("the package has no name");
  }
  if (typeof manifest.version !== "string" || !VERSION_PATTERN.test(manifest.version)) {
    errors.push(`package version "${String(manifest.version)}" is not a version`);
  }

  if (!files || typeof files !== "object") {
    errors.push("the package has no file bodies");
    return { errors, entryErrors, compatibility };
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    errors.push("the package has no entries");
    return { errors, entryErrors, compatibility };
  }

  const seen = new Set<string>();
  const claimed = new Set<string>();
  for (let i = 0; i < manifest.entries.length; i += 1) {
    const entry = manifest.entries[i];
    const label = typeof entry?.path === "string" && entry.path ? entry.path : `entry ${i + 1}`;
    const shape = entryShapeError(entry);
    if (shape) {
      entryErrors.set(i, shape);
      errors.push(`${label}: ${shape}`);
      continue;
    }
    const key = entry.path.toLowerCase();
    if (seen.has(key)) {
      const message = "duplicate entry path";
      entryErrors.set(i, message);
      errors.push(`${label}: ${message}`);
      continue;
    }
    seen.add(key);
    claimed.add(entry.path);

    const body = files[entry.path];
    if (body === undefined) {
      const message = "entry has no body in the package";
      entryErrors.set(i, message);
      errors.push(`${label}: ${message}`);
      continue;
    }
    const decoded = bodyBytes(body);
    if ("error" in decoded) {
      entryErrors.set(i, decoded.error);
      errors.push(`${label}: ${decoded.error}`);
      continue;
    }
    const actual = await sha256Bytes(decoded.bytes);
    if (actual !== entry.sha256) {
      const message = `sha256 mismatch (manifest says ${entry.sha256.slice(0, 12)}…, body is ${actual.slice(0, 12)}…)`;
      entryErrors.set(i, message);
      errors.push(`${label}: ${message}`);
    }
  }

  for (const path of Object.keys(files)) {
    if (!claimed.has(path)) errors.push(`${path}: body has no entry in the manifest`);
  }

  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies)) {
      errors.push("dependencies must be a list");
    } else {
      for (const dep of manifest.dependencies) {
        if (dep?.kind === "workflow") {
          if (typeof dep.id !== "string" || !WORKFLOW_ID_PATTERN.test(dep.id)) {
            errors.push(`dependency "${String(dep.id)}" is not a valid workflow id`);
          }
        } else if (dep?.kind === "template") {
          const pathError = entryPathError(dep.path);
          if (pathError) errors.push(`template dependency: ${pathError}`);
        } else {
          errors.push(`unknown dependency kind "${String(dep?.kind)}"`);
        }
      }
    }
  }

  return { errors, entryErrors, compatibility };
}

/** Every fatal problem with this package, user-readable. Empty ⇒ valid. */
export async function validateManifest(
  pkg: NoamPackage,
  host?: ManifestHostInfo,
): Promise<string[]> {
  return (await validatePackage(pkg, host)).errors;
}
