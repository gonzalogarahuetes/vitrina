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

/** A well-formed §9.2 body; the wrapping distinct per album so a swap shows. */
const albumBody = (overrides = {}) => ({
  id: randomUUID(),
  title: "Primer cumpleaños",
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

/** A server over the real graph, plus a signed-in owner's bearer token. */
async function buildTestServer() {
  const albums = inMemoryAlbums();
  const useCases = buildUseCases(
    {
      owners: inMemoryOwners(),
      albums,
      recipients: { async findGrantByTokenHash() { return null; } },
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

  return { app, albums, auth: { authorization: `Bearer ${signup.json().token}` } };
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
    ["a title over 200 characters", { title: "a".repeat(201) }],
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
