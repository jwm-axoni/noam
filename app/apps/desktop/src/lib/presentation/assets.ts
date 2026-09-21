import * as ipc from "../ipc";
import { saveAttachment } from "../attachments";

export const MAX_ICON_BYTES = 5 * 1024 * 1024;
export const MAX_COVER_BYTES = 20 * 1024 * 1024;
export const ICON_THUMBNAIL_PX = 256;
export const MAX_COVER_SOURCE_PX = 8192;
export const MAX_COVER_DECODED_PIXELS = 40_000_000;

type PresentationAssetKind = "icon" | "cover";
export interface IconCrop {
  x: number;
  y: number;
  zoom: number;
}

export interface PresentationAssetTarget {
  vaultEpoch: number;
  /** Stable local vault identity used to keep device-local recents isolated. */
  vaultScope: string;
  isCurrent: () => boolean;
}

export interface PresentationAssetSource {
  name: string;
  bytes: Uint8Array;
  mime: string;
  previewUrl: string;
  target: PresentationAssetTarget;
}

const STALE_TARGET_ERROR = "The image destination changed before it could be imported.";

const IMAGE_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export type AssetValidation =
  | { ok: true; ext: keyof typeof IMAGE_MIMES; mime: string }
  | { ok: false; message: string };

export function validatePresentationAsset(
  name: string,
  bytes: Uint8Array,
  kind: PresentationAssetKind,
): AssetValidation {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const mime = IMAGE_MIMES[ext];
  if (!mime) {
    return { ok: false, message: "Choose a PNG, JPEG, WebP or SVG image." };
  }
  const limit = kind === "icon" ? MAX_ICON_BYTES : MAX_COVER_BYTES;
  if (bytes.byteLength > limit) {
    return {
      ok: false,
      message: `${kind === "icon" ? "Icons" : "Covers"} must be ${limit / 1024 / 1024} MB or smaller.`,
    };
  }
  if (ext === "svg") {
    try {
      sanitizedSvg(bytes);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "The SVG could not be read.",
      };
    }
  } else if (!matchesImageSignature(ext, bytes)) {
    return {
      ok: false,
      message: `The file contents do not match the .${ext} extension.`,
    };
  }
  return { ok: true, ext: ext as keyof typeof IMAGE_MIMES, mime };
}

function matchesImageSignature(ext: string, bytes: Uint8Array): boolean {
  if (ext === "png") {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return png.every((byte, index) => bytes[index] === byte);
  }
  if (ext === "jpg" || ext === "jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (ext === "webp") {
    return (
      bytes.length >= 12 &&
      new TextDecoder("ascii").decode(bytes.subarray(0, 4)) === "RIFF" &&
      new TextDecoder("ascii").decode(bytes.subarray(8, 12)) === "WEBP"
    );
  }
  return false;
}

function hasExternalCssUrl(value: string): boolean {
  if (!/url\s*\(/i.test(value)) return false;
  const references = [
    ...value.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi),
  ];
  return (
    references.length === 0 ||
    references.some((match) => !match[2]?.trim().startsWith("#"))
  );
}

function sanitizedSvg(bytes: Uint8Array): string {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The SVG is not valid UTF-8.");
  }
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  if (
    doc.doctype ||
    doc.querySelector("parsererror") ||
    doc.documentElement.localName !== "svg" ||
    doc.documentElement.namespaceURI !== SVG_NAMESPACE
  ) {
    throw new Error("The SVG could not be read.");
  }
  if (doc.querySelector("script, foreignObject, iframe, object, embed, style")) {
    throw new Error("The SVG contains active content.");
  }
  for (const element of doc.querySelectorAll("*")) {
    if (element.namespaceURI !== SVG_NAMESPACE) {
      throw new Error("The SVG contains elements outside the SVG namespace.");
    }
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (
        name === "xml:base" ||
        (attr.namespaceURI === "http://www.w3.org/XML/1998/namespace" &&
          attr.localName === "base")
      ) {
        throw new Error("The SVG contains an XML base URL.");
      }
      if (name.startsWith("on")) throw new Error("The SVG contains event handlers.");
      if (
        (name === "href" || name === "xlink:href" || name === "src") &&
        !value.startsWith("#")
      ) {
        throw new Error("The SVG references an external resource.");
      }
      if (hasExternalCssUrl(value)) {
        throw new Error("The SVG references an external resource.");
      }
    }
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}

function loadImage(bytes: Uint8Array, mime: string): Promise<HTMLImageElement> {
  const data = mime === "image/svg+xml" ? sanitizedSvg(bytes) : bytes;
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The image could not be decoded."));
    };
    image.src = url;
  });
}

function planRasterCrop(
  imageWidth: number,
  imageHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  crop: IconCrop = { x: 50, y: 50, zoom: 1 },
): { x: number; y: number; width: number; height: number } {
  const positionX = Math.min(100, Math.max(0, crop.x)) / 100;
  const positionY = Math.min(100, Math.max(0, crop.y)) / 100;
  const zoom = Math.min(3, Math.max(1, crop.zoom));
  const scale = Math.max(canvasWidth / imageWidth, canvasHeight / imageHeight) * zoom;
  const width = Math.max(1, imageWidth * scale);
  const height = Math.max(1, imageHeight * scale);
  const x = -(width - canvasWidth) * positionX;
  const y = -(height - canvasHeight) * positionY;
  return {
    x: x === 0 ? 0 : x,
    y: y === 0 ? 0 : y,
    width,
    height,
  };
}

async function rasterizedImage(
  bytes: Uint8Array,
  mime: string,
  maxPx: number,
  square: boolean,
  crop?: IconCrop,
  outputMime = "image/png",
): Promise<Uint8Array> {
  const image = await loadImage(bytes, mime);
  if (
    image.naturalWidth <= 0 ||
    image.naturalHeight <= 0 ||
    image.naturalWidth * image.naturalHeight > MAX_COVER_DECODED_PIXELS
  ) {
    throw new Error("The image dimensions are too large to import safely.");
  }
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, maxPx / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = square ? maxPx : Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = square ? maxPx : Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This device cannot prepare the icon.");
  const draw = square
    ? planRasterCrop(
      image.naturalWidth,
      image.naturalHeight,
      canvas.width,
      canvas.height,
      crop,
    )
    : (() => {
      const drawScale = Math.min(
        canvas.width / image.naturalWidth,
        canvas.height / image.naturalHeight,
      );
      const width = Math.max(1, image.naturalWidth * drawScale);
      const height = Math.max(1, image.naturalHeight * drawScale);
      return {
        x: (canvas.width - width) / 2,
        y: (canvas.height - height) / 2,
        width,
        height,
      };
    })();
  context.drawImage(image, draw.x, draw.y, draw.width, draw.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outputMime, outputMime === "image/png" ? undefined : 0.92));
  if (!blob) throw new Error("The icon could not be prepared.");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Pick one image, validate it, persist it under attachments, and return a portable path. */
export async function pickPresentationAsset(
  kind: PresentationAssetKind,
  target: PresentationAssetTarget,
): Promise<{ path: string; sourcePath?: string } | { error: string } | null> {
  const source = await pickPresentationSource(kind, target);
  if (!source || "error" in source) return source;
  try {
    return await savePresentationAsset(source.name, source.bytes, kind, source.target);
  } finally {
    URL.revokeObjectURL(source.previewUrl);
  }
}

export async function pickPresentationSource(
  kind: PresentationAssetKind,
  target: PresentationAssetTarget,
): Promise<PresentationAssetSource | { error: string } | null> {
  try {
    if (!target.isCurrent()) return { error: STALE_TARGET_ERROR };
    const selected = await ipc.pickFiles();
    if (!target.isCurrent()) return { error: STALE_TARGET_ERROR };
    const path = selected?.[0];
    if (!path) return null;
    const bytes = await ipc.readExternalFile(path);
    if (!target.isCurrent()) return { error: STALE_TARGET_ERROR };
    const validation = validatePresentationAsset(path, bytes, kind);
    if (!validation.ok) return { error: validation.message };
    const previewBytes = validation.ext === "svg"
      ? new TextEncoder().encode(sanitizedSvg(bytes))
      : bytes;
    return {
      name: path,
      bytes,
      mime: validation.mime,
      previewUrl: URL.createObjectURL(new Blob([previewBytes], { type: validation.mime })),
      target,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "The image could not be read.",
    };
  }
}

export async function savePresentationAsset(
  name: string,
  bytes: Uint8Array,
  kind: PresentationAssetKind,
  target: PresentationAssetTarget,
  crop?: IconCrop,
): Promise<{ path: string; sourcePath?: string } | { error: string }> {
  const validation = validatePresentationAsset(name, bytes, kind);
  if (!validation.ok) return { error: validation.message };
  if (!target.isCurrent()) return { error: STALE_TARGET_ERROR };
  try {
    let stored: string;
    let sourceStored: string | undefined;
    if (kind === "icon") {
      const rasterized = await rasterizedImage(
        bytes,
        validation.mime,
        ICON_THUMBNAIL_PX,
        true,
        crop,
      );
      if (!target.isCurrent()) return { error: STALE_TARGET_ERROR };
      stored = await saveAttachment(
        rasterized,
        "png",
        target.vaultEpoch,
      );
    } else {
      // Preserve a metadata-free, bounded source for future re-crops. The note
      // displays only the smaller passive PNG preview; public links never grant
      // the source attachment merely because this private field names it.
      const original =
        validation.ext === "svg"
          ? new TextEncoder().encode(sanitizedSvg(bytes))
          : bytes;
      const sourceMime = validation.mime === "image/svg+xml"
        ? "image/png"
        : validation.mime;
      const sourceExt = sourceMime === "image/jpeg"
        ? "jpg"
        : sourceMime === "image/webp"
          ? "webp"
          : "png";
      const source = await rasterizedImage(
        original,
        validation.mime,
        MAX_COVER_SOURCE_PX,
        false,
        undefined,
        sourceMime,
      );
      if (source.byteLength > MAX_COVER_BYTES) {
        throw new Error("The metadata-free cover source is larger than 20 MB.");
      }
      if (!target.isCurrent()) return { error: STALE_TARGET_ERROR };
      sourceStored = await saveAttachment(source, sourceExt, target.vaultEpoch);
      if (!target.isCurrent()) return { error: STALE_TARGET_ERROR };
      const preview = await rasterizedImage(original, validation.mime, 1600, false);
      if (!target.isCurrent()) return { error: STALE_TARGET_ERROR };
      stored = await saveAttachment(
        preview,
        "png",
        target.vaultEpoch,
      );
    }
    if (!target.isCurrent()) return { error: STALE_TARGET_ERROR };
    return {
      path: stored.replace(/^\//, ""),
      ...(sourceStored ? { sourcePath: sourceStored.replace(/^\//, "") } : {}),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The image could not be imported." };
  }
}

export const __presentationAssetTest = {
  matchesImageSignature,
  hasExternalCssUrl,
  planRasterCrop,
  sanitizedSvg,
};
