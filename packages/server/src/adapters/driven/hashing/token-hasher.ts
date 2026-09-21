/*
 * SHA-256, and nothing around it — schema §6. The rule this implements is
 * short enough to reimplement by accident somewhere else; don't. Both the
 * minting site and the bearer scheme call this one function.
 */

import { createHash } from "node:crypto";
import type { TokenHasher } from "../../../application/ports/token-hasher.js";

export function createTokenHasher(): TokenHasher {
  return {
    hash(token: Uint8Array): Uint8Array {
      return createHash("sha256").update(token).digest();
    },
  };
}
