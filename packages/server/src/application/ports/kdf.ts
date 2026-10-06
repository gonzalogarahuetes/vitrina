/*
 * Argon2id parameters as the relay stores them — one shape for both tables
 * that carry a passphrase-derived wrapping: `owner_keys` (§7.5, §8.1) and
 * `recipients` (§7.7). Same shape and, since `002`, the same floors
 * (16384 / 2 / 1 — schema §3). Two identical types would be two things to
 * update when the floors move.
 *
 * Floors are the route schemas' to enforce, mirroring `002`'s CHECKs — not
 * `001`'s, which shipped the v1 chosen values where floors belong. This type
 * carries no bound of its own.
 */

export type Argon2idParameters = {
  readonly memoryKib: number;
  readonly iterations: number;
  readonly parallelism: number;
};
