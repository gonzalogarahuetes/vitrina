/*
 * The in-memory graph PR 2's four route files share — api-sketch §7.5, §7.7,
 * §7.8. buildUseCases is imported rather than reimplemented, so the tests
 * assert the wiring production uses. Each fake raises the same
 * ApplicationError its Postgres adapter does: the envelope matches on
 * `instanceof`, so a look-alike with the right code would answer 500.
 *
 * The fakes are deliberately the thinnest that keep the port's promises.
 * What only a real database can show — COALESCE under a race, the cascade
 * revoke must not trigger, the 23505 constraint names — is
 * infra/*-repository.test.mjs's job, not this file's.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { OWNER_KDF_V1 } from "@vitrina/shared";

import { buildServer } from "../../dist/adapters/driving/http/server.js";
import { buildUseCases } from "../../dist/composition-root.js";
import { createCredentialHasher } from "../../dist/adapters/driven/hashing/credential-hasher.js";
import { createTokenHasher } from "../../dist/adapters/driven/hashing/token-hasher.js";
import { ApplicationError } from "../../dist/application/errors.js";

const NOW = new Date("2026-10-06T09:00:00.000Z");
const hex = (bytes) => Buffer.from(bytes).toString("hex");

export const b64 = (fill, bytes) => Buffer.alloc(bytes, fill).toString("base64url");

/** Schema §6: SHA-256 over the 32 RAW token bytes — what the client posts. */
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The same bytes, spelled with the final character's spare bits set — a
 * string the schema's pattern and length accept and only the decoder's
 * re-encode check refuses. Meaningful only for a length with spare bits
 * (§7.7's table): on 48 or 24 bytes it changes the bytes instead.
 */
export const nonCanonical = (encoded) =>
  encoded.slice(0, -1) + ALPHABET[ALPHABET.indexOf(encoded.at(-1)) + 1];

/** A minimal owner repository: accounts and tokens, revocable. */
function inMemoryOwners() {
  const byEmail = new Map();
  const byId = new Map();
  const tokens = new Map(); // hex(hash) -> row

  return {
    tokens,
    async createWithPasswordKey(owner) {
      if (byEmail.has(owner.email)) throw new ApplicationError("DUPLICATE_ADDRESS");
      const row = { id: randomUUID(), createdAt: NOW, ...owner };
      byEmail.set(owner.email, row);
      byId.set(row.id, row);
      return { id: row.id, createdAt: row.createdAt };
    },
    async findCredentialByEmail(email) {
      const row = byEmail.get(email);
      return row ? { id: row.id, authHash: row.authHash } : null;
    },
    async findKdfByEmail(email) {
      const row = byEmail.get(email);
      return row ? { kdfSalt: row.passwordKey.kdfSalt, params: row.passwordKey.params } : null;
    },
    async findPasswordKeyByOwnerId(ownerId) {
      return byId.get(ownerId)?.passwordKey ?? null;
    },
    async insertToken(token) {
      tokens.set(hex(token.tokenHash), {
        ownerId: token.ownerId,
        expiresAt: token.expiresAt,
        revokedAt: null,
      });
    },
    async findTokenByHash(tokenHash) {
      return tokens.get(hex(tokenHash)) ?? null;
    },
    // The adapter's predicate, owner AND hash, so a test that passes the
    // wrong owner sees what production would: nothing revoked.
    async revokeToken(ownerId, tokenHash) {
      const row = tokens.get(hex(tokenHash));
      if (row && row.ownerId === ownerId && row.revokedAt === null) row.revokedAt = NOW;
    },
    async revokeAllTokens(ownerId) {
      for (const row of tokens.values()) {
        if (row.ownerId === ownerId && row.revokedAt === null) row.revokedAt = NOW;
      }
    },
  };
}

function inMemoryAlbums() {
  const rows = new Map();
  return {
    rows,
    async create(album) {
      if (rows.has(album.id)) throw new ApplicationError("DUPLICATE_ALBUM_ID");
      rows.set(album.id, { ...album, createdAt: NOW, mediaCount: 0 });
      return { id: album.id, createdAt: NOW };
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

/** §9.4 needs a media port to answer at all; nothing here creates media. */
const emptyMedia = {
  async listByAlbum() {
    return [];
  },
  async listReadyEnvelopes() {
    return [];
  },
};

/**
 * The recipient repository: rows by id, looked up by token hash. Both
 * uniqueness rules raise the one code, as the adapter does (§7.7's 409).
 */
function inMemoryRecipients(albums) {
  const rows = new Map(); // id -> row as stored

  return {
    rows,
    async findGrantByTokenHash(tokenHash) {
      for (const row of rows.values()) {
        if (hex(row.tokenHash) === hex(tokenHash)) {
          return { id: row.id, albumId: row.albumId, revokedAt: row.revokedAt };
        }
      }
      return null;
    },
    async create(recipient) {
      const hashTaken = [...rows.values()].some(
        (row) => hex(row.tokenHash) === hex(recipient.tokenHash),
      );
      if (rows.has(recipient.id) || hashTaken) {
        throw new ApplicationError("DUPLICATE_RECIPIENT");
      }
      rows.set(recipient.id, { ...recipient, revokedAt: null, createdAt: NOW });
      return { id: recipient.id, createdAt: NOW };
    },
    async findScopeById(recipientId) {
      const row = rows.get(recipientId);
      if (!row) return null;
      const album = albums.rows.get(row.albumId);
      return { id: row.id, albumId: row.albumId, ownerId: album.ownerId };
    },
    async revoke(recipientId) {
      const row = rows.get(recipientId);
      if (!row) throw new Error("revoke matched no row");
      row.revokedAt ??= new Date(NOW.getTime() + rows.size); // the first one sticks
      return row.revokedAt;
    },
  };
}

export const signupBody = (email) => ({
  email,
  proof: b64(0x21, 32),
  kdf_salt: b64(0x41, 16),
  kdf_memory_kib: OWNER_KDF_V1.memoryKib,
  kdf_iterations: OWNER_KDF_V1.iterations,
  kdf_parallelism: OWNER_KDF_V1.parallelism,
  wrapped_master: b64(0x44, 48),
  wrap_nonce: b64(0x45, 24),
});

/**
 * A server over the real graph, with helpers for the parties PR 2's routes
 * care about: owners with one or more sessions, albums, and the ability to
 * read the stores back directly.
 */
export async function buildPr2Server() {
  const owners = inMemoryOwners();
  const albums = inMemoryAlbums();
  const recipients = inMemoryRecipients(albums);

  const useCases = buildUseCases(
    {
      owners,
      albums,
      media: emptyMedia,
      recipients,
      objectStore: {
        async put() {},
        async head() {
          return null;
        },
      },
      credentialHasher: createCredentialHasher(Buffer.alloc(32, 0x11)),
      tokenHasher: createTokenHasher(),
      clock: { now: () => NOW },
    },
    { kdfV1: OWNER_KDF_V1, dummyAuthHash: Buffer.alloc(32, 0x7f) },
  );

  const app = await buildServer({
    config: { clientOrigin: "http://localhost:5173" },
    useCases,
    logger: false,
  });
  await app.ready();

  /** A new owner, signed in; `session()` signs the same owner in again. */
  async function owner() {
    const email = `owner-${randomUUID()}@x.es`;
    const signup = await app.inject({ method: "POST", url: "/v1/signup", payload: signupBody(email) });
    assert.equal(signup.statusCode, 201, signup.body);

    const session = async () => {
      const login = await app.inject({
        method: "POST",
        url: "/v1/login",
        payload: { email, proof: signupBody(email).proof },
      });
      assert.equal(login.statusCode, 200, login.body);
      return { authorization: `Bearer ${login.json().token}` };
    };

    return { email, auth: { authorization: `Bearer ${signup.json().token}` }, session };
  }

  /** An album filed under `auth`'s owner, through the real route. */
  async function album(auth) {
    const id = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/v1/albums",
      headers: auth,
      payload: { id, title: b64(0x51, 60), wrapped_key: b64(0x42, 48), wrap_nonce: b64(0x43, 24) },
    });
    assert.equal(response.statusCode, 201, response.body);
    return id;
  }

  return { app, owners, albums, recipients, owner, album };
}
