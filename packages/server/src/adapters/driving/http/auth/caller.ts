/*
 * The one `FastifyRequest` augmentation — two declarations of `caller` with
 * different types do not compile, so this file exists to be the only one.
 *
 * The type itself is `application/caller.ts`'s: who is calling is an
 * application concept, and this adapter only parks it on a request. The import
 * points inward, which is the direction architecture §1 allows.
 */

import type { AuthenticatedPrincipal } from "../../../../application/caller.js";
import type { TokenLimiter } from "../token-limiter.js";

declare module "fastify" {
  interface FastifyRequest {
    /** §7.3 step 1's result. §7.1's `Caller` is what a route builds from it. */
    caller?: AuthenticatedPrincipal;
  }
  interface FastifyInstance {
    /** §11.5's one limiter, decorated on the root so every plugin shares it. */
    tokenLimiter: TokenLimiter;
  }
  interface FastifyContextConfig {
    /** §11.5: charges the shared byte budget, which implies `no-store`. */
    chargesByteBudget?: boolean;
  }
}
