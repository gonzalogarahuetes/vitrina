/*
 * agekey.sh, each refusal by violation. A fake age-keygen on PATH stands in
 * for age (not installed in CI): it knows one key and its public key.
 * Hermetic: the key text arrives on stdin, never the clipboard.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const AGEKEY = fileURLToPath(new URL("../backup/agekey.sh", import.meta.url));
const B32 = "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L";
const SECRET = "AGE-SECRET-KEY-1" + B32.repeat(2).slice(0, 58);
const OTHER = "AGE-SECRET-KEY-1" + B32.repeat(2).slice(1, 59);
const PUBLIC = "age1" + B32.toLowerCase().repeat(2).slice(0, 58);
const WRONG_PUBLIC = "age1" + B32.toLowerCase().repeat(2).slice(2, 60);

let dir;
let bin;
let out;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "agekey-"));
  bin = join(dir, "bin");
  out = join(dir, "vitrina-backup.agekey");
  spawnSync("mkdir", [bin]);
  writeFileSync(
    join(bin, "age-keygen"),
    `#!/usr/bin/env bash\n[[ "$1" == -y && "$(cat "$2")" == "${SECRET}" ]] && echo ${PUBLIC} && exit 0\necho "age-keygen: bad key" >&2; exit 1\n`,
  );
  chmodSync(join(bin, "age-keygen"), 0o755);
});
after(() => rmSync(dir, { recursive: true, force: true }));

function run(input) {
  return spawnSync("bash", [AGEKEY], {
    input,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, AGE_IDENTITY_FILE: out },
  });
}
const clean = () => rmSync(out, { force: true });

test("keeps only the key line from a messy paste, mode 600, and prints the public key, not the secret", () => {
  clean();
  const r = run(`Vitrina backup key (age)\n  # created: 2026-08-01T00:00:00Z\n  # public key: ${PUBLIC}\n  ${SECRET}  \n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, "utf8"), `${SECRET}\n`);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.match(r.stdout, new RegExp(PUBLIC));
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
});

test("refuses an existing file, leaving it untouched", () => {
  clean();
  writeFileSync(out, "keep me\n");
  const r = run(`${SECRET}\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exists; rm it first/);
  assert.equal(readFileSync(out, "utf8"), "keep me\n");
});

test("refuses a paste with no key", () => {
  clean();
  const r = run(`# public key: ${PUBLIC}\nVitrina backup key (age)\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /found 0 AGE-SECRET-KEY/);
  assert.ok(!existsSync(out));
});

test("refuses a paste with two different keys", () => {
  clean();
  const r = run(`${SECRET}\n${OTHER}\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /found 2 AGE-SECRET-KEY/);
  assert.ok(!existsSync(out));
});

test("refuses a key whose public key is not the one pasted with it", () => {
  clean();
  const r = run(`# public key: ${WRONG_PUBLIC}\n${SECRET}\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing written/);
  assert.ok(!existsSync(out));
});

test("refuses a key age-keygen rejects, and removes it", () => {
  clean();
  const r = run(`${OTHER}\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /age-keygen rejects the key/);
  assert.ok(!existsSync(out));
});
