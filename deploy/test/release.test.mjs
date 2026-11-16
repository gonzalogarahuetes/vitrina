/*
 * The release process's refusals, each verified by violation. Hermetic: git
 * repositories in a temporary directory, an `origin` that is a local bare
 * repository, a stand-in `ssh`. No server, no network.  node --test deploy/test/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const TAG_CHECK = path("../release/tag-check.sh");
const LIVE = path("../release/live.sh");
const RELEASE = path("../release/release.sh");

const scratch = mkdtempSync(join(tmpdir(), "vitrina-release-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

// The owner's git configuration (signing, hooks, default branch) stays out.
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: scratch,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid",
};
let n = 0;
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
/** A clone of a fresh origin whose main has one commit; returns the clone. */
function repo() {
  const dir = join(scratch, `r${n++}`);
  spawnSync("mkdir", ["-p", dir]);
  git(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(dir, "init", "-q", "-b", "main", "work");
  const work = join(dir, "work");
  git(work, "remote", "add", "origin", "../origin.git");
  git(work, "commit", "-q", "--allow-empty", "-m", "first");
  git(work, "push", "-q", "origin", "main");
  return work;
}
const check = (cwd) => spawnSync("bash", [TAG_CHECK], { cwd, env: GIT_ENV, encoding: "utf8" });
function refuses(cwd, pattern) {
  const r = check(cwd);
  assert.notEqual(r.status, 0, `expected a refusal, got: ${r.stdout}`);
  assert.match(r.stderr, pattern);
}

// --- tag-check.sh -----------------------------------------------------------------

test("tag-check: the control — a pushed tag on origin/main, clean tree, passes and names the tag", () => {
  const w = repo();
  git(w, "tag", "-a", "v1.2.3", "-m", "v1.2.3");
  git(w, "push", "-q", "origin", "v1.2.3");
  const r = check(w);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `v1.2.3 ${git(w, "rev-parse", "--short=12", "HEAD")}`);
});

test("tag-check: a lightweight tag passes too", () => {
  const w = repo();
  git(w, "tag", "v0.1.0");
  git(w, "push", "-q", "origin", "v0.1.0");
  assert.equal(check(w).status, 0);
});

test("tag-check refuses an untagged commit", () => {
  const w = repo();
  refuses(w, /has no vMAJOR\.MINOR\.PATCH tag/);
});

for (const bad of ["1.2.3", "v1.2", "v1.2.3-rc1", "v01.2.3", "release-1"]) {
  test(`tag-check refuses a tag not of the form vMAJOR.MINOR.PATCH: ${bad}`, () => {
    const w = repo();
    git(w, "tag", bad);
    git(w, "push", "-q", "origin", bad);
    refuses(w, /has no vMAJOR\.MINOR\.PATCH tag/);
  });
}

test("tag-check refuses a tag not on main (a pushed branch, not merged)", () => {
  const w = repo();
  git(w, "checkout", "-q", "-b", "feature");
  git(w, "commit", "-q", "--allow-empty", "-m", "feature work");
  git(w, "push", "-q", "origin", "feature");
  git(w, "tag", "v1.0.0");
  git(w, "push", "-q", "origin", "v1.0.0");
  refuses(w, /not on origin\/main/);
});

test("tag-check refuses when origin/main moved away (force-push), whatever the stale local copy says", () => {
  const w = repo();
  git(w, "commit", "-q", "--allow-empty", "-m", "to be dropped");
  git(w, "push", "-q", "origin", "main");
  git(w, "tag", "v1.0.0");
  git(w, "push", "-q", "origin", "v1.0.0");
  // Another machine rewrites main without that commit; this clone has not fetched.
  const other = join(w, "..", "other");
  git(join(w, ".."), "clone", "-q", "origin.git", "other");
  git(other, "reset", "-q", "--hard", "HEAD~1");
  git(other, "push", "-q", "--force", "origin", "main");
  refuses(w, /not on origin\/main/);
});

test("tag-check refuses a dirty tree: a modified tracked file", () => {
  const w = repo();
  writeFileSync(join(w, "f.txt"), "a\n");
  git(w, "add", "f.txt");
  git(w, "commit", "-q", "-m", "f");
  git(w, "push", "-q", "origin", "main");
  git(w, "tag", "v1.0.0");
  git(w, "push", "-q", "origin", "v1.0.0");
  assert.equal(check(w).status, 0); // control
  writeFileSync(join(w, "f.txt"), "b\n");
  refuses(w, /not clean/);
});

test("tag-check refuses a dirty tree: an untracked file", () => {
  const w = repo();
  git(w, "tag", "v1.0.0");
  git(w, "push", "-q", "origin", "v1.0.0");
  writeFileSync(join(w, "stray.txt"), "x\n");
  refuses(w, /not clean/);
});

test("tag-check refuses a tag that exists only locally", () => {
  const w = repo();
  git(w, "tag", "v1.0.0");
  refuses(w, /origin has no tag v1\.0\.0/);
});

test("tag-check refuses a tag that origin has on another commit (a moved tag)", () => {
  const w = repo();
  git(w, "tag", "v1.0.0");
  git(w, "push", "-q", "origin", "v1.0.0");
  git(w, "commit", "-q", "--allow-empty", "-m", "second");
  git(w, "push", "-q", "origin", "main");
  git(w, "tag", "-f", "v1.0.0"); // moved here, not on origin
  refuses(w, /tags are never moved/);
});

test("tag-check refuses a commit carrying two version tags", () => {
  const w = repo();
  for (const t of ["v1.0.0", "v1.0.1"]) {
    git(w, "tag", t);
    git(w, "push", "-q", "origin", t);
  }
  refuses(w, /more than one version tag/);
});

// --- live.sh, against a stand-in ssh that prints the two links --------------------

function live(apiLink, appLink) {
  const bin = mkdtempSync(join(scratch, "bin-"));
  const ssh = join(bin, "ssh");
  writeFileSync(ssh, `#!/usr/bin/env bash\nprintf '%s\\n%s\\n' ${JSON.stringify(apiLink)} ${JSON.stringify(appLink)}\n`);
  chmodSync(ssh, 0o755);
  return spawnSync("bash", [LIVE, "192.0.2.1", "admin"], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: scratch },
    encoding: "utf8",
  });
}
const ID = "20261113T101500Z-v1.4.0-0123456789ab";

test("live.sh: the control — both links on one tagged release prints its tag", () => {
  const r = live(`/opt/vitrina/api/releases/${ID}/packages/server`, `/opt/vitrina/app/releases/${ID}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "v1.4.0\n");
  assert.match(r.stderr, new RegExp(ID));
});

test("live.sh: a release from before tags prints 'untagged'", () => {
  const old = "20261028T154900Z-0123456789ab";
  const r = live(`/opt/vitrina/api/releases/${old}/packages/server`, `/opt/vitrina/app/releases/${old}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "untagged\n");
});

test("live.sh refuses when the API and the app are on different releases", () => {
  const other = "20261112T090000Z-v1.3.0-ba9876543210";
  const r = live(`/opt/vitrina/api/releases/${ID}/packages/server`, `/opt/vitrina/app/releases/${other}`);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /different|but the app is/);
});

test("live.sh refuses when nothing is live", () => {
  const r = live("none", "none");
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
});

// --- release.sh ---------------------------------------------------------------------

test("release.sh refuses a release name without a tag, before anything else", () => {
  const r = spawnSync("bash", [RELEASE, "20261113T101500Z-0123456789ab", "a", "b", "c", "d", "e"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a release id/);
});

test("release.sh: the control — a tagged release name passes the name check (and stops at sudo)", () => {
  const r = spawnSync("bash", [RELEASE, ID, "a", "b", "c", "d", "e"], { encoding: "utf8" });
  if (process.getuid?.() === 0) return; // as root it would go on; CI and the Mac are not root
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /run with sudo/);
});

test("release.sh's production API host is site.mjs's default", async () => {
  const fromRelease = /^PRODUCTION_API_HOST=(\S+)$/m.exec(readFileSync(RELEASE, "utf8"))?.[1];
  const site = readFileSync(path("../release/site.mjs"), "utf8");
  const fromSite = /host\("VITRINA_API_HOST", "([^"]+)"\)/.exec(site)?.[1];
  assert.ok(fromRelease && fromSite);
  assert.equal(fromRelease, fromSite);
});
