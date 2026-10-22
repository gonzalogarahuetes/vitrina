/*
 * GET /v1/recipient/key — api-sketch §10.1. A recipient's wrapped K_album, of
 * either kind, handed back so the client can unwrap it: under K_invite for a
 * qr recipient (encryption spec §6.1), under a passphrase-derived KEK for a
 * passphrase one (§6.2), with the KDF's public parameters. Returns WRAPPED,
 * never unwrapped: the relay holds no K_invite, passphrase, KEK or K_album to
 * return (§4.1's outbound half, #16).
 *
 * The input is the GRANT, not an id. Only `authenticateRecipient` produces
 * one, so the type is what makes "the caller's own row, and only that" true —
 * a string could come from a path, a query or a body. An owner principal has
 * no grant, which keeps §7.1's schemes apart here as well as in the adapter.
 *
 * §7.3's ladder, recipient branch, steps 3 then 4:
 *   3. No row for this caller → RECIPIENT_NOT_FOUND, a 404. Unreachable in
 *      practice: the grant came from the same table, and no route deletes a
 *      recipient. Until 006 a qr row answered here too, holding no wrapping;
 *      every row holds one now, so a revoked qr recipient gets 403 like any
 *      other.
 *   4. Revoked → ALBUM_ACCESS_REVOKED, a 403. The wrapping is the one piece
 *      of ciphertext that lets a revoked holder of either kind of invite
 *      finish an unwrap they had not started (§10.1).
 * Nothing is returned before step 4 runs; the wrap is READ first, which is
 * harmless, and RETURNED only after.
 *
 * Revocation comes from the grant step 1 resolved, not a second read — one
 * snapshot per request, as `resolveAlbumScope` does.
 *
 * Writes no access log: §10.5 is open, and v1 writing nothing is that
 * question's default, not its answer.
 */

import { ApplicationError } from "../errors.js";
import type {
  RecipientGrant,
  RecipientRepository,
  RecipientWrap,
} from "../ports/recipient-repository.js";

export type GetRecipientKeyDeps = {
  readonly recipients: RecipientRepository;
};

export type GetRecipientKeyInput = {
  readonly grant: RecipientGrant;
};

export type RecipientKey = {
  readonly recipientId: string;
  readonly wrap: RecipientWrap;
};

export function getRecipientKey(deps: GetRecipientKeyDeps) {
  return async (input: GetRecipientKeyInput): Promise<RecipientKey> => {
    const wrap = await deps.recipients.findWrapById(input.grant.id);

    if (!wrap) throw new ApplicationError("RECIPIENT_NOT_FOUND");

    // Step 4, after step 3.
    if (input.grant.revokedAt !== null) {
      throw new ApplicationError("ALBUM_ACCESS_REVOKED");
    }

    return {
      recipientId: input.grant.id,
      wrap,
    };
  };
}
