// Bytes, base64 and SHA-256 for the package service.
//
// A package is ONE JSON file, so every file body inside it is either a utf8
// string or base64. The hash in the manifest is always over the DECODED bytes,
// which is what makes an export→import round trip verifiable regardless of how
// a body happened to be encoded.
//
// `crypto.subtle` is the same digest the bridge (`lib/bridge/adapter.ts`) and
// attachments use; it exists in the Tauri webview and in Node ≥ 20, so nothing
// here needs a dependency or a Node-only import.

import type { PackageFileBody } from "../contracts";

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Lowercase hex SHA-256 over raw bytes. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  // `crypto.subtle` wants a real ArrayBuffer view; a Uint8Array is one.
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBufferView);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function sha256Text(text: string): Promise<string> {
  return sha256Bytes(utf8Bytes(text));
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without `btoa`'s latin-1 trap: we encode bytes, not a string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : BASE64_CHARS[b2 & 0x3f];
  }
  return out;
}

/** Decode base64; null when the input is not valid base64 (never throws). */
export function base64ToBytes(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "");
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  const out = new Uint8Array((clean.length / 4) * 3);
  let n = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_CHARS.indexOf(clean[i]);
    const c1 = BASE64_CHARS.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === "=" ? -1 : BASE64_CHARS.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === "=" ? -1 : BASE64_CHARS.indexOf(clean[i + 3]);
    if (c0 < 0 || c1 < 0) return null;
    out[n++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) out[n++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    else if (clean[i + 2] !== "=") return null;
    if (c3 >= 0) out[n++] = ((c2 & 0x03) << 6) | c3;
    else if (clean[i + 3] !== "=") return null;
  }
  return out.subarray(0, n);
}

/** The decoded bytes of one embedded body, or an error string. */
export function bodyBytes(body: PackageFileBody): { bytes: Uint8Array } | { error: string } {
  if (!body || typeof body !== "object") return { error: "body is not an object" };
  if (typeof body.content !== "string") return { error: "body content must be a string" };
  if (body.encoding === "utf8") return { bytes: utf8Bytes(body.content) };
  if (body.encoding === "base64") {
    const bytes = base64ToBytes(body.content);
    return bytes ? { bytes } : { error: "body is not valid base64" };
  }
  return { error: `unknown body encoding "${String(body.encoding)}"` };
}
