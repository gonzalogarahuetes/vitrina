import { timingSafeEqual } from "node:crypto";
import type { CredentialHasher } from "../ports/credential-hasher.js";

export type VerifyProof = (
  storedAuthHash: Uint8Array,
  proof: Uint8Array,
) => boolean;

export function makeVerifyProof(hasher: CredentialHasher): VerifyProof {
  return (storedAuthHash, proof) =>
    timingSafeEqual(hasher.authHash(proof), storedAuthHash);
}
