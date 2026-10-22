/*
 * Opening K_album — signatures approved by the owner. The implementations
 * (./open.ts) are the owner's: CLAUDE.md's "do not write" list. This chat calls
 * them, injected, and hands the resulting AlbumKey to the decrypt functions.
 */
import type { Envelope } from "$lib/envelope";
import type { AlbumKey } from "@vitrina/envelope/wasm/envelope.js";

export type { AlbumKey };

/**
 * `GET /v1/recipient/key` for a QR recipient (encryption spec §6.1), as the API
 * layer hands it over: `kind` checked, fields present and strings, nothing
 * decoded. Decoding, `id` included, is openInviteKey's, because it goes into
 * the wrap AAD. The session checks `kind` before calling: a passphrase answer
 * on a QR link is not recognised, and never reaches this type.
 */
export type InviteKeyMaterial = {
  readonly kind: "qr";
  readonly id: string;
  readonly wrapped: string;
  readonly wrap_nonce: string;
};

export type OpenInviteError =
  /** AuthenticationFailed: K_invite does not open this wrapping → dead page (flows §4.1 step 4) */
  | "damaged-link"
  /** Bad base64url, uuid or length in the relay's answer → notrecognised, as the passphrase mapping does */
  | "unusable-material"
  /** Anything else, a non-EnvelopeError throw included → device failed */
  | "could-not-derive";

export type OpenInviteResult =
  | { readonly ok: true; readonly albumKey: AlbumKey }
  | { readonly ok: false; readonly error: OpenInviteError };

/**
 * QR. Synchronous: no Argon2id. Zeroes `inviteKey` on every path, success or
 * failure — it is `invite.inviteKey`, decoded fresh from the fragment or the
 * tab's stored copy, so zeroing it never destroys the only one.
 */
export type OpenInviteKey = (
  env: Envelope,
  inviteKey: Uint8Array,
  material: InviteKeyMaterial,
) => OpenInviteResult;

/**
 * `GET /v1/recipient/key` for a passphrase recipient (encryption spec §6.2), as
 * the API layer hands it over: `kind` checked, fields present, strings and
 * integers, nothing decoded. Decoding, `id` included, is the owner's, because
 * it goes into the wrap AAD.
 */
export type PassphraseKeyMaterial = {
  readonly kind: "passphrase";
  readonly id: string;
  readonly kdf_salt: string;
  readonly wrapped: string;
  readonly wrap_nonce: string;
  readonly kdf_memory_kib: number;
  readonly kdf_iterations: number;
  readonly kdf_parallelism: number;
};

/** Either answer of `GET /v1/recipient/key`, told apart by `kind` (api-sketch §10.1). */
export type RecipientKeyMaterial = InviteKeyMaterial | PassphraseKeyMaterial;

export type UnwrapError =
  /** EmptyPassphrase: rejected before Argon2id → pass.empty */
  | "empty"
  /** AuthenticationFailed, UnpairedSurrogate → pass.wrong */
  | "wrong-passphrase"
  /** HashingFailed, RandomnessUnavailable, any non-EnvelopeError throw → derive.failed */
  | "could-not-derive"
  /** WrongLength, InvalidParams, UnexpectedKeyLength, bad base64url or uuid → notrecognised */
  | "unusable-material";

export type OpenPassphraseResult =
  | { readonly ok: true; readonly albumKey: AlbumKey }
  | { readonly ok: false; readonly error: UnwrapError };

export type OpenPassphraseKey = (
  env: Envelope,
  passphrase: string,
  material: PassphraseKeyMaterial,
) => Promise<OpenPassphraseResult>;
