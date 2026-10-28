/*
 * The recovery REHEARSAL only: copy every object under media/ from the
 * production media bucket into the rehearsal's own, so the restored database
 * points at photos that exist — without the rehearsal server ever holding
 * production credentials. Production is only listed and read: this file sends
 * it ListObjectsV2 and GetObject, nothing else.
 *
 *   node deploy/backup/copy-media.mjs <source.env> <target.env>
 *
 * Each file holds the API's names (S3_ENDPOINT, S3_BUCKET, AWS_DEFAULT_REGION,
 * AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY). Refuses when both name the same
 * bucket, and when the target already holds media/ objects.
 * In a real recovery nothing is copied: the new server uses the production
 * media bucket itself.
 */

import { readFileSync } from "node:fs";
import {
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const NAMES = ["S3_ENDPOINT", "S3_BUCKET", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const die = (m) => (console.error(`copy-media: ${m}`), process.exit(2));

function load(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    die(`cannot read ${path}`);
  }
  const env = Object.fromEntries(
    text
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
  const missing = NAMES.filter((n) => !env[n]);
  if (missing.length) die(`${path} lacks ${missing.join(", ")}`);
  if (!env.S3_ENDPOINT.startsWith("https://")) die(`${path}: S3_ENDPOINT must be https`);
  return env;
}
const client = (e) =>
  new S3Client({
    endpoint: new URL(e.S3_ENDPOINT).origin,
    region: e.AWS_DEFAULT_REGION,
    credentials: { accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY },
    forcePathStyle: true,
  });

const [sourcePath, targetPath] = process.argv.slice(2);
if (!sourcePath || !targetPath) die("usage: copy-media.mjs <source.env> <target.env>");
const source = load(sourcePath);
const target = load(targetPath);
if (source.S3_BUCKET === target.S3_BUCKET) die(`source and target are both ${source.S3_BUCKET}`);

const from = client(source);
const to = client(target);
await to.send(new HeadBucketCommand({ Bucket: target.S3_BUCKET })); // the target exists and these keys open it

async function* keys(c, Bucket) {
  let ContinuationToken;
  do {
    const page = await c.send(new ListObjectsV2Command({ Bucket, Prefix: "media/", ContinuationToken }));
    for (const o of page.Contents ?? []) yield o.Key;
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

for await (const k of keys(to, target.S3_BUCKET)) die(`${target.S3_BUCKET} already holds ${k}; use an empty bucket`);

let count = 0;
let bytes = 0;
for await (const Key of keys(from, source.S3_BUCKET)) {
  const object = await from.send(new GetObjectCommand({ Bucket: source.S3_BUCKET, Key }));
  await to.send(
    new PutObjectCommand({
      Bucket: target.S3_BUCKET,
      Key,
      Body: object.Body,
      ContentLength: object.ContentLength,
      ContentType: "application/octet-stream",
    }),
  );
  count++;
  bytes += object.ContentLength ?? 0;
}
console.log(`copied ${count} objects (${bytes} bytes) from ${source.S3_BUCKET} to ${target.S3_BUCKET}; the source was only read`);
from.destroy();
to.destroy();
