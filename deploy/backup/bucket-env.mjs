/*
 * What copy-media.mjs and empty-bucket.mjs share: reading a bucket's env file,
 * the refusal of production's buckets by name, and the bounded wait for new
 * credentials. Mac-side, rehearsal and staging only.
 *
 * Production's media bucket is the S3_BUCKET in ~/.vitrina/storage.env, and
 * production's backup bucket the BACKUP_BUCKET in ~/.vitrina/backup-bucket.env
 * when that file exists. Neither name is in the repository. Without
 * storage.env there is no way to tell, so every write refuses.
 *
 * COPY_MEDIA_SELF_TEST=1 lets the tests use a plain-http endpoint on loopback.
 * COPY_MEDIA_RETRY_SECONDS (default 300, at most 900) bounds the wait.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

export const NAMES = ["S3_ENDPOINT", "S3_BUCKET", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

export function dier(tool) {
  return (m, code = 2) => {
    console.error(`${tool}: ${m}`);
    process.exit(code);
  };
}

function parse(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

const loopback = (url) => url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);

export function load(path, die) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    die(`cannot read ${path}`);
  }
  const env = parse(text);
  const missing = NAMES.filter((n) => !env[n]);
  if (missing.length) die(`${path} lacks ${missing.join(", ")} (values from the password manager)`);
  let url;
  try {
    url = new URL(env.S3_ENDPOINT);
  } catch {
    die(`${path}: S3_ENDPOINT is not a URL`);
  }
  const selfTest = process.env.COPY_MEDIA_SELF_TEST === "1" && loopback(url);
  if (url.protocol !== "https:" && !selfTest) die(`${path}: S3_ENDPOINT must be https`);
  return env;
}

/** Refuses `env`'s bucket when it is one of production's, whatever it holds. */
export function refuseProduction(env, label, die) {
  const dir = join(homedir(), ".vitrina");
  const storage = join(dir, "storage.env");
  let production;
  try {
    production = parse(readFileSync(storage, "utf8")).S3_BUCKET;
  } catch {
    // unreadable: handled below
  }
  if (!production) die(`cannot tell production's media bucket: no S3_BUCKET in ${storage}; refusing to write`);
  if (env.S3_BUCKET === production) die(`${label} ${env.S3_BUCKET} is production's media bucket (${storage}); refusing`);
  let backup;
  try {
    backup = parse(readFileSync(join(dir, "backup-bucket.env"), "utf8")).BACKUP_BUCKET;
  } catch {
    // no recovery under way: no backup bucket named on this Mac
  }
  if (backup && env.S3_BUCKET === backup) die(`${label} ${env.S3_BUCKET} is production's backup bucket; refusing`);
}

export const client = (e) =>
  new S3Client({
    endpoint: new URL(e.S3_ENDPOINT).origin,
    region: e.AWS_DEFAULT_REGION,
    credentials: { accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY },
    forcePathStyle: true,
  });

function retrySeconds(die) {
  const raw = process.env.COPY_MEDIA_RETRY_SECONDS ?? "300";
  if (!/^\d+$/.test(raw) || Number(raw) > 900) die(`COPY_MEDIA_RETRY_SECONDS must be 0 to 900, not ${raw}`);
  return Number(raw);
}

// New Hetzner credentials reach the storage gateways one at a time: for a few
// minutes a request may be refused with 403 (AccessDenied, InvalidAccessKeyId)
// and the next one accepted. A 403 from wrong credentials looks the same, so
// the wait is bounded and the failure names the bucket.
const refused = (err) => err?.$metadata?.httpStatusCode === 403;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` (one whole operation, safe to repeat), retrying on 403 until the
 * bound; any other error, or the bound reached, ends the run naming the bucket.
 */
export function retrier(die) {
  const limitMs = retrySeconds(die) * 1000;
  const intervalMs = Math.min(10_000, Math.max(50, limitMs / 6));
  return async function withRetry(role, bucket, what, fn) {
    const start = Date.now();
    let told = false;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const code = err?.Code ?? err?.name ?? "error";
        if (!refused(err)) die(`${role} bucket ${bucket}: ${what} failed: ${code}: ${err?.message ?? err}`, 1);
        const waited = Date.now() - start;
        if (waited >= limitMs)
          die(
            `${role} bucket ${bucket}: ${what} still refused (403 ${code}) after ${Math.round(waited / 1000)} s; ` +
              `check ${bucket}'s credentials`,
            1,
          );
        if (!told) {
          console.error(
            `${role} bucket ${bucket}: ${what} refused (403 ${code}); new credentials can take minutes to work ` +
              `everywhere, retrying for up to ${limitMs / 1000} s`,
          );
          told = true;
        }
        await sleep(intervalMs);
      }
    }
  };
}

/** Every object in the bucket under `prefix`, as Map(key → size). */
export async function listAll(c, Bucket, Prefix) {
  const out = new Map();
  let ContinuationToken;
  do {
    const page = await c.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    for (const o of page.Contents ?? []) out.set(o.Key, o.Size ?? 0);
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}
