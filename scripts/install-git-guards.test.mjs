import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

function run(root, command, args, env = process.env) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", env });
}

function git(root, args) {
  const result = run(root, "git", args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "noam-install-guards-"));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Install Guard Test"]);
  git(root, ["config", "user.email", "install-guard@example.test"]);
  cpSync(join(repositoryRoot, ".githooks"), join(root, ".githooks"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  for (const script of ["install-git-guards.mjs", "check-push.mjs", "check-publication.mjs"]) {
    cpSync(join(repositoryRoot, "scripts", script), join(root, "scripts", script));
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Guarded tree"]);

  const bin = join(root, "..", `${root.split("/").pop()}-bin`);
  mkdirSync(bin);
  writeFileSync(join(bin, "gitleaks"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "gitleaks"), 0o755);
  const installed = run(root, process.execPath, [join(root, "scripts", "install-git-guards.mjs")]);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  return { root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

test("hooks still guard a checkout that has no .githooks folder", () => {
  const fixture = createFixture();
  git(fixture.root, ["checkout", "--orphan", "legacy"]);
  git(fixture.root, ["rm", "-rf", "--quiet", "."]);
  writeFileSync(join(fixture.root, "notes.md"), "Old history.\n");
  git(fixture.root, ["add", "notes.md"]);

  const commit = run(fixture.root, "git", ["commit", "-m", "Unguarded commit"], fixture.env);
  assert.notEqual(commit.status, 0, commit.stderr || commit.stdout);

  git(fixture.root, ["commit", "--no-verify", "-m", "Old root"]);
  const rogue = mkdtempSync(join(tmpdir(), "noam-install-guards-rogue-"));
  git(rogue, ["init", "--bare"]);
  const push = run(fixture.root, "git", ["push", rogue, "legacy"], fixture.env);
  assert.notEqual(push.status, 0, push.stderr || push.stdout);
  assert.equal(run(rogue, "git", ["rev-parse", "--verify", "legacy"]).status, 128);
});
