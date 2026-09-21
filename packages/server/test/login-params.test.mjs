/*
 * The /login/params use case — api-sketch §7.5, §4.3, §8.2. RED until
 * src/application/use-cases/login-params.ts exists. Expected export:
 *   loginParams(deps: {owners, hasher, kdfV1}):
 *     (input: {email: string}) => Promise<OwnerKdfRow>
 * `email` arrives AS TYPED; the use case normalises. Wire names (`kdf_salt`,
 * snake_case) are the HTTP adapter's — architecture §4 decision 5.
 * Hermetic: a fake repository, the real hasher, no Postgres.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loginParams } from "../dist/application/use-cases/login-params.js";
import { createCredentialHasher } from "../dist/adapters/driven/hashing/credential-hasher.js";
import { normaliseAddress } from "../dist/domain/owner/normalise-address.js";

const hex = (u8) => Buffer.from(u8).toString("hex");
const range = (from, to) => new Uint8Array(Array.from({ length: to - from }, (_, i) => from + i));

const SECRET = range(0x10, 0x30);
const hasher = createCredentialHasher(SECRET);

/** The v1 constant, passed through deps — application/ may not import shared. */
const KDF_V1 = { memoryKib: 65536, iterations: 3, parallelism: 1 };

/** A stored row, deliberately NOT equal to KDF_V1 so a hit cannot pass as a miss. */
const STORED = {
  kdfSalt: range(0x40, 0x50),
  params: { memoryKib: 131072, iterations: 4, parallelism: 2 },
};

/** Records every lookup, so the call COUNT and its ARGUMENT are both assertable. */
function fakeOwners(rows = new Map()) {
  const calls = [];
  return {
    calls,
    async findKdfByEmail(normalisedEmail) {
      calls.push(normalisedEmail);
      return rows.get(normalisedEmail) ?? null;
    },
  };
}

describe("loginParams", () => {
  describe("an address with an account", () => {
    it("returns the stored salt and parameters", async () => {
      const owners = fakeOwners(new Map([["ana@x.es", STORED]]));
      const result = await loginParams({ owners, hasher, kdfV1: KDF_V1 })({ email: "ana@x.es" });

      assert.equal(hex(result.kdfSalt), hex(STORED.kdfSalt));
      assert.deepEqual(result.params, STORED.params);
    });

    it("finds the account whatever spelling was typed", async () => {
      // §8.2: normalisation runs before the lookup, so a differently-cased,
      // differently-spaced spelling reaches the same row.
      const owners = fakeOwners(new Map([["ana@x.es", STORED]]));
      const result = await loginParams({ owners, hasher, kdfV1: KDF_V1 })({ email: "  Ana@X.ES  " });

      assert.equal(hex(result.kdfSalt), hex(STORED.kdfSalt), "a miss here means the lookup saw the as-typed form");
      assert.deepEqual(owners.calls, ["ana@x.es"]);
    });
  });

  describe("an address with no account", () => {
    it("still answers, with the deterministic decoy salt", async () => {
      const owners = fakeOwners();
      const result = await loginParams({ owners, hasher, kdfV1: KDF_V1 })({ email: "nobody@x.es" });

      assert.equal(hex(result.kdfSalt), hex(hasher.decoySalt("nobody@x.es")));
    });

    it("returns the v1 parameters, so a decoy has nothing to distinguish it", async () => {
      // §8.1: the decoy carries what every real row carries. Assert against the
      // constant from deps — the same one a client build signs up with.
      const owners = fakeOwners();
      const result = await loginParams({ owners, hasher, kdfV1: KDF_V1 })({ email: "nobody@x.es" });

      assert.deepEqual(result.params, KDF_V1);
    });

    it("computes the decoy from the NORMALISED address", async () => {
      // Two spellings of one unknown address must give one salt. Hashing the
      // as-typed form makes the salt vary per spelling, which is the oracle
      // §4.3's "a varying salt is itself an oracle" names.
      const owners = fakeOwners();
      const call = loginParams({ owners, hasher, kdfV1: KDF_V1 });

      const a = await call({ email: "Nobody@X.es" });
      const b = await call({ email: " nobody@x.es " });
      assert.equal(hex(a.kdfSalt), hex(b.kdfSalt));
      assert.equal(hex(a.kdfSalt), hex(hasher.decoySalt(normaliseAddress("Nobody@X.es"))));
    });

    it("is indistinguishable in shape from a hit", async () => {
      const hit = await loginParams({ owners: fakeOwners(new Map([["ana@x.es", STORED]])), hasher, kdfV1: KDF_V1 })({ email: "ana@x.es" });
      const miss = await loginParams({ owners: fakeOwners(), hasher, kdfV1: KDF_V1 })({ email: "nobody@x.es" });

      assert.deepEqual(Object.keys(hit).sort(), Object.keys(miss).sort());
      assert.equal(hit.kdfSalt.byteLength, miss.kdfSalt.byteLength);
    });
  });

  describe("§4.3 — the lookup runs unconditionally", () => {
    it("queries exactly once on a hit and once on a miss", async () => {
      // The structural assertion §6.2 asks for instead of a stopwatch: the
      // substitution happens AFTER the query returns. Branching before it —
      // "is this address known?" — is the timing oracle.
      const hitRepo = fakeOwners(new Map([["ana@x.es", STORED]]));
      const missRepo = fakeOwners();

      await loginParams({ owners: hitRepo, hasher, kdfV1: KDF_V1 })({ email: "ana@x.es" });
      await loginParams({ owners: missRepo, hasher, kdfV1: KDF_V1 })({ email: "nobody@x.es" });

      assert.equal(hitRepo.calls.length, 1);
      assert.equal(missRepo.calls.length, 1, "a miss must cost the same query a hit does");
    });
  });

  describe("§8.2 — an address empty after normalisation", () => {
    it("is rejected, and rejected before any lookup", async () => {
      // Emptiness is a property of the input, not of whether an account exists,
      // so rejecting early reveals nothing and §4.3 is untouched. The error's
      // shape is the implementation's; that it rejects without querying is not.
      const owners = fakeOwners();
      const call = loginParams({ owners, hasher, kdfV1: KDF_V1 });

      await assert.rejects(() => call({ email: "   " }));
      await assert.rejects(() => call({ email: " " }));
      assert.deepEqual(owners.calls, [], "an empty address must not reach the repository");
    });
  });

  describe("what the response must not carry", () => {
    it("returns the salt and parameters only", async () => {
      // A row fetched whole is a row that can be returned whole. findKdfByEmail
      // is narrow for that reason; this fails if it widens and the use case
      // passes the row through.
      const owners = fakeOwners(new Map([["ana@x.es", { ...STORED, wrappedMaster: range(0, 48), wrapNonce: range(0, 24) }]]));
      const result = await loginParams({ owners, hasher, kdfV1: KDF_V1 })({ email: "ana@x.es" });

      assert.deepEqual(Object.keys(result).sort(), ["kdfSalt", "params"]);
      assert.deepEqual(Object.keys(result.params).sort(), ["iterations", "memoryKib", "parallelism"]);
    });
  });
});
