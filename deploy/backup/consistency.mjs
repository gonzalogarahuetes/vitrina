/*
 * Every live `ready` media row's two objects exist in the bucket, at the
 * lengths §9.7 confirmed. The database backup holds no photos; it only points
 * at them, and this is the check that the pointers still land.
 *
 *   node --env-file=<the API's env> deploy/backup/consistency.mjs [--hide-missing]
 *
 * Reads DATABASE_URL and the S3_* / AWS_* names the API reads, and goes
 * through the API's own store and key derivation (packages/server/dist), so
 * the strings checked are the strings served.
 *
 * Read-only unless --hide-missing (restore.sh passes it on request): then
 * rows with an absent object get `removed_at`, so the API omits them instead
 * of answering 500, and are listed. The usual cause is a photo removed (§9.11)
 * after the backup was taken: `ready` in the restored row, gone from the bucket.
 */

import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { checkReadyMedia } from "./media-check.mjs";

const DIST = new URL("../../packages/server/dist/", import.meta.url);
if (!existsSync(new URL("composition-root.js", DIST))) {
  console.error("consistency.mjs: packages/server/dist is missing — build the server first");
  process.exit(2);
}
const { buildComposition } = await import(new URL("composition-root.js", DIST));
const { objectKey } = await import(new URL("domain/media/object-key.js", DIST));

const NAMES = ["DATABASE_URL", "S3_ENDPOINT", "S3_BUCKET", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const missingEnv = NAMES.filter((n) => !process.env[n]);
if (missingEnv.length) {
  console.error(`consistency.mjs: missing ${missingEnv.join(", ")}`);
  process.exit(2);
}
const hideMissing = process.argv.includes("--hide-missing");

// The secret is irrelevant to a HEAD; a random one keeps this from needing the real one.
const { adapters } = buildComposition({
  serverSecret: randomBytes(32),
  databaseUrl: process.env.DATABASE_URL,
  storage: {
    endpoint: new URL(process.env.S3_ENDPOINT).origin,
    region: process.env.AWS_DEFAULT_REGION,
    bucket: process.env.S3_BUCKET,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const { pool, objectStore } = adapters;

try {
  const result = await checkReadyMedia(
    {
      listReady: async () =>
        (
          await pool.query(
            "SELECT id::text AS id, byte_size AS \"byteSize\" FROM media WHERE status = 'ready' AND removed_at IS NULL ORDER BY created_at",
          )
        ).rows,
      head: (id, variant) => objectStore.head(objectKey(id, variant)),
      // The same guard as the selection, so a row that changed in between is untouched;
      // COALESCE as the repository's own hide, so a first removed_at is never moved.
      hide: async (ids) =>
        (
          await pool.query(
            "UPDATE media SET removed_at = COALESCE(removed_at, now()) WHERE id = ANY($1::uuid[]) AND status = 'ready' AND removed_at IS NULL RETURNING id::text AS id",
            [ids],
          )
        ).rows.map((r) => r.id),
    },
    { hideMissing },
  );
  // After the check, so a --hide-missing run reports the state it left behind.
  const { rows: byStatus } = await pool.query(
    "SELECT status, (removed_at IS NOT NULL) AS removed, count(*)::int AS n FROM media GROUP BY 1, 2 ORDER BY 1, 2",
  );

  console.log(`media by status: ${byStatus.map((r) => `${r.status}${r.removed ? "(removed)" : ""}=${r.n}`).join(" ") || "none"}`);
  console.log(`ready rows checked: ${result.checked}, missing: ${result.missing.length}, length mismatches: ${result.mismatched.length}`);
  for (const m of result.missing)
    console.log(`  ${result.hidden.includes(m.id) ? "HIDDEN " : "MISSING"} ${m.id} (absent: ${m.absent.join(", ")})`);
  for (const m of result.mismatched) console.log(`  MISMATCH ${m.id}: objects total ${m.objects} bytes, row says ${m.row}`);

  const unhidden = result.missing.filter((m) => !result.hidden.includes(m.id));
  if (unhidden.length || result.mismatched.length) process.exitCode = 1;
  if (result.checked === 0 && !hideMissing) {
    console.log("  (no ready rows: nothing was proved — upload photos first)");
    process.exitCode = 1;
  }
} finally {
  await pool.end();
  adapters.client.destroy();
}
