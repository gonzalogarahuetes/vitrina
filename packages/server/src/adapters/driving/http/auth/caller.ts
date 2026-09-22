/*
 * What §7.3 step 1 resolved, and the one `FastifyRequest` augmentation — two
 * declarations of `caller` with different types do not compile. NOT §7.1's
 * `Caller`: the route builds that from this, after steps 3 and 4.
 */

import type { RecipientGrant } from "../../../../application/ports/recipient-repository.js";

export type AuthenticatedPrincipal =
  | { kind: "owner"; ownerId: string }
  | { kind: "recipient"; grant: RecipientGrant };

declare module "fastify" {
  interface FastifyRequest {
    caller?: AuthenticatedPrincipal;
  }
}
