import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve(import.meta.dirname, "check-publication.mjs");

function run(root, policy, extraArgs = []) {
  return spawnSync(process.execPath, [script, "--root", root, "--policy", policy, "--scope", "tree", "--format", "json", ...extraArgs], { encoding: "utf8" });
}

function git(root, args, env = process.env) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env });
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

test("scans a path whose Git type changed into a text blob within a commit range", () => {
  const root = mkdtempSync(join(tmpdir(), "noam-publication-typechange-"));
  initializeRepository(root);
  const policy = fixturePolicy(root);
  writeFileSync(join(root, "README.md"), "Clean root.\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Clean root"]);

  const link = join(root, "notes.txt");
  symlinkSync("README.md", link);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "Add a link"]);

  // A type change (symlink to regular blob) is reported as `T`, which a diff filter of ACMR drops.
  const email = ["private.person", "gmail.com"].join("@");
  unlinkSync(link);
  writeFileSync(link, `${email}\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "Replace the link with a regular file"]);

  unlinkSync(link);
  symlinkSync("README.md", link);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "Restore the link"]);

  const result = run(root, policy, ["--scope", "range", "--range", "HEAD"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.findings.some((finding) => finding.rule === "personal-email-provider"), result.stdout);
  assert.doesNotMatch(result.stdout, /private\.person/);
});

test("scans a commit body, not only the commit subject", () => {
  const root = mkdtempSync(join(tmpdir(), "noam-publication-body-"));
  initializeRepository(root);
  const policy = fixturePolicy(root);
  writeFileSync(join(root, "README.md"), "Clean root.\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Clean root"]);
  const email = ["private.person", "gmail.com"].join("@");
  git(root, ["commit", "--allow-empty", "-m", "Clean subject", "-m", `Reported by ${email}`]);

  const result = run(root, policy, ["--scope", "range", "--range", "HEAD", "--fail-on-review"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.findings.some((finding) => finding.rule === "personal-email-provider"), result.stdout);
  assert.doesNotMatch(result.stdout, /private\.person/);
});

test("scans the committer identity, not only the author identity", () => {
  const root = mkdtempSync(join(tmpdir(), "noam-publication-committer-"));
  initializeRepository(root);
  const policy = fixturePolicy(root);
  writeFileSync(join(root, "README.md"), "Clean root.\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Clean root"]);
  const email = ["private.person", "gmail.com"].join("@");
  git(root, ["commit", "--allow-empty", "-m", "Clean subject"], {
    ...process.env,
    GIT_COMMITTER_NAME: "Private Person",
    GIT_COMMITTER_EMAIL: email,
  });

  const result = run(root, policy, ["--scope", "range", "--range", "HEAD", "--fail-on-review"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.findings.some((finding) => finding.rule === "personal-email-provider"), result.stdout);
  assert.doesNotMatch(result.stdout, /private\.person/);
});

test("can fail closed when a rule requires human review", () => {
  const root = mkdtempSync(join(tmpdir(), "noam-publication-review-"));
  writeFileSync(join(root, "notes.txt"), "needs-review\n");
  const result = run(root, fixturePolicy(root, { includeReviewRule: true }), ["--fail-on-review"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).reviewItems, 1);
});

test("redacts every sensitive value on a reported line", () => {
  const root = mkdtempSync(join(tmpdir(), "noam-publication-redact-"));
  const first = ["private.person", "gmail.com"].join("@");
  const second = ["other.person", "icloud.com"].join("@");
  writeFileSync(join(root, "config.txt"), `cc ${first} ${first} ${second}\n`);
  const result = run(root, fixturePolicy(root));
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout).findings[0]?.evidence ?? "";
  assert.equal(evidence, "cc [redacted] [redacted] [redacted]");
});
