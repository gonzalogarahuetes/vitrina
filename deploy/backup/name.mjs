/*
 * The backup key for a moment, from prune.mjs — the one place the name is
 * written, so what backup.sh uploads is what prune can read the age of.
 *
 *   node name.mjs <prefix> [iso-date]     default: now
 */

import { backupKey } from "./prune.mjs";

const [prefix, iso] = process.argv.slice(2);
try {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`not a date: ${iso}`);
  console.log(backupKey(prefix, date));
} catch (e) {
  console.error(`name.mjs: ${e.message}`);
  process.exit(2);
}
