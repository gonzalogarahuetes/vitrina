// `GET /v1/media/{media_id}/asset` — api-sketch §11.2 and §11.6, over the real
// graph with a fake store that clamps and answers 416 as SeaweedFS does
// (infra/object-store-adapter.test.mjs measured it). Discharges §6.2's rows.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { StorageError } from "../dist/application/ports/object-store.js";
import { b64, buildPr2Server, sha256 } from "./support/pr2-graph.mjs";

const NOW = new Date("2026-10-08T09:00:00.000Z");

/** Past one 256 KiB chunk, so a later range (`bytes=262208-`) exists. */
const SIZE = 300_000;
const ASSET = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));

function inMemoryMedia(albums) {
  const rows = new Map();
  return {
    add(albumId, status = "ready") {
      const id = randomUUID();
      const { ownerId } = albums.rows.get(albumId);
      rows.set(id, {
        id, albumId, ownerId, kind: "photo", status,
        byteSize: status === "ready" ? SIZE : null, createdAt: NOW, updatedAt: NOW,
      });
      return id;
    },
    // Postgres compares uuids case-insensitively; the fake must too.
    async findById(mediaId) {
      return rows.get(mediaId.toLowerCase()) ?? null;
    },
    async listByAlbum() {
      return [];
    },
    async listReadyEnvelopes() {
      return [];
    },
  };
}

/** S3 semantics: clamp the end, 416 when the start is past the object. */
function fakeStore() {
  const store = {
    calls: [],
    failWith: null,
    async put() {},
    async head() {
      return null;
    },
    async get(key, range) {
      store.calls.push({ key, range });
      if (store.failWith) throw store.failWith;
      if (range === undefined) return { body: Readable.from([ASSET]), contentLength: SIZE };
      if (range.start >= SIZE) throw new StorageError("INVALID_RANGE", { objectSize: SIZE });
      const end = Math.min(range.end ?? SIZE - 1, SIZE - 1);
      const slice = ASSET.subarray(range.start, end + 1);
      return {
        body: Readable.from([slice]),
        contentLength: slice.length,
        contentRange: { start: range.start, end, size: SIZE },
        etag: '"abc"', // a field a careless route might pass on
      };
    },
  };
  return store;
}

function fakeAccessLogs() {
  const logs = {
    rows: [],
    failWith: null,
    async record(event) {
      if (logs.failWith) throw logs.failWith;
      logs.rows.push(event);
    },
  };
  return logs;
}

async function setup({ captureLogs = false } = {}) {
  const objectStore = fakeStore();
  const accessLogs = fakeAccessLogs();
  const logLines = [];
  let media;
  const server = await buildPr2Server({
    media: {
      findById: (...a) => media.findById(...a),
      listByAlbum: (...a) => media.listByAlbum(...a),
      listReadyEnvelopes: (...a) => media.listReadyEnvelopes(...a),
    },
    objectStore,
    accessLogs,
    logger: captureLogs ? { level: "trace", stream: { write: (line) => logLines.push(JSON.parse(line)) } } : false,
  });
  media = inMemoryMedia(server.albums);

  const parent = await server.owner();
  const albumId = await server.album(parent.auth);
  return { ...server, media, objectStore, accessLogs, logLines, parent, albumId };
}

/** A recipient through §7.7, optionally revoked through §7.8. */
async function recipient({ app, parent }, albumId, { revoked = false } = {}) {
  const token = randomBytes(32);
  const id = randomUUID();
  const created = await app.inject({
    method: "POST",
    url: `/v1/albums/${albumId}/recipients`,
    headers: parent.auth,
    payload: { id, kind: "qr", label: b64(0x6c, 60), token_hash: sha256(token).toString("base64url") },
  });
  assert.equal(created.statusCode, 201, created.body);
  if (revoked) {
    const response = await app.inject({ method: "POST", url: `/v1/recipients/${id}/revoke`, headers: parent.auth });
    assert.equal(response.statusCode, 200, response.body);
  }
  return { id, auth: { authorization: `Bearer ${token.toString("base64url")}` } };
}

const fetchAsset = (app, mediaId, headers = {}, range) =>
  app.inject({
    method: "GET",
    url: `/v1/media/${mediaId}/asset`,
    headers: range === undefined ? headers : { ...headers, range },
  });

function assertBareError(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.deepEqual(Object.keys(response.json()).sort(), ["code", "message"]);
  assert.equal(response.json().code, code);
}

describe("GET /v1/media/{media_id}/asset — §11.2", () => {
  describe("the range table", () => {
    const served = [
      ["bytes=0-63", 0, 63, "header-sized, the first request of every open"],
      ["bytes=262208-", 262208, SIZE - 1, "open-ended, to the last byte"],
      [`bytes=${SIZE - 10}-${SIZE + 5000}`, SIZE - 10, SIZE - 1, "past the end: the store's clamp, forwarded"],
    ];
    for (const [range, start, end, why] of served) {
      it(`${range} → 206 — ${why}`, async () => {
        const ctx = await setup();
        const mediaId = ctx.media.add(ctx.albumId);

        const response = await fetchAsset(ctx.app, mediaId, ctx.parent.auth, range);

        assert.equal(response.statusCode, 206, response.body);
        assert.ok(response.rawPayload.equals(ASSET.subarray(start, end + 1)), "body is not the slice");
        assert.equal(response.headers["content-range"], `bytes ${start}-${end}/${SIZE}`);
        assert.equal(response.headers["content-length"], String(end - start + 1));
        assert.equal(response.headers["content-type"], "application/octet-stream");
        assert.equal(response.headers["accept-ranges"], "bytes");
        assert.equal(response.headers["cache-control"], "no-store");
        // §11.2's whitelist: nothing the store happened to add.
        for (const absent of ["etag", "last-modified"]) assert.equal(response.headers[absent], undefined);
      });
    }

    it("asks the store for the asset key, with the range as parsed", async () => {
      const ctx = await setup();
      const mediaId = ctx.media.add(ctx.albumId);

      await fetchAsset(ctx.app, mediaId.toUpperCase(), ctx.parent.auth, "bytes=0-63");

      assert.deepEqual(ctx.objectStore.calls, [{ key: `media/${mediaId}/asset`, range: { start: 0, end: 63 } }]);
    });

    for (const start of [SIZE, SIZE + 1000]) {
      it(`bytes=${start}- → 416 with Content-Range: bytes */size`, async () => {
        const ctx = await setup();
        const mediaId = ctx.media.add(ctx.albumId);

        const response = await fetchAsset(ctx.app, mediaId, ctx.parent.auth, `bytes=${start}-`);

        assertBareError(response, 416, "RANGE_NOT_SATISFIABLE");
        assert.equal(response.headers["content-range"], `bytes */${SIZE}`);
        assert.equal(response.headers["accept-ranges"], "bytes");
        assert.equal(response.headers["cache-control"], "no-store");
      });
    }

    const refused = [
      [undefined, "no Range header at all — the row someone will 'fix' toward RFC 9110"],
      ["bytes=10-5", "start after end"],
      ["bytes=-500", "suffix range"],
      ["bytes=0-1,4-5", "multi-range"],
      ["items=0-10", "another unit"],
    ];
    for (const [range, why] of refused) {
      it(`${range ?? "(none)"} → 400, no details, nothing echoed — ${why}`, async () => {
        const ctx = await setup();
        const mediaId = ctx.media.add(ctx.albumId);

        const response = await fetchAsset(ctx.app, mediaId, ctx.parent.auth, range);

        assertBareError(response, 400, "VALIDATION_FAILED");
        if (range !== undefined) assert.ok(!response.body.includes(range), "the Range value reached the body (#15)");
        assert.equal(response.headers["accept-ranges"], "bytes", "the 400 must say what the route wants");
        assert.equal(ctx.objectStore.calls.length, 0, "a malformed range reached the store");
      });
    }

    it("Accept-Ranges is on the 401 too — set before auth runs", async () => {
      const ctx = await setup();
      const response = await fetchAsset(ctx.app, ctx.media.add(ctx.albumId), {}, "bytes=0-63");

      assertBareError(response, 401, "UNAUTHENTICATED");
      assert.equal(response.headers["accept-ranges"], "bytes");
    });

    it("the thumbnail route does not advertise ranges", async () => {
      // The hook is the asset route's, not the plugin's (§11.3).
      const ctx = await setup();
      const response = await ctx.app.inject({
        method: "GET",
        url: `/v1/media/${ctx.media.add(ctx.albumId)}/thumbnail`,
        headers: ctx.parent.auth,
      });

      assert.equal(response.headers["accept-ranges"], undefined);
    });
  });

  describe("§7.3's ladder, then ready", () => {
    it("an absent id is 404", async () => {
      const ctx = await setup();
      assertBareError(await fetchAsset(ctx.app, randomUUID(), ctx.parent.auth, "bytes=0-63"), 404, "NOT_FOUND");
    });

    it("a recipient of another album gets 404", async () => {
      const ctx = await setup();
      const other = await ctx.album(ctx.parent.auth);
      const { auth } = await recipient(ctx, ctx.albumId);

      assertBareError(await fetchAsset(ctx.app, ctx.media.add(other), auth, "bytes=0-63"), 404, "NOT_FOUND");
    });

    it("a pending row is 404, and the store is never asked", async () => {
      const ctx = await setup();
      const mediaId = ctx.media.add(ctx.albumId, "pending");

      assertBareError(await fetchAsset(ctx.app, mediaId, ctx.parent.auth, "bytes=0-63"), 404, "NOT_FOUND");
      assert.equal(ctx.objectStore.calls.length, 0);
    });

    it("a revoked recipient asking for a PENDING row in their own album gets 403, not 404", async () => {
      // §6.1's row: the ready check runs after the ladder, never hoisted above it.
      const ctx = await setup();
      const { auth } = await recipient(ctx, ctx.albumId, { revoked: true });

      assertBareError(await fetchAsset(ctx.app, ctx.media.add(ctx.albumId, "pending"), auth, "bytes=0-63"), 403, "ACCESS_REVOKED");
    });

    it("a ready row with no object is 500, not 404", async () => {
      const ctx = await setup();
      const mediaId = ctx.media.add(ctx.albumId);
      ctx.objectStore.failWith = new StorageError("NOT_FOUND");

      assertBareError(await fetchAsset(ctx.app, mediaId, ctx.parent.auth, "bytes=0-63"), 500, "INTERNAL");
    });
  });
});

describe("§11.6 — asset_viewed", () => {
  it("a recipient's range from byte 0 writes exactly one row, naming them and the asset", async () => {
    const ctx = await setup();
    const mediaId = ctx.media.add(ctx.albumId);
    const maria = await recipient(ctx, ctx.albumId);

    assert.equal((await fetchAsset(ctx.app, mediaId, maria.auth, "bytes=0-262207")).statusCode, 206);

    assert.deepEqual(ctx.accessLogs.rows, [{ event: "asset_viewed", recipientId: maria.id, mediaId }]);
  });

  it("a later range on the same asset writes nothing", async () => {
    const ctx = await setup();
    const mediaId = ctx.media.add(ctx.albumId);
    const { auth } = await recipient(ctx, ctx.albumId);

    assert.equal((await fetchAsset(ctx.app, mediaId, auth, "bytes=262208-")).statusCode, 206);

    assert.deepEqual(ctx.accessLogs.rows, []);
  });

  it("two opens are two rows — never deduplicated on write", async () => {
    const ctx = await setup();
    const mediaId = ctx.media.add(ctx.albumId);
    const { auth } = await recipient(ctx, ctx.albumId);

    await fetchAsset(ctx.app, mediaId, auth, "bytes=0-63");
    await fetchAsset(ctx.app, mediaId, auth, "bytes=0-");

    assert.equal(ctx.accessLogs.rows.length, 2);
  });

  it("an owner's open writes nothing — the table has no owner column", async () => {
    const ctx = await setup();

    await fetchAsset(ctx.app, ctx.media.add(ctx.albumId), ctx.parent.auth, "bytes=0-63");

    assert.deepEqual(ctx.accessLogs.rows, []);
  });

  it("no 4xx writes: malformed, revoked, pending, out of scope", async () => {
    const ctx = await setup();
    const live = await recipient(ctx, ctx.albumId);
    const revoked = await recipient(ctx, ctx.albumId, { revoked: true });
    const other = await ctx.album(ctx.parent.auth);

    await fetchAsset(ctx.app, ctx.media.add(ctx.albumId), live.auth, "bytes=0-1,4-5");
    await fetchAsset(ctx.app, ctx.media.add(ctx.albumId), live.auth);
    await fetchAsset(ctx.app, ctx.media.add(ctx.albumId), revoked.auth, "bytes=0-63");
    await fetchAsset(ctx.app, ctx.media.add(ctx.albumId, "pending"), live.auth, "bytes=0-63");
    await fetchAsset(ctx.app, ctx.media.add(other), live.auth, "bytes=0-63");

    assert.deepEqual(ctx.accessLogs.rows, []);
  });

  it("a 500 from the store writes nothing — the row follows the store's answer", async () => {
    const ctx = await setup();
    const { auth } = await recipient(ctx, ctx.albumId);
    ctx.objectStore.failWith = new StorageError("UNAVAILABLE");

    assert.equal((await fetchAsset(ctx.app, ctx.media.add(ctx.albumId), auth, "bytes=0-63")).statusCode, 500);
    assert.deepEqual(ctx.accessLogs.rows, []);
  });

  it("thumbnails never log, even for a recipient", async () => {
    const ctx = await setup();
    const { auth } = await recipient(ctx, ctx.albumId);

    await ctx.app.inject({ method: "GET", url: `/v1/media/${ctx.media.add(ctx.albumId)}/thumbnail`, headers: auth });

    assert.deepEqual(ctx.accessLogs.rows, []);
  });

  it("a failed write still serves the 206, and logs one error line", async () => {
    // The log is a feature, not a control: refusing ciphertext over a
    // bookkeeping row makes the album unavailable in exactly that outage.
    const ctx = await setup({ captureLogs: true });
    const mediaId = ctx.media.add(ctx.albumId);
    const { auth } = await recipient(ctx, ctx.albumId);
    ctx.accessLogs.failWith = new Error("access_log insert failed (pg 57P01)");

    const response = await fetchAsset(ctx.app, mediaId, auth, "bytes=0-63");

    assert.equal(response.statusCode, 206, response.body);
    assert.ok(response.rawPayload.equals(ASSET.subarray(0, 64)));
    const errors = ctx.logLines.filter((line) => line.level >= 50);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.equal(errors[0].msg, "access_log write failed");
  });
});
