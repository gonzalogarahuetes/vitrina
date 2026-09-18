/*
 * The one server secret's two uses — api-sketch §8.2, encryption spec §6.6.1:
 *   decoy_salt = HMAC-SHA-256(secret, "vitrina-decoy-v1"       ‖ normalised_email)[0..16]
 *   auth_hash  = HMAC-SHA-256(secret, "vitrina-auth-pepper-v1" ‖ proof)
 * A port so the login use case is testable without the secret, and so the
 * secret has ONE reader: the composition root builds the adapter from config
 * and hands it in. Not the token hasher (SHA-256), not Argon2id — schema §3.
 */

/** Bytes in, bytes out. `proof` is the 32 raw bytes, never its base64url string. */
export interface CredentialHasher {
  /**
   * `HMAC-SHA-256(secret, "vitrina-auth-pepper-v1" ‖ proof)`, 32 bytes. Stored in
   * `owners.auth_hash` at signup; recomputed at login for the constant-time compare.
   */
  authHash(proof: Uint8Array): Uint8Array;

  /**
   * `HMAC-SHA-256(secret, "vitrina-decoy-v1" ‖ UTF-8(normalisedEmail))[0..16]` — a
   * real salt's width. The caller normalises first, as it does before the lookup.
   */
  decoySalt(normalisedEmail: string): Uint8Array;
}
