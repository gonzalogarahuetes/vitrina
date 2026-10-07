/*
 * GET /v1/recipient/key — api-sketch §10.1. A passphrase recipient's wrapped
 * K_album and its public parameters, handed back so the client can derive the
 * KEK and unwrap. Returns WRAPPED, never unwrapped: the relay holds no
 * passphrase, KEK or K_album to return (§4.1's outbound half, #16).
 *
 * The input is the GRANT, not an id. Only `authenticateRecipient` produces
 * one, so the type is what makes "the caller's own row, and only that" true —
 * a string could come from a path, a query or a body. An owner principal has
 * no grant, which keeps §7.1's schemes apart here as well as in the adapter.
 *
 * §7.3's ladder, recipient branch, steps 3 then 4:
 *   3. No wrapping for this caller (a qr row) → RECIPIENT_NOT_FOUND, a 404.
 *   4. Revoked → ALBUM_ACCESS_REVOKED, a 403.
 * So a revoked QR recipient gets 404 — a decision, pinned by
 * recipient-key-routes.test.mjs. Nothing is returned before step 4 runs; the
 * wrap is READ first, which is harmless, and RETURNED only after.
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

    // Step 4, after step 3: a revoked QR recipient gets 404, not 403.
    if (input.grant.revokedAt !== null) {
      throw new ApplicationError("ALBUM_ACCESS_REVOKED");
    }

    return {
      recipientId: input.grant.id,
      wrap,
    };
  };
}
