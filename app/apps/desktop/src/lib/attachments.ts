// Shared attachment persistence. Pasted images (Editor) and files dropped onto
// an open note (FileTree) both land here so they behave identically: bytes are
// written under `attachments/<hash>.<ext>` (content-hashed so identical files
// de-dupe) and referenced from the note by a vault-root markdown `src`.

import * as ipc from "./ipc";
import { previewKind } from "./preview";

// Formats the app understands but that don't render in an <img> on every
// platform (Linux WebKitGTK can't decode HEIC/TIFF). We transcode them to PNG
// on import — on the machine doing the import the webview CAN decode them, and
// the resulting PNG then renders everywhere and syncs to every teammate.
const TRANSCODE_TO_PNG: Record<string, string> = {
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** Load bytes of `mime` into an <img> via a blob URL (webview-native decode). */
function decodeImage(bytes: Uint8Array, mime: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

/** Re-encode already-decoded image bytes as PNG through a canvas. */
async function transcodeToPng(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  const img = await decodeImage(bytes, mime);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx || !canvas.width || !canvas.height) throw new Error("cannot draw image");
  ctx.drawImage(img, 0, 0);
  const png = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!png) throw new Error("PNG encode failed");
  return new Uint8Array(await png.arrayBuffer());
}

/**
 * Persist bytes under `attachments/<hash>.<ext>` and return the vault-root
 * markdown `src` (e.g. `/attachments/ab12cd34.png`). `makeResolveAsset` turns
 * that back into a loadable `asset:` URL for rendering.
 */
export async function saveAttachment(bytes: Uint8Array, ext: string): Promise<string> {
  // Non-portable image formats (HEIC/TIFF) → PNG so they render everywhere. If
  // the decode fails, fall back to storing the original untouched.
  const sourceMime = TRANSCODE_TO_PNG[ext.toLowerCase()];
  if (sourceMime) {
    try {
      bytes = await transcodeToPng(bytes, sourceMime);
      ext = "png";
    } catch (e) {
      console.warn(`transcode ${ext}→png failed; keeping original`, e);
    }
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rel = `attachments/${hash}.${ext}`;
  await ipc.writeBinaryFile(rel, bytes);
  return `/${rel}`;
}

/**
 * Copy a dropped host file into `attachments/` and return the markdown to embed
 * it in a note. Previewable files (images AND PDFs) use the `![]()` embed form
 * so live preview renders them in place (images inline, PDFs as a block); any
 * other file type becomes a plain link (`[]`). Hash-named, so the note never
 * carries an unwieldy source path.
 */
export async function embedDroppedFile(path: string): Promise<string> {
  const name = path.split(/[\\/]/).pop() ?? "file";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "bin";
  const bytes = await ipc.readExternalFile(path);
  const src = await saveAttachment(bytes, ext);
  const label = dot > 0 ? name.slice(0, dot) : name;
  return previewKind(name) != null ? `![${label}](${src})` : `[${name}](${src})`;
}
