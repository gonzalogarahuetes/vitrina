/*
 * The set of use cases the composition root builds and the HTTP adapter calls.
 *
 * vitrina-server-architecture.md §4 decision 4 fixes the shape each entry takes:
 * `(deps) => (input) => Promise<result>`. What is threaded through here is the
 * inner function — deps are bound once, at boot.
 */

import type { MintedSession } from "./mint-session.js";
import type { LoginInput } from "./login.js";
import type { LoginParamsInput } from "./login-params.js";
import type { SignupInput, SignupResult } from "./signup.js";
import type { OwnerKeyInput } from "./owner-key.js";
import type { AuthenticateOwnerInput } from "./authenticate-owner.js";
import type {
  OwnerKdfRow,
  OwnerPasswordKey,
} from "../ports/owner-repository.js";
import type { AuthenticateRecipientInput } from "./authenticate-recipient.js";
import type { RecipientGrant } from "../ports/recipient-repository.js";

export type UseCases = {
  // PR 2b — the owner credential lifecycle (api-sketch §7.5, §8.3).
  readonly signup: (input: SignupInput) => Promise<SignupResult>;
  readonly loginParams: (input: LoginParamsInput) => Promise<OwnerKdfRow>;
  readonly login: (input: LoginInput) => Promise<MintedSession>;
  readonly ownerKey: (input: OwnerKeyInput) => Promise<OwnerPasswordKey>;
  /** §7.3 steps 1-2. Null for unknown, revoked or expired — the adapter maps. */
  readonly authenticateOwner: (
    input: AuthenticateOwnerInput,
  ) => Promise<string | null>;
  /**
   * §7.3 step 1. Null for an unknown token ONLY — a revoked grant comes back
   * with `revokedAt` set, because step 4 runs after the route has resolved
   * scope. Folding revocation in here answers `401` where §7.1 wants `403`.
   */
  readonly authenticateRecipient: (
    input: AuthenticateRecipientInput,
  ) => Promise<RecipientGrant | null>;
};
