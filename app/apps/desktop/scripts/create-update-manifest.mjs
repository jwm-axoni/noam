#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export function makeUpdateManifest({ version, archive, signature, notes, date = new Date().toISOString() }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a release version such as 0.1.60");
  const sig = readFileSync(signature, "utf8").trim();
  if (!sig) throw new Error("Updater signature is empty");
  if (!basename(archive).endsWith(".app.tar.gz")) throw new Error("Expected a macOS app update archive");
  const url = `https://github.com/jwm-axoni/noam/releases/download/v${version}/${encodeURIComponent(basename(archive))}`;
  return {
    version,
    notes,
    pub_date: date,
    platforms: { "darwin-aarch64": { signature: sig, url } },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [version, archive, signature, notesFile, output] = process.argv.slice(2);
  if (!version || !archive || !signature || !notesFile || !output) {
    throw new Error("Usage: node create-update-manifest.mjs VERSION ARCHIVE SIGNATURE NOTES_FILE OUTPUT");
  }
  const manifest = makeUpdateManifest({ version, archive, signature, notes: readFileSync(notesFile, "utf8") });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${output} for macOS Apple Silicon ${version}`);
}
