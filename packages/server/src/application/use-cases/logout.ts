import type { OwnerRepository } from "../ports/owner-repository.js";
import type { TokenHasher } from "../ports/token-hasher.js";

export type LogoutDeps = {
  readonly owners: OwnerRepository;
  readonly tokenHasher: TokenHasher;
};

export type LogoutInput = {
  readonly ownerId: string;
  readonly token: Uint8Array;
};

export function logout(deps: LogoutDeps) {
  return async (input: LogoutInput): Promise<void> => {
    const hash = deps.tokenHasher.hash(input.token);
    await deps.owners.revokeToken(input.ownerId, hash);
  };
}
