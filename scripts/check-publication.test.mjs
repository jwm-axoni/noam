import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve(import.meta.dirname, "check-publication.mjs");

function run(root, policy) {
  return spawnSync(process.execPath, [script, "--root", root, "--policy", policy, "--scope", "tree", "--format", "json"], {
    encoding: "utf8",
  });
}

function fixturePolicy(root, blockedToken = null) {
  const path = join(root, "policy.json");
  const blockedTokenHashes = blockedToken
    ? [{ id: "fixture-token", sha256: createHash("sha256").update(blockedToken).digest("hex") }]
    : [];
  writeFileSync(path, JSON.stringify({
    version: 1,
    ignoredDirectories: ["node_modules"],
    legalOnlyTokenHashes: [],
    blockedTokenHashes,
    regexRules: [{
      id: "personal-email-provider",
      severity: "blocker",
      pattern: "[A-Z0-9._%+-]+@(gmail|icloud)\\.[A-Z]{2,}",
      flags: "i",
    }],
  }));
  return path;
}

test("passes a clean export", () => {
  const root = mkdtempSync(join(tmpdir(), "noam-publication-clean-"));
  writeFileSync(join(root, "README.md"), "Synthetic project data only.\n");
  const result = run(root, fixturePolicy(root));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).blockers, 0);
});

test("blocks a personal email through the executable interface", () => {
  const root = mkdtempSync(join(tmpdir(), "noam-publication-email-"));
  writeFileSync(join(root, "config.txt"), "contact: private.person@gmail.com\n");
  const result = run(root, fixturePolicy(root));
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.findings[0]?.rule, "personal-email-provider");
  assert.doesNotMatch(report.findings[0]?.evidence ?? "", /private\.person/);
});

test("blocks a hashed forbidden token without storing it in the policy", () => {
  const root = mkdtempSync(join(tmpdir(), "noam-publication-token-"));
  const token = "fixture-private-token";
  writeFileSync(join(root, "notes.txt"), `${token}\n`);
  const result = run(root, fixturePolicy(root, token));
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).findings[0]?.rule, "fixture-token");
});
