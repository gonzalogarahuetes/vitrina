/*
 * The one place a session token is created — api-sketch §7.4. Two routes mint
 * (`/signup` and `/login`), and the mitigation for two minting sites is one
 * code path rather than two implementations: both set the same window and
 * insert the same row. §6.2 owes a test asserting both produce it.
 */

import { randomBytes } from "node:crypto";
import type { OwnerRepository } from "../ports/owner-repository.js";
import type { Clock } from "../ports/clock.js";
import type { TokenHasher } from "../ports/token-hasher.js";

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

/**
 * Two weeks — §7.5, and PROVISIONAL there pending brief §11. Named so whoever
 * revisits it can find it; there is no refresh route, so this is the whole of
 * how long a stolen token stays useful.
 */
const SESSION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function makeMintSession(
  owners: OwnerRepository,
  hasher: TokenHasher,
  clock: Clock,
) {
  return async (ownerId: string): Promise<MintedSession> => {
    // `token` leaves in the response and is stored nowhere; `tokenHash` is
    // stored and never returned. Swapping them puts live credentials in the
    // database and breaks every lookup at once (schema §6).
    const token = randomBytes(32);
    const tokenHash = hasher.hash(token);
    const expiresAt = new Date(clock.now().getTime() + SESSION_WINDOW_MS);

    await owners.insertToken({
      ownerId,
      tokenHash,
      expiresAt,
    });

    return {
      token,
      expiresAt,
    };
  };
}
