/*
 * Albums — api-sketch §9.2, §9.3, §9.4, schema §3.
 * Binary columns are `Uint8Array` here; base64url is transport and belongs to
 * the HTTP adapter (schema §6).
 */

export type NewAlbum = {
  /** Client-generated, no server default — it is inside the wrap AAD (§9.1). */
  readonly id: string;
  readonly ownerId: string;
  /**
   * 41–1024 bytes of ciphertext: nonce ‖ ciphertext ‖ tag under K_title
   * (encryption spec §2). The relay stores it and cannot read it; the client's
   * character limit is the client's, since nothing here can count characters.
   */
  readonly title: Uint8Array;
  /** 48 bytes. Ciphertext, not key material — §4.1's third accepted wrapping. */
  readonly wrappedKey: Uint8Array;
  /** 24 bytes. The field that gets forgotten (§7.7). */
  readonly wrapNonce: Uint8Array;
};

export type CreatedAlbum = {
  readonly id: string;
  readonly createdAt: Date;
};

/** §9.2's list. Owner-only by construction, so it needs no branch on caller kind. */
export type OwnerAlbum = CreatedAlbum & {
  readonly title: Uint8Array;
  readonly wrappedKey: Uint8Array;
  readonly wrapNonce: Uint8Array;
  /** `COUNT(*)` over the album's media rows regardless of `status` (§9.2). */
  readonly mediaCount: number;
};

/** §9.4's row — no wrapping, no envelopes, no byte sizes. Either caller kind. */
export type AlbumRow = CreatedAlbum & {
  readonly ownerId: string;
  readonly title: Uint8Array;
};

export interface AlbumRepository {
  /**
   * Duplicates come from the primary key, never a prior `SELECT`, and surface
   * as `ApplicationError("DUPLICATE_ALBUM_ID")` — §9.2's `409` means "already
   * created", because a fresh id would orphan the wrapping.
   */
  create(album: NewAlbum): Promise<CreatedAlbum>;

  /** §9.2, `created_at` descending. No pagination in v1 — a key list an owner
   * can hold half of is worse than a long one. */
  listForOwner(ownerId: string): Promise<readonly OwnerAlbum[]>;

  /**
   * §9.4 and §9.5's scope lookup. Returns `ownerId` rather than taking it, so
   * §9.3's comparison happens once in the use case: the owner branch checks it,
   * the recipient branch checks `caller.albumId` and never reads it.
   */
  findById(albumId: string): Promise<AlbumRow | null>;
}
