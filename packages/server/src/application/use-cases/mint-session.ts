/*
 * The one place a session token is created — api-sketch §7.4. Two routes mint
 * (`/signup` and `/login`), and the mitigation for two minting sites is one
 * code path rather than two implementations: both set the same window and
 * insert the same row. §6.2 owes a test asserting both produce it.
 *
 * TYPE ONLY for now; the implementation lands with the token work.
 */

/**
 * The 32 raw bytes, not their base64url spelling — that is transport, and the
 * HTTP adapter encodes it (§7.2). The relay holds the plaintext token only
 * until the response is written; what it stores is the SHA-256 (schema §6).
 */
export type MintedSession = {
  readonly token: Uint8Array; // 32
  readonly expiresAt: Date;
};

/** Generates the token, computes `expires_at`, inserts the `owner_tokens` row. */
export type MintSession = (ownerId: string) => Promise<MintedSession>;
