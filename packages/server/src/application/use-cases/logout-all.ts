import type { OwnerRepository } from "../ports/owner-repository.js";

export type LogoutAllDeps = {
  readonly owners: OwnerRepository;
};

export type LogoutAllInput = {
  readonly ownerId: string;
};

export function logoutAll(deps: LogoutAllDeps) {
  return async (input: LogoutAllInput): Promise<void> => {
    await deps.owners.revokeAllTokens(input.ownerId);
  };
}
