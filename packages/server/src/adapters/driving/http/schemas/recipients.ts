import {
  timestamp,
  uuid,
  b64urlRange,
  b64url,
  kdfParameters,
} from "./fragments.js";

const label = b64urlRange(55, 1366);

const wrapping = {
  wrapped: b64url(64),
  wrap_nonce: b64url(32),
  kdf_salt: b64url(22),
  kdf_memory_kib: { type: "integer", minimum: 16384, maximum: 2147483647 },
  kdf_iterations: { type: "integer", minimum: 2, maximum: 2147483647 },
  kdf_parallelism: { type: "integer", minimum: 1, maximum: 2147483647 },
} as const;

/**
 * Both kinds since 19 October 2026: `K_album` under `K_invite` for qr
 * (encryption spec §6.1), under the passphrase KEK for passphrase (§6.2).
 */
const WRAP_FIELDS = ["wrapped", "wrap_nonce"];

/** Passphrase only: qr has no KDF, `K_invite` being uniformly random (§6.1). */
const KDF_FIELDS = [
  "kdf_salt",
  "kdf_memory_kib",
  "kdf_iterations",
  "kdf_parallelism",
];

export const createRecipientSchema = {
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
      label,
      token_hash: b64url(43),
      kind: { type: "string", enum: ["qr", "passphrase"] },
      ...wrapping,
    },
    required: ["id", "kind", "label", "token_hash", ...WRAP_FIELDS],
    additionalProperties: false,
    if: {
      properties: {
        kind: { const: "passphrase" },
      },
    },
    then: {
      required: [...KDF_FIELDS],
    },
    else: {
      not: { anyOf: KDF_FIELDS.map((f) => ({ required: [f] })) },
    },
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

export const revokeRecipientSchema = {
  params: {
    type: "object",
    properties: { recipient_id: uuid },
    required: ["recipient_id"],
    additionalProperties: false,
  },
  response: {
    200: {
      type: "object",
      properties: { revoked_at: timestamp },
      required: ["revoked_at"],
      additionalProperties: false,
    },
  },
} as const;

/**
 * §10.1. `kind` says which unwrap to run, and whether the four KDF fields are
 * present: required for passphrase, absent for qr. The handler builds each
 * shape from the port's union; the `then` makes a passphrase answer missing
 * one a serialiser error rather than a response the client cannot derive from.
 */
export const retrieveRecipientKeySchema = {
  response: {
    200: {
      type: "object",
      properties: {
        id: uuid,
        kind: { type: "string", enum: ["qr", "passphrase"] },
        kdf_salt: b64url(22),
        ...kdfParameters,
        wrapped: b64url(64),
        wrap_nonce: b64url(32),
      },
      required: ["id", "kind", ...WRAP_FIELDS],
      additionalProperties: false,
      if: {
        properties: {
          kind: { const: "passphrase" },
        },
      },
      then: {
        required: [...KDF_FIELDS],
      },
    },
  },
} as const;

export const retrieveRecipientSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        id: uuid,
        album_id: uuid,
        label,
        kind: { type: "string", enum: ["qr", "passphrase"] },
        created_at: timestamp,
      },
      required: ["id", "album_id", "label", "kind", "created_at"],
      additionalProperties: false,
    },
  },
} as const;
