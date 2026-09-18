/*
 * Vectors for the CredentialHasher adapter — api-sketch §8.2's two HMACs.
 * Every digest was computed in Python (hmac/hashlib), so this is a second
 * implementation, not node:crypto checking itself. Expected export:
 *   createCredentialHasher(secret: Uint8Array)  from dist/adapters/driven/hashing/
 * The secret arrives as an argument; the adapter reads no environment variable.
 * Hermetic, against dist/.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCredentialHasher } from "../dist/adapters/driven/hashing/credential-hasher.js";

const hex = (u8) => Buffer.from(u8).toString("hex");
const bytes = (h) => new Uint8Array(Buffer.from(h, "hex"));
const range = (from, to) => new Uint8Array(Array.from({ length: to - from }, (_, i) => from + i));

/** 32 bytes, 0x10..0x2f. Fixed, so every digest below is reproducible. */
const SECRET_A = range(0x10, 0x30);
/** Differs from SECRET_A in byte 0 only. */
const SECRET_B = bytes("ff1112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f");

const PROOF_SEQ = range(0x00, 0x20); // 0x00..0x1f
const PROOF_ZERO = new Uint8Array(32);
const PROOF_HIGH = range(0xe0, 0x100); // 0xe0..0xff

describe("createCredentialHasher — §8.2 vectors", () => {
  const hasher = createCredentialHasher(SECRET_A);

  describe("authHash", () => {
    const vectors = [
      { name: "proof 0x00..0x1f", proof: PROOF_SEQ, expected: "e0986037ea5af1d4241394d269e309f4384fc6226887b6fd87c891dcc6a66ef4" },
      { name: "proof all zero", proof: PROOF_ZERO, expected: "a2cd48f261731732bc2a153efcb31e3523d21d713b64e5e365e267105d511adb" },
      { name: "proof 0xe0..0xff", proof: PROOF_HIGH, expected: "30b60746a8f78d21676502f882771ce6a4730bd5ef12def7bb369dcec6484799" },
    ];

    for (const { name, proof, expected } of vectors) {
      it(`${name} → ${expected.slice(0, 8)}…`, () => {
        assert.equal(hex(hasher.authHash(proof)), expected);
      });
    }

    it("is 32 bytes", () => {
      assert.equal(hasher.authHash(PROOF_SEQ).byteLength, 32);
    });

    it("is deterministic", () => {
      assert.equal(hex(hasher.authHash(PROOF_SEQ)), hex(hasher.authHash(PROOF_SEQ)));
    });

    it("depends on the secret: one byte of key changes the whole digest", () => {
      const other = createCredentialHasher(SECRET_B);
      assert.equal(
        hex(other.authHash(PROOF_SEQ)),
        "aef0eee090f168269cfce74e089c872af18bb81c7d4a1da4f2351adb8d46065b",
      );
    });

    it("hashes the raw bytes, not the base64url spelling of them", () => {
      // The 43-char string as UTF-8 — what a careless caller would pass.
      const b64Spelling = Buffer.from(Buffer.from(PROOF_SEQ).toString("base64url"), "utf8");
      const wrong = "0bbe766e1e7d1ccb0933e55cfc516cb6f248688d8fd5eb6fe87ec2d8088bf03b";
      assert.notEqual(hex(hasher.authHash(PROOF_SEQ)), wrong);
      // Pinned so an adapter that starts accepting strings fails here.
      assert.equal(hex(hasher.authHash(new Uint8Array(b64Spelling))), wrong);
    });
  });

  describe("decoySalt", () => {
    const vectors = [
      { name: "ana@x.es", email: "ana@x.es", expected: "e30069253cc1b706bea502a494538b45" },
      // UTF-8 of é is c3 a9; UTF-16 would give c751251b… (pinned below).
      { name: "caf\u00e9@x.es (UTF-8)", email: "caf\u00e9@x.es", expected: "8ccb9c9b853482dfd8ebbd3f413bf02e" },
      // Rejecting "" is the use cases' job (§8.2); the hasher must not care.
      { name: "empty string is hashed, not rejected", email: "", expected: "92e42f50aaa01c507b441fdd2adf8a4b" },
      // U+FEFF survives normaliseAddress, so it reaches here and is hashed as-is.
      { name: "takes the normalised address as given, no second normalisation", email: "\ufeffana@x.es", expected: "957bb7a827b752ea4551601c8c0e3609" },
    ];

    for (const { name, email, expected } of vectors) {
      it(`${name} → ${expected.slice(0, 8)}…`, () => {
        assert.equal(hex(hasher.decoySalt(email)), expected);
      });
    }

    it("is 16 bytes — the width of a real kdf_salt", () => {
      // A decoy of a different length than a stored salt is a distinguisher (§7.5).
      assert.equal(hasher.decoySalt("ana@x.es").byteLength, 16);
    });

    it("is the FIRST 16 bytes of the full HMAC, not the last or a re-hash", () => {
      const full = "e30069253cc1b706bea502a494538b45731af977558b8809a1f0276b108e08a8";
      assert.equal(hex(hasher.decoySalt("ana@x.es")), full.slice(0, 32));
    });

    it("encodes the address as UTF-8, not UTF-16", () => {
      assert.notEqual(hex(hasher.decoySalt("caf\u00e9@x.es")), "c751251b776f7fa32ba3de450e2b1eb6");
    });

    it("is deterministic — repeated attempts return the same salt (§4.3)", () => {
      assert.equal(hex(hasher.decoySalt("nobody@x.es")), hex(hasher.decoySalt("nobody@x.es")));
    });

    it("depends on the secret", () => {
      const other = createCredentialHasher(SECRET_B);
      assert.notEqual(hex(other.decoySalt("ana@x.es")), hex(hasher.decoySalt("ana@x.es")));
    });
  });

  describe("domain separation", () => {
    it("the same 32 bytes through the two domains give unrelated outputs", () => {
      // Same bytes into both methods: shared or absent domain strings would agree.
      const asEmail = Buffer.from(PROOF_SEQ).toString("latin1");
      const decoyOfProofBytes = hasher.decoySalt(asEmail);
      const authOfProofBytes = hasher.authHash(PROOF_SEQ);
      assert.notEqual(hex(decoyOfProofBytes), hex(authOfProofBytes).slice(0, 32));
    });
  });
});
