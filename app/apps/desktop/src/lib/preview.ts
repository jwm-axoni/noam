// Which non-note files the app can preview in-place (images and PDFs). Notes
// (.md) and pages (.html) are rendered by the editor / HtmlView; everything
// here rides the asset: protocol via `convertFileSrc` instead.

export type PreviewKind = "image" | "pdf";

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "jfif",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
  "ico",
  // Apple formats — macOS screenshots/photos default to these; the webview
  // (WKWebView) renders them natively in an <img>.
  "heic",
  "heif",
  "tiff",
  "tif",
]);

/** The preview kind for a path, or null if it isn't a previewable file type. */
export function previewKind(path: string): PreviewKind | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === path.toLowerCase()) return null; // no extension
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return null;
}
