/*
 * `DELETE /v1/media/{media_id}` — api-sketch §9.11, over the real graph with
 * in-memory ports. buildUseCases is imported rather than reimplemented.
 *
 * Two halves. The route: 204 means erased, 202 means hidden with erasure
 * pending, and a repeated DELETE after the row is gone is the same 404 as an
 * absent or another owner's id. The read side: a hidden row is refused or
 * omitted by every route that serves or accepts media.
 *
 * WHAT THIS FILE CANNOT SHOW. The read-side filters are SQL — `removed_at IS
 * NULL` in four repository methods — and the fake below implements them, so
 * the second half asserts that no route reaches a media row by a path that
 * skips the port, not that the SQL is right. infra/media-repository.test.mjs
 * asserts the SQL, and infra/media-removal-journey.test.mjs the whole path.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { StorageError } from "../dist/application/ports/object-store.js";
import { b64, buildPr2Server, sha256 } from "./support/pr2-graph.mjs";

const NOW = new Date("2026-10-09T09:00:00.000Z");
const ENVELOPE = Buffer.alloc(120, 0x33);

/**
 * The media port with §9.11's semantics where the SQL has them: hidden rows
 * are invisible to the three reads and refused by `beginUpload`; `hide` is
 * owner-scoped and keeps the first `removed_at`; `erase` deletes only a hidden
 * row with nothing in flight.
 */
function inMemoryMedia(albums) {
  const rows = new Map();
  const live = (row) => row !== undefined && row.removedAt === null;
  return {
    rows,
    add(albumId, status = "ready") {
      const id = randomUUID();
      rows.set(id, {
        id, albumId, kind: "photo", status, metadata: ENVELOPE,
        byteSize: status === "ready" ? 300 : null,
        createdAt: new Date(NOW.getTime() + rows.size), updatedAt: NOW,
        removedAt: null, inFlight: 0,
      });
      return id;
    },
    async findById(mediaId) {
      const row = rows.get(mediaId.toLowerCase());
      if (!live(row)) return null;
      const { removedAt, inFlight, metadata, ...rest } = row;
      return { ...rest, ownerId: albums.rows.get(row.albumId).ownerId };
    },
    async listByAlbum(albumId) {
      return [...rows.values()]
        .filter((row) => row.albumId === albumId && live(row))
        .map(({ id, createdAt, kind, status }) => ({ id, createdAt, kind, status }));
    },
    async listReadyEnvelopes(albumId) {
      return [...rows.values()]
        .filter((row) => row.albumId === albumId && live(row) && row.status === "ready")
        .map((row) => ({ mediaId: row.id, envelope: row.metadata }));
    },
    async beginUpload(mediaId) {
      const row = rows.get(mediaId);
      if (!live(row)) return null;
      if (row.status === "ready") return "already_ready";
      row.status = "processing";
      row.inFlight += 1;
      return "started";
    },
    async endUpload(mediaId) {
      const row = rows.get(mediaId);
      if (!row) throw new Error("endUpload on a row that cannot be gone");
      row.inFlight -= 1;
      return row.removedAt === null
        ? { state: "live" }
        : { state: "removed", uploadsInFlight: row.inFlight };
    },
    async markReady(mediaId, byteSize) {
      const row = rows.get(mediaId);
      if (!live(row) || row.status !== "processing") return;
      row.status = "ready";
      row.byteSize = byteSize;
    },
    async markFailed(mediaId) {
      const row = rows.get(mediaId);
      if (row?.status === "processing") row.status = "failed";
    },
    async hide(mediaId, ownerId) {
      const row = rows.get(mediaId.toLowerCase());
      if (!row || albums.rows.get(row.albumId).ownerId !== ownerId) return null;
      row.removedAt ??= NOW;
      return { id: row.id, uploadsInFlight: row.inFlight };
    },
    async erase(mediaId) {
      const row = rows.get(mediaId);
      if (!row || row.removedAt === null || row.inFlight !== 0) return false;
      rows.delete(mediaId);
      return true;
    },
  };
}

/** key → bytes. `removeFails` stands for an unreachable store on DELETE. */
function fakeStore() {
  const store = {
    objects: new Map(),
    gets: [],
    removeFails: false,
    getHook: null,
    putHook: null,
    seed(mediaId) {
      store.objects.set(`media/${mediaId}/asset`, Buffer.alloc(200, 0xaa));
      store.objects.set(`media/${mediaId}/thumbnail`, Buffer.alloc(100, 0xbb));
    },
    async put(key, body) {
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      store.objects.set(key, Buffer.concat(chunks));
      store.putHook?.(key);
    },
    async head(key) {
      const bytes = store.objects.get(key);
      return bytes === undefined ? null : { length: bytes.length };
    },
    async get(key, range) {
      store.gets.push(key);
      store.getHook?.(key);
      const bytes = store.objects.get(key);
      if (bytes === undefined) throw new StorageError("NOT_FOUND");
      if (range === undefined) return { body: Readable.from([bytes]), contentLength: bytes.length };
      const end = Math.min(range.end ?? bytes.length - 1, bytes.length - 1);
      const slice = bytes.subarray(range.start, end + 1);
      return {
        body: Readable.from([slice]),
        contentLength: slice.length,
        contentRange: { start: range.start, end, size: bytes.length },
      };
    },
    async remove(key) {
      if (store.removeFails) {
        throw new StorageError("UNAVAILABLE", { cause: new Error(`DELETE ${key}`) });
      }
      store.objects.delete(key);
    },
  };
  return store;
}

function fakeAccessLogs() {
  const logs = { rows: [], async record(event) { logs.rows.push(event); } };
  return logs;
}

async function setup({ captureLogs = false } = {}) {
  const objectStore = fakeStore();
  const accessLogs = fakeAccessLogs();
  const logLines = [];
  let media;
  const server = await buildPr2Server({
    // Forwarded, because the fake needs the graph's albums to resolve owners.
    media: Object.fromEntries(
      ["findById", "listByAlbum", "listReadyEnvelopes", "beginUpload", "endUpload",
        "markReady", "markFailed", "hide", "erase"].map((name) => [name, (...a) => media[name](...a)]),
    ),
    objectStore,
    accessLogs,
    logger: captureLogs
      ? { level: "trace", stream: { write: (line) => logLines.push(JSON.parse(line)) } }
      : false,
  });
  media = inMemoryMedia(server.albums);

  const parent = await server.owner();
  const albumId = await server.album(parent.auth);

  /** A ready row with both objects in the store. */
  const readyMedia = () => {
    const id = media.add(albumId);
    objectStore.seed(id);
    return id;
  };

  return { ...server, media, objectStore, accessLogs, logLines, parent, albumId, readyMedia };
}

/** A qr recipient of `albumId`, through §7.7. */
async function recipient({ app, parent }, albumId) {
  const token = randomBytes(32);
  const created = await app.inject({
    method: "POST",
    url: `/v1/albums/${albumId}/recipients`,
    headers: parent.auth,
    payload: { id: randomUUID(), kind: "qr", label: b64(0x6c, 60), token_hash: sha256(token).toString("base64url"), wrapped: b64(0x77, 48), wrap_nonce: b64(0x6e, 24) },
  });
  assert.equal(created.statusCode, 201, created.body);
  return { authorization: `Bearer ${token.toString("base64url")}` };
}

const remove = (app, mediaId, headers) =>
  app.inject({ method: "DELETE", url: `/v1/media/${mediaId}`, headers });

const get = (app, url, headers) => app.inject({ method: "GET", url, headers });

describe("DELETE /v1/media/{media_id} — §9.11", () => {
  it("is 204 with no body once both objects and the row are gone", async () => {
    const { app, parent, media, objectStore, readyMedia } = await setup();
    const id = readyMedia();

    const response = await remove(app, id, parent.auth);

    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.body, "");
    assert.equal(objectStore.objects.size, 0, "an object survived a 204");
    assert.equal(media.rows.has(id), false, "the row survived a 204");
  });

  it("is 202 with no body while an upload is in flight, and the row is hidden", async () => {
    // Hidden at once — every read refuses it — but not erased: the PUT that
    // started before the hide may land after any delete issued now.
    const { app, parent, media, readyMedia } = await setup();
    const id = readyMedia();
    media.rows.get(id).inFlight = 1;

    const response = await remove(app, id, parent.auth);

    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.body, "");
    assert.equal(media.rows.has(id), true, "erased with an upload in flight");
    assert.equal((await get(app, `/v1/media/${id}`, parent.auth)).statusCode, 404);
  });

  it("is 202 when the store is unreachable, logs the cause at error, and a retry finishes it", async () => {
    // The owner's intent has taken effect; what failed is the erasure, which
    // is a retry. A 500 would tell the client nothing happened.
    const { app, parent, media, objectStore, logLines, readyMedia } = await setup({ captureLogs: true });
    const id = readyMedia();
    objectStore.removeFails = true;

    const pending = await remove(app, id, parent.auth);

    assert.equal(pending.statusCode, 202, pending.body);
    assert.equal(pending.body, "");
    const logged = logLines.find((line) => line.level === 50);
    assert.ok(logged, `expected an error line, got: ${JSON.stringify(logLines)}`);
    assert.equal(logged.err.type, "StorageError");

    objectStore.removeFails = false;
    const retried = await remove(app, id, parent.auth);

    assert.equal(retried.statusCode, 204, retried.body);
    assert.equal(objectStore.objects.size, 0);
    assert.equal(media.rows.has(id), false);
  });

  it("is 404 when repeated after a 204, byte for byte the same as an absent id", async () => {
    // A client whose 204 was lost retries and gets 404. That means done: the
    // row was deleted only after both objects were confirmed absent.
    const { app, parent, readyMedia } = await setup();
    const id = readyMedia();
    assert.equal((await remove(app, id, parent.auth)).statusCode, 204);

    const repeated = await remove(app, id, parent.auth);
    const absent = await remove(app, randomUUID(), parent.auth);

    assert.equal(repeated.statusCode, 404);
    assert.equal(repeated.json().code, "NOT_FOUND");
    assert.equal(repeated.body, absent.body);
  });

  it("is 404 for another owner's media, identical to absent, and touches nothing", async () => {
    // §7.3: a 204 here would also have to be the answer for an absent id, and
    // would report an erasure that did not happen.
    const { app, owner, parent, media, objectStore, readyMedia } = await setup();
    const id = readyMedia();
    const intruder = await owner();

    const theirs = await remove(app, id, intruder.auth);
    const absent = await remove(app, randomUUID(), intruder.auth);

    assert.equal(theirs.statusCode, 404);
    assert.equal(theirs.body, absent.body);
    assert.equal(media.rows.get(id).removedAt, null, "another owner's DELETE hid the row");
    assert.equal(objectStore.objects.size, 2);
    assert.equal((await get(app, `/v1/media/${id}`, parent.auth)).statusCode, 200);
  });

  it("is 401 for a recipient, even on media in their own album — owner scheme only", async () => {
    const ctx = await setup();
    const id = ctx.readyMedia();
    const viewer = await recipient(ctx, ctx.albumId);

    const response = await remove(ctx.app, id, viewer);

    assert.equal(response.statusCode, 401, response.body);
    assert.equal(ctx.media.rows.get(id).removedAt, null);
  });

  it("is 401 without a token, and resolves no scope first", async () => {
    const { app, readyMedia } = await setup();
    const id = readyMedia();

    const known = await remove(app, id, {});
    const unknown = await remove(app, randomUUID(), {});

    assert.equal(known.statusCode, 401);
    assert.equal(known.body, unknown.body);
  });

  it("is 400 for a media_id that is not a uuid", async () => {
    const { app, parent } = await setup();

    const response = await remove(app, "not-a-uuid", parent.auth);

    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, "VALIDATION_FAILED");
  });

  it("writes no access_log row — an owner action is not an open", async () => {
    const { app, parent, accessLogs, readyMedia } = await setup();

    await remove(app, readyMedia(), parent.auth);

    assert.deepEqual(accessLogs.rows, []);
  });
});

describe("a hidden row is refused or omitted everywhere — §9.11", () => {
  /*
   * Hidden and not yet erased — the 202 state, reached through the route
   * itself with the store refusing deletes. Each read is paired with a live
   * `ready` row in the same album, so a filter that drops everything fails.
   */
  async function hidden() {
    const ctx = await setup();
    const keep = ctx.readyMedia();
    const gone = ctx.readyMedia();
    const viewer = await recipient(ctx, ctx.albumId);
    ctx.objectStore.removeFails = true;
    assert.equal((await remove(ctx.app, gone, ctx.parent.auth)).statusCode, 202);
    ctx.objectStore.removeFails = false;
    assert.equal(ctx.objectStore.objects.size, 4, "the objects are meant to still exist here");
    return { ...ctx, keep, gone, viewer };
  }

  for (const who of ["parent", "viewer"]) {
    it(`§9.4 album details omit it, for the ${who === "parent" ? "owner" : "recipient"}`, async () => {
      const ctx = await hidden();
      const headers = who === "parent" ? ctx.parent.auth : ctx.viewer;

      const response = await get(ctx.app, `/v1/albums/${ctx.albumId}`, headers);

      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().media.map((m) => m.id), [ctx.keep]);
    });

    it(`§9.5 metadata omits it, for the ${who === "parent" ? "owner" : "recipient"}`, async () => {
      const ctx = await hidden();
      const headers = who === "parent" ? ctx.parent.auth : ctx.viewer;

      const response = await get(ctx.app, `/v1/albums/${ctx.albumId}/metadata`, headers);

      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().metadata.map((m) => m.media_id), [ctx.keep]);
    });

    for (const variant of ["asset", "thumbnail"]) {
      it(`§11 ${variant} is 404 and the store is never asked, for the ${who === "parent" ? "owner" : "recipient"}`, async () => {
        const ctx = await hidden();
        const headers = { ...(who === "parent" ? ctx.parent.auth : ctx.viewer), range: "bytes=0-" };

        const response = await get(ctx.app, `/v1/media/${ctx.gone}/${variant}`, headers);
        const absent = await get(ctx.app, `/v1/media/${randomUUID()}/${variant}`, headers);

        assert.equal(response.statusCode, 404, response.body);
        assert.equal(response.body, absent.body);
        assert.deepEqual(ctx.objectStore.gets, []);
        assert.deepEqual(ctx.accessLogs.rows, [], "a refused fetch wrote an open");
      });
    }
  }

  it("§9.8 status is 404, identical to absent", async () => {
    const ctx = await hidden();

    const response = await get(ctx.app, `/v1/media/${ctx.gone}`, ctx.parent.auth);
    const absent = await get(ctx.app, `/v1/media/${randomUUID()}`, ctx.parent.auth);

    assert.equal(response.statusCode, 404);
    assert.equal(response.body, absent.body);
  });

  for (const variant of ["asset", "thumbnail"]) {
    it(`§9.7 PUT ${variant} is 404 — not 409, and nothing is written`, async () => {
      // The row was `ready`, which §9.7 answers 409. Hidden, it does not exist.
      const ctx = await hidden();
      const before = ctx.objectStore.objects.get(`media/${ctx.gone}/${variant}`);

      const response = await ctx.app.inject({
        method: "PUT",
        url: `/v1/media/${ctx.gone}/${variant}`,
        headers: { ...ctx.parent.auth, "content-type": "application/octet-stream" },
        payload: Buffer.alloc(100, 0x77),
      });

      assert.equal(response.statusCode, 404, response.body);
      assert.equal(ctx.objectStore.objects.get(`media/${ctx.gone}/${variant}`), before);
    });
  }
});

describe("a fetch racing a removal — §9.11 against §11.2 and §11.3", () => {
  /*
   * The fetch read a live row; the removal hid it and deleted the objects
   * before the fetch reached the store. Until §9.11 that NOT_FOUND was a
   * broken invariant and a 500, because nothing deleted a `ready` row's
   * objects. Now it is a removal, and the answer is the 404 a request one
   * moment later would get. A `ready` row whose object is missing with no
   * removal in sight is still the 500.
   */
  for (const variant of ["asset", "thumbnail"]) {
    it(`${variant}: 404 when the row was hidden between the lookup and the store`, async () => {
      const ctx = await setup();
      const id = ctx.readyMedia();
      ctx.objectStore.getHook = () => {
        ctx.media.rows.get(id).removedAt = NOW;
        ctx.objectStore.objects.clear();
      };

      const response = await get(ctx.app, `/v1/media/${id}/${variant}`, {
        ...ctx.parent.auth,
        range: "bytes=0-",
      });

      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.json().code, "NOT_FOUND");
    });

    it(`${variant}: still 500 when a live ready row's object is missing`, async () => {
      const ctx = await setup();
      const id = ctx.readyMedia();
      ctx.objectStore.objects.clear();

      const response = await get(ctx.app, `/v1/media/${id}/${variant}`, {
        ...ctx.parent.auth,
        range: "bytes=0-",
      });

      assert.equal(response.statusCode, 500, response.body);
    });
  }
});

describe("an upload that finishes onto a hidden row — §9.11 at the route", () => {
  /*
   * The DELETE landed while this PUT streamed (the hook stands in for it),
   * and this upload is the last one out, so it runs the erasure a DELETE runs.
   */
  async function uploadingWhenHidden({ captureLogs = false } = {}) {
    const ctx = await setup({ captureLogs });
    const id = ctx.media.add(ctx.albumId, "processing");
    ctx.objectStore.objects.set(`media/${id}/thumbnail`, Buffer.alloc(100, 0xbb));
    ctx.objectStore.putHook = () => {
      ctx.media.rows.get(id).removedAt = NOW;
    };
    const put = () =>
      ctx.app.inject({
        method: "PUT",
        url: `/v1/media/${id}/asset`,
        headers: { ...ctx.parent.auth, "content-type": "application/octet-stream" },
        payload: Buffer.alloc(200, 0x77),
      });
    return { ...ctx, id, put };
  }

  it("answers 404, and the row and both objects are gone", async () => {
    const { id, put, media, objectStore } = await uploadingWhenHidden();

    const response = await put();

    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().code, "NOT_FOUND");
    assert.equal(objectStore.objects.size, 0, "an object survived the last upload out");
    assert.equal(media.rows.has(id), false, "the row survived the last upload out");
  });

  it("answers 404 when the erasure cannot reach the store, logs it at error, and keeps the row hidden", async () => {
    // The level §9.11 gives the DELETE path's unreachable store. The envelope
    // alone logs an ApplicationError's cause at warn, which is not enough.
    const { id, put, media, objectStore, logLines } = await uploadingWhenHidden({ captureLogs: true });
    objectStore.removeFails = true;

    const response = await put();

    assert.equal(response.statusCode, 404, response.body);
    assert.ok(media.rows.has(id), "erased with the objects unconfirmed");
    assert.notEqual(media.rows.get(id).removedAt, null);
    const logged = logLines.find((line) => line.level === 50 && JSON.stringify(line).includes("StorageError"));
    assert.ok(logged, `expected an error line carrying the StorageError, got: ${JSON.stringify(logLines)}`);
  });
});
