/*
 * §9.6's media create and §9.8's status — api-sketch §9.3, §9.6, §9.8.
 * Import every schema here into test/route-table.test.mjs, or the walk
 * stops covering the surface brief §6 #16 rests on.
 */

import { b64urlRange, timestamp, uuid } from "./fragments.js";

/** §9.6's enum of one. Schema §3 admits 'video' from day one (#8); the API
 * does not until Phase 3, and widening it later is additive. */
const kind = { type: "string", enum: ["photo"] } as const;
/**
 * #9's ladder, in a RESPONSE only. No route accepts a `status` field on any
 * body, ever (§9.7) — which is why the route-table walk scopes that forbidden
 * name to `body` and lets it through here.
 */
const status = {
  type: "string",
  enum: ["pending", "processing", "ready", "failed"],
} as const;

export const createMediaSchema = {
  params: {
    type: "object",
    properties: { album_id: uuid },
    required: ["album_id"],
    additionalProperties: false,
  },
  body: {
    type: "object",
    properties: {
      id: uuid,
      kind,
      metadata: b64urlRange(108, 5462),
    },
    required: ["id", "kind", "metadata"],
    additionalProperties: false,
  },
  response: {
    201: {
      type: "object",
      properties: { id: uuid, created_at: timestamp, status },
      required: ["id", "created_at", "status"],
      additionalProperties: false,
    },
  },
} as const;

export const getMediaSchema = {
  params: {
    type: "object",
    properties: { media_id: uuid },
    required: ["media_id"],
    additionalProperties: false,
  },
  response: {
    200: {
      type: "object",
      properties: {
        id: uuid,
        created_at: timestamp,
        status,
        album_id: uuid,
        kind,
        /*
         * Integer once `ready`, null before — so the union, not a plain
         * integer. Verified: a bare `null` here is not a schema and fails at
         * boot with "must be object,boolean" rather than at request time.
         */
        byte_size: { type: ["integer", "null"] },
        updated_at: timestamp,
      },
      required: [
        "id",
        "created_at",
        "status",
        "album_id",
        "kind",
        "byte_size",
        "updated_at",
      ],
      additionalProperties: false,
    },
  },
} as const;
