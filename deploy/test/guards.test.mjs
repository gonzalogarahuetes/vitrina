/*
 * deploy/'s refusals, each verified by violation. Retention: prune.test.mjs.
 * Hermetic: no Docker, no bucket, no database — every case refuses before
 * reaching one.  node --test deploy/test/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const BACKUP = path("../backup/backup.sh");
const ACCEPTANCE = path("../storage/acceptance.mjs");

// A well-formed recipient (age's own test-vector shape: 58 bech32 characters).
const RECIPIENT = "age1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(2).slice(0, 58);
const VALID = {
  PATH: process.env.PATH,
  DATABASE_URL: "postgres://u@127.0.0.1:1/x",
  AGE_RECIPIENT: RECIPIENT,
  MEDIA_BUCKET: "vitrina-media",
  BACKUP_BUCKET: "vitrina-backups",
  BACKUP_S3_ENDPOINT: "http://localhost:1",
  BACKUP_S3_REGION: "x",
  BACKUP_AWS_ACCESS_KEY_ID: "x",
  BACKUP_AWS_SECRET_ACCESS_KEY: "x",
  RETENTION_DAYS: "30",
  PG_DUMP: "false", // stops the run right after the guards, whatever is installed
};
const backup = (env) => spawnSync("bash", [BACKUP], { env, encoding: "utf8" });

test("backup.sh: the control — a valid environment passes every guard", () => {
  const r = backup(VALID);
  assert.notEqual(r.status, 0); // PG_DUMP=false, or no age installed
  assert.doesNotMatch(r.stderr, /refusing|missing|must be|is not an age/);
});

for (const [name, env, pattern] of [
  ["the server secret in its environment", { VITRINA_SERVER_SECRET: "x".repeat(43) }, /must not hold it/],
  ["an age private key as the recipient", { AGE_RECIPIENT: "AGE-SECRET-KEY-1" + "Q".repeat(58) }, /PRIVATE key/],
  ["a recipient that is not one", { AGE_RECIPIENT: "age1short" }, /not an age X25519 recipient/],
  ["the media bucket as the backup bucket", { BACKUP_BUCKET: "vitrina-media" }, /separate one/],
  ["no retention", { RETENTION_DAYS: "" }, /missing RETENTION_DAYS/],
  ["a retention of zero", { RETENTION_DAYS: "0" }, /positive integer/],
  ["a prefix without its slash (it would match pg-other/ too)", { BACKUP_PREFIX: "pg" }, /invalid BACKUP_PREFIX/],
]) {
  test(`backup.sh refuses ${name}`, () => {
    const r = backup({ ...VALID, ...env });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, pattern);
  });
}

const RESTORE = path("../backup/restore.sh");
const RESTORE_ENV = {
  PATH: process.env.PATH,
  TARGET_DATABASE_URL: "postgres://u@127.0.0.1:1/x",
  AGE_IDENTITY: RESTORE, // any readable file; nothing gets that far
  BACKUP_BUCKET: "b", BACKUP_S3_ENDPOINT: "http://localhost:1", BACKUP_S3_REGION: "x",
  BACKUP_AWS_ACCESS_KEY_ID: "x", BACKUP_AWS_SECRET_ACCESS_KEY: "x",
};

test("restore.sh --hide-missing requires the media bucket's names; without the flag it does not", () => {
  const flagged = spawnSync("bash", [RESTORE, "--hide-missing"], { env: RESTORE_ENV, encoding: "utf8" });
  assert.match(flagged.stderr, /missing S3_ENDPOINT/);
  const plain = spawnSync("bash", [RESTORE], { env: RESTORE_ENV, encoding: "utf8" });
  assert.doesNotMatch(plain.stderr, /missing S3_ENDPOINT/);
});

test("restore.sh refuses an unknown option rather than reading it as a key", () => {
  const r = spawnSync("bash", [RESTORE, "--hide-mising"], { env: RESTORE_ENV, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown option/);
});

test("acceptance.mjs refuses an env file inside the repository", () => {
  const r = spawnSync(process.execPath, [`--env-file=${path("../storage/storage.env.example")}`, ACCEPTANCE], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /inside the repository/);
});

test("acceptance.mjs refuses a plain-http endpoint", () => {
  const env = { PATH: process.env.PATH, S3_ENDPOINT: "http://localhost:8333", S3_BUCKET: "b", AWS_DEFAULT_REGION: "r", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" };
  const r = spawnSync(process.execPath, [ACCEPTANCE], { env, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be https/);
});
