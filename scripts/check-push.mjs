#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const zeroObject = "0".repeat(40);

function parseArgs(argv) {
  const options = { root: resolve(scriptDirectory, ".."), remoteName: null, remoteUrl: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") options.root = resolve(argv[++index]);
    else if (value === "--remote-name") options.remoteName = argv[++index];
    else if (value === "--remote-url") options.remoteUrl = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.remoteName || !options.remoteUrl) throw new Error("Both --remote-name and --remote-url are required");
  return options;
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function normalizeRepository(url) {
  const trimmed = url.trim().replace(/\.git\/?$/, "");
  const scp = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scp && !trimmed.includes("://")) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function isValidationGate(url) {
  return url.startsWith("/") && /\/\.no-mistakes\/repos\/[a-f0-9]{12}\.git$/i.test(url);
}

function fail(message) {
  console.error(`Push blocked: ${message}`);
  process.exitCode = 1;
}

function requireSuccess(result, description) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error?.code === "ENOENT") {
    fail(`${description} is not installed or is not on PATH.`);
    return false;
  }
  if (result.status !== 0) {
    fail(`${description} did not pass.`);
    return false;
  }
  return true;
}

const options = parseArgs(process.argv.slice(2));
const policyPath = resolve(options.root, ".publication-policy.json");
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const validationRemote = (policy.validationRemotes ?? []).includes(options.remoteName) && isValidationGate(options.remoteUrl);
const normalizedRemote = normalizeRepository(options.remoteUrl);

if (!validationRemote && !(policy.allowedPushRepositories ?? []).includes(normalizedRemote)) {
  fail(`remote ${options.remoteName} is not an approved publication repository.`);
}

const input = readFileSync(0, "utf8").trim();
const updates = input ? input.split("\n").map((line) => line.trim().split(/\s+/)) : [];
const ranges = new Set();
const tagObjects = new Set();

for (const fields of updates) {
  if (fields.length !== 4) {
    fail("Git supplied an unexpected pre-push record.");
    continue;
  }
  const [, localObject, , remoteObject] = fields;
  if (localObject === zeroObject) continue;

  // Every root commit reachable from the tip must be the clean root: an ancestry check alone lets a
  // merge with --allow-unrelated-histories graft old history in beside it.
  const roots = run("git", ["rev-list", "--max-parents=0", localObject], options.root);
  if (roots.status !== 0 || roots.stdout.trim() !== policy.cleanRootCommit) {
    fail("outgoing history does not descend solely from the approved clean root commit.");
    continue;
  }
  // Git hands the hook the tag object itself for an annotated tag. Turning that straight into a
  // revision range makes rev-list dereference it to commits, so the tagger identity and the
  // annotation text are never scanned; the tag object has to be checked on its own as well.
  const objectType = run("git", ["cat-file", "-t", localObject], options.root);
  if (objectType.status !== 0) {
    fail(`unable to determine the type of pushed object ${localObject}.`);
    continue;
  }
  if (objectType.stdout.trim() === "tag") tagObjects.add(localObject);

  ranges.add(remoteObject === zeroObject ? localObject : `${remoteObject}..${localObject}`);
}

if (process.exitCode) process.exit();

for (const tagObject of tagObjects) {
  const publication = run(process.execPath, [
    resolve(scriptDirectory, "check-publication.mjs"),
    "--root", options.root,
    "--policy", policyPath,
    "--scope", "tag",
    "--tag", tagObject,
    "--fail-on-review",
  ], options.root);
  requireSuccess(publication, "publication tag scan");
}

for (const revisionRange of ranges) {
  const publication = run(process.execPath, [
    resolve(scriptDirectory, "check-publication.mjs"),
    "--root", options.root,
    "--policy", policyPath,
    "--scope", "range",
    "--range", revisionRange,
    "--fail-on-review",
  ], options.root);
  if (!requireSuccess(publication, "publication history scan")) continue;

  const secrets = run("gitleaks", ["git", "--redact", "--no-banner", `--log-opts=${revisionRange}`], options.root);
  requireSuccess(secrets, "gitleaks history scan");
}

if (!process.exitCode) console.log("Push guard passed: approved remote, clean lineage, publication scan, and secret scan.");
