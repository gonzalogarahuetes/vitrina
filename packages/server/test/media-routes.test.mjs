/*
 * §9.6's media create, end to end over the REAL use-case graph with in-memory
 * repositories — api-sketch §9.3, §9.6, §9.1.
 * buildUseCases is imported rather than reimplemented, so these assert the
 * wiring production uses instead of a copy kept in step by hand.
 * Hermetic: app.inject, no Docker, no Postgres.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { describe, it } from "node:test";

import { OWNER_KDF_V1 } from "@vitrina/shared";

import { buildServer } from "../dist/adapters/driving/http/server.js";
import { buildUseCases } from "../dist/composition-root.js";
import { createCredentialHasher } from "../dist/adapters/driven/hashing/credential-hasher.js";
import { createTokenHasher } from "../dist/adapters/driven/hashing/token-hasher.js";
import { ApplicationError } from "../dist/application/errors.js";

const CLIENT_ORIGIN = "http://localhost:5173";
const SECRET = Buffer.alloc(32, 0x11);

const b64 = (fill, bytes) => Buffer.alloc(bytes, fill).toString("base64url");

/** The smallest legal envelope: 64-byte header, one byte, a 16-byte tag. */
const MIN_ENVELOPE = b64(0x5a, 81);

const mediaBody = (overrides = {}) => ({
  id: randomUUID(),
  kind: "photo",
  metadata: MIN_ENVELOPE,
  ...overrides,
});

const albumBody = () => ({
  id: randomUUID(),
  title: "Primer cumpleaños",
  wrapped_key: b64(0x42, 48),
  wrap_nonce: b64(0x43, 24),
});

const signupBody = (email) => ({
  email,
  proof: b64(0x21, 32),
  kdf_salt: b64(0x41, 16),
  kdf_memory_kib: OWNER_KDF_V1.memoryKib,
  kdf_iterations: OWNER_KDF_V1.iterations,
  kdf_parallelism: OWNER_KDF_V1.parallelism,
  wrapped_master: b64(0x44, 48),
  wrap_nonce: b64(0x45, 24),
});

function inMemoryOwners() {
  const owners = new Map();
  const byId = new Map();
  const tokens = new Map();
  return {
    async createWithPasswordKey(owner) {
      if (owners.has(owner.email)) throw new ApplicationError("DUPLICATE_ADDRESS");
      const row = { id: randomUUID(), createdAt: new Date("2026-09-24T09:00:00.000Z"), ...owner };
      owners.set(owner.email, row);
      byId.set(row.id, row);
      return { id: row.id, createdAt: row.createdAt };
    },
    async findCredentialByEmail(email) {
      const row = owners.get(email);
      return row ? { id: row.id, authHash: row.authHash } : null;
    },
    async findKdfByEmail(email) {
      const row = owners.get(email);
      return row ? { kdfSalt: row.passwordKey.kdfSalt, params: row.passwordKey.params } : null;
    },
    async findPasswordKeyByOwnerId(ownerId) {
      return byId.get(ownerId)?.passwordKey ?? null;
    },
    async insertToken(token) {
      tokens.set(Buffer.from(token.tokenHash).toString("hex"), {
        ownerId: token.ownerId,
        expiresAt: token.expiresAt,
        revokedAt: null,
      });
    },
    async findTokenByHash(tokenHash) {
      return tokens.get(Buffer.from(tokenHash).toString("hex")) ?? null;
    },
  };
}

function inMemoryAlbums() {
  const rows = new Map();
  return {
    rows,
    async create(album) {
      if (rows.has(album.id)) throw new ApplicationError("DUPLICATE_ALBUM_ID");
      const row = { ...album, createdAt: new Date("2026-09-24T09:00:00.000Z"), mediaCount: 0 };
      rows.set(album.id, row);
      return { id: row.id, createdAt: row.createdAt };
    },
    async listForOwner(ownerId) {
      return [...rows.values()].filter((row) => row.ownerId === ownerId);
    },
    async findById(albumId) {
      const row = rows.get(albumId);
      return row
        ? { id: row.id, ownerId: row.ownerId, title: row.title, createdAt: row.createdAt }
        : null;
    },
  };
}

/**
 * Records the row it was handed, so assertions can inspect the write.
 * `findById` resolves `ownerId` through the album, as the real query's join
 * does — a fake that returned it from the media row would let a broken scope
 * check pass.
 */
function inMemoryMedia(albums) {
  const rows = new Map();
  return {
    rows,
    async create(media) {
      if (rows.has(media.id)) throw new ApplicationError("DUPLICATE_MEDIA_ID");
      const row = {
        ...media,
        createdAt: new Date("2026-09-24T09:00:00.000Z"),
        updatedAt: new Date("2026-09-24T09:00:00.000Z"),
        status: "pending",
        byteSize: null,
      };
      rows.set(media.id, row);
      return { id: row.id, createdAt: row.createdAt, status: row.status };
    },
    async findById(mediaId) {
      const row = rows.get(mediaId);
      if (!row) return null;
      return { ...row, ownerId: albums.rows.get(row.albumId).ownerId };
    },
    /* §9.7's transitions, with the guards the SQL has — a fake without them
     * passes tests the database would fail. */
    async beginUpload(mediaId) {
      const row = rows.get(mediaId);
      if (!row) return null;
      if (row.status === "ready") return "already_ready";
      row.status = "processing";
      return "started";
    },
    async markReady(mediaId, byteSize) {
      const row = rows.get(mediaId);
      if (row.status !== "processing") return;
      row.status = "ready";
      row.byteSize = byteSize;
    },
    async markFailed(mediaId) {
      const row = rows.get(mediaId);
      if (row.status !== "processing") return;
      row.status = "failed";
    },
  };
}

/** The store, as key → length. Counts what it is actually handed. */
function fakeStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, body) {
      let written = 0;
      for await (const chunk of body) written += chunk.length;
      objects.set(key, written);
    },
    async head(key) {
      const length = objects.get(key);
      return length === undefined ? null : { length };
    },
  };
}

/** A server over the real graph, one signed-in owner, and one of their albums. */
async function buildTestServer() {
  const albums = inMemoryAlbums();
  const media = inMemoryMedia(albums);
  const objectStore = fakeStore();
  const useCases = buildUseCases(
    {
      owners: inMemoryOwners(),
      albums,
      media,
      objectStore,
      recipients: { async findGrantByTokenHash() { return null; } },
      credentialHasher: createCredentialHasher(SECRET),
      tokenHasher: createTokenHasher(),
      clock: { now: () => new Date("2026-09-24T09:00:00.000Z") },
    },
    { kdfV1: OWNER_KDF_V1, dummyAuthHash: Buffer.alloc(32, 0x7f) },
  );

  const app = await buildServer({
    config: { clientOrigin: CLIENT_ORIGIN },
    useCases,
    logger: false,
  });
  await app.ready();

  const signIn = async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/signup",
      payload: signupBody(`owner-${randomUUID()}@x.es`),
    });
    assert.equal(response.statusCode, 201, response.body);
    return { authorization: `Bearer ${response.json().token}` };
  };

  const auth = await signIn();
  const album = albumBody();
  const created = await app.inject({
    method: "POST",
    url: "/v1/albums",
    headers: auth,
    payload: album,
  });
  assert.equal(created.statusCode, 201, created.body);

  return { app, auth, signIn, album, albums, media, objectStore };
}

const postMedia = (app, auth, albumId, payload) =>
  app.inject({
    method: "POST",
    url: `/v1/albums/${albumId}/media`,
    headers: auth,
    payload,
  });

const getMedia = (app, auth, mediaId) =>
  app.inject({ method: "GET", url: `/v1/media/${mediaId}`, headers: auth });

describe("POST /v1/albums/{album_id}/media — §9.6", () => {
  it("creates the row at pending and returns the client's id", async () => {
    const { app, auth, album } = await buildTestServer();
    const body = mediaBody();

    const response = await postMedia(app, auth, album.id, body);

    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().id, body.id);
    // The status is the column the row was created with, not a literal the
    // route asserted — no route writes a status string (§9.7).
    assert.equal(response.json().status, "pending");
    assert.deepEqual(Object.keys(response.json()).sort(), ["created_at", "id", "status"]);
  });

  it("stores the envelope as bytes, decoded from base64url", async () => {
    // The route's whole job on the way in: base64url to bytes. The relay never
    // parses the header or checks `VTRN` (§9.1's format-blindness).
    const { app, auth, album, media } = await buildTestServer();
    const body = mediaBody();

    await postMedia(app, auth, album.id, body);
    const stored = media.rows.get(body.id);

    assert.ok(stored.metadata instanceof Uint8Array);
    assert.equal(stored.metadata.length, 81);
    assert.equal(Buffer.from(stored.metadata).toString("base64url"), MIN_ENVELOPE);
  });

  it("writes the path's album and no owner", async () => {
    /*
     * `media` has no owner column; the album owns the media. §9.3 uses the
     * caller only to decide whether the album is in scope.
     *
     * This does NOT prove the handler ignores a body-supplied `album_id` —
     * measured, as §9.2's owner_id case was: `removeAdditional` strips the key
     * before the handler runs, so the guard is `additionalProperties: false`
     * in the schema, and this is the end-to-end half.
     */
    const { app, auth, album, media } = await buildTestServer();
    const body = mediaBody();

    await postMedia(app, auth, album.id, body);

    assert.deepEqual(Object.keys(media.rows.get(body.id)).sort(), [
      "albumId",
      "byteSize",
      "createdAt",
      "id",
      "kind",
      "metadata",
      "status",
      "updatedAt",
    ]);
    assert.equal(media.rows.get(body.id).albumId, album.id);
  });

  it("is 409 on a duplicate id, with no details", async () => {
    // "Already created", never "try again": a new id would orphan the
    // envelope the client already encrypted under the old one.
    const { app, auth, album } = await buildTestServer();
    const body = mediaBody();
    await postMedia(app, auth, album.id, body);

    const response = await postMedia(app, auth, album.id, body);

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, "CONFLICT");
    assert.equal(response.json().details, undefined);
  });

  describe("§9.3 — absent and not-yours are one answer", () => {
    it("is 404 for an album that does not exist", async () => {
      const { app, auth } = await buildTestServer();

      const response = await postMedia(app, auth, randomUUID(), mediaBody());

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "NOT_FOUND");
    });

    it("is 404, byte for byte, for another owner's album", async () => {
      /*
       * The assertion §9.3 exists for. A `403` would confirm the album exists,
       * which brief §9.1 calls the easiest way to leak album access — so the
       * two responses are compared rather than each checked for a status.
       */
      const { app, auth, signIn, album } = await buildTestServer();
      const intruder = await signIn();

      const theirs = await postMedia(app, intruder, album.id, mediaBody());
      const absent = await postMedia(app, intruder, randomUUID(), mediaBody());

      assert.equal(theirs.statusCode, 404);
      assert.equal(theirs.body, absent.body);
    });

    it("writes nothing when the album is out of scope", async () => {
      const { app, signIn, album, media } = await buildTestServer();
      const intruder = await signIn();

      await postMedia(app, intruder, album.id, mediaBody());

      assert.equal(media.rows.size, 0);
    });
  });

  it("is 401 without a token, and resolves no scope first", async () => {
    // §7.3's order: authentication is step 1, scope is step 3. An unauthenticated
    // request must not learn whether the album exists.
    const { app, album } = await buildTestServer();

    const known = await postMedia(app, {}, album.id, mediaBody());
    const unknown = await postMedia(app, {}, randomUUID(), mediaBody());

    assert.equal(known.statusCode, 401);
    assert.equal(known.body, unknown.body);
  });

  describe("validation", () => {
    /*
     * WHICH CHECK REJECTS THESE, measured 24 September 2026 by widening the
     * decoder's bounds to 1–100000 and watching every case below still pass.
     * The schema's 108–5462 CHARACTER bounds do all the work: canonical
     * base64url maps them exactly onto 81–4096 bytes, so no string the schema
     * admits can decode outside the range. `decodeRangeOr400`'s byte bounds
     * are defence against a change to this schema, not an active second check.
     */
    const invalid = [
      ["an id that is not a uuid", { id: "not-a-uuid" }],
      ["a kind outside the v1 enum", { kind: "video" }],
      ["an envelope below 81 bytes", { metadata: b64(0x5a, 80) }],
      ["an envelope above 4096 bytes", { metadata: b64(0x5a, 4097) }],
      ["metadata that is not base64url", { metadata: "+".repeat(108) }],
    ];

    for (const [name, override] of invalid) {
      it(`rejects ${name}`, async () => {
        const { app, auth, album } = await buildTestServer();

        const response = await postMedia(app, auth, album.id, mediaBody(override));

        assert.equal(response.statusCode, 400, response.body);
        assert.equal(response.json().code, "VALIDATION_FAILED");
      });
    }

    it("accepts both ends of the envelope range", async () => {
      // 81 and 4096 bytes are inclusive bounds — a schema written with
      // exclusive ones rejects the smallest legal envelope there is.
      const { app, auth, album } = await buildTestServer();

      for (const size of [81, 4096]) {
        const response = await postMedia(
          app,
          auth,
          album.id,
          mediaBody({ metadata: b64(0x5a, size) }),
        );
        assert.equal(response.statusCode, 201, `${size} bytes: ${response.body}`);
      }
    });

    it("rejects an album_id that is not a uuid before resolving scope", async () => {
      // Without `format: "uuid"` on the path parameter this reaches Postgres
      // and 22P02 becomes a 500 rather than a 400.
      const { app, auth } = await buildTestServer();

      const response = await postMedia(app, auth, "not-a-uuid", mediaBody());

      assert.equal(response.statusCode, 400, response.body);
    });
  });
});

describe("GET /v1/media/{media_id} — §9.8", () => {
  /** Creates a row and hands back its id. */
  async function withMedia({ app, auth, album }) {
    const body = mediaBody();
    const created = await postMedia(app, auth, album.id, body);
    assert.equal(created.statusCode, 201, created.body);
    return body.id;
  }

  it("returns the seven fields §9.8 declares, and only those", async () => {
    const { app, auth, album } = await buildTestServer();
    const mediaId = await withMedia({ app, auth, album });

    const response = await getMedia(app, auth, mediaId);

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(Object.keys(response.json()).sort(), [
      "album_id",
      "byte_size",
      "created_at",
      "id",
      "kind",
      "status",
      "updated_at",
    ]);
  });

  it("carries no owner_id, which MediaRow holds for the scope check", async () => {
    /*
     * The row the use case returns has `ownerId` from §9.3's join.
     *
     * WHAT STOPS IT REACHING THE WIRE, measured 24 September 2026 by making
     * `statusBody` spread the row and watching this still pass: the response
     * schema's `additionalProperties: false`, not the handler's mapping. That
     * is a real outbound guard and the thing §6.2's owed PR 4 row generalises
     * — but it means this asserts the schema, and the explicit mapping in
     * `statusBody` is belt to its braces.
     */
    const { app, auth, album } = await buildTestServer();
    const mediaId = await withMedia({ app, auth, album });

    const body = (await getMedia(app, auth, mediaId)).json();

    assert.equal(body.owner_id, undefined);
    assert.equal(body.ownerId, undefined);
  });

  it("reports byte_size as null before ready, not as absent or zero", async () => {
    // §9.8: "integer once ready; null before". The field is required, so a
    // client can tell "not known yet" from "the server forgot to send it".
    const { app, auth, album } = await buildTestServer();
    const mediaId = await withMedia({ app, auth, album });

    const body = (await getMedia(app, auth, mediaId)).json();

    assert.ok("byte_size" in body);
    assert.strictEqual(body.byte_size, null);
    assert.equal(body.status, "pending");
    assert.equal(body.album_id, album.id);
  });

  it("is 404, byte for byte, for another owner's media and for an absent one", async () => {
    /*
     * §9.3's `{media_id}` row: the join must resolve to the caller, else 404.
     * Without the check every owner can poll every row in the system by
     * guessing an id — and a status that differed between the two cases would
     * confirm the row exists, which is what the identical bodies rule out.
     */
    const { app, auth, signIn, album } = await buildTestServer();
    const mediaId = await withMedia({ app, auth, album });
    const intruder = await signIn();

    const theirs = await getMedia(app, intruder, mediaId);
    const absent = await getMedia(app, intruder, randomUUID());

    assert.equal(theirs.statusCode, 404);
    assert.equal(theirs.body, absent.body);
    assert.equal(theirs.json().code, "NOT_FOUND");
  });

  it("answers through the one envelope, with no hand-rolled body", async () => {
    // A route that built its own 404 would send {message} with no `code`, and
    // a client branching on `code` would see undefined (§1.1).
    const { app, auth } = await buildTestServer();

    const response = await getMedia(app, auth, randomUUID());

    assert.deepEqual(Object.keys(response.json()).sort(), ["code", "message"]);
  });

  it("is 401 without a token, and resolves no scope first", async () => {
    const { app, auth, album } = await buildTestServer();
    const mediaId = await withMedia({ app, auth, album });

    const known = await getMedia(app, {}, mediaId);
    const unknown = await getMedia(app, {}, randomUUID());

    assert.equal(known.statusCode, 401);
    assert.equal(known.body, unknown.body);
  });

  it("rejects a media_id that is not a uuid", async () => {
    const { app, auth } = await buildTestServer();

    const response = await getMedia(app, auth, "not-a-uuid");

    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, "VALIDATION_FAILED");
  });
});

/*
 * §9.7's uploads run over a REAL SOCKET, not app.inject, and that is not a
 * preference. The route decides between answering and staying silent on
 * `request.raw.complete`, which light-my-request does not model — it is
 * `undefined` under inject, so every upload would take the hijack branch and
 * the assertion would hang rather than fail. These two routes are the first
 * in the system whose contract is about the connection rather than the body,
 * so they are the first that a mock request cannot express.
 */

/** A `PUT` with the framing under the test's control. */
function putObject(port, path, options = {}) {
  const { auth = {}, body, contentType = "application/octet-stream" } = options;
  return new Promise((resolve) => {
    const headers = { ...auth };
    if (contentType !== null) headers["content-type"] = contentType;
    // Node uses chunked when a body is written and this is unset, which is how
    // the `411` case is expressed — there is no other way to omit it.
    if (!options.omitLength) {
      headers["content-length"] = String(options.contentLength ?? body?.length ?? 0);
    }

    const request = http.request(
      { host: "127.0.0.1", port, method: "PUT", path, headers },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => (raw += chunk));
        response.on("end", () =>
          resolve({ statusCode: response.statusCode, body: raw, json: () => JSON.parse(raw) }),
        );
      },
    );
    request.on("error", (error) => resolve({ statusCode: null, error: error.code }));
    // A hijacked reply never answers, so the assertion needs a deadline of its
    // own or it hangs instead of failing.
    setTimeout(() => resolve({ statusCode: "NO RESPONSE", body: "" }), 2000).unref();

    if (body) request.write(body);
    request.end();
  });
}

/** A body of `bytes`, which is also what the server must count. */
const envelope = (bytes) => Buffer.alloc(bytes, 0x5a);

describe("PUT /v1/media/{media_id}/{asset,thumbnail} — §9.7", () => {
  /** A listening server, a signed-in owner, an album and a `pending` row. */
  async function withMedia(t) {
    const server = await buildTestServer();
    const body = mediaBody();
    const created = await postMedia(server.app, server.auth, server.album.id, body);
    assert.equal(created.statusCode, 201, created.body);

    await server.app.listen({ host: "127.0.0.1", port: 0 });
    t.after(() => server.app.close());

    const port = server.app.server.address().port;
    const put = (variant, options) =>
      putObject(port, `/v1/media/${body.id}/${variant}`, { auth: server.auth, ...options });

    return { ...server, mediaId: body.id, port, put };
  }

  describe("the pre-read checks", () => {
    it("is 411 with no Content-Length", async (t) => {
      const { put } = await withMedia(t);

      const response = await put("asset", { body: envelope(200), omitLength: true });

      assert.equal(response.statusCode, 411, response.body);
      assert.equal(response.json().code, "LENGTH_REQUIRED");
    });

    it("is 400 below the 81-byte floor", async (t) => {
      /*
       * The one check the confirming HEAD cannot back up: a zero-length body
       * compares a count of 0 against a length of 0 and matches, so it would
       * reach `ready` — the only false `ready` the evidence rule admits.
       */
      const { put, media, mediaId } = await withMedia(t);

      for (const bytes of [0, 80]) {
        const response = await put("asset", { body: envelope(bytes) });

        assert.equal(response.statusCode, 400, `${bytes} bytes: ${response.body}`);
        assert.equal(media.rows.get(mediaId).status, "pending", "the row must not move");
      }
    });

    it("accepts exactly 81 bytes", async (t) => {
      // The floor is inclusive: 81 is the smallest legal envelope, not the
      // smallest rejected one.
      const { put } = await withMedia(t);

      const response = await put("asset", { body: envelope(81) });

      assert.equal(response.statusCode, 200, response.body);
    });

    it("is 400 for a malformed Content-Length", async (t) => {
      // `Number("abc")` is NaN, and `NaN > max` is false — without the integer
      // guard a malformed framing passes every check below it.
      const { put } = await withMedia(t);

      const response = await put("asset", { body: envelope(200), contentLength: "abc" });

      assert.ok(
        response.statusCode === 400 || response.statusCode === null,
        `expected 400 or a refused framing, got ${response.statusCode}`,
      );
    });

    const refusedTypes = [
      // `application/json` and `text/plain` are the two Fastify installs by
      // default, and both would be accepted without the nested scope: JSON
      // answers `400` from its own parser, and text/plain answers `200` with
      // `request.body` a STRING — on which the deadline's `destroy()` fails
      // and the counting generator iterates characters (§9.7, measured).
      "application/json",
      "text/plain",
      // And one Fastify has no parser for, which would be refused either way.
      "image/jpeg",
    ];
    for (const contentType of refusedTypes) {
      it(`is 415 for ${contentType}`, async (t) => {
        const { put } = await withMedia(t);

        const response = await put("asset", { body: envelope(200), contentType });

        assert.equal(response.statusCode, 415, `${contentType}: ${response.body}`);
      });
    }

    it("is 401 without a token, before any of the above", async (t) => {
      const { port, mediaId } = await withMedia(t);

      const response = await putObject(port, `/v1/media/${mediaId}/asset`, {
        body: envelope(200),
        omitLength: true,
      });

      assert.equal(response.statusCode, 401, "authentication precedes 411");
    });
  });

  describe("the ceiling is per variant and the floor is not", () => {
    const OVER_THUMBNAIL = 1024 * 1024 + 1;

    it("refuses a body over 1 MiB on the thumbnail", async (t) => {
      const { put } = await withMedia(t);

      const response = await put("thumbnail", { body: envelope(OVER_THUMBNAIL) });

      assert.equal(response.statusCode, 413, response.body);
      assert.equal(response.json().code, "PAYLOAD_TOO_LARGE");
    });

    it("accepts the same body on the asset, whose ceiling is 16 MiB", async (t) => {
      /*
       * The assertion the extraction exists for. One handler serves both
       * variants, so the ceiling is a parameter and the floor is not — and a
       * copied handler carrying the asset's constant passes the test above
       * and fails this one, or the reverse.
       */
      const { put } = await withMedia(t);

      const response = await put("asset", { body: envelope(OVER_THUMBNAIL) });

      assert.equal(response.statusCode, 200, response.body);
    });
  });

  describe("§9.3 scope and §9.7's 409", () => {
    it("is 404 for an unknown media id", async (t) => {
      const { port, auth } = await withMedia(t);

      const response = await putObject(port, `/v1/media/${randomUUID()}/asset`, {
        auth,
        body: envelope(200),
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "NOT_FOUND");
    });

    it("is 404, byte for byte, for another owner's media", async (t) => {
      const { port, signIn, mediaId } = await withMedia(t);
      const intruder = await signIn();

      const theirs = await putObject(port, `/v1/media/${mediaId}/asset`, {
        auth: intruder,
        body: envelope(200),
      });
      const absent = await putObject(port, `/v1/media/${randomUUID()}/asset`, {
        auth: intruder,
        body: envelope(200),
      });

      assert.equal(theirs.statusCode, 404);
      assert.equal(theirs.body, absent.body);
    });

    it("is 409 once the row is ready", async (t) => {
      // "PUT is idempotent" is the instinct that removes this check; after
      // `ready`, replacing an object a recipient may be mid-fetch on is editing.
      const { put } = await withMedia(t);
      await put("asset", { body: envelope(200) });
      await put("thumbnail", { body: envelope(100) });

      const response = await put("asset", { body: envelope(200) });

      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().code, "CONFLICT");
    });
  });

  describe("the ladder, through the route", () => {
    it("answers §9.8's status object, processing after one object", async (t) => {
      const { put } = await withMedia(t);

      const response = await put("asset", { body: envelope(200) });

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().status, "processing");
      assert.equal(response.json().byte_size, null);
      assert.deepEqual(Object.keys(response.json()).sort(), [
        "album_id",
        "byte_size",
        "created_at",
        "id",
        "kind",
        "status",
        "updated_at",
      ]);
    });

    it("reaches ready on the second object, with byte_size the sum", async (t) => {
      const { put } = await withMedia(t);

      await put("asset", { body: envelope(200) });
      const response = await put("thumbnail", { body: envelope(100) });

      assert.equal(response.json().status, "ready");
      assert.strictEqual(response.json().byte_size, 300);
    });

    it("reaches ready in the other order too", async (t) => {
      // §9.7: "Order is free. Asset first or thumbnail first; `ready` waits
      // for both." One handler is what makes that true rather than asserted.
      const { put } = await withMedia(t);

      await put("thumbnail", { body: envelope(100) });
      const response = await put("asset", { body: envelope(200) });

      assert.equal(response.json().status, "ready");
      assert.strictEqual(response.json().byte_size, 300);
    });

    it("writes each variant to its own key", async (t) => {
      const { put, mediaId, objectStore } = await withMedia(t);

      await put("asset", { body: envelope(200) });
      await put("thumbnail", { body: envelope(100) });

      assert.equal(objectStore.objects.get(`media/${mediaId}/asset`), 200);
      assert.equal(objectStore.objects.get(`media/${mediaId}/thumbnail`), 100);
    });
  });
});
