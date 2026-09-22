/*
 * §7.3 step 1, as a use case rather than inside the HTTP adapter —
 * architecture §5 keeps repositories out of `buildServer`, and the bearer
 * scheme needs a row. Null only for a token that matches nothing: a revoked
 * grant comes back intact, because revocation is step 4 and the route's.
 */

import type {
  RecipientGrant,
  RecipientRepository,
} from "../ports/recipient-repository.js";
import type { TokenHasher } from "../ports/token-hasher.js";

export type AuthenticateRecipientDeps = {
  readonly recipients: RecipientRepository;
  readonly tokenHasher: TokenHasher;
};

/** The 32 RAW bytes. The adapter decodes base64url strictly (§7.2). */
export type AuthenticateRecipientInput = { readonly token: Uint8Array };

export function authenticateRecipient(deps: AuthenticateRecipientDeps) {
  return async (
    input: AuthenticateRecipientInput,
  ): Promise<RecipientGrant | null> => {
    // Lookup BY HASH, never comparison — no code path compares two tokens or
    // two hashes, so there is nothing here to time (§7.2, schema §6).
    const grant = await deps.recipients.findGrantByTokenHash(
      deps.tokenHasher.hash(input.token),
    );

    return grant;
  };
}
