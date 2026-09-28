#!/usr/bin/env node
// Bumps the desktop app version across all four version sources, which the
// release docs require to stay equal:
//   app/apps/desktop/package.json
//   app/apps/desktop/src-tauri/tauri.conf.json
//   app/apps/desktop/src-tauri/Cargo.toml
//   app/apps/desktop/src-tauri/Cargo.lock  (the `desktop` package entry only)
//
// Usage:
//   node scripts/bump-version.mjs [--bump patch|minor|major] [--to X.Y.Z] [--check]
//
// --check exits 0 when all four sources agree, 1 otherwise (no writes).

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "app", "apps", "desktop");
const tauriDir = join(desktop, "src-tauri");

const SOURCES = [
  join(desktop, "package.json"),
  join(tauriDir, "tauri.conf.json"),
  join(tauriDir, "Cargo.toml"),
  join(tauriDir, "Cargo.lock"),
];

function readVersion(file) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".json")) {
    return JSON.parse(text).version;
  }
  if (file.endsWith("Cargo.toml")) {
    const m = text.match(/^version\s*=\s*"([^"]+)"/m);
    return m && m[1];
  }
  // Cargo.lock: only the `desktop` package entry.
  const m = text.match(/name\s*=\s*"desktop"\nversion\s*=\s*"([^"]+)"/);
  return m && m[1];
}

function writeVersion(file, version) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".json")) {
    // Surgical replacement: re-serializing would reformat arrays and churn
    // the diff. The version key is unique in these files.
    const next = text.replace(
      /("version"\s*:\s*")[^"]+(")/,
      `$1${version}$2`,
    );
    if (next === text) throw new Error(`version key not found in ${file}`);
    writeFileSync(file, next);
    return;
  }
  if (file.endsWith("Cargo.toml")) {
    writeFileSync(
      file,
      text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`),
    );
    return;
  }
  writeFileSync(
    file,
    text.replace(
      /(name\s*=\s*"desktop"\nversion\s*=\s*")[^"]+(")/,
      `$1${version}$2`,
    ),
  );
}

function bumpSemver(version, kind) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Not a semver version: ${version}`);
  }
  const [major, minor, patch] = parts;
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const versions = new Map(SOURCES.map((f) => [f, readVersion(f)]));
const distinct = new Set(versions.values());

if (args.includes("--check")) {
  for (const [f, v] of versions) console.log(`${v}\t${f}`);
  if (distinct.size !== 1 || distinct.has(undefined)) {
    console.error("Version mismatch across sources.");
    process.exit(1);
  }
  console.log("All version sources agree.");
  process.exit(0);
}

if (distinct.size !== 1 || distinct.has(undefined)) {
  console.error("Refusing to bump: version sources disagree.");
  for (const [f, v] of versions) console.error(`  ${v}\t${f}`);
  process.exit(1);
}

const current = [...distinct][0];
const target = opt("--to", null) || bumpSemver(current, opt("--bump", "patch"));
if (!/^\d+\.\d+\.\d+$/.test(target)) {
  console.error(`Invalid target version: ${target}`);
  process.exit(1);
}

for (const f of SOURCES) writeVersion(f, target);
console.log(`${current} -> ${target}`);
