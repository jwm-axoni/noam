#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(root, ".git"))) {
  console.log("Git guards were not installed because this source tree is not a Git checkout.");
  process.exit(0);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stderr || "Unable to configure Git hooks.");
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

// The hooks live in the Git directory, not the checkout: a relative `.githooks` hooksPath resolves
// against the working tree, so checking out a commit without that folder silently ran no guard at all.
// Copied there, the hooks keep running on any checkout and fail closed when its guard scripts are missing.
const hooksDirectory = resolve(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), "noam-guard-hooks");
mkdirSync(hooksDirectory, { recursive: true });
for (const hook of readdirSync(resolve(root, ".githooks"))) {
  const target = resolve(hooksDirectory, hook);
  copyFileSync(resolve(root, ".githooks", hook), target);
  chmodSync(target, 0o755);
}
git(["config", "--local", "core.hooksPath", hooksDirectory]);

console.log(`Git guards installed for this checkout (${hooksDirectory}).`);
