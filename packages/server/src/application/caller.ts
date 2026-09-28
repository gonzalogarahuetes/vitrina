/*
 * Who is calling — api-sketch §7.1, in the two shapes §7.3 turns one into the
 * other through. Both live here rather than in the HTTP adapter: they are
 * application concepts, and the adapter only parks one on a request.
 */

import type { RecipientGrant } from "./ports/recipient-repository.js";

/**
 * What §7.3 step 1 resolved: a token matched a row, and nothing else has been
 * decided. NOT §7.1's `Caller` — the `grant` still carries `revokedAt`,
 * because scope is step 3 and revocation is step 4, and folding them together
 * answers `403` where a recipient probing another album must get `404`.
 */
export type AuthenticatedPrincipal =
  | { readonly kind: "owner"; readonly ownerId: string }
  | { readonly kind: "recipient"; readonly grant: RecipientGrant };

/*
 * The resolved identity — api-sketch §7.1. Constructed only after §7.3's
 * steps 3 and 4 have run, so a handler holding one has no revocation flag it
 * could forget to check.
 */
export type Caller =
  | { readonly kind: "owner"; readonly ownerId: string }
  | {
      readonly kind: "recipient";
      readonly recipientId: string;
      readonly albumId: string;
    };
