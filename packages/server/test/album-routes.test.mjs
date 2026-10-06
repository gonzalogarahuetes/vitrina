/*
 * §9.2's two album routes, end to end over the REAL use-case graph with an
 * in-memory repository — api-sketch §9.2, §4.1, §8.3.
 * buildUseCases is imported rather than reimplemented, so these assert the
 * wiring production uses instead of a copy kept in step by hand.
 * Hermetic: app.inject, no Docker, no Postgres.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The same bytes, spelled with the final character's spare bits set — a
 * string the schema's pattern and length accept and only the decoder refuses.
 */
const nonCanonical = (encoded) =>
  encoded.slice(0, -1) + ALPHABET[ALPHABET.indexOf(encoded.at(-1)) + 1];

/**
 * A well-formed §9.2 body; the wrapping distinct per album so a swap shows.
 * The title is ciphertext since 003 — arbitrary bytes here, because the relay
 * never opens it (encryption spec §2).
 */
const albumBody = (overrides = {}) => ({
  id: randomUUID(),
  title: b64(0x51, 60),
  wrapped_key: b64(0x42, 48),
  wrap_nonce: b64(0x43, 24),
  ...overrides,
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

/** The owner port, in a Map. Enough to mint a token; the real one has its own tests. */
function inMemoryOwners() {
  const owners = new Map();
  const byId = new Map();
  const tokens = new Map();

  return {
    async createWithPasswordKey(owner) {
      if (owners.has(owner.email)) throw new ApplicationError("DUPLICATE_ADDRESS");
      const row = { id: randomUUID(), createdAt: new Date("2026-09-21T09:00:00.000Z"), ...owner };
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

/**
 * The album port, in a Map. `mediaCount` is settable because §9.2's count is
 * the media repository's business and this file is about the two album routes.
 */
function inMemoryAlbums() {
  const rows = new Map(); // id -> row

  return {
    rows,
    async create(album) {
      if (rows.has(album.id)) {
        // The real adapter raises this from the PK; the envelope matches on
        // instanceof, so a look-alike with the right code would be a 500.
        throw new ApplicationError("DUPLICATE_ALBUM_ID");
      }
      const row = { ...album, createdAt: new Date("2026-09-21T09:00:00.000Z"), mediaCount: 0 };
      rows.set(album.id, row);
      return { id: row.id, createdAt: row.createdAt };
    },
    async listForOwner(ownerId) {
      return [...rows.values()]
        .filter((row) => row.ownerId === ownerId)
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    },
    async findById(albumId) {
      const row = rows.get(albumId);
      return row
        ? { id: row.id, ownerId: row.ownerId, title: row.title, createdAt: row.createdAt }
        : null;
    },
  };
}


/** §9.4's listing and §9.5's envelopes, from one map of rows. */
function inMemoryMedia() {
  const rows = new Map();
  return {
    rows,
    add(albumId, { status = "pending", envelope = Buffer.alloc(81, 0x11) } = {}) {
      const id = randomUUID();
      rows.set(id, {
        id,
        albumId,
        kind: "photo",
        status,
        metadata: envelope,
        createdAt: new Date(`2026-09-21T09:00:0${rows.size}.000Z`),
      });
      return id;
    },
    async listByAlbum(albumId) {
      // §9.4: every row, whatever its status, oldest first.
      return [...rows.values()]
        .filter((row) => row.albumId === albumId)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async listReadyEnvelopes(albumId) {
      // §9.5: the one place the server filters on status.
      return [...rows.values()]
        .filter((row) => row.albumId === albumId && row.status === "ready")
        .map((row) => ({ mediaId: row.id, envelope: row.metadata }));
    },
  };
}

/**
 * §7.7's create route is PR 2's and unbuilt, so grants are registered here —
 * keyed by the hash the real TokenHasher produces, as the table would be.
 */
function inMemoryRecipients() {
  const byHash = new Map();
  const hasher = createTokenHasher();
  return {
    grant(albumId, { revokedAt = null } = {}) {
      const token = Buffer.alloc(32, byHash.size + 1);
      byHash.set(Buffer.from(hasher.hash(token)).toString("hex"), {
        id: randomUUID(),
        albumId,
        revokedAt,
      });
      return { authorization: `Bearer ${token.toString("base64url")}` };
    },
    async findGrantByTokenHash(tokenHash) {
      return byHash.get(Buffer.from(tokenHash).toString("hex")) ?? null;
    },
  };
}

/** A server over the real graph, plus a signed-in owner's bearer token. */
async function buildTestServer() {
  const albums = inMemoryAlbums();
  const media = inMemoryMedia();
  const recipients = inMemoryRecipients();
  const useCases = buildUseCases(
    {
      owners: inMemoryOwners(),
      albums,
      media,
      recipients,
      objectStore: { async put() {}, async head() { return null; } },
      credentialHasher: createCredentialHasher(SECRET),
      tokenHasher: createTokenHasher(),
      clock: { now: () => new Date("2026-09-21T09:00:00.000Z") },
    },
    { kdfV1: OWNER_KDF_V1, dummyAuthHash: Buffer.alloc(32, 0x7f) },
  );

  const app = await buildServer({
    config: { clientOrigin: CLIENT_ORIGIN },
    useCases,
    logger: false,
  });
  await app.ready();

  const signup = await app.inject({
    method: "POST",
    url: "/v1/signup",
    payload: signupBody(`owner-${randomUUID()}@x.es`),
  });
  assert.equal(signup.statusCode, 201, signup.body);

  return {
    app,
    albums,
    media,
    recipients,
    auth: { authorization: `Bearer ${signup.json().token}` },
  };
}

const createAlbum = (app, auth, body) =>
  app.inject({ method: "POST", url: "/v1/albums", headers: auth, payload: body });

const listAlbums = (app, auth) =>
  app.inject({ method: "GET", url: "/v1/albums", headers: auth });

describe("POST /v1/albums — §9.2", () => {
  it("returns 201 with the client's own id", async () => {
    // §9.2 returns the id the client generated, as §7.7 and §9.6 do. It looks
    // redundant and is not: it is the created resource's identifier.
    const { app, auth } = await buildTestServer();
    const body = albumBody();

    const response = await createAlbum(app, auth, body);

    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().id, body.id);
    assert.match(response.json().created_at, /Z$/);
    assert.deepEqual(Object.keys(response.json()).sort(), ["created_at", "id"]);
  });

  it("ignores an owner_id in the body, and files the album under the caller", async () => {
    /*
     * WHAT THIS DOES AND DOES NOT PROVE, measured 23 September 2026 by making
     * the handler read `body.owner_id` and watching this still pass. Fastify's
     * `removeAdditional` strips the key before the handler runs, so a handler
     * that read it would see undefined. The guard is the schema's
     * `additionalProperties: false`, not this assertion — which is worth
     * keeping as the end-to-end half, and worth not mistaking for the other.
     */
    const { app, auth } = await buildTestServer();
    const body = { ...albumBody(), owner_id: randomUUID() };

    assert.equal((await createAlbum(app, auth, body)).statusCode, 201);
    const listed = (await listAlbums(app, auth)).json().albums;

    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, body.id);
  });

  it("is 409 CONFLICT on a duplicate id, with no details", async () => {
    // "Already created", never "try again": a fresh id would orphan the
    // wrapping the client computed under the old one (§9.2).
    const { app, auth } = await buildTestServer();
    const body = albumBody();
    await createAlbum(app, auth, body);

    const response = await createAlbum(app, auth, body);

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, "CONFLICT");
    assert.equal(response.json().details, undefined);
  });

  it("is 401 without a token", async () => {
    const { app } = await buildTestServer();
    const response = await createAlbum(app, {}, albumBody());

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, "UNAUTHENTICATED");
  });

  const invalid = [
    ["an id that is not a uuid", { id: "not-a-uuid" }],
    ["an empty title", { title: "" }],
    // §2's floor and the relay's ceiling. 40 and 1025 bytes are 54 and 1367
    // characters, one outside b64urlRange(55, 1366) on each side.
    ["a 40-byte title, below the 41-byte floor", { title: b64(0x51, 40) }],
    ["a 1025-byte title, above the 1024-byte ceiling", { title: b64(0x51, 1025) }],
    // What a client that has not caught up with 003 would post. Refused, not
    // stored: the column's every reader assumes ciphertext.
    ["a plaintext title", { title: "Primer cumpleaños" }],
    ["a title that is not base64url", { title: "+".repeat(60) }],
    // In the pattern and the length, so only decodeRangeOr400 can refuse it —
    // the one case that fails if the route stops decoding.
    ["a non-canonical title spelling", { title: nonCanonical(b64(0x51, 41)) }],
    ["a wrapped_key of the wrong length", { wrapped_key: b64(0x42, 47) }],
    ["a wrap_nonce of the wrong length", { wrap_nonce: b64(0x43, 23) }],
    ["a wrapped_key that is not base64url", { wrapped_key: "+".repeat(64) }],
  ];
  for (const [name, override] of invalid) {
    it(`rejects ${name}`, async () => {
      const { app, auth } = await buildTestServer();
      const response = await createAlbum(app, auth, albumBody(override));

      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().code, "VALIDATION_FAILED");
    });
  }

  it("accepts a title at exactly the floor and exactly the ceiling", async () => {
    // The 400 rows above prove the bounds exist; these prove they are not one
    // byte too tight. 41 and 1024 bytes are 55 and 1366 characters.
    const { app, auth } = await buildTestServer();
    for (const bytes of [41, 1024]) {
      const response = await createAlbum(app, auth, albumBody({ title: b64(0x51, bytes) }));
      assert.equal(response.statusCode, 201, `${bytes} bytes: ${response.body}`);
    }
  });

  it("hands the use case the title's bytes, not its spelling", async () => {
    // base64url is transport and belongs to the adapter (schema §6): what
    // reaches the repository is the 60 bytes the client encrypted.
    const { app, auth, albums } = await buildTestServer();
    const body = albumBody({ title: b64(0x5a, 60) });
    await createAlbum(app, auth, body);

    const stored = albums.rows.get(body.id).title;
    assert.ok(stored instanceof Uint8Array, "decoded, not the string");
    assert.deepEqual(Buffer.from(stored), Buffer.alloc(60, 0x5a));
  });

  it("rejects a body with no wrapping at all", async () => {
    /*
     * §9.2: "An album row with no wrapping is an album whose owner can never
     * re-open it from a second device." Making the field optional "for now" is
     * how that state becomes reachable, so required-ness is asserted.
     */
    const { app, auth } = await buildTestServer();
    const { wrapped_key, wrap_nonce, ...body } = albumBody();

    assert.ok(wrapped_key && wrap_nonce, "fixture lost its wrapping");
    assert.equal((await createAlbum(app, auth, body)).statusCode, 400);
  });
});

describe("GET /v1/albums — §9.2", () => {
  it("returns every wrapping, equal to what was posted", async () => {
    /*
     * §6.2's owed row. This is where an owner gets their album keys back: one
     * call after §8.4 and the client holds every K_album it owns. Two albums,
     * because one cannot show a mapping that returns the same row twice.
     */
    const { app, auth } = await buildTestServer();
    const first = albumBody({ wrapped_key: b64(0x11, 48), wrap_nonce: b64(0x12, 24) });
    const second = albumBody({ wrapped_key: b64(0x21, 48), wrap_nonce: b64(0x22, 24) });
    await createAlbum(app, auth, first);
    await createAlbum(app, auth, second);

    const listed = (await listAlbums(app, auth)).json().albums;
    const byId = new Map(listed.map((album) => [album.id, album]));

    assert.equal(byId.get(first.id).wrapped_key, first.wrapped_key);
    assert.equal(byId.get(first.id).wrap_nonce, first.wrap_nonce);
    assert.equal(byId.get(second.id).wrapped_key, second.wrapped_key);
    assert.equal(byId.get(second.id).wrap_nonce, second.wrap_nonce);
  });

  it("carries Cache-Control: no-store", async () => {
    // §8.3's rule — every response carrying a wrapped blob. The third such
    // route, and the one §6.2 owes a header assertion for.
    const { app, auth } = await buildTestServer();
    await createAlbum(app, auth, albumBody());

    const response = await listAlbums(app, auth);

    assert.equal(response.headers["cache-control"], "no-store");
  });

  it("returns each album's own fields, and nothing else", async () => {
    const { app, auth } = await buildTestServer();
    const body = albumBody();
    await createAlbum(app, auth, body);

    const [album] = (await listAlbums(app, auth)).json().albums;

    assert.deepEqual(Object.keys(album).sort(), [
      "created_at",
      "id",
      "media_count",
      "title",
      "wrap_nonce",
      "wrapped_key",
    ]);
    assert.equal(album.title, body.title);
    assert.strictEqual(album.media_count, 0);
  });

  it("returns each title as the bytes that were posted", async () => {
    // Two albums with different titles, so a list returning one title for both
    // fails. The relay neither opens nor re-encodes them.
    const { app, auth } = await buildTestServer();
    const first = albumBody({ title: b64(0x61, 41) });
    const second = albumBody({ title: b64(0x62, 1024) });
    await createAlbum(app, auth, first);
    await createAlbum(app, auth, second);

    const byId = new Map((await listAlbums(app, auth)).json().albums.map((a) => [a.id, a]));

    assert.equal(byId.get(first.id).title, first.title);
    assert.equal(byId.get(second.id).title, second.title);
  });

  it("is scoped to the caller", async () => {
    // Two owners on one server. A list that forgot its WHERE passes every
    // assertion above, because each looks its own album up by id.
    const { app, auth } = await buildTestServer();
    await createAlbum(app, auth, albumBody());

    const second = await app.inject({
      method: "POST",
      url: "/v1/signup",
      payload: signupBody(`other-${randomUUID()}@x.es`),
    });
    const otherAuth = { authorization: `Bearer ${second.json().token}` };

    assert.deepEqual((await listAlbums(app, otherAuth)).json().albums, []);
    assert.equal((await listAlbums(app, auth)).json().albums.length, 1);
  });

  it("is ordered by created_at descending", async () => {
    const { app, auth, albums } = await buildTestServer();
    const older = albumBody();
    const newer = albumBody();
    await createAlbum(app, auth, older);
    await createAlbum(app, auth, newer);
    albums.rows.get(older.id).createdAt = new Date("2026-01-01T00:00:00.000Z");
    albums.rows.get(newer.id).createdAt = new Date("2026-06-01T00:00:00.000Z");

    const ids = (await listAlbums(app, auth)).json().albums.map((a) => a.id);

    assert.deepEqual(ids, [newer.id, older.id]);
  });

  it("is 401 without a token, and says nothing about whether albums exist", async () => {
    const { app, auth } = await buildTestServer();
    await createAlbum(app, auth, albumBody());

    const response = await listAlbums(app, {});

    assert.equal(response.statusCode, 401);
    assert.deepEqual(Object.keys(response.json()).sort(), ["code", "message"]);
  });
});

const getAlbum = (app, auth, albumId) =>
  app.inject({ method: "GET", url: `/v1/albums/${albumId}`, headers: auth });

const getMetadata = (app, auth, albumId) =>
  app.inject({ method: "GET", url: `/v1/albums/${albumId}/metadata`, headers: auth });

describe("GET /v1/albums/{album_id} — §9.4", () => {
  /** An album with one row in each of three statuses. */
  async function withAlbum() {
    const server = await buildTestServer();
    const album = albumBody();
    assert.equal((await createAlbum(server.app, server.auth, album)).statusCode, 201);
    const pending = server.media.add(album.id, { status: "pending" });
    const ready = server.media.add(album.id, { status: "ready" });
    const failed = server.media.add(album.id, { status: "failed" });
    return { ...server, album, pending, ready, failed };
  }

  it("lists every media row, whatever its status, oldest first", async () => {
    // §9.4: a video in `processing` must not vanish from the owner's grid, so
    // the status filter is the client's (#9).
    const { app, auth, album, pending, ready, failed } = await withAlbum();

    const body = (await getAlbum(app, auth, album.id)).json();

    assert.deepEqual(
      body.media.map((row) => row.id),
      [pending, ready, failed],
    );
    assert.deepEqual(body.media.map((row) => row.status).sort(), [
      "failed",
      "pending",
      "ready",
    ]);
  });

  it("carries no wrapping — the key is §9.2's, owner-only", async () => {
    const { app, auth, album } = await withAlbum();

    const body = (await getAlbum(app, auth, album.id)).json();

    assert.deepEqual(Object.keys(body).sort(), ["created_at", "id", "media", "title"]);
    assert.deepEqual(Object.keys(body.media[0]).sort(), [
      "created_at",
      "id",
      "kind",
      "status",
    ]);
  });

  it("returns the title as the bytes that were posted", async () => {
    // §9.4 gives recipients the title too, which is why it is under K_album
    // rather than K_master (encryption spec §2). The byte-identical test below
    // shows both caller kinds get the same value; this shows it is the right one.
    const { app, auth, album } = await withAlbum();

    const body = (await getAlbum(app, auth, album.id)).json();

    assert.equal(body.title, album.title);
  });

  it("answers a recipient with a byte-identical body", async () => {
    /*
     * §6.2's owed row. Fails the day someone adds an owner-only field to the
     * shared route instead of to §9.2.
     */
    const { app, auth, recipients, album } = await withAlbum();
    const recipient = recipients.grant(album.id);

    const asOwner = await getAlbum(app, auth, album.id);
    const asRecipient = await getAlbum(app, recipient, album.id);

    assert.equal(asRecipient.statusCode, 200, asRecipient.body);
    assert.equal(asRecipient.body, asOwner.body);
  });

  describe("§7.3's steps 3 and 4, in that order", () => {
    it("is 403 for a revoked recipient on their OWN album", async () => {
      const { app, recipients, album } = await withAlbum();
      const revoked = recipients.grant(album.id, { revokedAt: new Date() });

      const response = await getAlbum(app, revoked, album.id);

      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().code, "ACCESS_REVOKED");
    });

    it("is 404 for a revoked recipient on ANY other album, identically", async () => {
      /*
       * The assertion the order exists for. Checking revocation first answers
       * `403` here too, which confirms the other album exists — brief §9.1's
       * easiest way to leak album access.
       */
      const { app, recipients, album } = await withAlbum();
      const revoked = recipients.grant(album.id, { revokedAt: new Date() });
      const live = recipients.grant(album.id);
      const other = randomUUID();

      const fromRevoked = await getAlbum(app, revoked, other);
      const fromLive = await getAlbum(app, live, other);

      assert.equal(fromRevoked.statusCode, 404);
      assert.equal(fromRevoked.body, fromLive.body);
    });

    it("is 404 for another owner's album", async () => {
      // A second owner on the SAME server: a token minted by a different
      // instance is unknown here, and 401 would pass this without ever
      // reaching §9.3.
      const { app, album } = await withAlbum();
      const signup = await app.inject({
        method: "POST",
        url: "/v1/signup",
        payload: signupBody(`stranger-${randomUUID()}@x.es`),
      });
      const stranger = { authorization: `Bearer ${signup.json().token}` };

      const response = await getAlbum(app, stranger, album.id);

      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.json().code, "NOT_FOUND");
    });
  });

  it("is 401 without a token", async () => {
    const { app, album } = await withAlbum();

    assert.equal((await getAlbum(app, {}, album.id)).statusCode, 401);
  });
});

describe("GET /v1/albums/{album_id}/metadata — §9.5", () => {
  async function withEnvelopes() {
    const server = await buildTestServer();
    const album = albumBody();
    assert.equal((await createAlbum(server.app, server.auth, album)).statusCode, 201);
    const envelope = Buffer.alloc(120, 0x33);
    const ready = server.media.add(album.id, { status: "ready", envelope });
    const pending = server.media.add(album.id, { status: "pending" });
    return { ...server, album, ready, pending, envelope };
  }

  it("returns only ready rows, and §9.4 still lists the pending one", async () => {
    /*
     * §6.2's owed row, and the pair IS the assertion — the two routes filter
     * differently on purpose, so either alone would pass a server that
     * filtered everywhere or nowhere.
     */
    const { app, auth, album, ready, pending } = await withEnvelopes();

    const envelopes = (await getMetadata(app, auth, album.id)).json().metadata;
    const listed = (await getAlbum(app, auth, album.id)).json().media;

    assert.deepEqual(
      envelopes.map((row) => row.media_id),
      [ready],
    );
    assert.equal(listed.length, 2, "the listing is what makes this non-vacuous");
    assert.ok(listed.some((row) => row.id === pending && row.status === "pending"));
  });

  it("returns the envelope bytes verbatim", async () => {
    // The relay does not parse the header (§9.1's format-blindness).
    const { app, auth, album, envelope } = await withEnvelopes();

    const [row] = (await getMetadata(app, auth, album.id)).json().metadata;

    assert.equal(row.envelope, envelope.toString("base64url"));
  });

  it("carries Cache-Control: no-store", async () => {
    // The first ciphertext response in the document (§9.5, §11.3).
    const { app, auth, album } = await withEnvelopes();

    const response = await getMetadata(app, auth, album.id);

    assert.equal(response.headers["cache-control"], "no-store");
  });

  it("answers a recipient too, and refuses a revoked one on their own album", async () => {
    const { app, recipients, album } = await withEnvelopes();

    const live = await getMetadata(app, recipients.grant(album.id), album.id);
    const revoked = await getMetadata(
      app,
      recipients.grant(album.id, { revokedAt: new Date() }),
      album.id,
    );

    assert.equal(live.statusCode, 200, live.body);
    assert.equal(revoked.statusCode, 403);
  });
});
