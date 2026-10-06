import { ApplicationError } from "../errors.js";
import type { RecipientRepository } from "../ports/recipient-repository.js";

export type RevokeRecipientDeps = {
  readonly recipients: RecipientRepository;
};

export type RevokeRecipientInput = {
  readonly ownerId: string;
  readonly recipientId: string;
};

export function revokeRecipient(deps: RevokeRecipientDeps) {
  return async (input: RevokeRecipientInput): Promise<Date> => {
    const scope = await deps.recipients.findScopeById(input.recipientId);
    if (!scope || scope.ownerId !== input.ownerId) {
      throw new ApplicationError("RECIPIENT_NOT_FOUND");
    }

    return deps.recipients.revoke(input.recipientId);
  };
}
