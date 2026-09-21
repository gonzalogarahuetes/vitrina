/*
 * The owner aggregate and its tokens — api-sketch §7.5, §8.3, schema §3.
 * Four routes read through this port: /signup writes, /login/params and /login
 * read by address, /owner/key reads by the caller's id. Architecture §4
 * decision 2 keeps it one aggregate, one repository; §1 keeps it free of `pg`.
 * Binary columns are `Uint8Array` at this boundary — never base64url, which is
 * transport and belongs to the HTTP adapter (schema §6).
 */

/** Argon2id, per `owner_keys` row. Floors are the signup schema's to enforce (§8.1). */
export type OwnerKdfParameters = {
  readonly memoryKib: number;
  readonly iterations: number;
  readonly parallelism: number;
};

/** What `/login/params` may return, and nothing else — §7.5. */
export type OwnerKdfRow = {
  readonly kdfSalt: Uint8Array; // 16
  readonly params: OwnerKdfParameters;
};

/** The password credential's full row, for `/owner/key` — §8.3. */
export type OwnerPasswordKey = OwnerKdfRow & {
  readonly wrappedMaster: Uint8Array; // 48 — ciphertext, never inspected
  readonly wrapNonce: Uint8Array; // 24
};

/** What `/login` compares against. Carries no key material (#16). */
export type OwnerCredential = {
  readonly id: string;
  readonly authHash: Uint8Array; // 32
};

export type NewOwner = {
  readonly email: string; // ALREADY normalised — §8.2, the caller applies it
  readonly authHash: Uint8Array;
  readonly passwordKey: OwnerPasswordKey;
};

export type CreatedOwner = {
  readonly id: string;
  readonly createdAt: Date;
};

export type OwnerToken = {
  readonly ownerId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
};

export type NewOwnerToken = {
  readonly ownerId: string;
  readonly tokenHash: Uint8Array; // SHA-256 of the 32 raw bytes (schema §6)
  readonly expiresAt: Date;
};

export interface OwnerRepository {
  /**
   * The `owners` row and its first `owner_keys` row, in ONE transaction (§7.5).
   * An owner with no wrapping can authenticate and decrypt nothing, and no route
   * can repair it. Duplicates come from the `UNIQUE`, never a prior `SELECT`,
   * and surface as `ApplicationError("DUPLICATE_ADDRESS")` — see errors.ts.
   */
  createWithPasswordKey(owner: NewOwner): Promise<CreatedOwner>;

  /**
   * `/login`'s lookup. Returns `null` for an unknown address — the caller
   * substitutes the dummy row rather than returning early (§4.3).
   */
  findCredentialByEmail(normalisedEmail: string): Promise<OwnerCredential | null>;

  /**
   * `/login/params`' lookup: the password-kind row's salt and parameters only.
   * Deliberately narrower than the row — a route that never fetches
   * `wrapped_master` has none to leak.
   */
  findKdfByEmail(normalisedEmail: string): Promise<OwnerKdfRow | null>;

  /**
   * `/owner/key`, by the id the bearer token resolved to. No address and no id
   * parameter, so there is nothing to enumerate (§8.3).
   */
  findPasswordKeyByOwnerId(ownerId: string): Promise<OwnerPasswordKey | null>;

  /** Both minting sites call this — one code path, two routes (§7.4). */
  insertToken(token: NewOwnerToken): Promise<void>;

  /**
   * Lookup by hash, never comparison (§7.2). Returns the row as stored; the
   * caller applies §7.3's steps 1–2, so the `401` reasoning stays where the
   * status codes live.
   */
  findTokenByHash(tokenHash: Uint8Array): Promise<OwnerToken | null>;
}
