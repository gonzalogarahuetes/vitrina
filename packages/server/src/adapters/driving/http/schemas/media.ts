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

/** The media id in the path — §9.3's flat form: the row determines its album. */
const mediaIdParams = {
  type: "object",
  properties: { media_id: uuid },
  required: ["media_id"],
  additionalProperties: false,
} as const;

/**
 * §9.8's status object, shared by the status route and both uploads — "one
 * type for where this row is, whether the client asked or was told".
 */
const statusObject = {
  type: "object",
  properties: {
    id: uuid,
    created_at: timestamp,
    status,
    album_id: uuid,
    kind,
    /*
     * Integer once `ready`, null before — so the union, not a plain integer.
     * Verified: a bare `null` here is not a schema and fails at boot with
     * "must be object,boolean" rather than at request time.
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
} as const;

export const getMediaSchema = {
  params: mediaIdParams,
  response: { 200: statusObject },
} as const;

/*
 * §9.7's two uploads. NO `body` SCHEMA, deliberately: the body is the raw
 * envelope as `application/octet-stream`, and a schema here would have Fastify
 * validate a stream. It is also why the route-table walk's "no body accepts
 * `status`" holds structurally on the two routes it was written for — they
 * accept no body fields at all.
 *
 * `bodyLimit` is absent for the same reason it cannot help: measured, it is
 * applied by the parsers that accumulate a body, and this route's hands the
 * stream through. The 16 MiB and 1 MiB limits are the handler's (§9.7).
 */
export const uploadAssetSchema = {
  params: mediaIdParams,
  response: { 200: statusObject },
} as const;

export const uploadThumbnailSchema = {
  params: mediaIdParams,
  response: { 200: statusObject },
} as const;
