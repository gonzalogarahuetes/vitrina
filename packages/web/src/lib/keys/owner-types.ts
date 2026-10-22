/*
 * The owner's key functions. The owner approved these signatures on
 * 15 October 2026, and the two invite functions on 22 October 2026. The implementations (./owner-open.ts) are the owner's, on
 * CLAUDE.md's "do not write" list. The owner session (lib/owner/session.ts)
 * gets them injected and calls them. Nothing on the glue side derives, wraps
 * or unwraps.
 *
 * Rules that hold for every function below:
 *   - Each catches everything and returns a result, as openPassphraseKey does.
 *     A WASM trap still poisons the instance through envelope.ts's guard.
 *   - A handle a function creates for itself is freed by that function on
 *     every failure path. A handle returned on success belongs to the caller.
 */
import type { Envelope } from "$lib/envelope";
import type { KdfParameters } from "@vitrina/shared";
import type { AlbumKey, MasterKey, OwnerKek } from "@vitrina/envelope/wasm/envelope.js";

export type { AlbumKey, MasterKey, OwnerKek };

type Fail<E> = { readonly ok: false; readonly error: E };

/** `POST /v1/login/params` 200, shape-checked by the API layer, nothing decoded. */
export type LoginParams = {
  readonly kdf_salt: string;
  readonly kdf_memory_kib: number;
  readonly kdf_iterations: number;
  readonly kdf_parallelism: number;
};

/** `GET /v1/owner/key` 200, shape-checked, nothing decoded. */
export type OwnerKeyMaterial = LoginParams & {
  readonly wrapped_master: string;
  readonly wrap_nonce: string;
};

/** The fields of one `GET /v1/albums` row that opening its key needs. */
export type AlbumWrapping = {
  readonly id: string;
  readonly wrapped_key: string;
  readonly wrap_nonce: string;
};

// ── Signup (flows §3.2 step 2) ───────────────────────────────────────────

/**
 * Generates K_master and the salt, derives with OWNER_KDF_V1, wraps, and frees
 * the KEK before returning. The KEK never reaches the glue.
 */
export type SignupKeys = {
  readonly master: MasterKey;
  /** 32 bytes. The glue zeroes it once `POST /v1/signup` settles. */
  readonly proof: Uint8Array;
  /** 16 bytes. */
  readonly kdfSalt: Uint8Array;
  /** The parameters actually used, so the request body has one source for them. */
  readonly params: KdfParameters;
  /** 48 bytes. */
  readonly wrappedMaster: Uint8Array;
  /** 24 bytes. */
  readonly wrapNonce: Uint8Array;
};

export type CreateAccountKeysError =
  /** EmptyPassword. */
  | "empty"
  /** UnpairedSurrogate → signup.invalid */
  | "invalid-password"
  /** HashingFailed, RandomnessUnavailable, InvalidParams, any other throw → derive.failed */
  | "could-not-derive";

export type CreateAccountKeys = (
  env: Envelope,
  password: string,
) => Promise<{ readonly ok: true; readonly keys: SignupKeys } | Fail<CreateAccountKeysError>>;

// ── Sign-in step 2 (flows §3.3) ──────────────────────────────────────────

export type DeriveLoginCredentialError =
  | "empty"
  /** Unpaired surrogate. No account can have this password → signin.failed, and no request is sent. */
  | "invalid-password"
  | "could-not-derive"
  /** Bad base64url, NotUint32, InvalidParams, above the ceiling (kdf-ceiling.ts) → signin.unavailable */
  | "unusable-material";

/** The KEK is a handle because it has to outlive the `/login` round trip. */
export type DeriveLoginCredential = (
  env: Envelope,
  password: string,
  params: LoginParams,
) => Promise<{ readonly ok: true; readonly kek: OwnerKek; readonly proof: Uint8Array } | Fail<DeriveLoginCredentialError>>;

// ── Sign-in step 4 ───────────────────────────────────────────────────────

export type OpenMasterKeyError =
  /** AuthenticationFailed, UnexpectedKeyLength → signin.cannot-unlock, after POST /v1/logout */
  | "cannot-unlock"
  /** WrongLength, bad base64url → the same screen */
  | "unusable-material"
  /** Any other throw → derive.failed */
  | "could-not-derive";

/**
 * Frees `kek` every time, on success and on failure, the way openDirectKey
 * always zeroes `key`. The caller never touches it again.
 */
export type OpenMasterKey = (
  env: Envelope,
  kek: OwnerKek,
  material: OwnerKeyMaterial,
) => { readonly ok: true; readonly master: MasterKey } | Fail<OpenMasterKeyError>;

// ── Unlock (flows §3.1) ──────────────────────────────────────────────────

export type UnlockMasterKeyError =
  | "empty"
  /** AuthenticationFailed, UnpairedSurrogate → unlock.wrong */
  | "wrong-password"
  | "could-not-derive"
  | "unusable-material";

/**
 * Derivation and unwrap in one call. The proof is zeroed inside and never
 * returned, so the types make "unlock cannot call /login" structural.
 */
export type UnlockMasterKey = (
  env: Envelope,
  password: string,
  material: OwnerKeyMaterial,
) => Promise<{ readonly ok: true; readonly master: MasterKey } | Fail<UnlockMasterKeyError>>;

// ── Album list (flows §3.4) ──────────────────────────────────────────────

export type OpenAlbumKeyError =
  /** AuthenticationFailed, UnexpectedKeyLength */
  | "cannot-open"
  /** Bad uuid, base64url, WrongLength */
  | "unusable-material"
  | "could-not-derive";

/** One call per row. A failure marks that album as failed; it is never dropped. */
export type OpenAlbumKey = (
  env: Envelope,
  master: MasterKey,
  album: AlbumWrapping,
) => { readonly ok: true; readonly albumKey: AlbumKey } | Fail<OpenAlbumKeyError>;

// ── Create album (flows §3.5) ────────────────────────────────────────────

/**
 * Generates K_album (AlbumKey.generate(), which the owner is adding to the
 * binding) and wraps it under K_master with `albumId` in the AAD. `albumId` is
 * a lowercase uuid the glue generated.
 */
export type CreateAlbumKey = (
  env: Envelope,
  master: MasterKey,
  albumId: string,
) =>
  | { readonly ok: true; readonly albumKey: AlbumKey; readonly wrappedKey: Uint8Array; readonly wrapNonce: Uint8Array }
  /** RandomnessUnavailable, or any other throw. */
  | Fail<"could-not-derive">;

// ── Create invite (flows §3.8) ───────────────────────────────────────────
// Approved 22 October 2026, with full regeneration on a 409: the glue calls
// the function again from scratch and re-encrypts the label under the new id.

/** What both modes post, plus the token for the fragment. Every secret an invite needs is made in one place. */
type NewRecipient = {
  /** Lowercase UUIDv4 from crypto.randomUUID(). In the wrap AAD, and K_label derives from it. */
  readonly recipientId: string;
  /** The fragment's `t`: base64url, 43 chars. The 32 raw bytes are zeroed inside once encoded and hashed. */
  readonly token: string;
  /** SHA-256 of the 32 raw token bytes (schema §6). 32 bytes. The only form of the token that is posted. */
  readonly tokenHash: Uint8Array;
  /** 48 bytes. */
  readonly wrapped: Uint8Array;
  /** 24 bytes. */
  readonly wrapNonce: Uint8Array;
};

export type QrInvite = NewRecipient & {
  readonly kind: "qr";
  /** The fragment's `k`: base64url, 43 chars. From toInviteBytes(); that array is zeroed inside once encoded, and the InviteKey handle freed. */
  readonly inviteKey: string;
};

export type PassphraseInvite = NewRecipient & {
  readonly kind: "passphrase";
  /** PASSPHRASE_WORDS words as the list spells them, in order. Joined with U+0020 for the wrap. */
  readonly words: readonly string[];
  /** 16 bytes, drawn by the crate inside wrapAlbumKey. */
  readonly kdfSalt: Uint8Array;
  /** The parameters actually used (RECIPIENT_KDF_V1), so the request body has one source for them. */
  readonly params: KdfParameters;
};

/** One vetted wordlist (encryption spec §6.3), named by its file: `en.txt` is `en`. */
export type Wordlist = { readonly language: string; readonly words: readonly string[] };

/** Async only because crypto.subtle.digest is. `albumKey` is borrowed and never freed. */
export type CreateQrInvite = (
  env: Envelope,
  albumKey: AlbumKey,
) => Promise<{ readonly ok: true; readonly invite: QrInvite } | Fail<"could-not-derive">>;

export type CreatePassphraseInviteError =
  /** Fewer than 7,776 words: refused rather than drawing a passphrase under 64 bits. */
  | "unusable-wordlist"
  /** RandomnessUnavailable, HashingFailed, a subtle.digest failure, any other throw → derive.failed */
  | "could-not-derive";

/** Runs Argon2id: the glue shows the derivation wait (flows §2) and awaits two frames first. */
export type CreatePassphraseInvite = (
  env: Envelope,
  albumKey: AlbumKey,
  wordlist: Wordlist,
) => Promise<{ readonly ok: true; readonly invite: PassphraseInvite } | Fail<CreatePassphraseInviteError>>;

/** The eight functions, as the session takes them. */
export type OwnerKeyFunctions = {
  readonly createAccountKeys: CreateAccountKeys;
  readonly deriveLoginCredential: DeriveLoginCredential;
  readonly openMasterKey: OpenMasterKey;
  readonly unlockMasterKey: UnlockMasterKey;
  readonly openAlbumKey: OpenAlbumKey;
  readonly createAlbumKey: CreateAlbumKey;
  readonly createQrInvite: CreateQrInvite;
  readonly createPassphraseInvite: CreatePassphraseInvite;
};
