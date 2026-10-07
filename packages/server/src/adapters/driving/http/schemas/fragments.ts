/*
 * Schema pieces shared by every route table — api-sketch §7.2, schema §6.
 * One copy of the base64url pattern in particular: a pattern that drifts in one
 * file accepts spellings `decode-field.ts` then rejects with another status.
 */

/** Schema §6's alphabet. No padding, no `+`, no `/`. */
export const B64URL = { pattern: "^[A-Za-z0-9_-]+$" } as const;

/** A fixed-length encoded field. 32 bytes → 43 chars, 48 → 64, 24 → 32. */
export const b64url = (chars: number) =>
  ({ type: "string", minLength: chars, maxLength: chars, ...B64URL }) as const;

/**
 * A bounded one, for v1's variable-length binary fields: §9.6's metadata
 * envelope and §9.2's album title. Character bounds here, byte bounds in the
 * decoder; a character count does not pin a byte count on its own, so pick
 * the characters from the bytes and let the decoder be the check.
 */
export const b64urlRange = (minChars: number, maxChars: number) =>
  ({
    type: "string",
    minLength: minChars,
    maxLength: maxChars,
    ...B64URL,
  }) as const;

/**
 * Enforced, not decorative: Fastify's ajv-compiler registers `ajv-formats`,
 * verified 23 September 2026 by asserting a bad value answers 400. Without it
 * a malformed id reaches Postgres and 22P02 becomes a 500.
 */
export const uuid = { type: "string", format: "uuid" } as const;

/** RFC 3339 UTC with a trailing Z, built by the route — see rfc3339.ts. */
export const timestamp = { type: "string" } as const;

/**
 * FLOORS, never the v1 chosen values — §8.1. A client may post HIGHER
 * parameters; that is the entire reason they are stored per row. A schema
 * pinned to 65536/3/1 works today and rejects every account created after
 * Phase 2 raises the default.
 */
export const kdfParameters = {
  kdf_memory_kib: { type: "integer", minimum: 16384 },
  kdf_iterations: { type: "integer", minimum: 2 },
  kdf_parallelism: { type: "integer", minimum: 1 },
} as const;
