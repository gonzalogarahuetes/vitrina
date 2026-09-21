import { createHmac } from "node:crypto";
import type { CredentialHasher } from "../../../application/ports/credential-hasher.js";

class CredentialHasherAdapter implements CredentialHasher {
  private readonly secret: Uint8Array;
  constructor(secret: Uint8Array) {
    this.secret = secret;
  }

  authHash(proof: Uint8Array): Uint8Array {
    return createHmac("sha256", this.secret) // key
      .update("vitrina-auth-pepper-v1", "ascii") // message, part 1
      .update(proof) // message, part 2
      .digest();
  }

  decoySalt(normalisedEmail: string): Uint8Array {
    return createHmac("sha256", this.secret) // key
      .update("vitrina-decoy-v1", "ascii")
      .update(normalisedEmail, "utf8")
      .digest()
      .subarray(0, 16);
  }
}

export function createCredentialHasher(secret: Uint8Array): CredentialHasher {
  return new CredentialHasherAdapter(secret);
}
