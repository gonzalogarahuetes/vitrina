// `GET /v1/media/{media_id}/thumbnail` — api-sketch §11.3, over the real graph
// with a fake store. Discharges §6.2's "ignores Range" and the ladder rows,
// including §6.1's: a revoked recipient's pending row is 403, not 404.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { StorageError } from "../dist/application/ports/object-store.js";
import { b64, buildPr2Server, sha256 } from "./support/pr2-graph.mjs";

const NOW = new Date("2026-10-07T09:00:00.000Z");

/** Each byte its own offset mod 251, so a truncated or reordered body shows. */
const THUMBNAIL = Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 251));

/** Rows as `MediaRepository.findById` returns them, ownerId from the album. */
function inMemoryMedia(albums) {
  const rows = new Map();
  return {
    add(albumId, status = "ready") {
      const id = randomUUID();
      const { ownerId } = albums.rows.get(albumId);
      rows.set(id, {
        id, albumId, ownerId, kind: "photo", status,
        byteSize: status === "ready" ? THUMBNAIL.length : null,
        createdAt: NOW, updatedAt: NOW,
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

/** Serves THUMBNAIL for every key, or throws `failWith`; records each call. */
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
      // Extra fields a careless adapter might pass on; the route must not.
      return { body: Readable.from([THUMBNAIL]), contentLength: THUMBNAIL.length, etag: '"abc"' };
    },
  };
  return store;
}

async function setup() {
  const objectStore = fakeStore();
  let media;
  const server = await buildPr2Server({
    media: {
      findById: (...a) => media.findById(...a),
      listByAlbum: (...a) => media.listByAlbum(...a),
      listReadyEnvelopes: (...a) => media.listReadyEnvelopes(...a),
    },
    objectStore,
  });
  media = inMemoryMedia(server.albums);

  const parent = await server.owner();
  const albumId = await server.album(parent.auth);
  return { ...server, media, objectStore, parent, albumId };
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
  return { authorization: `Bearer ${token.toString("base64url")}` };
}

const fetchThumbnail = (app, mediaId, headers = {}) =>
  app.inject({ method: "GET", url: `/v1/media/${mediaId}/thumbnail`, headers });

function assertBareError(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.deepEqual(Object.keys(response.json()).sort(), ["code", "message"]);
  assert.equal(response.json().code, code);
}

describe("GET /v1/media/{media_id}/thumbnail — §11.3", () => {
  describe("serving", () => {
    it("an owner gets the whole object, byte for byte, with exactly §11.3's headers", async () => {
      const ctx = await setup();
      const mediaId = ctx.media.add(ctx.albumId);

      const response = await fetchThumbnail(ctx.app, mediaId, ctx.parent.auth);

      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.rawPayload.equals(THUMBNAIL), "body differs from the stored object");
      assert.equal(response.headers["content-type"], "application/octet-stream");
      assert.equal(response.headers["content-length"], String(THUMBNAIL.length));
      assert.equal(response.headers["cache-control"], "no-store");
      // No ranges advertised, and nothing the store happened to add (§11.2).
      for (const absent of ["content-range", "accept-ranges", "etag", "last-modified"]) {
        assert.equal(response.headers[absent], undefined, `${absent} reached the client`);
      }
    });

    it("a recipient of the album gets it too", async () => {
      const ctx = await setup();
      const mediaId = ctx.media.add(ctx.albumId);

      const response = await fetchThumbnail(ctx.app, mediaId, await recipient(ctx, ctx.albumId));

      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.rawPayload.equals(THUMBNAIL));
    });

    it("asks the store for the thumbnail key, never the asset, and with no range", async () => {
      const ctx = await setup();
      const mediaId = ctx.media.add(ctx.albumId);

      await fetchThumbnail(ctx.app, mediaId.toUpperCase(), ctx.parent.auth);

      assert.deepEqual(ctx.objectStore.calls, [{ key: `media/${mediaId}/thumbnail`, range: undefined }]);
    });
  });

  describe("Range is ignored — not rejected, not honoured (§11.3)", () => {
    for (const range of ["bytes=0-10", "bytes=-5", "items=0-10", "bytes=0-1,4-5"]) {
      it(`${range} → 200, the whole body, no Content-Range`, async () => {
        const ctx = await setup();
        const mediaId = ctx.media.add(ctx.albumId);

        const response = await fetchThumbnail(ctx.app, mediaId, { ...ctx.parent.auth, range });

        assert.equal(response.statusCode, 200, response.body);
        assert.ok(response.rawPayload.equals(THUMBNAIL));
        assert.equal(response.headers["content-range"], undefined);
        assert.equal(ctx.objectStore.calls[0].range, undefined, "the route passed a range on");
      });
    }
  });

  describe("§7.3's ladder, then ready", () => {
    it("no token is 401", async () => {
      const ctx = await setup();
      assertBareError(await fetchThumbnail(ctx.app, ctx.media.add(ctx.albumId)), 401, "UNAUTHENTICATED");
    });

    it("an absent id is 404", async () => {
      const ctx = await setup();
      assertBareError(await fetchThumbnail(ctx.app, randomUUID(), ctx.parent.auth), 404, "NOT_FOUND");
    });

    it("another owner's media is 404", async () => {
      const ctx = await setup();
      const mediaId = ctx.media.add(ctx.albumId);
      const stranger = await ctx.owner();

      assertBareError(await fetchThumbnail(ctx.app, mediaId, stranger.auth), 404, "NOT_FOUND");
    });

    it("a recipient of another album gets 404", async () => {
      const ctx = await setup();
      const otherAlbum = await ctx.album(ctx.parent.auth);
      const mediaId = ctx.media.add(otherAlbum);

      assertBareError(await fetchThumbnail(ctx.app, mediaId, await recipient(ctx, ctx.albumId)), 404, "NOT_FOUND");
    });

    for (const status of ["pending", "processing", "failed"]) {
      it(`a ${status} row is 404, and the store is never asked`, async () => {
        const ctx = await setup();
        const mediaId = ctx.media.add(ctx.albumId, status);

        assertBareError(await fetchThumbnail(ctx.app, mediaId, ctx.parent.auth), 404, "NOT_FOUND");
        assert.equal(ctx.objectStore.calls.length, 0);
      });
    }

    it("a revoked recipient on their own album gets 403, with no-store", async () => {
      const ctx = await setup();
      const mediaId = ctx.media.add(ctx.albumId);

      const response = await fetchThumbnail(ctx.app, mediaId, await recipient(ctx, ctx.albumId, { revoked: true }));

      assertBareError(response, 403, "ACCESS_REVOKED");
      assert.equal(response.headers["cache-control"], "no-store");
    });

    it("a revoked recipient asking for a PENDING row in their own album gets 403, not 404", async () => {
      // §6.1's row. Hoisting the ready check for an early return answers 404
      // here, and the two answers would tell a revoked recipient what is ready.
      const ctx = await setup();
      const mediaId = ctx.media.add(ctx.albumId, "pending");

      const response = await fetchThumbnail(ctx.app, mediaId, await recipient(ctx, ctx.albumId, { revoked: true }));

      assertBareError(response, 403, "ACCESS_REVOKED");
    });

    it("the same revoked recipient asking about another album's pending row gets 404", async () => {
      // Step 3 before step 4: revocation must not confirm another album's rows exist.
      const ctx = await setup();
      const otherAlbum = await ctx.album(ctx.parent.auth);
      const mediaId = ctx.media.add(otherAlbum, "pending");

      const response = await fetchThumbnail(ctx.app, mediaId, await recipient(ctx, ctx.albumId, { revoked: true }));

      assertBareError(response, 404, "NOT_FOUND");
    });
  });

  describe("the store failing", () => {
    it("a ready row with no object is 500 — a broken invariant, not a 404", async () => {
      const ctx = await setup();
      const mediaId = ctx.media.add(ctx.albumId);
      ctx.objectStore.failWith = new StorageError("NOT_FOUND");

      assertBareError(await fetchThumbnail(ctx.app, mediaId, ctx.parent.auth), 500, "INTERNAL");
    });

    it("an unreachable store is 500", async () => {
      const ctx = await setup();
      const mediaId = ctx.media.add(ctx.albumId);
      ctx.objectStore.failWith = new StorageError("UNAVAILABLE");

      assertBareError(await fetchThumbnail(ctx.app, mediaId, ctx.parent.auth), 500, "INTERNAL");
    });
  });
});
