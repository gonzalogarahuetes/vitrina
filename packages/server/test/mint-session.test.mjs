/*
 * The one minting site — api-sketch §7.4, §7.5, schema §6. Expected export:
 *   makeMintSession(owners, tokenHasher, clock): MintSession
 * The real token hasher, a fake repository and a held clock, so `expiresAt`
 * is an equality rather than a tolerance. Hermetic, against dist/.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeMintSession } from "../dist/application/use-cases/mint-session.js";
import { createTokenHasher } from "../dist/adapters/driven/hashing/token-hasher.js";

const hex = (u8) => Buffer.from(u8).toString("hex");

const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-20T12:34:56.000Z");
const TWO_WEEKS_LATER = "2026-10-04T12:34:56.000Z";

const tokenHasher = createTokenHasher();
const heldClock = (now = NOW) => ({ now: () => now });

function fakeOwners() {
  const inserted = [];
  return {
    inserted,
    async insertToken(row) {
      inserted.push(row);
    },
  };
}

describe("makeMintSession", () => {
  describe("the token and what is stored", () => {
    it("stores the hash of the token, and returns the token", async () => {
      const owners = fakeOwners();
      const session = await makeMintSession(owners, tokenHasher, heldClock())(OWNER_ID);

      assert.equal(hex(owners.inserted[0].tokenHash), hex(tokenHasher.hash(session.token)));
    });

    it("never stores the token itself", async () => {
      // The failure that puts live bearer credentials in the database. Worth
      // its own case because the two values are the same shape and length.
      const owners = fakeOwners();
      const session = await makeMintSession(owners, tokenHasher, heldClock())(OWNER_ID);

      assert.notEqual(hex(owners.inserted[0].tokenHash), hex(session.token));
    });

    it("returns 32 raw bytes, not a base64url string", async () => {
      const session = await makeMintSession(fakeOwners(), tokenHasher, heldClock())(OWNER_ID);

      assert.ok(session.token instanceof Uint8Array);
      assert.equal(session.token.byteLength, 32);
    });

    it("stores a 32-byte hash", async () => {
      // CHK on owner_tokens.token_hash is 32; a wrong width fails at the
      // insert in production and here instead.
      const owners = fakeOwners();
      await makeMintSession(owners, tokenHasher, heldClock())(OWNER_ID);

      assert.equal(owners.inserted[0].tokenHash.byteLength, 32);
    });

    it("draws a fresh token every time", async () => {
      const owners = fakeOwners();
      const mint = makeMintSession(owners, tokenHasher, heldClock());
      const first = await mint(OWNER_ID);
      const second = await mint(OWNER_ID);

      assert.notEqual(hex(first.token), hex(second.token));
      assert.notEqual(hex(owners.inserted[0].tokenHash), hex(owners.inserted[1].tokenHash));
    });

    it("draws tokens that are not obviously structured", async () => {
      // A cheap smoke test for a non-random source: 64 tokens, all distinct,
      // none all-zero. It cannot prove a CSPRNG, and does not claim to.
      const mint = makeMintSession(fakeOwners(), tokenHasher, heldClock());
      const seen = new Set();
      for (let i = 0; i < 64; i++) {
        const { token } = await mint(OWNER_ID);
        assert.notEqual(hex(token), "00".repeat(32));
        seen.add(hex(token));
      }
      assert.equal(seen.size, 64);
    });
  });

  describe("the window", () => {
    it("expires exactly two weeks after the clock's now (§7.5)", async () => {
      const session = await makeMintSession(fakeOwners(), tokenHasher, heldClock())(OWNER_ID);

      assert.equal(session.expiresAt.toISOString(), TWO_WEEKS_LATER);
    });

    it("reads the clock rather than the wall clock", async () => {
      // A held clock a year out: Date.now() anywhere in here fails this.
      const far = new Date("2027-01-01T00:00:00.000Z");
      const session = await makeMintSession(fakeOwners(), tokenHasher, heldClock(far))(OWNER_ID);

      assert.equal(session.expiresAt.toISOString(), "2027-01-15T00:00:00.000Z");
    });

    it("stores the same expiry it returns", async () => {
      const owners = fakeOwners();
      const session = await makeMintSession(owners, tokenHasher, heldClock())(OWNER_ID);

      assert.equal(owners.inserted[0].expiresAt.toISOString(), session.expiresAt.toISOString());
    });

    it("gives both minting sites the same window (§7.4)", async () => {
      // One code path, so signup's and login's sessions cannot drift apart.
      // Asserted as equality because the clock is held, not as a tolerance.
      const mint = makeMintSession(fakeOwners(), tokenHasher, heldClock());
      const asSignup = await mint(OWNER_ID);
      const asLogin = await mint(OWNER_ID);

      assert.equal(asSignup.expiresAt.toISOString(), asLogin.expiresAt.toISOString());
    });
  });

  describe("the row", () => {
    it("inserts once, for the owner it was given", async () => {
      const owners = fakeOwners();
      await makeMintSession(owners, tokenHasher, heldClock())(OWNER_ID);

      assert.equal(owners.inserted.length, 1);
      assert.equal(owners.inserted[0].ownerId, OWNER_ID);
    });

    it("writes the three columns and nothing else", async () => {
      const owners = fakeOwners();
      await makeMintSession(owners, tokenHasher, heldClock())(OWNER_ID);

      assert.deepEqual(Object.keys(owners.inserted[0]).sort(), ["expiresAt", "ownerId", "tokenHash"]);
    });
  });
});
