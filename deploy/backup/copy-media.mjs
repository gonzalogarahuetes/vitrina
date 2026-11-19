/*
 * The recovery REHEARSAL and staging only: copy every object under media/ from
 * the production media bucket into the rehearsal's own, so the restored
 * database points at photos that exist — without the rehearsal server ever
 * holding production credentials. The source is only listed and read: this
 * file sends it ListObjectsV2 and GetObject, nothing else.
 *
 *   node deploy/backup/copy-media.mjs <source.env> <target.env>
 *
 * Each file holds the API's names (S3_ENDPOINT, S3_BUCKET, AWS_DEFAULT_REGION,
 * AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY). Refuses, before any request:
 *   - a target that is production's media or backup bucket (bucket-env.mjs),
 *     whatever it holds — so swapped arguments write nothing;
 *   - source and target naming the same bucket.
 * Then refuses a non-empty target unless it is an earlier partial copy: every
 * object in it (any prefix) also in the source at the same size. Such a target
 * is resumed: only the missing objects are copied. Anything else in it — an
 * object the source lacks, or a size that differs — is refused, untouched.
 * A 403 (new credentials) is retried for a bounded time, then fails naming
 * the bucket. Run it again after any failure: it resumes.
 * In a real recovery nothing is copied: the new server uses the production
 * media bucket itself.
 */

import { GetObjectCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { client, dier, listAll, load, refuseProduction, retrier } from "./bucket-env.mjs";

const die = dier("copy-media");
const [sourcePath, targetPath] = process.argv.slice(2);
if (!sourcePath || !targetPath) die("usage: copy-media.mjs <source.env> <target.env>");
const source = load(sourcePath, die);
const target = load(targetPath, die);
refuseProduction(target, "target", die);
if (source.S3_BUCKET === target.S3_BUCKET) die(`source and target are both ${source.S3_BUCKET}`);
const withRetry = retrier(die);

const from = client(source);
const to = client(target);
const S = ["source", source.S3_BUCKET];
const T = ["target", target.S3_BUCKET];

// The target exists and these keys open it.
await withRetry(...T, "HeadBucket", () => to.send(new HeadBucketCommand({ Bucket: target.S3_BUCKET })));
const present = await withRetry(...T, "list", () => listAll(to, target.S3_BUCKET, undefined));
const wanted = await withRetry(...S, "list", () => listAll(from, source.S3_BUCKET, "media/"));

const show = (keys) => keys.slice(0, 3).join(", ") + (keys.length > 3 ? `, … (${keys.length} in all)` : "");
const foreign = [...present.keys()].filter((k) => !wanted.has(k));
if (foreign.length)
  die(`${target.S3_BUCKET} holds what ${source.S3_BUCKET}'s media/ does not: ${show(foreign)}; use an empty bucket`);
const differ = [...present].filter(([k, size]) => wanted.get(k) !== size).map(([k]) => k);
if (differ.length) die(`${target.S3_BUCKET} holds objects at a different size from the source: ${show(differ)}; use an empty bucket`);
if (present.size) console.log(`resuming: ${present.size} of ${wanted.size} objects already in ${target.S3_BUCKET} at the same size`);

let count = 0;
let bytes = 0;
for (const [Key, size] of wanted) {
  if (present.has(Key)) continue;
  // Get and put repeat together: a body stream cannot be sent twice.
  await withRetry(...T, `copy ${Key}`, async () => {
    const object = await withRetry(...S, `get ${Key}`, () =>
      from.send(new GetObjectCommand({ Bucket: source.S3_BUCKET, Key })),
    );
    try {
      await to.send(
        new PutObjectCommand({
          Bucket: target.S3_BUCKET,
          Key,
          Body: object.Body,
          ContentLength: object.ContentLength,
          ContentType: "application/octet-stream",
        }),
      );
    } catch (err) {
      object.Body?.destroy?.();
      throw err;
    }
  });
  count++;
  bytes += size;
}
console.log(
  `copied ${count} objects (${bytes} bytes) from ${source.S3_BUCKET} to ${target.S3_BUCKET}` +
    (present.size ? `, ${present.size} already there` : "") +
    "; the source was only read",
);
from.destroy();
to.destroy();
