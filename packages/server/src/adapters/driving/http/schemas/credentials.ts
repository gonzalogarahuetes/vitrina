/*
 * The four owner-credential routes' JSON Schemas — api-sketch §7.5, §8.1, §8.3.
 * This directory is the audit surface brief §6 #16 rests on: "no endpoint
 * accepts key material" is checkable by a test that walks the route table,
 * which only works if every route has an entry here.
 *
 * Wire names are snake_case; the port's are camelCase. The routes map between.
 */

/** Encoded character counts. 32 bytes → 43 chars, 16 → 22, 48 → 64, 24 → 32. */
const B64URL = { pattern: "^[A-Za-z0-9_-]+$" } as const;
const b64url = (chars: number) =>
  ({ type: "string", minLength: chars, maxLength: chars, ...B64URL }) as const;

/**
 * As typed: no `format: email` and no `pattern`. The relay normalises
 * server-side (§8.2), and a client-side format check would reject spellings
 * the normaliser accepts. 254 is RFC 5321's path limit and bounds the column;
 * it is not a validity claim.
 */
const email = { type: "string", minLength: 1, maxLength: 254 } as const;

/**
 * FLOORS, never the v1 chosen values — §8.1. A client may post HIGHER
 * parameters; that is the entire reason they are stored per row. A schema
 * pinned to 65536/3/1 works today and rejects every account created after
 * Phase 2 raises the default.
 */
const kdfParameters = {
  kdf_memory_kib: { type: "integer", minimum: 16384 },
  kdf_iterations: { type: "integer", minimum: 2 },
  kdf_parallelism: { type: "integer", minimum: 1 },
} as const;

const timestamp = { type: "string" } as const; // RFC 3339 UTC, built by the route

export const signupSchema = {
  body: {
    type: "object",
    properties: {
      email,
      // The login proof, never the password. §4.1: a wrapped blob is
      // ciphertext and may be posted; the key that wrapped it may not.
      proof: b64url(43),
      kdf_salt: b64url(22),
      ...kdfParameters,
      wrapped_master: b64url(64),
      wrap_nonce: b64url(32),
    },
    required: [
      "email",
      "proof",
      "kdf_salt",
      "kdf_memory_kib",
      "kdf_iterations",
      "kdf_parallelism",
      "wrapped_master",
      "wrap_nonce",
    ],
    additionalProperties: false,
  },
  response: {
    201: {
      type: "object",
      properties: {
        id: { type: "string" },
        created_at: timestamp,
        token: b64url(43),
        expires_at: timestamp,
      },
      required: ["id", "created_at", "token", "expires_at"],
      additionalProperties: false,
    },
  },
} as const;

export const loginParamsSchema = {
  body: {
    type: "object",
    properties: { email },
    required: ["email"],
    additionalProperties: false,
  },
  response: {
    // Nothing that varies with whether the account exists — §7.5. The decoy
    // salt is encoded by the same encoder, so it cannot differ in spelling.
    200: {
      type: "object",
      properties: { kdf_salt: b64url(22), ...kdfParameters },
      required: ["kdf_salt", "kdf_memory_kib", "kdf_iterations", "kdf_parallelism"],
      additionalProperties: false,
    },
  },
} as const;

export const loginSchema = {
  body: {
    type: "object",
    properties: { email, proof: b64url(43) },
    required: ["email", "proof"],
    additionalProperties: false,
  },
  response: {
    200: {
      type: "object",
      properties: { token: b64url(43), expires_at: timestamp },
      required: ["token", "expires_at"],
      additionalProperties: false,
    },
  },
} as const;

export const ownerKeySchema = {
  response: {
    // Everything needed to unwrap K_master except the password (§8.3).
    200: {
      type: "object",
      properties: {
        kdf_salt: b64url(22),
        ...kdfParameters,
        wrapped_master: b64url(64),
        wrap_nonce: b64url(32),
      },
      required: [
        "kdf_salt",
        "kdf_memory_kib",
        "kdf_iterations",
        "kdf_parallelism",
        "wrapped_master",
        "wrap_nonce",
      ],
      additionalProperties: false,
    },
  },
} as const;
