/*
 * secret-scan.mjs against a throwaway git repository with secrets planted in
 * it — the violation the real scan can only report the absence of.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCAN = fileURLToPath(new URL("../server/secret-scan.mjs", import.meta.url));
const spec = (name, value) => `${name}:${value.length}:${createHash("sha256").update(value).digest("hex")}`;

const IN_FILE = randomBytes(32).toString("base64url"); // 43 chars, a server secret's shape
const IN_HISTORY = randomBytes(30).toString("base64"); // 40 chars, a storage key's shape
const IN_URL = randomBytes(32).toString("base64url");
const NOWHERE = randomBytes(32).toString("base64url");

let repo;
const git = (...args) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};
const scan = (...specs) => spawnSync(process.execPath, [SCAN, repo, ...specs], { encoding: "utf8" });

before(() => {
  repo = mkdtempSync(join(tmpdir(), "secret-scan-"));
  git("init", "-q");
  git("config", "user.email", "t@x.es");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "config.env"), `VITRINA_SERVER_SECRET=${IN_FILE}\n`);
  writeFileSync(join(repo, "notes.md"), `endpoint https://bucket.example/${IN_URL}?x=1\n`);
  writeFileSync(join(repo, "old.env"), `AWS_SECRET_ACCESS_KEY=${IN_HISTORY}\n`);
  git("add", ".");
  git("commit", "-qm", "planted");
  unlinkSync(join(repo, "old.env"));
  git("add", "-A");
  git("commit", "-qm", "removed again — still in history");
});

after(() => rmSync(repo, { recursive: true, force: true }));

test("finds a secret in a tracked file", () => {
  const r = scan(spec("VITRINA_SERVER_SECRET", IN_FILE));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL VITRINA_SERVER_SECRET is in the repository: config\.env/);
});

test("finds a secret that was committed and later removed", () => {
  const r = scan(spec("AWS_SECRET_ACCESS_KEY", IN_HISTORY));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL AWS_SECRET_ACCESS_KEY is in the repository: history [0-9a-f]{12}/);
});

test("finds a secret glued inside a longer string (a URL path)", () => {
  const r = scan(spec("IN_URL", IN_URL));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /notes\.md/);
});

test("passes for a secret that is nowhere, and never prints a value", () => {
  const r = scan(spec("VITRINA_SERVER_SECRET", NOWHERE));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^PASS VITRINA_SERVER_SECRET/m);
  for (const v of [IN_FILE, IN_HISTORY, IN_URL, NOWHERE]) assert.doesNotMatch(r.stdout + r.stderr, new RegExp(v.replace(/[+/]/g, "\\$&")));
});

test("refuses a malformed fingerprint rather than passing", () => {
  assert.equal(scan("VITRINA_SERVER_SECRET:43:nothex").status, 2);
  assert.equal(scan().status, 2);
});
