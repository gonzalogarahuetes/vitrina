/*
 * The /login use case — api-sketch §7.5, §4.3. RED until
 * src/application/use-cases/login.ts exists. Expected export:
 *   login(deps: {owners, verifyProof, mintSession, dummyAuthHash}):
 *     (input: {email: string, proof: Uint8Array}) => Promise<MintedSession>
 * `email` as typed, `proof` already decoded to 32 bytes by the adapter.
 * Hermetic: fakes throughout, no hasher, no Postgres.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { login } from "../dist/application/use-cases/login.js";

const hex = (u8) => Buffer.from(u8).toString("hex");
const range = (from, to) => new Uint8Array(Array.from({ length: to - from }, (_, i) => from + i));

const PROOF = range(0x00, 0x20);
const DUMMY = range(0x90, 0xb0);
const OWNER = { id: "11111111-1111-4111-8111-111111111111", authHash: range(0x40, 0x60) };
const SESSION = { token: range(0x70, 0x90), expiresAt: new Date("2026-10-01T00:00:00Z") };

/** Records the address each lookup was given, so count and argument both assert. */
function fakeOwners(rows = new Map()) {
  const calls = [];
  return {
    calls,
    async findCredentialByEmail(normalisedEmail) {
      calls.push(normalisedEmail);
      return rows.get(normalisedEmail) ?? null;
    },
  };
}

/** `answer` decides the verdict; every call is recorded with its arguments. */
function spyVerify(answer) {
  const calls = [];
  const fn = (storedAuthHash, proof) => {
    calls.push({ storedAuthHash, proof });
    return answer;
  };
  fn.calls = calls;
  return fn;
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

const withAccount = () => fakeOwners(new Map([["ana@x.es", OWNER]]));

/** Asserts a rejection carrying this ApplicationError code, and nothing more. */
async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.details, undefined, "no error in PR 2 carries details (§7.3)");
    return true;
  });
}

describe("login", () => {
  describe("a correct proof for a known address", () => {
    it("mints a session for that owner", async () => {
      const mintSession = spyMint();
      const result = await login({
        owners: withAccount(),
        verifyProof: spyVerify(true),
        mintSession,
        dummyAuthHash: DUMMY,
      })({ email: "ana@x.es", proof: PROOF });

      assert.deepEqual(mintSession.calls, [OWNER.id]);
      assert.equal(hex(result.token), hex(SESSION.token));
      assert.equal(result.expiresAt.toISOString(), SESSION.expiresAt.toISOString());
    });

    it("verifies against the stored hash and the submitted proof", async () => {
      const verifyProof = spyVerify(true);
      await login({ owners: withAccount(), verifyProof, mintSession: spyMint(), dummyAuthHash: DUMMY })(
        { email: "ana@x.es", proof: PROOF },
      );

      assert.equal(verifyProof.calls.length, 1);
      assert.equal(hex(verifyProof.calls[0].storedAuthHash), hex(OWNER.authHash));
      assert.equal(hex(verifyProof.calls[0].proof), hex(PROOF));
    });

    it("finds the account whatever spelling was typed", async () => {
      const owners = withAccount();
      const mintSession = spyMint();
      await login({ owners, verifyProof: spyVerify(true), mintSession, dummyAuthHash: DUMMY })(
        { email: "  Ana@X.ES  ", proof: PROOF },
      );

      assert.deepEqual(owners.calls, ["ana@x.es"]);
      assert.deepEqual(mintSession.calls, [OWNER.id]);
    });
  });

  describe("failure", () => {
    it("a wrong proof for a known address is INVALID_CREDENTIALS", async () => {
      await rejectsWithCode(
        login({ owners: withAccount(), verifyProof: spyVerify(false), mintSession: spyMint(), dummyAuthHash: DUMMY })(
          { email: "ana@x.es", proof: PROOF },
        ),
        "INVALID_CREDENTIALS",
      );
    });

    it("an unknown address is INVALID_CREDENTIALS — the same code (§4.3)", async () => {
      await rejectsWithCode(
        login({ owners: fakeOwners(), verifyProof: spyVerify(false), mintSession: spyMint(), dummyAuthHash: DUMMY })(
          { email: "nobody@x.es", proof: PROOF },
        ),
        "INVALID_CREDENTIALS",
      );
    });

    it("mints nothing on either failure", async () => {
      const wrongProof = spyMint();
      const unknown = spyMint();

      await assert.rejects(
        login({ owners: withAccount(), verifyProof: spyVerify(false), mintSession: wrongProof, dummyAuthHash: DUMMY })(
          { email: "ana@x.es", proof: PROOF },
        ),
      );
      await assert.rejects(
        login({ owners: fakeOwners(), verifyProof: spyVerify(false), mintSession: unknown, dummyAuthHash: DUMMY })(
          { email: "nobody@x.es", proof: PROOF },
        ),
      );

      assert.deepEqual(wrongProof.calls, []);
      assert.deepEqual(unknown.calls, []);
    });
  });

  describe("§4.3 — the miss path runs the hit path's work", () => {
    it("queries once and verifies once, on a hit and on a miss alike", async () => {
      const hitOwners = withAccount();
      const hitVerify = spyVerify(true);
      const missOwners = fakeOwners();
      const missVerify = spyVerify(false);

      await login({ owners: hitOwners, verifyProof: hitVerify, mintSession: spyMint(), dummyAuthHash: DUMMY })(
        { email: "ana@x.es", proof: PROOF },
      );
      await assert.rejects(
        login({ owners: missOwners, verifyProof: missVerify, mintSession: spyMint(), dummyAuthHash: DUMMY })(
          { email: "nobody@x.es", proof: PROOF },
        ),
      );

      assert.equal(hitOwners.calls.length, 1);
      assert.equal(missOwners.calls.length, 1, "a miss must cost the same query");
      assert.equal(hitVerify.calls.length, 1);
      assert.equal(missVerify.calls.length, 1, "returning early on a miss is the timing oracle");
    });

    it("verifies against the dummy hash on a miss", async () => {
      const verifyProof = spyVerify(false);
      await assert.rejects(
        login({ owners: fakeOwners(), verifyProof, mintSession: spyMint(), dummyAuthHash: DUMMY })(
          { email: "nobody@x.es", proof: PROOF },
        ),
      );

      assert.equal(hex(verifyProof.calls[0].storedAuthHash), hex(DUMMY));
      assert.equal(hex(verifyProof.calls[0].proof), hex(PROOF));
    });

    it("a dummy that VERIFIES still mints nothing", async () => {
      // There is no owner id on the miss path, so minting must be unreachable
      // by construction rather than because the compare happens to fail.
      const mintSession = spyMint();
      await rejectsWithCode(
        login({ owners: fakeOwners(), verifyProof: spyVerify(true), mintSession, dummyAuthHash: DUMMY })(
          { email: "nobody@x.es", proof: PROOF },
        ),
        "INVALID_CREDENTIALS",
      );

      assert.deepEqual(mintSession.calls, []);
    });
  });

  describe("§8.2 — an address empty after normalisation", () => {
    it("is EMPTY_ADDRESS, before any lookup or verification", async () => {
      const owners = fakeOwners();
      const verifyProof = spyVerify(false);
      const mintSession = spyMint();

      await rejectsWithCode(
        login({ owners, verifyProof, mintSession, dummyAuthHash: DUMMY })({ email: "   ", proof: PROOF }),
        "EMPTY_ADDRESS",
      );

      assert.deepEqual(owners.calls, []);
      assert.deepEqual(verifyProof.calls, []);
      assert.deepEqual(mintSession.calls, []);
    });
  });
});
