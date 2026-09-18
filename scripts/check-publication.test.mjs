import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve(import.meta.dirname, "check-publication.mjs");

function run(root, policy, extraArgs = []) {
  return spawnSync(process.execPath, [script, "--root", root, "--policy", policy, "--scope", "tree", "--format", "json", ...extraArgs], { encoding: "utf8" });
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initializeRepository(root) {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Publication Test"]);
  git(root, ["config", "user.email", "publication@example.test"]);
}

function fixturePolicy(root, { blockedToken = null, includeReviewRule = false } = {}) {
  const path = join(root, "policy.json");
  const blockedTokenHashes = blockedToken
    ? [{ id: "fixture-token", sha256: createHash("sha256").update(blockedToken).digest("hex") }]
    : [];
  const regexRules = [{ id: "personal-email-provider", severity: "blocker", pattern: "[A-Z0-9._%+-]+@(gmail|icloud)\\.[A-Z]{2,}", flags: "i" }];
  if (includeReviewRule) {
    regexRules.push({ id: "manual-review", severity: "review", pattern: "needs-review", flags: "i", allowedPaths: ["policy.json"] });
  }
  writeFileSync(path, JSON.stringify({
    version: 1,
    ignoredDirectories: ["node_modules"],
    legalOnlyTokenHashes: [],
    blockedTokenHashes,
    regexRules,
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
  const result = run(root, fixturePolicy(root, { blockedToken: token }));
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).findings[0]?.rule, "fixture-token");
});

test("scans the staged snapshot rather than a later working-tree edit", () => {
  const root = mkdtempSync(join(tmpdir(), "noam-publication-index-"));
  initializeRepository(root);
  const email = ["private.person", "gmail.com"].join("@");
  writeFileSync(join(root, "config.txt"), `contact: ${email}\n`);
  git(root, ["add", "config.txt"]);
  writeFileSync(join(root, "config.txt"), "contact: public@example.test\n");
  const result = run(root, fixturePolicy(root), ["--source", "index"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).findings[0]?.rule, "personal-email-provider");
});

test("scans content that was added and removed within a commit range", () => {
  const root = mkdtempSync(join(tmpdir(), "noam-publication-range-"));
  initializeRepository(root);
  const policy = fixturePolicy(root);
  writeFileSync(join(root, "README.md"), "Clean root.\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Clean root"]);
  const email = ["private.person", "gmail.com"].join("@");
  writeFileSync(join(root, "temporary.txt"), `${email}\n`);
  git(root, ["add", "temporary.txt"]);
  git(root, ["commit", "-m", "Add temporary value"]);
  git(root, ["rm", "temporary.txt"]);
  git(root, ["commit", "-m", "Remove temporary value"]);
  const result = run(root, policy, ["--scope", "range", "--range", "HEAD"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).findings[0]?.rule, "personal-email-provider");
});

test("can fail closed when a rule requires human review", () => {
  const root = mkdtempSync(join(tmpdir(), "noam-publication-review-"));
  writeFileSync(join(root, "notes.txt"), "needs-review\n");
  const result = run(root, fixturePolicy(root, { includeReviewRule: true }), ["--fail-on-review"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).reviewItems, 1);
});
