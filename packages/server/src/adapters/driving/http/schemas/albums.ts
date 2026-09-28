/*
 * §9.2's two album routes — api-sketch §9.2, §4.1, schema §3.
 * This directory is the audit surface brief §6 #16 rests on: import every
 * schema into test/route-table.test.mjs, or the walk stops covering it.
 */

import { B64URL, b64url, timestamp, uuid } from "./fragments.js";

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

/** §9.3's `{album_id}`, flat for both caller kinds. */
const albumIdParams = {
  type: "object",
  properties: { album_id: uuid },
  required: ["album_id"],
  additionalProperties: false,
} as const;

/** §9.4's media row: ids, kind, status. No byte sizes, no envelopes. */
const mediaListing = {
  type: "object",
  properties: {
    id: uuid,
    kind: { type: "string", enum: ["photo", "video"] },
    status: {
      type: "string",
      enum: ["pending", "processing", "ready", "failed"],
    },
    created_at: timestamp,
  },
  required: ["id", "kind", "status", "created_at"],
  additionalProperties: false,
} as const;

export const findAlbumByIdSchema = {
  params: albumIdParams,
  response: {
    200: {
      type: "object",
      // No `wrapped_key`: the wrapping is §9.2's, owner-only, and this route
      // is shared. That absence is what keeps §7.1's no-branch rule holdable.
      properties: {
        id: uuid,
        title,
        created_at: timestamp,
        media: { type: "array", items: mediaListing },
      },
      required: ["id", "title", "created_at", "media"],
      additionalProperties: false,
    },
  },
} as const;

export const getAlbumMetadataSchema = {
  params: albumIdParams,
  response: {
    200: {
      type: "object",
      properties: {
        metadata: {
          type: "array",
          items: {
            type: "object",
            // The complete envelope bytes, returned verbatim — the relay does
            // not parse the header (§9.1's format-blindness).
            properties: { media_id: uuid, envelope: { type: "string", ...B64URL } },
            required: ["media_id", "envelope"],
            additionalProperties: false,
          },
        },
      },
      required: ["metadata"],
      additionalProperties: false,
    },
  },
} as const;
