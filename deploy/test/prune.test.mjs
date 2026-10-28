/*
 * Retention, over names — prune.mjs. Hermetic. The real-bucket version is
 * `rehearse.sh prune`.
 *
 * Verified by violation (the cases marked ⚑): parseBackupKey matching the
 * name on its last path segment, without its prefix check and round-trip,
 * turns them red. The prefix is enforced twice — `startsWith` and the
 * round-trip through backupKey — and removing either one alone stays green,
 * measured: that is the redundancy, not a gap in the tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPrefix, backupKey, parseBackupKey, selectForDeletion } from "../backup/prune.mjs";

const DAY = 86_400_000;
const NOW = new Date("2026-10-27T03:00:00Z");
const P = "pg/";
const ago = (days) => new Date(NOW - days * DAY);
const key = (days, prefix = P) => backupKey(prefix, ago(days));
const objects = (...keys) => keys.map((k) => ({ key: k }));
const daily = (n) => objects(...Array.from({ length: n }, (_, i) => key(i)));

// --- names ---

test("a backup name round-trips to its time, to the second", () => {
  const at = new Date("2026-10-27T15:28:19Z");
  assert.equal(backupKey(P, at), "pg/vitrina-20261027T152819Z.dump.age");
  assert.equal(parseBackupKey(P, backupKey(P, at)).toISOString(), at.toISOString());
});

test("anything that is not exactly a backup name directly under the prefix parses to null", () => {
  for (const k of [
    "pg/vitrina-20261340T000000Z.dump.age", // month 13: refused, not rolled over
    "pg/vitrina-20261027T152819Z.dump.age.bak",
    "pg/vitrina-20261027T152819Z.dump",
    "pg/README",
    "pg/sub/vitrina-20261027T152819Z.dump.age",
    "pgx/vitrina-20261027T152819Z.dump.age",
    "vitrina-20261027T152819Z.dump.age",
  ]) assert.equal(parseBackupKey(P, k), null, k);
});

test("prefixes: only relative, slash-terminated ones", () => {
  for (const ok of ["pg/", "rehearsal/", "backups/pg/"]) assert.equal(assertPrefix(ok), ok);
  for (const bad of ["", "pg", "/", "/pg/", "pg//", "../pg/", "pg/../", "PG/", undefined])
    assert.throws(() => assertPrefix(bad), undefined, JSON.stringify(bad));
});

// --- selection ---

test("deletes what is older than the window, nothing newer", () => {
  const r = selectForDeletion(daily(40), P, NOW, 30, 7);
  assert.deepEqual(r.delete, daily(40).slice(31).map((o) => o.key));
});

test("never deletes the newest keepMin, however old — a failing job keeps its last good copies", () => {
  const stale = objects(...Array.from({ length: 10 }, (_, i) => key(90 + i)));
  assert.deepEqual(selectForDeletion(stale, P, NOW, 30, 7).delete, stale.slice(7).map((o) => o.key));
});

test("⚑ never selects a key outside the prefix, even when the store hands it back", () => {
  // As if the store ignored ListObjects' Prefix: ancient, well-formed names elsewhere.
  const outside = [key(400, "pgx/"), key(400, "other/"), "vitrina-20200101T000000Z.dump.age", key(400, "pg/sub/")];
  const r = selectForDeletion(objects(...outside, key(1), key(50)), P, NOW, 30, 1);
  assert.deepEqual(r.delete, [key(50)]);
  assert.deepEqual(r.ignored.sort(), [...outside].sort());
});

test("⚑ keys it ignores do not count towards keepMin", () => {
  // Otherwise three junk keys under the prefix would let it delete the last real backup.
  const junk = ["pg/README", key(0, "pg/sub/"), "pg/vitrina-latest.dump.age"];
  const r = selectForDeletion(objects(...junk, key(100)), P, NOW, 30, 1);
  assert.deepEqual(r.delete, []);
});

test("refuses nonsense rather than deleting everything", () => {
  assert.throws(() => selectForDeletion(daily(3), P, NOW, 0, 7));
  assert.throws(() => selectForDeletion(daily(3), P, NOW, Number.NaN, 7));
  assert.throws(() => selectForDeletion(daily(3), P, NOW, 30, 0));
  assert.throws(() => selectForDeletion(daily(3), "", NOW, 30, 7));
  assert.throws(() => selectForDeletion(daily(3), "pg", NOW, 30, 7));
});
