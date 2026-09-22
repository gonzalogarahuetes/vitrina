/*
 * The recipient credential — api-sketch §7.1, §7.3, §7.7, schema §3.
 * PR 2's scope completed, not PR 3's grown: PR 2b shipped four of §7.9's eight
 * routes and this scheme was never built. PR 3 is the first thing to need it.
 *
 * No create and no revoke: §7.7's route stays PR 2's and unbuilt, and the
 * tests insert rows directly. The invite IS the credential — no expiry, no
 * session, no refresh (§7.7, brief §3).
 */

/**
 * Narrower than the row, as `OwnerKdfRow` is. The six passphrase columns are
 * §10.1's and PR 4's; `kind` and `label` are PR 4's and §11.4's. Each gets its
 * own method rather than widening what every request loads.
 */
export type RecipientGrant = {
  readonly id: string;
  /** The single album this credential grants. §9.3 compares it to the path. */
  readonly albumId: string;
  /**
   * Returned as stored, NOT filtered — §7.3 puts scope at step 3 and
   * revocation at step 4. A `WHERE revoked_at IS NULL` answers `401` where a
   * revoked recipient asking for their own album must get `403`.
   */
  readonly revokedAt: Date | null;
};

export interface RecipientRepository {
  /**
   * §7.3 step 1. SHA-256 over the 32 raw token bytes (schema §6), looked up
   * and never compared (§7.2). No `expires_at` on this side — recipient tokens
   * carry only revocation. `null` for no match; the caller maps it to `401`.
   */
  findGrantByTokenHash(tokenHash: Uint8Array): Promise<RecipientGrant | null>;
}
