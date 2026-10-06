import { timestamp, uuid, b64urlRange, b64url } from "./fragments.js";

const label = b64urlRange(55, 1366);

const wrapping = {
  wrapped: b64url(64),
  wrap_nonce: b64url(32),
  kdf_salt: b64url(22),
  kdf_memory_kib: { type: "integer", minimum: 16384, maximum: 2147483647 },
  kdf_iterations: { type: "integer", minimum: 2, maximum: 2147483647 },
  kdf_parallelism: { type: "integer", minimum: 1, maximum: 2147483647 },
} as const;

const WRAP_FIELDS = [
  "wrapped",
  "wrap_nonce",
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
    required: ["id", "kind", "label", "token_hash"],
    additionalProperties: false,
    if: {
      properties: {
        kind: { const: "passphrase" },
      },
    },
    then: {
      required: [...WRAP_FIELDS],
    },
    else: {
      not: { anyOf: WRAP_FIELDS.map((f) => ({ required: [f] })) },
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
