#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(root, ".git"))) {
  console.log("Git guards were not installed because this source tree is not a Git checkout.");
  process.exit(0);
}

const result = spawnSync("git", ["config", "--local", "core.hooksPath", ".githooks"], { cwd: root, encoding: "utf8" });
if (result.status !== 0) {
  console.error(result.stderr || "Unable to configure Git hooks.");
  process.exit(result.status ?? 1);
}

console.log("Git guards installed for this checkout (.githooks).");
