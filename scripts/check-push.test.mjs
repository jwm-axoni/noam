import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve(import.meta.dirname, "check-push.mjs");
const zeroObject = "0".repeat(40);
const approvedRemote = "git@github.com:jwm-axoni/noam.git";

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "noam-push-guard-"));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Push Guard Test"]);
  git(root, ["config", "user.email", "push-guard@example.test"]);
  writeFileSync(join(root, "README.md"), "Clean root.\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "Clean root"]);
  const cleanRoot = git(root, ["rev-parse", "HEAD"]);
  writePolicy(root, cleanRoot);

  const bin = join(root, "test-bin");
  mkdirSync(bin);
  const fakeGitleaks = join(bin, "gitleaks");
  writeFileSync(fakeGitleaks, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeGitleaks, 0o755);
  return { root, cleanRoot, bin };
}

function writePolicy(root, cleanRoot) {
  writeFileSync(join(root, ".publication-policy.json"), JSON.stringify({
    version: 1,
    cleanRootCommit: cleanRoot,
    allowedPushRepositories: ["github.com/jwm-axoni/noam"],
    validationRemotes: ["no-mistakes"],
    ignoredDirectories: [".git"],
    blockedTokenHashes: [],
    legalOnlyTokenHashes: [],
    regexRules: [{
      id: "personal-email-provider",
      severity: "blocker",
      pattern: "[A-Z0-9._%+-]+@(gmail|icloud)\\.[A-Z]{2,}",
      flags: "i",
    }],
  }));
}

function runGuard(fixture, { remoteName = "origin", remoteUrl = approvedRemote, localObject = fixture.cleanRoot, remoteObject = zeroObject } = {}) {
  return spawnSync(process.execPath, [
    script,
    "--root", fixture.root,
    "--remote-name", remoteName,
    "--remote-url", remoteUrl,
  ], {
    cwd: fixture.root,
    encoding: "utf8",
    input: `refs/heads/main ${localObject} refs/heads/main ${remoteObject}\n`,
    env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` },
  });
}

test("allows clean history to the approved repository", () => {
  const fixture = createFixture();
  const result = runGuard(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Push guard passed/);
});

test("rejects a push to any other repository", () => {
  const fixture = createFixture();
  const result = runGuard(fixture, { remoteUrl: "git@github.com:jwm-axoni/not-noam.git" });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /not an approved publication repository/);
});

test("does not let a validation remote name bypass the destination check", () => {
  const fixture = createFixture();
  const result = runGuard(fixture, { remoteName: "no-mistakes", remoteUrl: "git@github.com:jwm-axoni/not-noam.git" });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /not an approved publication repository/);
});

test("allows the local validation gate under the validation remote name", () => {
  const fixture = createFixture();
  const result = runGuard(fixture, { remoteName: "no-mistakes", remoteUrl: "/tmp/gate/.no-mistakes/repos/0123456789ab.git" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("rejects a validation-gate path under any other remote name", () => {
  const fixture = createFixture();
  const result = runGuard(fixture, { remoteName: "origin", remoteUrl: "/tmp/gate/.no-mistakes/repos/0123456789ab.git" });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /not an approved publication repository/);
});

test("rejects a validation remote whose path is not the gate shape", () => {
  const fixture = createFixture();
  for (const remoteUrl of ["/tmp/.no-mistakes/repos/0123456789ab.git/../other.git", "relative/.no-mistakes/repos/0123456789ab.git", "/tmp/.no-mistakes/repos/0123.git"]) {
    const result = runGuard(fixture, { remoteName: "no-mistakes", remoteUrl });
    assert.equal(result.status, 1, `${remoteUrl}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /not an approved publication repository/);
  }
});

test("rejects unrelated history even when the destination is approved", () => {
  const fixture = createFixture();
  const tree = git(fixture.root, ["write-tree"]);
  const unrelated = git(fixture.root, ["commit-tree", tree, "-m", "Unrelated root"]);
  const result = runGuard(fixture, { localObject: unrelated });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /does not descend solely from the approved clean root/);
});

test("rejects old history grafted in by an unrelated-history merge", () => {
  const fixture = createFixture();
  const tree = git(fixture.root, ["write-tree"]);
  const oldRoot = git(fixture.root, ["commit-tree", tree, "-m", "Old repository root"]);
  const merge = git(fixture.root, ["commit-tree", tree, "-p", fixture.cleanRoot, "-p", oldRoot, "-m", "Graft old history"]);
  const result = runGuard(fixture, { localObject: merge, remoteObject: fixture.cleanRoot });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /does not descend solely from the approved clean root/);
});

test("rejects an annotated tag whose own message carries private content", () => {
  const fixture = createFixture();
  const email = ["private.person", "gmail.com"].join("@");
  // The tagger identity and annotation live on the tag object itself, so nothing in the commit range
  // that Git dereferences the tag into contains them.
  git(fixture.root, ["tag", "-a", "v0.0.1", "-m", `Cut for ${email}`, fixture.cleanRoot]);
  const tagObject = git(fixture.root, ["rev-parse", "v0.0.1"]);
  assert.equal(git(fixture.root, ["cat-file", "-t", tagObject]), "tag");

  const result = runGuard(fixture, { localObject: tagObject });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /personal-email-provider/);
  assert.doesNotMatch(result.stdout, /private\.person/);
});

test("allows an annotated tag whose message is clean", () => {
  const fixture = createFixture();
  git(fixture.root, ["tag", "-a", "v0.0.2", "-m", "Clean release", fixture.cleanRoot]);
  const result = runGuard(fixture, { localObject: git(fixture.root, ["rev-parse", "v0.0.2"]) });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Push guard passed/);
});

test("rejects private content that was committed and later removed", () => {
  const fixture = createFixture();
  const email = ["private.person", "gmail.com"].join("@");
  const temporary = join(fixture.root, "temporary.txt");
  writeFileSync(temporary, `${email}\n`);
  git(fixture.root, ["add", "temporary.txt"]);
  git(fixture.root, ["commit", "-m", "Add temporary value"]);
  unlinkSync(temporary);
  git(fixture.root, ["add", "-A"]);
  git(fixture.root, ["commit", "-m", "Remove temporary value"]);
  const tip = git(fixture.root, ["rev-parse", "HEAD"]);
  const result = runGuard(fixture, { localObject: tip, remoteObject: fixture.cleanRoot });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /personal-email-provider/);
  assert.doesNotMatch(result.stdout, /private\.person/);
});
