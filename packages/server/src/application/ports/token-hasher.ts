/*
 * SHA-256 of a relay-minted token — schema §6. Two call sites must agree byte
 * for byte: mint-session hashes what it stores, the bearer scheme hashes what
 * it is presented and looks the hash up (§7.2, §7.3). A disagreement makes
 * every session fail identically, with no diagnostic.
 * NOT the credential hasher (peppered HMAC, §8.2), NOT Argon2id — schema §3's
 * auth_hash comment lists the three kinds and why none becomes another.
 */

export interface TokenHasher {
  /**
   * The canonical input is the 32 RAW bytes, never the base64url string
   * (schema §6). The HTTP adapter decodes strictly; this hashes.
   *
   * A fast hash is correct here and only here: the relay mints these itself,
   * so 256 bits of CSPRNG entropy is a fact rather than a claim about a client.
   */
  hash(token: Uint8Array): Uint8Array;
}
