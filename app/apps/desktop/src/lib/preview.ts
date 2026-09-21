import registryJson from "../../file-types.json";

export type PreviewKind =
  | "note"
  | "html"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "text"
  | "json"
  | "csv"
  | "external";

export interface FileTypeDefinition {
  id: string;
  extensions: string[];
  mimes: string[];
  importRule: "note" | "html" | "asset";
  preview: PreviewKind;
  embed: "inline" | "player" | "card" | "link";
  platform: string;
  fallback: "source" | "external";
}

export const FILE_TYPES = registryJson as FileTypeDefinition[];

const byExtension = new Map(
  FILE_TYPES.flatMap((definition) =>
    definition.extensions.map((extension) => [extension, definition] as const),
  ),
);

const byMime = new Map(
  FILE_TYPES.flatMap((definition) =>
    definition.mimes.map((mime) => [mime, definition] as const),
  ),
);

/** Remove URL decorations before inspecting a path's extension. */
export function undecoratedPath(path: string): string {
  const end = [path.indexOf("?"), path.indexOf("#")]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), path.length);
  return path.slice(0, end);
}

export function extensionOf(path: string): string | null {
  const name = undecoratedPath(path).split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function fileType(path: string, mime?: string | null): FileTypeDefinition | null {
  if (mime) {
    const normalized = mime.split(";", 1)[0].trim().toLowerCase();
    const mimeMatch = byMime.get(normalized);
    if (mimeMatch) return mimeMatch;
  }
  const extension = extensionOf(path);
  return extension ? (byExtension.get(extension) ?? null) : null;
}

/** The viewer used when this path opens as a file, or null for note content. */
export function previewKind(path: string, mime?: string | null): PreviewKind | null {
  const kind = fileType(path, mime)?.preview ?? null;
  return kind === "note" || kind === "html" ? null : kind;
}

export function canEmbed(path: string): boolean {
  const behavior = fileType(path)?.embed;
  return behavior === "inline" || behavior === "player";
}
