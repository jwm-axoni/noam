#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");
const maximumTextBytes = 8 * 1024 * 1024;

function parseArgs(argv) {
  const options = {
    root: defaultRoot,
    policy: resolve(defaultRoot, ".publication-policy.json"),
    scope: "tree",
    source: "working",
    range: null,
    tag: null,
    failOnReview: false,
    format: "text",
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") options.root = resolve(argv[++index]);
    else if (value === "--policy") options.policy = resolve(argv[++index]);
    else if (value === "--scope") options.scope = argv[++index];
    else if (value === "--source") options.source = argv[++index];
    else if (value === "--range") options.range = argv[++index];
    else if (value === "--tag") options.tag = argv[++index];
    else if (value === "--fail-on-review") options.failOnReview = true;
    else if (value === "--format") options.format = argv[++index];
    else if (value === "--output") options.output = resolve(argv[++index]);
    else if (value === "--help" || value === "-h") {
      console.log("Usage: node scripts/check-publication.mjs [--root PATH] [--policy PATH] [--scope tree|history|range|tag|remote|all] [--source working|index] [--range REVISION_RANGE] [--tag OBJECT] [--fail-on-review] [--format text|json] [--output PATH]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!["tree", "history", "range", "tag", "remote", "all"].includes(options.scope)) {
    throw new Error(`Unsupported scope: ${options.scope}`);
  }
  if (!["working", "index"].includes(options.source)) {
    throw new Error(`Unsupported source: ${options.source}`);
  }
  if (!["text", "json"].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`);
  }
  if (options.scope === "range" && !options.range) {
    throw new Error("--scope range requires --range REVISION_RANGE");
  }
  if (options.scope === "tag" && !options.tag) {
    throw new Error("--scope tag requires --tag OBJECT");
  }
  return options;
}

function run(command, args, cwd, encoding = "utf8") {
  return spawnSync(command, args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(root, path) {
  return relative(root, path).split("\\").join("/");
}

function listWorkingFiles(root, ignoredDirectories) {
  const gitFiles = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root);
  if (gitFiles.status === 0) {
    return gitFiles.stdout
      .split("\0")
      .filter(Boolean)
      .map((path) => resolve(root, path))
      .filter((path) => existsSync(path) && lstatSync(path).isFile());
  }

  const files = [];
  const ignored = new Set(ignoredDirectories);
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  return files;
}

function listIndexFiles(root) {
  // `T` belongs in every diff filter here: a path flipped from a symlink or gitlink into a regular
  // blob is reported as a type change, so ACMR alone let prohibited content through unscanned.
  const result = run("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"], root);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to read the Git index");
  return result.stdout.split("\0").filter(Boolean);
}

function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

function candidatesForLine(line) {
  const lower = line.toLowerCase();
  const words = lower.match(/[a-z0-9._%+@-]+/g) ?? [];
  const candidates = new Set(words);

  for (let size = 2; size <= 4; size += 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      candidates.add(words.slice(start, start + size).join(" "));
    }
  }

  for (const match of lower.matchAll(/\/(?:users|home)\/[^/\s"'`]+/g)) {
    candidates.add(match[0]);
  }
  return candidates;
}

function redact(line, rules) {
  return rules.reduce((text, rule) => text.replace(rule.redactor, "[redacted]"), line).slice(0, 240);
}

function createScanner(policy) {
  const blockedHashes = new Map((policy.blockedTokenHashes ?? []).map((rule) => [rule.sha256, rule]));
  const legalHashes = new Map((policy.legalOnlyTokenHashes ?? []).map((rule) => [rule.sha256, rule]));
  const regexRules = (policy.regexRules ?? []).map((rule) => ({
    ...rule,
    regex: new RegExp(rule.pattern, rule.flags),
    redactor: new RegExp(rule.pattern, `${(rule.flags ?? "").replace("g", "")}g`),
  }));

  return (text, path, scope = "tree", policyPath = path) => {
    const findings = [];
    const lines = text.split(/\r?\n/);
    const activeRules = regexRules.filter((rule) =>
      (!rule.scopes || rule.scopes.includes(scope)) && !rule.allowedPaths?.includes(policyPath));

    lines.forEach((line, index) => {
      for (const candidate of candidatesForLine(line)) {
        const digest = sha256(candidate);
        const blocked = blockedHashes.get(digest);
        if (blocked) {
          findings.push({ severity: "blocker", rule: blocked.id, path, line: index + 1, evidence: "[redacted token]" });
        }

        const legal = legalHashes.get(digest);
        if (legal && !legal.allowedPaths.includes(policyPath)) {
          findings.push({ severity: "blocker", rule: legal.id, path, line: index + 1, evidence: "[third-party term outside legal notice]" });
        }
      }

      for (const rule of activeRules) {
        rule.regex.lastIndex = 0;
        const match = rule.regex.exec(line);
        if (!match) continue;
        findings.push({ severity: rule.severity, rule: rule.id, path, line: index + 1, evidence: redact(line, activeRules) });
      }
    });

    return findings;
  };
}

function uniqueFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.severity}:${finding.rule}:${finding.path}:${finding.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scanBuffer(buffer, path, scope, scanText, policyPath = path) {
  if (looksBinary(buffer)) return { findings: [], scanned: false };
  if (buffer.length > maximumTextBytes) {
    return {
      findings: [{ severity: "review", rule: "large-text-file", path, line: 1, evidence: `${buffer.length} bytes` }],
      scanned: false,
    };
  }
  return { findings: scanText(buffer.toString("utf8"), path, scope, policyPath), scanned: true };
}

function scanWorkingTree(root, policy, scanText) {
  const findings = [];
  let scannedFiles = 0;

  for (const file of listWorkingFiles(root, policy.ignoredDirectories ?? [])) {
    const path = normalizePath(root, file);
    const scanned = scanBuffer(readFileSync(file), path, "tree", scanText);
    findings.push(...scanned.findings);
    if (scanned.scanned) scannedFiles += 1;
  }
  return { findings, scannedFiles };
}

function scanIndex(root, scanText) {
  const findings = [];
  let scannedFiles = 0;

  for (const path of listIndexFiles(root)) {
    const result = run("git", ["show", `:${path}`], root, null);
    if (result.status !== 0) {
      findings.push({ severity: "review", rule: "index-entry-unavailable", path, line: 1, evidence: "Unable to read staged content" });
      continue;
    }
    const scanned = scanBuffer(result.stdout, path, "index", scanText);
    findings.push(...scanned.findings);
    if (scanned.scanned) scannedFiles += 1;
  }
  return { findings, scannedFiles };
}

// Prohibited data hides in the commit body and in the committer identity just as easily as in the
// subject and the author, so every part of the message and both identities are scanned. Bodies span
// lines, so each commit is terminated with a NUL to keep the commit count accurate.
const commitMetadataFormat = "%H%x09%an%x09%ae%x09%cn%x09%ce%x09%s%n%b";

function scanHistory(root, scanText) {
  const result = run("git", ["log", "--all", `--format=${commitMetadataFormat}%x00`], root);
  if (result.status !== 0) {
    return {
      findings: [{ severity: "review", rule: "history-unavailable", path: "git-history", line: 1, evidence: "No Git history found" }],
      scannedCommits: 0,
    };
  }
  const entries = result.stdout.split("\0").filter((entry) => entry.trim());
  return { findings: scanText(result.stdout, "git-history", "history"), scannedCommits: entries.length };
}

function scanRange(root, revisionRange, scanText) {
  const revisions = run("git", ["rev-list", "--reverse", revisionRange], root);
  if (revisions.status !== 0) {
    return {
      findings: [{ severity: "review", rule: "range-unavailable", path: "git-history", line: 1, evidence: "Unable to resolve revision range" }],
      scannedFiles: 0,
      scannedCommits: 0,
    };
  }

  const commits = revisions.stdout.split("\n").filter(Boolean);
  const findings = [];
  let scannedFiles = 0;

  for (const commit of commits) {
    const metadata = run("git", ["show", "-s", `--format=${commitMetadataFormat}`, commit], root);
    if (metadata.status === 0) findings.push(...scanText(metadata.stdout, `git-history/${commit}`, "history"));
    else findings.push({ severity: "review", rule: "commit-metadata-unavailable", path: `git-history/${commit}`, line: 1, evidence: "Unable to read commit metadata" });

    const pathsResult = run("git", ["diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "--diff-filter=ACMRT", "-r", "-z", commit], root);
    if (pathsResult.status !== 0) {
      findings.push({ severity: "review", rule: "commit-tree-unavailable", path: `git-history/${commit}`, line: 1, evidence: "Unable to read commit tree" });
      continue;
    }

    for (const path of new Set(pathsResult.stdout.split("\0").filter(Boolean))) {
      const blob = run("git", ["show", `${commit}:${path}`], root, null);
      const findingPath = `git-history/${commit}/${path}`;
      if (blob.status !== 0) {
        findings.push({ severity: "review", rule: "commit-blob-unavailable", path: findingPath, line: 1, evidence: "Unable to read historical content" });
        continue;
      }
      const scanned = scanBuffer(blob.stdout, findingPath, "range", scanText, path);
      findings.push(...scanned.findings);
      if (scanned.scanned) scannedFiles += 1;
    }
  }

  return { findings, scannedFiles, scannedCommits: commits.length };
}

// An annotated tag carries its own tagger identity and message. Nothing reachable through a commit
// range contains them, so the tag object has to be read directly.
function scanTag(root, tagObject, scanText) {
  const result = run("git", ["cat-file", "-p", tagObject], root, null);
  if (result.status !== 0) {
    return {
      findings: [{ severity: "review", rule: "tag-unavailable", path: `git-tag/${tagObject}`, line: 1, evidence: "Unable to read tag object content" }],
      scannedTags: 0,
    };
  }
  const scanned = scanBuffer(result.stdout, `git-tag/${tagObject}`, "history", scanText);
  return { findings: scanned.findings, scannedTags: scanned.scanned ? 1 : 0 };
}

function scanRemote(root, scanText) {
  const result = run("git", ["remote", "-v"], root);
  if (result.status !== 0 || !result.stdout.trim()) {
    return {
      findings: [{ severity: "review", rule: "remote-unavailable", path: "git-remote", line: 1, evidence: "No Git remote configured" }],
      scannedRemotes: 0,
    };
  }
  const lines = result.stdout.trim().split("\n");
  return { findings: scanText(result.stdout, "git-remote", "remote"), scannedRemotes: lines.length };
}

function printText(report) {
  console.log(`Publication readiness: ${report.blockers} blocker(s), ${report.reviewItems} review item(s)`);
  console.log(`Scanned ${report.scannedFiles} file(s), ${report.scannedCommits} commit(s), ${report.scannedTags} tag object(s), ${report.scannedRemotes} remote entry(s)`);
  for (const finding of report.findings) {
    console.log(`${finding.severity.toUpperCase()} ${finding.rule} ${finding.path}:${finding.line} ${finding.evidence}`);
  }
}

const options = parseArgs(process.argv.slice(2));
const policy = JSON.parse(readFileSync(options.policy, "utf8"));
const scanText = createScanner(policy);
const findings = [];
let scannedFiles = 0;
let scannedCommits = 0;
let scannedTags = 0;
let scannedRemotes = 0;

if (options.scope === "tree" || options.scope === "all") {
  const tree = options.source === "index" ? scanIndex(options.root, scanText) : scanWorkingTree(options.root, policy, scanText);
  findings.push(...tree.findings);
  scannedFiles += tree.scannedFiles;
}
if (options.scope === "history" || options.scope === "all") {
  const history = scanHistory(options.root, scanText);
  findings.push(...history.findings);
  scannedCommits += history.scannedCommits;
}
if (options.scope === "range") {
  const range = scanRange(options.root, options.range, scanText);
  findings.push(...range.findings);
  scannedFiles += range.scannedFiles;
  scannedCommits += range.scannedCommits;
}
if (options.scope === "tag") {
  const tag = scanTag(options.root, options.tag, scanText);
  findings.push(...tag.findings);
  scannedTags += tag.scannedTags;
}
if (options.scope === "remote" || options.scope === "all") {
  const remote = scanRemote(options.root, scanText);
  findings.push(...remote.findings);
  scannedRemotes += remote.scannedRemotes;
}

const finalFindings = uniqueFindings(findings);
const report = {
  version: 1,
  root: options.root,
  scope: options.scope,
  source: options.source,
  range: options.range,
  tag: options.tag,
  scannedFiles,
  scannedCommits,
  scannedTags,
  scannedRemotes,
  blockers: finalFindings.filter((finding) => finding.severity === "blocker").length,
  reviewItems: finalFindings.filter((finding) => finding.severity === "review").length,
  findings: finalFindings,
};

if (options.output) writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
if (options.format === "json") console.log(JSON.stringify(report, null, 2));
else printText(report);

process.exitCode = report.blockers > 0 || (options.failOnReview && report.reviewItems > 0) ? 1 : 0;
