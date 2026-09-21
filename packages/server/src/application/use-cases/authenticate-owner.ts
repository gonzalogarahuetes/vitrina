/*
 * §7.3 steps 1 and 2, as a use case rather than inside the HTTP adapter —
 * architecture §5 keeps repositories out of `buildServer`, and the bearer
 * scheme needs a row. Returns the owner or null; the adapter chooses the
 * status, so the 401 reasoning stays where the status codes live.
 */

import type { Clock } from "../ports/clock.js";
import type { OwnerRepository } from "../ports/owner-repository.js";
import type { TokenHasher } from "../ports/token-hasher.js";

export type AuthenticateOwnerDeps = {
  readonly owners: OwnerRepository;
  readonly tokenHasher: TokenHasher;
  readonly clock: Clock;
};

/** The 32 RAW bytes. The adapter decodes base64url strictly (§7.2). */
export type AuthenticateOwnerInput = { readonly token: Uint8Array };

export function authenticateOwner(deps: AuthenticateOwnerDeps) {
  return async (input: AuthenticateOwnerInput): Promise<string | null> => {
    // Lookup BY HASH, never comparison — no code path compares two tokens or
    // two hashes, so there is nothing here to time (§7.2, schema §6).
    const token = await deps.owners.findTokenByHash(deps.tokenHasher.hash(input.token));
    if (token === null) return null;

    // Unknown, revoked and expired are one answer: an owner logs in again.
    if (token.revokedAt !== null) return null;
    if (token.expiresAt.getTime() <= deps.clock.now().getTime()) return null;

    return token.ownerId;
  };
}
