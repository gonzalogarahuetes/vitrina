/*
 * Rehearsal and staging teardown: delete every object in a throwaway bucket,
 * because Hetzner deletes only empty buckets.
 *
 *   node deploy/backup/empty-bucket.mjs <bucket.env> <bucket name>
 *
 * The bucket's name is typed out as well as read from the file, and must
 * match. Refuses production's media and backup buckets by name, whatever they
 * hold (bucket-env.mjs), before any request. One DeleteObject per object.
 */

import { DeleteObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { client, dier, listAll, load, refuseProduction, retrier } from "./bucket-env.mjs";

const die = dier("empty-bucket");
const [path, named] = process.argv.slice(2);
if (!path || !named) die("usage: empty-bucket.mjs <bucket.env> <bucket name>");
const env = load(path, die);
refuseProduction(env, "bucket", die);
if (named !== env.S3_BUCKET) die(`${path} names ${env.S3_BUCKET}, not ${named}; nothing deleted`);
const withRetry = retrier(die);
const c = client(env);
const B = ["throwaway", env.S3_BUCKET];

await withRetry(...B, "HeadBucket", () => c.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET })));
let n = 0;
// Listed again after each pass, until empty: a listing can lag the deletes.
for (let pass = 1; ; pass++) {
  const keys = await withRetry(...B, "list", () => listAll(c, env.S3_BUCKET, undefined));
  if (!keys.size) break;
  if (pass > 3) die(`${env.S3_BUCKET} still lists ${keys.size} objects after 3 passes; run it again in a minute`, 1);
  for (const Key of keys.keys()) {
    await withRetry(...B, `delete ${Key}`, () => c.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key })));
    n++;
  }
}
console.log(`deleted ${n} objects; ${env.S3_BUCKET} is empty`);
c.destroy();
