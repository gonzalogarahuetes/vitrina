/*
 * GET /v1/owner/key — api-sketch §8.3. The caller's own password row, resolved
 * from the bearer token: no id in the path, so there is nothing to enumerate
 * and no 404 to leak. Returns the wrapping WRAPPED; the relay cannot unwrap it
 * because it holds nothing to unwrap with (§4.1's outward twin).
 */

import type {
  OwnerPasswordKey,
  OwnerRepository,
} from "../ports/owner-repository.js";

export type OwnerKeyDeps = { readonly owners: OwnerRepository };
export type OwnerKeyInput = { readonly ownerId: string };

export function ownerKey(deps: OwnerKeyDeps) {
  return async (input: OwnerKeyInput): Promise<OwnerPasswordKey> => {
    const key = await deps.owners.findPasswordKeyByOwnerId(input.ownerId);
    if (key === null) {
      // Unreachable while signup's two writes stay one transaction (§7.5):
      // an authenticated owner has a password row. So this is a 500 with a
      // stack, not a 404 — the token was valid and the data is wrong.
      throw new Error("authenticated owner has no password key row");
    }
    return key;
  };
}
