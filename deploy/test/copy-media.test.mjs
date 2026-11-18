/*
 * copy-media.mjs and empty-bucket.mjs against an in-process fake of the S3
 * calls they make (path-style, plain http on loopback under
 * COPY_MEDIA_SELF_TEST=1). Each refusal by violation, with the fake's request
 * log as the proof that nothing was written. Hermetic: no Docker, no bucket.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const COPY = path("../backup/copy-media.mjs");
const EMPTY = path("../backup/empty-bucket.mjs");

// ---- the fake ---------------------------------------------------------------

const buckets = new Map(); // name → Map(key → Buffer)
const deny = new Map(); // name → how many more requests get 403 AccessDenied
let log = []; // { method, bucket, key }
let server;
let endpoint;

const xml = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
};
const fail = (res, method, status, code) =>
  method === "HEAD" ? (res.writeHead(status), res.end()) : xml(res, status, `<Error><Code>${code}</Code><Message>${code}</Message><RequestId>t</RequestId></Error>`);

// The SDK streams a body of known length as aws-chunked: "<hex>[;ext]\r\n<data>\r\n" … "0\r\n<trailers>".
function unchunk(buf) {
  const out = [];
  let at = 0;
  for (;;) {
    const eol = buf.indexOf("\r\n", at);
    const size = parseInt(buf.subarray(at, eol).toString().split(";")[0], 16);
    if (!size) return Buffer.concat(out);
    out.push(buf.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
}

const PAGE = 2; // small, so every listing pages

async function handle(req, res) {
  const url = new URL(req.url, "http://fake");
  const [, bucket, ...rest] = url.pathname.split("/");
  const key = decodeURIComponent(rest.join("/"));
  const parts = [];
  for await (const c of req) parts.push(c);
  let body = Buffer.concat(parts);
  log.push({ method: req.method, bucket, key });
  const left = deny.get(bucket) ?? 0;
  if (left > 0) return deny.set(bucket, left - 1), fail(res, req.method, 403, "AccessDenied");
  const b = buckets.get(bucket);
  if (!b) return fail(res, req.method, 404, "NoSuchBucket");
  if (!key && req.method === "HEAD") return res.end();
  if (!key && req.method === "GET") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const all = [...b.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = Number(url.searchParams.get("continuation-token") ?? 0);
    const page = all.slice(from, from + PAGE);
    const more = from + PAGE < all.length;
    return xml(
      res,
      200,
      `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount>` +
        `<MaxKeys>${PAGE}</MaxKeys><IsTruncated>${more}</IsTruncated>` +
        page.map((k) => `<Contents><Key>${k}</Key><Size>${b.get(k).length}</Size></Contents>`).join("") +
        (more ? `<NextContinuationToken>${from + PAGE}</NextContinuationToken>` : "") +
        `</ListBucketResult>`,
    );
  }
  if (req.method === "GET") {
    if (!b.has(key)) return fail(res, "GET", 404, "NoSuchKey");
    res.writeHead(200, { "content-length": b.get(key).length, etag: '"e"' });
    return res.end(b.get(key));
  }
  if (req.method === "PUT") {
    if (/aws-chunked/.test(req.headers["content-encoding"] ?? "") || /^STREAMING-/.test(req.headers["x-amz-content-sha256"] ?? ""))
      body = unchunk(body);
    b.set(key, body);
    res.writeHead(200, { etag: '"e"' });
    return res.end();
  }
  if (req.method === "DELETE") return b.delete(key), res.writeHead(204), res.end();
  fail(res, req.method, 400, "Unexpected");
}

// ---- fixtures ---------------------------------------------------------------

let home;
let dir;
const PROD = "prod-media";
const REHEARSAL = "rehearsal-media";
const BACKUPS = "prod-backups";

function envFile(name, bucket) {
  const p = join(dir, name);
  writeFileSync(
    p,
    `S3_ENDPOINT=${endpoint}\nS3_BUCKET=${bucket}\nAWS_DEFAULT_REGION=fake\nAWS_ACCESS_KEY_ID=k\nAWS_SECRET_ACCESS_KEY=s\n`,
  );
  return p;
}

const PHOTOS = {
  "media/a/original": "aaaa",
  "media/a/thumbnail": "aa",
  "media/b/original": "bbbbbb",
  "media/b/thumbnail": "bb",
  "media/c/original": "ccccccc",
};

function reset({ rehearsal = {}, production = PHOTOS } = {}) {
  buckets.clear();
  deny.clear();
  log = [];
  const fill = (o) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
  buckets.set(PROD, fill(production));
  buckets.set(REHEARSAL, fill(rehearsal));
  buckets.set(BACKUPS, fill({ "pg/x.dump.age": "z" }));
}

function run(script, args, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, HOME: home, COPY_MEDIA_SELF_TEST: "1", COPY_MEDIA_RETRY_SECONDS: "2", ...extra },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    // A run that outlives this is a wait without a bound: killed, so it fails here instead of hanging.
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (status) => (clearTimeout(timer), resolve({ status, stdout, stderr })));
  });
}

const writes = (bucket) => log.filter((r) => r.bucket === bucket && ["PUT", "DELETE", "POST"].includes(r.method));
const contents = (bucket) => Object.fromEntries([...buckets.get(bucket)].map(([k, v]) => [k, v.toString()]));

before(async () => {
  server = createServer((req, res) => handle(req, res).catch((e) => (res.writeHead(500), res.end(String(e)))));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  home = mkdtempSync(join(tmpdir(), "copy-media-home-"));
  dir = mkdtempSync(join(tmpdir(), "copy-media-env-"));
  mkdirSync(join(home, ".vitrina"));
  writeFileSync(join(home, ".vitrina", "storage.env"), `S3_ENDPOINT=${endpoint}\nS3_BUCKET=${PROD}\n`);
});
after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

// ---- copy-media: what it does ------------------------------------------------

test("copies media/ into an empty target; the source is only listed and read", async () => {
  reset();
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /copied 5 objects \(21 bytes\)/);
  assert.deepEqual(contents(REHEARSAL), PHOTOS);
  assert.deepEqual([...new Set(log.filter((x) => x.bucket === PROD).map((x) => x.method))], ["GET"]);
});

test("resumes a partial copy: only the missing objects are copied", async () => {
  reset({ rehearsal: { "media/a/original": "aaaa", "media/b/thumbnail": "bb" } });
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /resuming: 2 of 5/);
  assert.match(r.stdout, /copied 3 objects .*2 already there/);
  assert.deepEqual(writes(REHEARSAL).map((w) => w.key).sort(), ["media/a/thumbnail", "media/b/original", "media/c/original"]);
  assert.deepEqual(contents(REHEARSAL), PHOTOS);
});

test("waits out a few 403s from new credentials, then copies", async () => {
  reset();
  deny.set(REHEARSAL, 3);
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`target bucket ${REHEARSAL}: .*refused \\(403 .*\\).*retrying`));
  assert.deepEqual(contents(REHEARSAL), PHOTOS);
});

// ---- copy-media: refusals, by violation --------------------------------------

test("refuses production's media bucket as the target, before any request", async () => {
  reset({ production: {} }); // even empty
  const r = await run(COPY, [envFile("s.env", REHEARSAL), envFile("t.env", PROD)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, new RegExp(`target ${PROD} is production's media bucket`));
  assert.equal(log.length, 0);
});

test("refuses production's media bucket as the target when it would pass the resume check", async () => {
  reset({ rehearsal: PHOTOS }); // a full rehearsal copy as source: production ⊆ source, same sizes
  const r = await run(COPY, [envFile("s.env", REHEARSAL), envFile("t.env", PROD)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /production's media bucket/);
  assert.equal(log.length, 0);
});

test("refuses production's backup bucket as the target, when the recovery file names it", async () => {
  reset();
  const backupEnv = join(home, ".vitrina", "backup-bucket.env");
  writeFileSync(backupEnv, `BACKUP_BUCKET=${BACKUPS}\n`);
  try {
    const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", BACKUPS)]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(`target ${BACKUPS} is production's backup bucket`));
    assert.equal(log.length, 0);
  } finally {
    rmSync(backupEnv);
  }
});

test("refuses to write anywhere when it cannot tell production's bucket", async () => {
  reset();
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)], { HOME: dir });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot tell production's media bucket/);
  assert.equal(log.length, 0);
});

test("refuses the same bucket as source and target", async () => {
  reset();
  const r = await run(COPY, [envFile("s.env", REHEARSAL), envFile("t.env", REHEARSAL)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /source and target are both/);
  assert.equal(log.length, 0);
});

test("refuses a target holding an object the source does not", async () => {
  reset({ rehearsal: { "media/a/original": "aaaa", "media/zzz/original": "?" } });
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /holds what .* does not: media\/zzz\/original; use an empty bucket/);
  assert.deepEqual(writes(REHEARSAL), []);
});

test("refuses a target holding anything outside media/", async () => {
  reset({ rehearsal: { "notes.txt": "x" } });
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not: notes\.txt/);
  assert.deepEqual(writes(REHEARSAL), []);
});

test("refuses a target holding an object at a different size", async () => {
  reset({ rehearsal: { "media/a/original": "aa" } });
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /different size from the source: media\/a\/original/);
  assert.deepEqual(writes(REHEARSAL), []);
});

test("a 403 that persists fails after the bounded wait, naming the bucket", async () => {
  reset();
  deny.set(REHEARSAL, Infinity);
  const started = Date.now();
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)], { COPY_MEDIA_RETRY_SECONDS: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`target bucket ${REHEARSAL}: HeadBucket still refused \\(403 .*\\) after 1 s; check ${REHEARSAL}'s credentials`));
  assert.ok(Date.now() - started < 10_000);
  assert.deepEqual(writes(REHEARSAL), []);
});

test("a refused source is named as the source", async () => {
  reset();
  deny.set(PROD, Infinity);
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)], { COPY_MEDIA_RETRY_SECONDS: "0" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`source bucket ${PROD}: list still refused`));
  assert.deepEqual(writes(REHEARSAL), []);
});

test("any other error fails at once, naming the bucket", async () => {
  reset();
  buckets.delete(REHEARSAL);
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`target bucket ${REHEARSAL}: HeadBucket failed`));
});

test("refuses a plain-http endpoint outside the self-test", async () => {
  reset();
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)], { COPY_MEDIA_SELF_TEST: "" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be https/);
  assert.equal(log.length, 0);
});

test("refuses an unbounded wait", async () => {
  reset();
  const r = await run(COPY, [envFile("s.env", PROD), envFile("t.env", REHEARSAL)], { COPY_MEDIA_RETRY_SECONDS: "3600" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /COPY_MEDIA_RETRY_SECONDS must be 0 to 900/);
  assert.equal(log.length, 0);
});

// ---- empty-bucket ----------------------------------------------------------

test("empty-bucket deletes everything in a throwaway bucket", async () => {
  reset({ rehearsal: { ...PHOTOS, "notes.txt": "x" } });
  const r = await run(EMPTY, [envFile("t.env", REHEARSAL), REHEARSAL]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /deleted 6 objects; rehearsal-media is empty/);
  assert.deepEqual(contents(REHEARSAL), {});
  assert.deepEqual(contents(PROD), PHOTOS);
});

test("empty-bucket refuses production's media bucket, before any request", async () => {
  reset();
  const r = await run(EMPTY, [envFile("t.env", PROD), PROD]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /production's media bucket/);
  assert.equal(log.length, 0);
  assert.deepEqual(contents(PROD), PHOTOS);
});

test("empty-bucket refuses production's backup bucket, before any request", async () => {
  reset();
  const backupEnv = join(home, ".vitrina", "backup-bucket.env");
  writeFileSync(backupEnv, `BACKUP_BUCKET=${BACKUPS}\n`);
  try {
    const r = await run(EMPTY, [envFile("t.env", BACKUPS), BACKUPS]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /production's backup bucket/);
    assert.equal(log.length, 0);
  } finally {
    rmSync(backupEnv);
  }
});

test("empty-bucket refuses when the typed name is not the file's bucket", async () => {
  reset({ rehearsal: PHOTOS });
  const r = await run(EMPTY, [envFile("t.env", REHEARSAL), "something-else"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /names rehearsal-media, not something-else; nothing deleted/);
  assert.equal(log.length, 0);
});

test("empty-bucket refuses to delete anything when it cannot tell production's bucket", async () => {
  reset({ rehearsal: PHOTOS });
  const r = await run(EMPTY, [envFile("t.env", REHEARSAL), REHEARSAL], { HOME: dir });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot tell production's media bucket/);
  assert.equal(log.length, 0);
});
