/*
 * Phase 1 — brief §12's hosting acceptance condition, against the real
 * Hetzner bucket, from the owner's Mac. Nothing else in deploy/ may depend on
 * Hetzner until this is green. Any red is a stop: the fallback provider is
 * brief §12's decision and the owner's, not this script's.
 *
 *   pnpm --filter @vitrina/server build
 *   node --env-file="$HOME/.vitrina/storage.env" deploy/storage/acceptance.mjs
 *
 * The env file holds the server's own variable names (storage.env.example)
 * and lives OUTSIDE the repository; the script refuses one inside it.
 *
 * Everything that the relay itself does goes through the relay's own code —
 * buildComposition's S3Client, createObjectStore, verifyBucket — so the
 * assertions hold on the path production takes (api-sketch §9.7's rule:
 * assert a guarantee on the path this system actually takes). Only what the
 * relay never does (versioning, presigning, CacheControl metadata) uses the
 * SDK directly.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const DIST = new URL("../../packages/server/dist/", import.meta.url);

// --- guards, before any request -------------------------------------------

/*
 * The script's own control, run once before trusting a green against Hetzner:
 *   ACCEPTANCE_SELF_TEST=1 node --env-file=.env.example deploy/storage/acceptance.mjs
 * against `pnpm infra:up`. SeaweedFS creates a bucket on its first PutObject
 * (measured; see verifyBucket), so the misspelled-bucket test MUST go red
 * there. If it is green on SeaweedFS, it proves nothing on Hetzner.
 */
const selfTest = process.env.ACCEPTANCE_SELF_TEST === "1";
const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(process.env.S3_ENDPOINT ?? "");

for (const arg of process.execArgv) {
  const m = /^--env-file(?:-if-exists)?=(.+)$/.exec(arg);
  if (!m || (selfTest && local)) continue; // .env.example's values are public and local
  const path = realpathSync(resolve(m[1]));
  if (path.startsWith(realpathSync(REPO).replace(/\/?$/, sep))) {
    console.error(`refusing: ${m[1]} is inside the repository. Real credentials live outside it.`);
    process.exit(2);
  }
}

const NAMES = ["S3_ENDPOINT", "S3_BUCKET", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const missing = NAMES.filter((n) => !process.env[n]);
if (missing.length) {
  console.error(`missing: ${missing.join(", ")} (see deploy/storage/storage.env.example)`);
  process.exit(2);
}
if (!process.env.S3_ENDPOINT.startsWith("https://") && !(selfTest && local)) {
  console.error("S3_ENDPOINT must be https — this is the real provider, not SeaweedFS");
  process.exit(2);
}
if (!existsSync(new URL("composition-root.js", DIST))) {
  console.error("packages/server/dist is missing — `pnpm --filter @vitrina/server build` first");
  process.exit(2);
}

const { buildComposition } = await import(new URL("composition-root.js", DIST));
const { createObjectStore, verifyBucket } = await import(new URL("adapters/driven/s3/object-store.js", DIST));

const storage = {
  endpoint: new URL(process.env.S3_ENDPOINT).origin,
  region: process.env.AWS_DEFAULT_REGION,
  bucket: process.env.S3_BUCKET,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

// The relay's own client and store. The pool is never queried; pg connects lazily.
const { adapters } = buildComposition({
  serverSecret: randomBytes(32),
  databaseUrl: "postgres://unused@127.0.0.1:1/unused",
  storage,
});
const { client: s3, objectStore: store } = adapters;

// --- fixtures ----------------------------------------------------------------

const RUN = randomBytes(8).toString("hex");
const PREFIX = `acceptance/${RUN}`; // opaque, no filenames (CLAUDE.md)
const written = new Set();

/** The envelope's shape at the transport layer: 256 KiB chunks, a partial last one. */
const CHUNK = 256 * 1024;
const SIZE = 2 * CHUNK + 1024;
const BODY = randomBytes(SIZE);
const KEY = `${PREFIX}/asset`;

const streamOf = (buf) => Readable.from([buf.subarray(0, 100_000), buf.subarray(100_000)]);
const drain = async (readable) => {
  const parts = [];
  for await (const p of readable) parts.push(p);
  return Buffer.concat(parts);
};
const putViaRelay = async (key, buf) => {
  written.add(key);
  await store.put(key, streamOf(buf), buf.length);
};

after(async () => {
  for (const key of written) await s3.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key })).catch(() => {});
  const leftovers = [];
  for (const key of written) if ((await store.head(key).catch(() => "unknown")) !== null) leftovers.push(key);
  if (leftovers.length) console.error(`CLEANUP INCOMPLETE — delete by hand: ${leftovers.join(" ")}`);
  await adapters.pool.end();
  s3.destroy();
});

// --- 0. the boot check -------------------------------------------------------

test("the relay's boot check passes on the real bucket", async () => {
  await verifyBucket(s3, storage.bucket, storage.endpoint);
});

// --- 1. write, then read a byte range -----------------------------------------

test("a streamed PutObject through the relay's adapter lands, whole", async () => {
  // A Readable with a ContentLength is exactly object-store.ts's put. If the
  // SDK's default integrity framing (aws-chunked + trailing checksum) is not
  // accepted by the provider, this is where it shows.
  await putViaRelay(KEY, BODY);
  const head = await store.head(KEY);
  assert.deepEqual(head, { length: SIZE });
  const whole = await store.get(KEY);
  assert.ok((await drain(whole.body)).equals(BODY), "round-tripped bytes differ");
});

const ranges = [
  ["chunk 0", { start: 0, end: CHUNK - 1 }],
  ["a middle chunk, without touching chunk 0", { start: CHUNK, end: 2 * CHUNK - 1 }],
  ["the partial final chunk", { start: 2 * CHUNK, end: SIZE - 1 }],
  ["an open-ended range", { start: 2 * CHUNK }],
];
for (const [name, range] of ranges) {
  test(`a ranged GET through the relay's adapter: ${name}`, async () => {
    const got = await store.get(KEY, range);
    const end = range.end ?? SIZE - 1;
    assert.deepEqual(got.contentRange, { start: range.start, end, size: SIZE });
    assert.equal(got.contentLength, end - range.start + 1);
    assert.ok((await drain(got.body)).equals(BODY.subarray(range.start, end + 1)));
  });
}

test("a range past the end is the adapter's INVALID_RANGE, with the size (§11.2's 416)", async () => {
  await assert.rejects(store.get(KEY, { start: SIZE }), (e) => e.code === "INVALID_RANGE" && e.objectSize === SIZE);
});

test("a byte range through a presigned URL (brief §12's literal wording)", async () => {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: storage.bucket, Key: KEY }), { expiresIn: 60 });
  const res = await fetch(url, { headers: { Range: `bytes=${CHUNK}-${2 * CHUNK - 1}` } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes ${CHUNK}-${2 * CHUNK - 1}/${SIZE}`);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(BODY.subarray(CHUNK, 2 * CHUNK)));
});

test("an absent object is the adapter's null, not a throw (§9.7 decides on the status code)", async () => {
  assert.equal(await store.head(`${PREFIX}/never-written`), null);
});

// --- 2. read-after-write for new objects ----------------------------------------

test("read-after-write: 25 new objects, each HEAD and GET immediately after its PUT", async () => {
  const misses = [];
  const timings = [];
  for (let i = 0; i < 25; i++) {
    const key = `${PREFIX}/raw-${i}`;
    const buf = randomBytes(4096 + i);
    const t0 = performance.now();
    await putViaRelay(key, buf);
    const head = await store.head(key); // the confirming HEAD of §9.7, at once
    const got = await store.get(key, { start: 0 }).then((o) => drain(o.body)).catch((e) => e);
    timings.push(performance.now() - t0);
    if (head?.length !== buf.length) misses.push(`${i}: head=${JSON.stringify(head)}`);
    else if (!(got instanceof Buffer) || !got.equals(buf)) misses.push(`${i}: get=${got?.code ?? "wrong bytes"}`);
  }
  timings.sort((a, b) => a - b);
  console.log(`  put→head→get: median ${timings[12].toFixed(0)} ms, worst ${timings[24].toFixed(0)} ms`);
  assert.deepEqual(misses, [], "a new object was not visible straight after its PUT — §9.7's not-yet-visible branch becomes the common path");
});

// --- 3. versioning is off ---------------------------------------------------------

test("bucket versioning has never been enabled", async () => {
  const v = await s3.send(new GetBucketVersioningCommand({ Bucket: storage.bucket }));
  // "Suspended" is not off: versions made while it was enabled are still kept.
  assert.equal(v.Status, undefined, `versioning is ${v.Status}: a removal (§9.11) would leave the ciphertext behind as an old version`);
});

test("by violation: overwrite then delete leaves no version behind", async () => {
  const key = `${PREFIX}/versioned`;
  await putViaRelay(key, randomBytes(512));
  await putViaRelay(key, randomBytes(512));
  await store.remove(key);
  assert.equal(await store.head(key), null);
  let listed;
  try {
    listed = await s3.send(new ListObjectVersionsCommand({ Bucket: storage.bucket, Prefix: key }));
  } catch (e) {
    console.log(`  ListObjectVersions unsupported (${e.name}); GetBucketVersioning above stands alone`);
    return;
  }
  const left = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].filter((v) => v.Key === key);
  assert.deepEqual(left.map((v) => v.VersionId), [], "deleted ciphertext survives as a version");
});

// --- 4. a misspelled bucket is not created ----------------------------------------

test("a write to a misspelled bucket fails, and creates nothing", async () => {
  // Random suffix: nobody else can own it, so a 403 cannot be someone else's bucket.
  const typo = `${storage.bucket}-typo-${RUN}`.slice(0, 63).replace(/-+$/, "");
  const typoStore = createObjectStore(s3, typo);
  let created = false;
  try {
    await assert.rejects(verifyBucket(s3, typo, storage.endpoint), "boot check passed on a bucket that should not exist");
    await assert.rejects(typoStore.put(`${PREFIX}/typo`, streamOf(randomBytes(1024)), 1024), "a PUT to a misspelled bucket succeeded");
    const status = await s3.send(new HeadBucketCommand({ Bucket: typo })).then(() => 200, (e) => e.$metadata?.httpStatusCode);
    created = status === 200;
    assert.equal(status, 404, `after the failed PUT, HEAD on the misspelled bucket answered ${status}`);
    // And the boot check still refuses it — the property verifyBucket's comment leaves open for Hetzner.
    await assert.rejects(verifyBucket(s3, typo, storage.endpoint));
  } finally {
    if (created) {
      await s3.send(new DeleteObjectCommand({ Bucket: typo, Key: `${PREFIX}/typo` })).catch(() => {});
      await s3.send(new DeleteBucketCommand({ Bucket: typo })).catch((e) => console.error(`DELETE BUCKET ${typo} BY HAND (${e.name})`));
    }
  }
});

// --- 5. CacheControl set at upload survives on reads -------------------------------

test("CacheControl stored at upload comes back on 200 and 206, SDK and presigned", async () => {
  const key = `${PREFIX}/cache-control`;
  written.add(key);
  await s3.send(new PutObjectCommand({
    Bucket: storage.bucket, Key: key, Body: BODY, ContentType: "application/octet-stream", CacheControl: "no-store",
  }));
  const whole = await s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
  await drain(whole.Body);
  assert.equal(whole.CacheControl, "no-store", "lost on a whole GET");
  const ranged = await s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key, Range: `bytes=${CHUNK}-${2 * CHUNK - 1}` }));
  await drain(ranged.Body);
  assert.equal(ranged.CacheControl, "no-store", "lost on a ranged GET");

  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: storage.bucket, Key: key }), { expiresIn: 60 });
  for (const headers of [{}, { Range: `bytes=0-${CHUNK - 1}` }]) {
    const res = await fetch(url, { headers });
    await res.arrayBuffer();
    assert.equal(res.headers.get("cache-control"), "no-store", `lost on a presigned ${res.status}`);
  }
});

// --- 6. erasure, as §9.11 relies on it ---------------------------------------------

test("remove() then head() answers null — the only evidence §9.11 may report as erased", async () => {
  const key = `${PREFIX}/erase`;
  await putViaRelay(key, randomBytes(2048));
  await store.remove(key);
  assert.equal(await store.head(key), null);
  await store.remove(key); // idempotent on an absent object
});
