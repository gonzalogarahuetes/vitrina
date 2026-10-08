/*
 * The smallest real graph §11.5's limiter tests need — recipients on albums
 * with ready envelopes, so §9.5 is a ciphertext route that exists today.
 * buildUseCases is imported rather than reimplemented, as elsewhere.
 *
 * No owner is ever signed in: albums are filed directly in the fake, and
 * §9.4/§9.5 accept recipients. The owner port answers the dual scheme's
 * parallel lookup (either.ts) with "no such token" and nothing else.
 */

import { randomUUID } from "node:crypto";

import { OWNER_KDF_V1 } from "@vitrina/shared";

import { buildServer } from "../../dist/adapters/driving/http/server.js";
import { buildUseCases } from "../../dist/composition-root.js";
import { createCredentialHasher } from "../../dist/adapters/driven/hashing/credential-hasher.js";
import { createTokenHasher } from "../../dist/adapters/driven/hashing/token-hasher.js";

const NOW = new Date("2026-10-07T09:00:00.000Z");
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** §11.5: every ciphertext-route request charges at least this. */
export const FLOOR = 16 * 1024;

const unknownOwners = {
  async findTokenByHash() {
    return null;
  },
};

function inMemoryAlbums() {
  const rows = new Map();
  return {
    rows,
    add() {
      const id = randomUUID();
      rows.set(id, { id, ownerId: randomUUID(), title: Buffer.alloc(60, 0x51), createdAt: NOW });
      return id;
    },
    async findById(albumId) {
      return rows.get(albumId) ?? null;
    },
  };
}

function inMemoryMedia() {
  const rows = new Map();
  return {
    /** A `ready` row with an envelope of `bytes` bytes (81–4096, §9.6). */
    addReady(albumId, bytes = 120) {
      const id = randomUUID();
      rows.set(id, {
        id,
        albumId,
        kind: "photo",
        status: "ready",
        metadata: Buffer.alloc(bytes, 0x33),
        createdAt: new Date(NOW.getTime() + rows.size),
      });
      return id;
    },
    async listByAlbum(albumId) {
      return [...rows.values()].filter((row) => row.albumId === albumId);
    },
    async listReadyEnvelopes(albumId) {
      return [...rows.values()]
        .filter((row) => row.albumId === albumId && row.status === "ready")
        .map((row) => ({ mediaId: row.id, envelope: row.metadata }));
    },
  };
}

/** Grants keyed by the hash the real TokenHasher produces, as the table is. */
function inMemoryRecipients() {
  const byHash = new Map();
  const hasher = createTokenHasher();
  return {
    grant(albumId, { revokedAt = null } = {}) {
      const token = Buffer.alloc(32, byHash.size + 1);
      byHash.set(hex(hasher.hash(token)), { id: randomUUID(), albumId, revokedAt });
      return { authorization: `Bearer ${token.toString("base64url")}` };
    },
    async findGrantByTokenHash(tokenHash) {
      return byHash.get(hex(tokenHash)) ?? null;
    },
  };
}

/**
 * `limits` and `routeObserver` are buildServer's test seams. `routeObserver`
 * is deliberately not called `onRoute`: it is not Fastify's hook, and a seam
 * that looks like a framework feature is one someone wires into production.
 */
export async function buildLimiterServer({ limits, routeObserver } = {}) {
  const albums = inMemoryAlbums();
  const media = inMemoryMedia();
  const recipients = inMemoryRecipients();

  const useCases = buildUseCases(
    {
      owners: unknownOwners,
      albums,
      media,
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
    limits,
    routeObserver,
  });
  await app.ready();

  return { app, albums, media, recipients };
}
