/*
 * The backup bucket, and nothing else. Its own variable names (BACKUP_*), so
 * the backup job's environment cannot be the API's by accident, and so the
 * API's media credentials are never what writes here.
 *
 *   node s3.mjs put <file> <key>        upload, then HEAD to confirm the length
 *   node s3.mjs get <key> <file>
 *   node s3.mjs latest <prefix>         newest key under prefix
 *   node s3.mjs prune <prefix> <retentionDays> <keepMin> [--dry-run]
 *                                       --dry-run lists what would go, deletes nothing
 *   node s3.mjs list [prefix]
 *   node s3.mjs ensure-bucket           localhost endpoints only (the rehearsal)
 *   node s3.mjs delete-prefix <prefix>  localhost endpoints only (the rehearsal's clean)
 *
 * Resolves @aws-sdk/client-s3 by walking up from this file: the repository's
 * node_modules locally; on the server, deploy places this beside the API's.
 */

import { createReadStream, createWriteStream, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { assertPrefix, parseBackupKey, selectForDeletion } from "./prune.mjs";

const NAMES = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_REGION", "BACKUP_BUCKET", "BACKUP_AWS_ACCESS_KEY_ID", "BACKUP_AWS_SECRET_ACCESS_KEY"];
const missing = NAMES.filter((n) => !process.env[n]);
if (missing.length) {
  console.error(`s3.mjs: missing ${missing.join(", ")}`);
  process.exit(2);
}
const endpoint = new URL(process.env.BACKUP_S3_ENDPOINT);
const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
if (endpoint.protocol !== "https:" && !local) {
  console.error("s3.mjs: BACKUP_S3_ENDPOINT must be https unless localhost");
  process.exit(2);
}
const Bucket = process.env.BACKUP_BUCKET;
const s3 = new S3Client({
  endpoint: endpoint.origin,
  region: process.env.BACKUP_S3_REGION,
  credentials: {
    accessKeyId: process.env.BACKUP_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.BACKUP_AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // as the API's client; phase 1 proved this path against the provider
});

async function list(prefix) {
  const out = [];
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }));
    for (const o of page.Contents ?? []) out.push({ key: o.Key, lastModified: o.LastModified, size: o.Size });
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}

const [cmd, ...args] = process.argv.slice(2);
try {
  switch (cmd) {
    case "put": {
      const [file, key] = args;
      const length = statSync(file).size;
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: createReadStream(file), ContentLength: length, ContentType: "application/octet-stream" }));
      const head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
      if (head.ContentLength !== length) throw new Error(`uploaded ${length} bytes, store reports ${head.ContentLength}`);
      console.log(`uploaded ${key} (${length} bytes)`);
      break;
    }
    case "get": {
      const [key, file] = args;
      const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      await pipeline(res.Body, createWriteStream(file, { mode: 0o600 }));
      break;
    }
    case "latest": {
      // Newest by the name's timestamp, as prune reads age; only backup names count.
      const prefix = assertPrefix(args[0]);
      const backups = (await list(prefix))
        .map((o) => ({ key: o.key, at: parseBackupKey(prefix, o.key) }))
        .filter((b) => b.at);
      if (!backups.length) throw new Error(`no backups under "${prefix}"`);
      backups.sort((a, b) => b.at - a.at);
      console.log(backups[0].key);
      break;
    }
    case "prune": {
      const dryRun = args.includes("--dry-run");
      const [prefix, days, keep, ...rest] = args.filter((a) => a !== "--dry-run");
      if (rest.length) throw new Error(`unexpected arguments: ${rest.join(" ")}`);
      assertPrefix(prefix); // before listing: never the whole bucket, never a sibling prefix
      const { delete: doomed, ignored } = selectForDeletion(await list(prefix), prefix, new Date(), Number(days), Number(keep));
      for (const key of ignored) console.log(`ignored ${key} (not a backup name)`);
      for (const key of doomed) {
        if (dryRun) {
          console.log(`would prune ${key}`);
          continue;
        }
        await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
        console.log(`pruned ${key}`);
      }
      break;
    }
    case "list": {
      for (const o of await list(args[0] ?? "")) console.log(o.key);
      break;
    }
    case "ensure-bucket": {
      if (!local) throw new Error("ensure-bucket is for the local rehearsal; the owner creates real buckets");
      await s3.send(new HeadBucketCommand({ Bucket })).catch(() => s3.send(new CreateBucketCommand({ Bucket })));
      break;
    }
    case "delete-prefix": {
      if (!local) throw new Error("delete-prefix is for the local rehearsal only");
      if (!args[0]) throw new Error("delete-prefix needs a non-empty prefix");
      for (const o of await list(args[0])) await s3.send(new DeleteObjectCommand({ Bucket, Key: o.key }));
      break;
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
} catch (e) {
  console.error(`s3.mjs ${cmd}: ${e.name}: ${e.message}`);
  process.exitCode = 1;
} finally {
  s3.destroy();
}
