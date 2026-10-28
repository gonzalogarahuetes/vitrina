/**
 * Backup names, and which backups retention deletes. Pure, so both are
 * tested without a bucket (deploy/test/prune.test.mjs).
 *
 * A backup's age is the timestamp in its NAME, written by backup.sh through
 * backupKey() below — not the store's LastModified, which a copy or a
 * re-upload resets and which nothing can set to the past.
 *
 * What prune may delete is narrow by construction: a key that is exactly
 * `<prefix>vitrina-YYYYMMDDTHHMMSSZ.dump.age`, directly under the prefix.
 * Anything else — outside the prefix, nested below it, or under it with any
 * other name — is never selected and never counted, even if the store hands
 * it back (a store that ignores ListObjects' Prefix is the case this guards).
 */

const NAME = /^vitrina-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump\.age$/;

/** The only prefixes prune and backup accept: non-empty, relative, ending in "/". */
export function assertPrefix(prefix) {
  if (typeof prefix !== "string" || !/^[a-z0-9][a-z0-9._-]*\/(?:[a-z0-9][a-z0-9._-]*\/)*$/.test(prefix) || prefix.includes("..")) {
    throw new Error(`backup prefix must look like "pg/": lowercase segments, each ending in "/" — got ${JSON.stringify(prefix)}`);
  }
  return prefix;
}

/** The key backup.sh writes for a backup taken at `date`. */
export function backupKey(prefix, date) {
  const s = date.toISOString(); // 2026-10-27T15:28:19.123Z
  return `${assertPrefix(prefix)}vitrina-${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}T${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}Z.dump.age`;
}

/** The backup's time, or null for any key prune must not touch. */
export function parseBackupKey(prefix, key) {
  if (typeof key !== "string" || !key.startsWith(prefix)) return null;
  const m = NAME.exec(key.slice(prefix.length)); // anchored, no "/": nothing nested matches
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Round-trip, so 20261340T… is refused rather than rolled into next year.
  return backupKey(prefix, date) === key ? date : null;
}

/**
 * Older than `retentionDays` goes, EXCEPT the newest `keepMin` backups, which
 * stay whatever their age: a backup job that has been failing for a month
 * must not end with retention deleting the last good copy.
 *
 * @param {{ key: string }[]} objects  as listed; anything not a backup is ignored
 * @returns {{ delete: string[], ignored: string[] }}
 */
export function selectForDeletion(objects, prefix, now, retentionDays, keepMin) {
  assertPrefix(prefix);
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error(`retentionDays must be a positive integer: ${retentionDays}`);
  if (!Number.isInteger(keepMin) || keepMin < 1) throw new Error(`keepMin must be a positive integer: ${keepMin}`);
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const backups = [];
  const ignored = [];
  for (const { key } of objects) {
    const at = parseBackupKey(prefix, key);
    if (at) backups.push({ key, at });
    else ignored.push(key);
  }
  return {
    delete: backups
      .sort((a, b) => b.at - a.at)
      .slice(keepMin)
      .filter((b) => b.at.getTime() < cutoff)
      .map((b) => b.key),
    ignored,
  };
}
