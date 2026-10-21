/*
 * The recipient credential — api-sketch §7.1, §7.3, §7.7, §7.8, schema §3.
 * The invite IS the credential — no expiry, no session, no refresh (§7.7,
 * brief §3).
 *
 * NO `delete`, and none should be added. `access_log.recipient_id` is
 * `ON DELETE CASCADE` (schema §5), so deleting a recipient row destroys that
 * recipient's entire view history — "María viewed this" — as a side effect of
 * revoking access. Revocation is `revoke` below: it sets `revoked_at` and
 * removes nothing (§7.8). §4.2's delete-objects-first rule covers albums and
 * owners and would not catch this, which is why it is stated here.
 */

import type { Argon2idParameters } from "./kdf.js";

/**
 * Narrower than the row, as `OwnerKdfRow` is. The six wrap columns are
 * §10.1's and PR 5's; `kind` and `label` are PR 4's and §11.4's. Each gets its
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

/**
 * A qr recipient's wrapping (encryption spec §6.1): K_album under K_invite,
 * which the invite carries and the relay never sees. Ciphertext, never key
 * material (#16). No KDF — K_invite is uniformly random and used directly.
 */
export type InviteWrap = {
  /** 48 bytes: K_album (32) + Poly1305 tag (16). */
  readonly wrapped: Uint8Array;
  /** 24 bytes. The field that gets forgotten (§7.7). */
  readonly wrapNonce: Uint8Array;
};

/**
 * A passphrase recipient's wrapping (encryption spec §6.2): K_album under a
 * KEK the relay never sees, and the public parameters that derive it.
 */
export type PassphraseWrap = InviteWrap & {
  /** 16 bytes. */
  readonly kdfSalt: Uint8Array;
  readonly params: Argon2idParameters;
};

/**
 * §10.1's answer: a recipient's wrapping, tagged with the kind that says which
 * unwrap the client runs. Every row has one since `006` (schema §3).
 */
export type RecipientWrap =
  | ({ readonly kind: "qr" } & InviteWrap)
  | ({ readonly kind: "passphrase" } & PassphraseWrap);

/**
 * A union, not four optional KDF fields: it mirrors `CHK_recipients_wrap_columns`
 * rather than trusting it. With optionals, `{ kind: "qr", kdfSalt }` compiles,
 * and a passphrase row without its salt reaches the database to be caught as
 * a 500.
 */
export type NewRecipient = {
  /** Client-generated, no server default — it is inside the wrap AAD (§7.7). */
  readonly id: string;
  readonly albumId: string;
  /**
   * 41–1024 bytes of ciphertext: nonce ‖ ciphertext ‖ tag under
   * K_label(recipient_id) (encryption spec §2). The relay cannot read it;
   * any character limit is the client's.
   */
  readonly label: Uint8Array;
  /** 32 bytes: SHA-256 of the raw token, computed by the client (§7.4). */
  readonly tokenHash: Uint8Array;
} & (
  | { readonly kind: "qr"; readonly wrap: InviteWrap }
  | { readonly kind: "passphrase"; readonly wrap: PassphraseWrap }
);

export type CreatedRecipient = {
  readonly id: string;
  readonly createdAt: Date;
};

/**
 * §11.4's row: the watermark's input. `label` is ciphertext, verbatim. No
 * `revokedAt` — the grant already carries it, and two copies can disagree.
 */
export type RecipientDetails = {
  readonly id: string;
  readonly albumId: string;
  readonly label: Uint8Array;
  readonly kind: "qr" | "passphrase";
  readonly createdAt: Date;
};

/** §7.8's scope input. `ownerId` comes from the `albums` join. */
export type RecipientScope = {
  readonly id: string;
  readonly albumId: string;
  readonly ownerId: string;
};

export interface RecipientRepository {
  /**
   * §7.3 step 1. SHA-256 over the 32 raw token bytes (schema §6), looked up
   * and never compared (§7.2). No `expires_at` on this side — recipient tokens
   * carry only revocation. `null` for no match; the caller maps it to `401`.
   */
  findGrantByTokenHash(tokenHash: Uint8Array): Promise<RecipientGrant | null>;

  /**
   * §7.7. Duplicates come from the constraints, never a prior `SELECT`. BOTH
   * `UNIQUE`s — the primary key and `token_hash` — surface as ONE code,
   * `ApplicationError("DUPLICATE_RECIPIENT")`: a `409` naming the column is an
   * oracle for "is this hash already in use".
   *
   * Any cause chained for the log is a message the adapter writes. Never the
   * pg error: its `detail` carries the colliding key, which here is the
   * submitted `token_hash` (#15).
   */
  create(recipient: NewRecipient): Promise<CreatedRecipient>;

  /**
   * §7.8's scope lookup. Returns `ownerId` rather than taking it, as
   * `AlbumRepository.findById` does, so §7.3 step 3 is decided in the use case
   * on every route alike. `null` for absent; the use case maps absent and
   * not-the-caller's to the same `404`.
   */
  findScopeById(recipientId: string): Promise<RecipientScope | null>;

  /**
   * §7.8. `SET revoked_at = COALESCE(revoked_at, now()) … RETURNING revoked_at`:
   * returns the ORIGINAL timestamp on every call after the first, and under
   * READ COMMITTED a concurrent second revoke blocks, re-reads, and returns the
   * first one too — idempotent under a race, not only in sequence. `now()` is
   * the database's, on the reasoning on `OwnerRepository`'s revocations.
   *
   * Called after `findScopeById`, by design. The window between the two is
   * harmless: no route deletes a recipient or an album, and the `COALESCE`
   * makes the update idempotent.
   */
  revoke(recipientId: string): Promise<Date>;

  /**
   * §10.1. A row's wrapping, of either kind, exactly as `create` stored it.
   * Ciphertext and its public parameters only — the relay holds no
   * `K_invite`, passphrase, KEK or `K_album` to return alongside it (§4.1's
   * outbound half, #16).
   *
   * `recipientId` comes from the grant §7.3 step 1 resolved, NEVER from the
   * request: there is no id in §10.1's path, and that absence is the scope
   * check. A caller passing a path or body value here rebuilds the
   * enumeration the flat route exists to remove.
   *
   * `null` only for an absent row. Until `006` it was also `null` for a qr
   * row, which held no wrapping; every row holds one now (schema §3), and a
   * row whose columns contradict its `kind` is a throw, not a `null`.
   *
   * Does NOT filter on `revoked_at`, as `findGrantByTokenHash` does not:
   * revocation is §7.3 step 4 and the use case's. The wrapping must not reach
   * a response before that check runs, which this method cannot enforce.
   */
  findWrapById(recipientId: string): Promise<RecipientWrap | null>;

  /**
   * §11.4. `recipientId` from the grant, never the request. Unfiltered on
   * `revoked_at`: revocation is step 4 and the use case's. `null` if absent.
   */
  findDetailsById(recipientId: string): Promise<RecipientDetails | null>;
}
