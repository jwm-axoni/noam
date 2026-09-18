#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");

function parseArgs(argv) {
  const options = {
    root: defaultRoot,
    policy: resolve(defaultRoot, ".publication-policy.json"),
    scope: "tree",
    format: "text",
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") options.root = resolve(argv[++index]);
    else if (value === "--policy") options.policy = resolve(argv[++index]);
    else if (value === "--scope") options.scope = argv[++index];
    else if (value === "--format") options.format = argv[++index];
    else if (value === "--output") options.output = resolve(argv[++index]);
    else if (value === "--help" || value === "-h") {
      console.log("Usage: node scripts/check-publication.mjs [--root PATH] [--policy PATH] [--scope tree|history|remote|all] [--format text|json] [--output PATH]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!["tree", "history", "remote", "all"].includes(options.scope)) {
    throw new Error(`Unsupported scope: ${options.scope}`);
  }
  if (!["text", "json"].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`);
  }
  return options;
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(root, path) {
  return relative(root, path).split("\\").join("/");
}

function listFiles(root, ignoredDirectories) {
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

function redact(line, match) {
  if (!match) return "[redacted]";
  return line.replace(match, "[redacted]").slice(0, 240);
}

function createScanner(policy) {
  const blockedHashes = new Map(policy.blockedTokenHashes.map((rule) => [rule.sha256, rule]));
  const legalHashes = new Map(policy.legalOnlyTokenHashes.map((rule) => [rule.sha256, rule]));
  const regexRules = policy.regexRules.map((rule) => ({
    ...rule,
    regex: new RegExp(rule.pattern, rule.flags),
  }));

  return (text, path, scope = "tree") => {
    const findings = [];
    const lines = text.split(/\r?\n/);

    lines.forEach((line, index) => {
      for (const candidate of candidatesForLine(line)) {
        const digest = sha256(candidate);
        const blocked = blockedHashes.get(digest);
        if (blocked) {
          findings.push({
            severity: "blocker",
            rule: blocked.id,
            path,
            line: index + 1,
            evidence: "[redacted token]",
          });
        }

        const legal = legalHashes.get(digest);
        if (legal && !legal.allowedPaths.includes(path)) {
          findings.push({
            severity: "blocker",
            rule: legal.id,
            path,
            line: index + 1,
            evidence: "[third-party term outside legal notice]",
          });
        }
      }

      for (const rule of regexRules) {
        if (rule.scopes && !rule.scopes.includes(scope)) continue;
        if (rule.allowedPaths?.includes(path)) continue;
        rule.regex.lastIndex = 0;
        const match = rule.regex.exec(line);
        if (!match) continue;
        findings.push({
          severity: rule.severity,
          rule: rule.id,
          path,
          line: index + 1,
          evidence: redact(line, match[0]),
        });
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

function scanTree(root, policy, scanText) {
  const findings = [];
  let scannedFiles = 0;

  for (const file of listFiles(root, policy.ignoredDirectories)) {
    const path = normalizePath(root, file);
    const buffer = readFileSync(file);
    if (looksBinary(buffer)) continue;
    if (buffer.length > 8 * 1024 * 1024) {
      findings.push({ severity: "review", rule: "large-text-file", path, line: 1, evidence: `${buffer.length} bytes` });
      continue;
    }
    scannedFiles += 1;
    findings.push(...scanText(buffer.toString("utf8"), path, "tree"));
  }
  return { findings, scannedFiles };
}

function scanHistory(root, scanText) {
  const result = run("git", ["log", "--all", "--format=%H%x09%an%x09%ae%x09%s"], root);
  if (result.status !== 0) {
    return {
      findings: [{ severity: "review", rule: "history-unavailable", path: "git-history", line: 1, evidence: "No Git history found" }],
      scannedCommits: 0,
    };
  }
  const lines = result.stdout.trim() ? result.stdout.trim().split("\n") : [];
  return { findings: scanText(result.stdout, "git-history", "history"), scannedCommits: lines.length };
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
  console.log(`Scanned ${report.scannedFiles} file(s), ${report.scannedCommits} commit(s), ${report.scannedRemotes} remote entry(s)`);
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
let scannedRemotes = 0;

if (options.scope === "tree" || options.scope === "all") {
  const tree = scanTree(options.root, policy, scanText);
  findings.push(...tree.findings);
  scannedFiles = tree.scannedFiles;
}
if (options.scope === "history" || options.scope === "all") {
  const history = scanHistory(options.root, scanText);
  findings.push(...history.findings);
  scannedCommits = history.scannedCommits;
}
if (options.scope === "remote" || options.scope === "all") {
  const remote = scanRemote(options.root, scanText);
  findings.push(...remote.findings);
  scannedRemotes = remote.scannedRemotes;
}

const finalFindings = uniqueFindings(findings);
const report = {
  version: 1,
  root: options.root,
  scope: options.scope,
  scannedFiles,
  scannedCommits,
  scannedRemotes,
  blockers: finalFindings.filter((finding) => finding.severity === "blocker").length,
  reviewItems: finalFindings.filter((finding) => finding.severity === "review").length,
  findings: finalFindings,
};

if (options.output) writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
if (options.format === "json") console.log(JSON.stringify(report, null, 2));
else printText(report);

process.exitCode = report.blockers > 0 ? 1 : 0;
