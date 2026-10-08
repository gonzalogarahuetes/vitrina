// GET /v1/recipient — api-sketch §11.4. The caller's own row, the watermark's
// input. Takes the GRANT, not an id: only `authenticateRecipient` makes one,
// which is what keeps this to the caller's row. Writes no access log (§11.4).

import { ApplicationError } from "../errors.js";
import type {
  RecipientDetails,
  RecipientGrant,
  RecipientRepository,
} from "../ports/recipient-repository.js";

export type GetOwnRecipientDeps = {
  readonly recipients: RecipientRepository;
};

export type GetOwnRecipientInput = {
  readonly grant: RecipientGrant;
};

export function getOwnRecipient(deps: GetOwnRecipientDeps) {
  return async (input: GetOwnRecipientInput): Promise<RecipientDetails> => {
    // Revocation BEFORE the read, unlike get-recipient-key.ts: no album in the
    // path means no step-3 scope check, so step 4 is the first answer (§7.3).
    if (input.grant.revokedAt !== null) {
      throw new ApplicationError("ALBUM_ACCESS_REVOKED");
    }

    const recipientDetails = await deps.recipients.findDetailsById(
      input.grant.id,
    );

    // A broken invariant, not a 404: the grant just matched this row and
    // nothing deletes recipients (§4.2). A plain Error logs a stack (§1.2).
    if (!recipientDetails) {
      throw new Error("Recipient not found after grant match.");
    }

    return recipientDetails;
  };
}
