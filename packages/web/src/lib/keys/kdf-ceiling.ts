/*
 * The Argon2id parameter ceiling, one copy, for every derivation whose
 * parameters come from the relay: `GET /v1/recipient/key` (lib/keys/open.ts),
 * and `POST /v1/login/params` and `GET /v1/owner/key` (the owner functions in
 * lib/keys/owner-open.ts). A relay row with unbounded parameters could freeze
 * the tab, and the crate sets no upper bound.
 *
 * Memory × iterations is capped at 4 × v1 (~9 s on the slowest target phone),
 * and memory at 2 × v1 (low-end Android).
 *
 * INTEROP RULE: before the parameters for new invites or new accounts rise
 * above these ceilings, every client must have raised its own ceilings first.
 * Otherwise an account or invite created by a newer client cannot be opened by
 * an older one.
 */
import type { KdfParameters } from "@vitrina/shared";

export const KDF_CEILING = {
  /** 2 × v1's 64 MiB. */
  maxMemoryKib: 131_072,
  maxParallelism: 4,
  /** 4 × v1's 65536 KiB × 3. */
  maxMemoryTimesIterations: 786_432,
} as const;

/** True if a derivation with these parameters may run on this device. */
export function withinKdfCeiling(p: KdfParameters): boolean {
  return (
    p.memoryKib <= KDF_CEILING.maxMemoryKib &&
    p.parallelism <= KDF_CEILING.maxParallelism &&
    p.memoryKib * p.iterations <= KDF_CEILING.maxMemoryTimesIterations
  );
}
