// Destination path rules for package entries.
//
// A package names where its files land, and the file comes from outside the
// vault — so this is the TS half of the same refusal `vault.rs
// resolve_in_vault` + `rel_path_is_ignored` make in Rust. We check here as
// well as there because the preview has to SHOW the user why an entry was
// refused, and because a refusal that only happens at write time would land
// halfway through an import.

import type { PackageEntryKind } from "../contracts";

/** Binary bodies can only be written under `attachments/` (see `attachments.rs ensure_attachment_rel`). */
export const ASSET_ROOT = "attachments/";

/**
 * Why this destination is unacceptable, or null when it is fine.
 *
 * Relative, forward-slash, normalised, inside the vault, outside `.context/`.
 */
export function entryPathError(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "path is missing";
  if (path.includes("\\")) return "path contains a backslash";
  if (/[\u0000-\u001f]/.test(path)) return "path contains a control character";
  if (/^[A-Za-z]:/.test(path)) return "path is absolute";
  if (path.startsWith("/")) return "path is absolute (leading slash)";
  if (path.endsWith("/")) return "path names a folder, not a file";

  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "") return "path has an empty segment";
    if (segment === ".") return "path has a '.' segment";
    if (segment === "..") return "path traversal ('..') is not allowed";
    if (segment !== segment.trim()) return "path segment has leading or trailing whitespace";
  }
  if (segments[0] === ".context") return "path targets the private '.context/' store";
  if (segments[0].startsWith(".")) return "path targets a hidden folder";
  return null;
}

/** Path rules that depend on what the entry IS. */
export function entryKindPathError(path: string, kind: PackageEntryKind): string | null {
  if (kind === "asset") {
    return path.startsWith(ASSET_ROOT)
      ? null
      : `asset must live under '${ASSET_ROOT}' (binary writes are refused elsewhere)`;
  }
  return path.toLowerCase().endsWith(".md") ? null : `${kind} destination must be a .md file`;
}

/** Vault-relative parent folder ("" at the root). */
export function parentFolder(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

function splitExtension(path: string): { stem: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? { stem: path.slice(0, dot), ext: path.slice(dot) } : { stem: path, ext: "" };
}

/**
 * The renamed destination a `duplicate` decision writes to: `Name (pkg).md`,
 * then `Name (pkg) 2.md`, `Name (pkg) 3.md`. Never the original — an unrelated
 * note at the entry's path is never overwritten.
 */
export function duplicateDestination(path: string, packageId: string, attempt: number): string {
  const { stem, ext } = splitExtension(path);
  const suffix = attempt <= 1 ? "" : ` ${attempt}`;
  return `${stem} (${packageId})${suffix}${ext}`;
}
