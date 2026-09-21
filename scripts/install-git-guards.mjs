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

function configuredHooksPath() {
  const result = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
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

// `pnpm install` runs this script through `prepare`, so overwriting core.hooksPath unconditionally
// would silently disable a contributor's existing hook manager. A path this installer does not own
// is reported and left alone; replacing it has to be asked for explicitly.
const existingHooksPath = configuredHooksPath();
if (existingHooksPath && resolve(root, existingHooksPath) !== hooksDirectory && !process.env.NOAM_GUARD_REPLACE_HOOKS_PATH) {
  console.error([
    `Git guards were not activated: core.hooksPath already points at ${existingHooksPath}.`,
    "That configuration was left in place. To run the guards as well, either:",
    `  - call ${resolve(hooksDirectory, "pre-commit")} and ${resolve(hooksDirectory, "pre-push")} from your own hooks, or`,
    "  - hand core.hooksPath over with: NOAM_GUARD_REPLACE_HOOKS_PATH=1 node scripts/install-git-guards.mjs",
  ].join("\n"));
  process.exit(0);
}

git(["config", "--local", "core.hooksPath", hooksDirectory]);

console.log(`Git guards installed for this checkout (${hooksDirectory}).`);
