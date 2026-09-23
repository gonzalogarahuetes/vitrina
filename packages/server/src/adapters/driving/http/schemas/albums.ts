/*
 * §9.2's two album routes — api-sketch §9.2, §4.1, schema §3.
 * This directory is the audit surface brief §6 #16 rests on: import every
 * schema into test/route-table.test.mjs, or the walk stops covering it.
 */

/** Encoded character counts. 48 bytes → 64 chars, 24 → 32. */
const B64URL = { pattern: "^[A-Za-z0-9_-]+$" } as const;
const b64url = (chars: number) =>
  ({ type: "string", minLength: chars, maxLength: chars, ...B64URL }) as const;

/**
 * Enforced, not decorative: Fastify's ajv-compiler registers `ajv-formats`,
 * verified 23 September 2026 by asserting a bad value answers 400. Without it
 * a malformed id reaches Postgres and 22P02 becomes a 500.
 */
const uuid = { type: "string", format: "uuid" } as const;

const timestamp = { type: "string" } as const; // RFC 3339 UTC, built by the route

/** Plaintext on the relay (§5.3). 200 is a column bound, not a product rule. */
const title = { type: "string", minLength: 1, maxLength: 200 } as const;

/**
 * §4.1's third accepted wrapping, after §7.7's and §7.5's. Ciphertext, and so
 * postable AND returnable; the key that wrapped it may never appear. Declared
 * once because the create accepts exactly what the list gives back.
 */
const wrapping = {
  wrapped_key: b64url(64), // K_album (32) + Poly1305 tag (16)
  wrap_nonce: b64url(32), // the field that gets forgotten (§7.7)
} as const;

export const createAlbumSchema = {
  body: {
    type: "object",
    // `id` is client-generated with no server default — it is inside the wrap
    // AAD, so the client holds it before it can compute `wrapped_key` (§9.1).
    properties: { id: uuid, title, ...wrapping },
    required: ["id", "title", "wrapped_key", "wrap_nonce"],
    additionalProperties: false,
  },
  response: {
    201: {
      type: "object",
      properties: { id: uuid, created_at: timestamp },
      required: ["id", "created_at"],
      additionalProperties: false,
    },
  },
} as const;

export const listAlbumsSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        albums: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: uuid,
              title,
              created_at: timestamp,
              ...wrapping,
              /*
               * `COUNT(*)` over the album's media rows whatever their status.
               * Measured: fast-json-stringify COERCES the string node-postgres
               * returns for bigint, so this hides a missing `::int` rather
               * than catching it. The infra test's strictEqual is the guard.
               */
              media_count: { type: "integer", minimum: 0 },
            },
            required: [
              "id",
              "title",
              "created_at",
              "wrapped_key",
              "wrap_nonce",
              "media_count",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["albums"],
      additionalProperties: false,
    },
  },
} as const;
