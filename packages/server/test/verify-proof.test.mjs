/*
 * The proof comparison — api-sketch §7.5, §8.2. RED until
 * src/application/use-cases/verify-proof.ts exists. Expected export:
 *   makeVerifyProof(hasher: CredentialHasher): VerifyProof
 *   VerifyProof = (storedAuthHash: Uint8Array, proof: Uint8Array) => boolean
 * The stored side is `owners.auth_hash`; the function recomputes
 * HMAC(pepper, proof) and compares. Hermetic, real hasher, against dist/.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { makeVerifyProof } from "../dist/application/use-cases/verify-proof.js";
import { createCredentialHasher } from "../dist/adapters/driven/hashing/credential-hasher.js";

const range = (from, to) => new Uint8Array(Array.from({ length: to - from }, (_, i) => from + i));

const SECRET = range(0x10, 0x30);
const hasher = createCredentialHasher(SECRET);
const verifyProof = makeVerifyProof(hasher);

const PROOF = range(0x00, 0x20);
const OTHER_PROOF = range(0xe0, 0x100);
/** What signup would have stored for PROOF — the credential-hasher vector. */
const STORED = hasher.authHash(PROOF);

describe("makeVerifyProof", () => {
  it("accepts the proof the stored hash was made from", () => {
    assert.equal(verifyProof(STORED, PROOF), true);
  });

  it("rejects a different proof", () => {
    assert.equal(verifyProof(STORED, OTHER_PROOF), false);
  });

  it("rejects a proof that differs in one bit", () => {
    const nearly = Uint8Array.from(PROOF);
    nearly[31] ^= 0x01;
    assert.equal(verifyProof(STORED, nearly), false);
  });

  it("rejects another owner's stored hash", () => {
    assert.equal(verifyProof(hasher.authHash(OTHER_PROOF), PROOF), false);
  });

  it("compares against the STORED hash, not the proof's own bytes", () => {
    // The mistake that makes every login fail: timingSafeEqual(proof, computed).
    // Passing the proof as the stored side must not verify.
    assert.equal(verifyProof(PROOF, PROOF), false);
  });

  it("is keyed by the secret: the same proof under another secret does not verify", () => {
    const other = makeVerifyProof(createCredentialHasher(range(0x20, 0x40)));
    assert.equal(other(STORED, PROOF), false);
  });

  describe("a malformed stored hash", () => {
    it("throws rather than reporting wrong credentials", () => {
      // A 31-byte auth_hash is corruption or a wiring bug, not a bad password.
      // Returning false would lock the owner out and report it as their fault
      // (#17: does it work, wrongly, without this).
      assert.throws(() => verifyProof(STORED.subarray(0, 31), PROOF));
    });

    it("throws on an empty stored hash too", () => {
      assert.throws(() => verifyProof(new Uint8Array(0), PROOF));
    });
  });

  it("uses a constant-time comparison, by import (§6.2)", () => {
    // A text assertion, deliberately: equality of two 32-byte values is not
    // observable as timing from a test without flakiness, so what is asserted
    // is that the module reaches for timingSafeEqual rather than === or equals.
    const source = readFileSync(
      new URL("../dist/application/use-cases/verify-proof.js", import.meta.url),
      "utf8",
    );
    assert.match(source, /timingSafeEqual/, "verify-proof must use node:crypto's timingSafeEqual");
  });
});
