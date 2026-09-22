/*
 * The owner bearer scheme — api-sketch §7.1, §7.2, §7.3 steps 1 and 2.
 * The mirror of recipient-auth.test.mjs, and the differences are the point:
 * expiry and revocation are folded into the use case here (§7.3 step 2), so
 * this preHandler has one answer where the recipient one has two.
 * Hermetic: app.inject, a fake `UseCases`, no Postgres.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildServer } from "../dist/adapters/driving/http/server.js";
import { makeRequireOwner } from "../dist/adapters/driving/http/auth/owner.js";

const CLIENT_ORIGIN = "http://localhost:5173";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";

/** 43 canonical characters — what a well-formed token looks like on the wire. */
const TOKEN = Buffer.alloc(32, 0x5a).toString("base64url");

/** 43 characters decoding to 32 bytes, spelled non-canonically. */
const NON_CANONICAL = "A".repeat(42) + "B";

/** 43 characters, one outside the base64url alphabet. */
const NOT_BASE64URL = "A".repeat(42) + "+";

async function buildTestServer(useCases) {
  const app = await buildServer({
    config: { clientOrigin: CLIENT_ORIGIN },
    useCases,
    logger: false,
    v1Plugins: [
      async (scope) => {
        scope.get(
          "/probe",
          { preHandler: makeRequireOwner(useCases) },
          async (request) => ({ caller: request.caller }),
        );
      },
    ],
  });
  await app.ready();
  return app;
}

/**
 * `authenticateRecipient` throws rather than returning null — the mirror of
 * the recipient file's stub. §7.1 forbids a route falling back from one table
 * to the other, and a stub that answered politely would allow it silently.
 */
const useCasesReturning = (result) => ({
  authenticateOwner: async () => result,
  authenticateRecipient: async () => {
    throw new Error("the owner scheme consulted recipients (§7.1)");
  },
});

const get = (app, headers = {}) =>
  app.inject({ method: "GET", url: "/v1/probe", headers });

describe("the owner bearer scheme", () => {
  describe("§7.3 steps 1 and 2 — one answer for every way of not being an owner", () => {
    const rejected = [
      ["no Authorization header", {}],
      ["a non-Bearer scheme", { authorization: `Basic ${TOKEN}` }],
      ["42 characters", { authorization: `Bearer ${"A".repeat(42)}` }],
      ["44 characters", { authorization: `Bearer ${"A".repeat(44)}` }],
      ["a character outside the alphabet", { authorization: `Bearer ${NOT_BASE64URL}` }],
      ["a non-canonical spelling", { authorization: `Bearer ${NON_CANONICAL}` }],
    ];

    for (const [name, headers] of rejected) {
      it(`${name} is 401 with no details`, async () => {
        const app = await buildTestServer(useCasesReturning(null));
        const response = await get(app, headers);

        assert.equal(response.statusCode, 401, response.body);
        assert.equal(response.json().code, "UNAUTHENTICATED");
        assert.equal(response.json().details, undefined);
      });
    }

    it("an unknown, expired or revoked token is 401, identically", async () => {
      /*
       * All three arrive here as `null` — the use case collapses them (§7.3
       * step 2), and a REVOKED OWNER token is 401 rather than 403 because the
       * recovery paths differ: an owner logs in again, a revoked recipient
       * can do nothing at all. That contrast is the reason the two schemes
       * have separate files.
       */
      const app = await buildTestServer(useCasesReturning(null));
      const response = await get(app, { authorization: `Bearer ${TOKEN}` });

      assert.equal(response.statusCode, 401);
      assert.deepEqual(Object.keys(response.json()).sort(), ["code", "message"]);
    });

    it("carries WWW-Authenticate: Bearer with no parameters", async () => {
      const app = await buildTestServer(useCasesReturning(null));
      const response = await get(app);

      assert.equal(response.headers["www-authenticate"], "Bearer");
    });
  });

  describe("a resolved owner", () => {
    it("is set on the request as the owner member of the union", async () => {
      const app = await buildTestServer(useCasesReturning(OWNER_ID));
      const response = await get(app, { authorization: `Bearer ${TOKEN}` });

      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().caller, { kind: "owner", ownerId: OWNER_ID });
    });

    it("carries no albumId — §7.1's tag is what keeps the two apart", async () => {
      // A flattened principal would compile with an absent albumId and let an
      // owner through a recipient-scoped check; the union makes it absent.
      const app = await buildTestServer(useCasesReturning(OWNER_ID));
      const response = await get(app, { authorization: `Bearer ${TOKEN}` });

      assert.equal(response.json().caller.albumId, undefined);
      assert.equal(response.json().caller.grant, undefined);
    });
  });

  describe("§7.1 — two tables, and no falling back between them", () => {
    it("never consults the recipient scheme", async () => {
      // The stub throws if reached; 401 rather than 500 is what says the
      // owner path looked in `owner_tokens` and nowhere else.
      const app = await buildTestServer(useCasesReturning(null));
      const response = await get(app, { authorization: `Bearer ${TOKEN}` });

      assert.equal(response.statusCode, 401);
    });
  });

  describe("a failing lookup is not an authentication failure", () => {
    it("a repository fault is 500, not 401", async () => {
      /*
       * The blanket `catch` this replaced turned a Postgres outage into `401`
       * for every owner — and because an ApiError with no cause is
       * deliberately unlogged, into a silent one. Every parent would be told
       * to log in again while the log showed normal traffic.
       */
      const app = await buildTestServer({
        authenticateOwner: async () => {
          throw new Error("connection terminated unexpectedly");
        },
        authenticateRecipient: async () => {
          throw new Error("the owner scheme consulted recipients (§7.1)");
        },
      });
      const response = await get(app, { authorization: `Bearer ${TOKEN}` });

      assert.equal(response.statusCode, 500);
      assert.equal(response.json().code, "INTERNAL");
    });
  });
});
