/*
 * Opening K_album — signatures approved by the owner. The implementations
 * (./open.ts) are the owner's: CLAUDE.md's "do not write" list. This chat calls
 * them, injected, and hands the resulting AlbumKey to the decrypt functions.
 */
import type { Envelope } from "$lib/envelope";
import type { AlbumKey } from "@vitrina/envelope/wasm/envelope.js";

export type { AlbumKey };

export type OpenDirectResult = { readonly ok: true; readonly albumKey: AlbumKey } | { readonly ok: false; readonly error: "could-not-derive" };

/** QR. Builds the AlbumKey, then zeroes `key` — which is invite.key, the same array. */
export type OpenDirectKey = (env: Envelope, key: Uint8Array) => OpenDirectResult;

/**
 * `GET /v1/recipient/key` as the API layer hands it over: shape-checked
 * (fields present, strings and integers), nothing decoded. Decoding, `id`
 * included, is the owner's, because it goes into the wrap AAD.
 */
export type RecipientKeyMaterial = {
  readonly id: string;
  readonly kdf_salt: string;
  readonly wrapped: string;
  readonly wrap_nonce: string;
  readonly kdf_memory_kib: number;
  readonly kdf_iterations: number;
  readonly kdf_parallelism: number;
};

export type UnwrapError =
  /** EmptyPassphrase: rejected before Argon2id → pass.empty */
  | "empty"
  /** AuthenticationFailed, UnpairedSurrogate → pass.wrong */
  | "wrong-passphrase"
  /** HashingFailed, RandomnessUnavailable, any non-EnvelopeError throw → derive.failed */
  | "could-not-derive"
  /** WrongLength, InvalidParams, UnexpectedKeyLength, bad base64url or uuid → notrecognised */
  | "unusable-material";

export type OpenPassphraseResult = { readonly ok: true; readonly albumKey: AlbumKey } | { readonly ok: false; readonly error: UnwrapError };

export type OpenPassphraseKey = (env: Envelope, passphrase: string, material: RecipientKeyMaterial) => Promise<OpenPassphraseResult>;
