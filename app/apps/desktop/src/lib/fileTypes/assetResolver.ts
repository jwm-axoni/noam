import { convertFileSrc } from "@tauri-apps/api/core";

const LOADABLE_SCHEME = /^(https?:|data:|blob:|asset:|tauri:|mailto:)/i;
const EXTERNAL_LINK_SCHEME = /^(https?:|mailto:)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function splitDecoration(source: string): { path: string; decoration: string } {
  const candidates = [source.indexOf("?"), source.indexOf("#")].filter(
    (index) => index >= 0,
  );
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return { path: source.slice(0, end), decoration: source.slice(end) };
}

export interface VaultReference {
  path: string;
  decoration: string;
}

function normalizeSegments(
  initial: string[],
  path: string,
  decode: boolean,
): string[] | null {
  const segments = [...initial];
  for (const segment of path.split("/")) {
    let part = segment;
    if (decode) {
      try {
        part = decodeURIComponent(segment);
      } catch {
        // Keep a literal malformed percent sequence as a filename character.
      }
    }
    if (/[\\/\u0000]/.test(part)) return null;
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments;
}

/**
 * Turn a Markdown URL destination into one safe vault-relative path.
 *
 * This is intentionally separate from `resolveVaultAsset`: links need the
 * relative path for the app's file router, while images need an asset-protocol
 * URL. Both now share the same one-pass decoding and traversal rules.
 */
export function resolveVaultReference(input: {
  documentPath: string;
  source: string;
}): VaultReference | null {
  const { documentPath, source } = input;
  if (
    !source ||
    source.startsWith("//") ||
    ANY_SCHEME.test(source)
  ) {
    return null;
  }

  const { path, decoration } = splitDecoration(source);
  if (!path) return null;
  const rootRelative = path.startsWith("/");
  const documentDir = documentPath.includes("/")
    ? documentPath.slice(0, documentPath.lastIndexOf("/"))
    : "";
  const segments = normalizeSegments(
    rootRelative || !documentDir ? [] : documentDir.split("/"),
    path,
    true,
  );

  return segments && segments.length > 0
    ? { path: segments.join("/"), decoration }
    : null;
}

/** Route one ordinary Markdown link without ever handing a vault path to the OS. */
export async function openMarkdownLink(input: {
  documentPath: string;
  source: string;
  openLocal: (path: string) => void | Promise<void>;
  openExternal: (url: string) => void | Promise<void>;
}): Promise<"local" | "external" | "ignored"> {
  const { documentPath, source, openLocal, openExternal } = input;
  if (EXTERNAL_LINK_SCHEME.test(source)) {
    await openExternal(source);
    return "external";
  }
  const reference = resolveVaultReference({ documentPath, source });
  if (!reference) return "ignored";
  await openLocal(reference.path);
  return "local";
}

/** Resolve a Markdown or presentation asset against its document's folder. */
export function resolveVaultAsset(input: {
  vaultPath: string | null;
  documentPath: string;
  source: string;
  /** Markdown destinations are URLs; metadata and file-tree values are paths. */
  sourceKind?: "url" | "path";
}): string {
  const { vaultPath, documentPath, source, sourceKind = "url" } = input;
  if (!source || (sourceKind === "url" && LOADABLE_SCHEME.test(source)) || !vaultPath) return source;

  const pathSegments = sourceKind === "path"
    ? normalizeSegments([], source.replace(/^\/+/, ""), false)
    : null;
  const reference = sourceKind === "url"
    ? resolveVaultReference({ documentPath, source })
    : pathSegments && pathSegments.length > 0
      ? { path: pathSegments.join("/"), decoration: "" }
      : null;
  if (!reference) return "";

  const absolute = `${vaultPath.replace(/\/$/, "")}/${reference.path}`;
  return `${convertFileSrc(absolute)}${reference.decoration}`;
}
