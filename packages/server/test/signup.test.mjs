/*
 * The /signup use case — api-sketch §7.5, §8.2. RED until
 * src/application/use-cases/signup.ts exists. Expected export:
 *   signup(deps: {owners, hasher, mintSession, allowList}):
 *     (input: {email, proof, kdfSalt, params, wrappedMaster, wrapNonce})
 *       => Promise<{id, createdAt, token, expiresAt}>
 * Floors are the JSON Schema's (§8.1), so no floors test here.
 * Hermetic: fake repository and minter, the real hasher, against dist/.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { signup } from "../dist/application/use-cases/signup.js";
import { createCredentialHasher } from "../dist/adapters/driven/hashing/credential-hasher.js";

const hex = (u8) => Buffer.from(u8).toString("hex");
const range = (from, to) => new Uint8Array(Array.from({ length: to - from }, (_, i) => from + i));

const hasher = createCredentialHasher(range(0x10, 0x30));

const PROOF = range(0x00, 0x20); // 32
const NEW_OWNER_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = new Date("2026-09-19T10:00:00Z");
const SESSION = { token: range(0x70, 0x90), expiresAt: new Date("2026-10-03T10:00:00Z") };

/**
 * The allowlist as config.ts builds it: normalised entries. "ana@x.es" is what
 * the default body's "Ana@X.es" normalises to, so every case outside the
 * allowlist block below is an invited address.
 */
const LISTED = new Set(["ana@x.es"]);

const body = (email = "Ana@X.es") => ({
  email,
  proof: PROOF,
  kdfSalt: range(0x40, 0x50), // 16
  params: { memoryKib: 65536, iterations: 3, parallelism: 1 },
  wrappedMaster: range(0x80, 0xb0), // 48
  wrapNonce: range(0xc0, 0xd8), // 24
});

/** Records every create; `fail` makes the UNIQUE fire, as the adapter would. */
function fakeOwners({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async createWithPasswordKey(owner) {
      calls.push(owner);
      if (fail) throw fail;
      return { id: NEW_OWNER_ID, createdAt: CREATED_AT };
    },
  };
}

function spyMint() {
  const calls = [];
  const fn = async (ownerId) => {
    calls.push(ownerId);
    return SESSION;
  };
  fn.calls = calls;
  return fn;
}

/** Every byte string anywhere in a structure, for the leak scan below. */
function everyByteString(value, found = []) {
  if (value instanceof Uint8Array) found.push(hex(value));
  else if (value && typeof value === "object") for (const v of Object.values(value)) everyByteString(v, found);
  return found;
}

describe("signup", () => {
  describe("the write", () => {
    it("creates the owner and the key row in ONE repository call", async () => {
      // The transaction is the repository's, so the port takes both halves at
      // once. Two calls here would be a state no route can repair (§7.5).
      const owners = fakeOwners();
      await signup({ allowList: LISTED, owners, hasher, mintSession: spyMint() })(body());

      assert.equal(owners.calls.length, 1);
    });

    it("stores the normalised address, not the address as typed", async () => {
      const owners = fakeOwners();
      await signup({ allowList: LISTED, owners, hasher, mintSession: spyMint() })(body("  Ana@X.ES  "));

      assert.equal(owners.calls[0].email, "ana@x.es");
    });

    it("stores HMAC(pepper, proof) as the auth hash", async () => {
      const owners = fakeOwners();
      await signup({ allowList: LISTED, owners, hasher, mintSession: spyMint() })(body());

      assert.equal(hex(owners.calls[0].authHash), hex(hasher.authHash(PROOF)));
    });

    it("passes the key material through verbatim", async () => {
      const owners = fakeOwners();
      const input = body();
      await signup({ allowList: LISTED, owners, hasher, mintSession: spyMint() })(input);

      const key = owners.calls[0].passwordKey;
      assert.equal(hex(key.kdfSalt), hex(input.kdfSalt));
      assert.equal(hex(key.wrappedMaster), hex(input.wrappedMaster));
      assert.equal(hex(key.wrapNonce), hex(input.wrapNonce));
      assert.deepEqual(key.params, input.params);
    });

    it("writes the proof nowhere", async () => {
      // The relay never holds the proof after the request is answered (§7.5):
      // it reaches the hasher and nothing else. Scans every byte string in the
      // repository input, at any depth.
      const owners = fakeOwners();
      await signup({ allowList: LISTED, owners, hasher, mintSession: spyMint() })(body());

      assert.equal(
        everyByteString(owners.calls[0]).includes(hex(PROOF)),
        false,
        "the raw proof reached the repository",
      );
    });
  });

  describe("the response", () => {
    it("mints a session for the new owner (§7.4)", async () => {
      const mintSession = spyMint();
      await signup({ allowList: LISTED, owners: fakeOwners(), hasher, mintSession })(body());

      assert.deepEqual(mintSession.calls, [NEW_OWNER_ID]);
    });

    it("returns the id, the timestamp and the session — and nothing else", async () => {
      // §7.5's 201 body. The wrapping does not come back: the signing-up device
      // holds K_master already, and §8.3 is the route that returns it.
      const result = await signup({ allowList: LISTED, owners: fakeOwners(), hasher, mintSession: spyMint() })(body());

      assert.deepEqual(Object.keys(result).sort(), ["createdAt", "expiresAt", "id", "token"]);
      assert.equal(result.id, NEW_OWNER_ID);
      assert.equal(result.createdAt.toISOString(), CREATED_AT.toISOString());
      assert.equal(hex(result.token), hex(SESSION.token));
      assert.equal(result.expiresAt.toISOString(), SESSION.expiresAt.toISOString());
    });
  });

  describe("failure", () => {
    it("propagates the duplicate address and mints nothing", async () => {
      // §4.3 carves signup out: a registered address IS revealed, by design.
      const duplicate = Object.assign(new Error("DUPLICATE_ADDRESS"), { code: "DUPLICATE_ADDRESS" });
      const mintSession = spyMint();

      await assert.rejects(
        signup({ allowList: LISTED, owners: fakeOwners({ fail: duplicate }), hasher, mintSession })(body()),
        (error) => error.code === "DUPLICATE_ADDRESS",
      );
      assert.deepEqual(mintSession.calls, []);
    });

    it("rejects an address empty after normalisation, before writing", async () => {
      const owners = fakeOwners();
      const mintSession = spyMint();

      await assert.rejects(
        signup({ allowList: LISTED, owners, hasher, mintSession })(body("   ")),
        (error) => error.code === "EMPTY_ADDRESS",
      );
      assert.deepEqual(owners.calls, []);
      assert.deepEqual(mintSession.calls, []);
    });
  });

  describe("the allowlist — closed by default, checked before anything is written", () => {
    /** The real hasher, counted: a refused address must cost no work. */
    function countingHasher() {
      const calls = [];
      return { calls, authHash: (proof) => (calls.push(proof), hasher.authHash(proof)) };
    }

    it("refuses an address that is not listed, before hashing, writing or minting", async () => {
      const owners = fakeOwners();
      const counted = countingHasher();
      const mintSession = spyMint();

      await assert.rejects(
        signup({ allowList: LISTED, owners, hasher: counted, mintSession })(body("eve@x.es")),
        (error) => error.code === "SIGNUP_NOT_ALLOWED",
      );
      assert.deepEqual(owners.calls, []);
      assert.deepEqual(counted.calls, []);
      assert.deepEqual(mintSession.calls, []);
    });

    it("an empty list refuses everyone — the address that otherwise succeeds included", async () => {
      // Brief §6 #17: a missing or empty setting means closed, never open.
      const owners = fakeOwners();

      await assert.rejects(
        signup({ allowList: new Set(), owners, hasher, mintSession: spyMint() })(body()),
        (error) => error.code === "SIGNUP_NOT_ALLOWED",
      );
      assert.deepEqual(owners.calls, []);
    });

    it("matches on the normalised address: a listed address typed differently is admitted", async () => {
      // The list holds normalised entries (config.ts), so the check must compare
      // the normalised form — the as-typed one would refuse "  ANA@x.ES ".
      const owners = fakeOwners();

      await signup({ allowList: LISTED, owners, hasher, mintSession: spyMint() })(body("  ANA@x.ES "));
      assert.equal(owners.calls[0].email, "ana@x.es");
    });

    it("is checked before the UNIQUE: an unlisted address learns nothing about existing accounts", async () => {
      // The store would answer DUPLICATE_ADDRESS; it must never be asked.
      const duplicate = Object.assign(new Error("DUPLICATE_ADDRESS"), { code: "DUPLICATE_ADDRESS" });
      const owners = fakeOwners({ fail: duplicate });

      await assert.rejects(
        signup({ allowList: LISTED, owners, hasher, mintSession: spyMint() })(body("eve@x.es")),
        (error) => error.code === "SIGNUP_NOT_ALLOWED",
      );
      assert.deepEqual(owners.calls, []);
    });

    it("a listed address that already has an account still gets DUPLICATE_ADDRESS", async () => {
      const duplicate = Object.assign(new Error("DUPLICATE_ADDRESS"), { code: "DUPLICATE_ADDRESS" });

      await assert.rejects(
        signup({ allowList: LISTED, owners: fakeOwners({ fail: duplicate }), hasher, mintSession: spyMint() })(body()),
        (error) => error.code === "DUPLICATE_ADDRESS",
      );
    });

    it("an empty address is still EMPTY_ADDRESS, whatever the list", async () => {
      // A property of the input (§8.2), so it comes first and says nothing about the list.
      await assert.rejects(
        signup({ allowList: new Set(), owners: fakeOwners(), hasher, mintSession: spyMint() })(body("   ")),
        (error) => error.code === "EMPTY_ADDRESS",
      );
    });

    it("the refusal carries no request content (#15)", async () => {
      await assert.rejects(
        signup({ allowList: LISTED, owners: fakeOwners(), hasher, mintSession: spyMint() })(body("eve@x.es")),
        (error) => {
          assert.equal(error.message, "SIGNUP_NOT_ALLOWED");
          assert.equal(error.details, undefined);
          return true;
        },
      );
    });
  });
});
