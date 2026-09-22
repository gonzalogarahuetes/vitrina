/*
 * The recipient bearer scheme — api-sketch §7.1, §7.2, §7.3 step 1.
 * Through `deps.v1Plugins`, so the preHandler runs inside the real `/v1`
 * context and its failures go through the real error envelope.
 * Hermetic: app.inject, a fake `UseCases`, no Postgres.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildServer } from "../dist/adapters/driving/http/server.js";
import { makeRequireRecipient } from "../dist/adapters/driving/http/auth/recipient.js";

const CLIENT_ORIGIN = "http://localhost:5173";

const ALBUM_ID = "11111111-1111-4111-8111-111111111111";
const RECIPIENT_ID = "22222222-2222-4222-8222-222222222222";

/** 43 canonical characters — what a well-formed token looks like on the wire. */
const TOKEN = Buffer.alloc(32, 0x5a).toString("base64url");

/**
 * 43 characters that decode to 32 bytes and are NOT the canonical spelling:
 * the final character's spare bits differ, so it re-encodes to something else.
 */
const NON_CANONICAL = "A".repeat(42) + "B";

/** 43 characters, one outside the base64url alphabet. */
const NOT_BASE64URL = "A".repeat(42) + "+";

/**
 * A server with one probe route behind the scheme. The route echoes
 * `request.caller` so the assertions can see what step 1 resolved — including
 * a revoked grant, which must reach it rather than being turned into a status.
 */
async function buildTestServer(useCases) {
  const app = await buildServer({
    config: { clientOrigin: CLIENT_ORIGIN },
    useCases,
    logger: false,
    v1Plugins: [
      async (scope) => {
        scope.get(
          "/probe",
          { preHandler: makeRequireRecipient(useCases) },
          async (request) => ({ caller: request.caller }),
        );
      },
    ],
  });
  await app.ready();
  return app;
}

/** The grant the repository would return, revoked or not. */
const grant = (revokedAt = null) => ({
  id: RECIPIENT_ID,
  albumId: ALBUM_ID,
  revokedAt,
});

/**
 * `authenticateOwner` throws rather than returning null. §7.1 forbids a route
 * falling back from one table to the other, and a stub that answered politely
 * would let that happen while every assertion still passed.
 */
const useCasesReturning = (result) => ({
  authenticateRecipient: async () => result,
  authenticateOwner: async () => {
    throw new Error("the recipient scheme consulted owner_tokens (§7.1)");
  },
});

const get = (app, headers = {}) =>
  app.inject({ method: "GET", url: "/v1/probe", headers });

describe("the recipient bearer scheme", () => {
  describe("§7.3 step 1 — one answer for every way of not being a recipient", () => {
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

        // 401 and not 400 for the two malformed cases specifically: a `400`
        // would tell a caller "that is not a token" apart from "that token is
        // unknown", which is the distinction §7.3 collapses on purpose.
        assert.equal(response.statusCode, 401, response.body);
        assert.equal(response.json().code, "UNAUTHENTICATED");
        assert.equal(response.json().details, undefined);
      });
    }

    it("an unknown token is 401, identically", async () => {
      const app = await buildTestServer(useCasesReturning(null));
      const response = await get(app, { authorization: `Bearer ${TOKEN}` });

      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, "UNAUTHENTICATED");
      // Exactly {code, message} — the envelope, and nothing a client could
      // use to tell this apart from the malformed cases above.
      assert.deepEqual(Object.keys(response.json()).sort(), ["code", "message"]);
    });

    it("carries WWW-Authenticate: Bearer with no parameters", async () => {
      // No realm, which would name the deployment, and no error_description,
      // which is where RFC 6750 invites the echo #15 forbids.
      const app = await buildTestServer(useCasesReturning(null));
      const response = await get(app);

      assert.equal(response.headers["www-authenticate"], "Bearer");
    });
  });

  describe("§7.3 step 4 is the route's, not this preHandler's", () => {
    it("sets the grant on the request for a live token", async () => {
      const app = await buildTestServer(useCasesReturning(grant()));
      const response = await get(app, { authorization: `Bearer ${TOKEN}` });

      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().caller, {
        kind: "recipient",
        grant: { id: RECIPIENT_ID, albumId: ALBUM_ID, revokedAt: null },
      });
    });

    it("lets a REVOKED grant through, with revokedAt intact", async () => {
      /*
       * The assertion this file exists for. A revoked recipient asking for
       * their own album is `403` and asking for another is `404`, which the
       * route can only decide once it has resolved scope — so revocation must
       * still be a separate fact here. Answering 401 is the natural bug and
       * makes ACCESS_REVOKED unreachable.
       */
      const revokedAt = new Date("2026-09-20T10:00:00.000Z");
      const app = await buildTestServer(useCasesReturning(grant(revokedAt)));
      const response = await get(app, { authorization: `Bearer ${TOKEN}` });

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().caller.grant.revokedAt, revokedAt.toISOString());
    });

    it("carries albumId, which §9.3 resolves scope against", async () => {
      const app = await buildTestServer(useCasesReturning(grant()));
      const response = await get(app, { authorization: `Bearer ${TOKEN}` });

      assert.equal(response.json().caller.grant.albumId, ALBUM_ID);
    });
  });

  describe("§7.1 — two tables, and no falling back between them", () => {
    it("never consults the owner scheme", async () => {
      // The stub throws if reached; a 401 here rather than a 500 is what says
      // the recipient path looked in `recipients` and nowhere else.
      const app = await buildTestServer(useCasesReturning(null));
      const response = await get(app, { authorization: `Bearer ${TOKEN}` });

      assert.equal(response.statusCode, 401);
    });
  });

  describe("a failing lookup is not an authentication failure", () => {
    it("a repository fault is 500, not 401", async () => {
      /*
       * The blanket `catch` this replaced turned a Postgres outage into `401`
       * for every caller — and because an ApiError with no cause is
       * deliberately unlogged, into a silent one. Every recipient would be
       * told their invite was invalid while the log showed normal traffic.
       */
      const app = await buildTestServer({
        authenticateRecipient: async () => {
          throw new Error("connection terminated unexpectedly");
        },
        authenticateOwner: async () => {
          throw new Error("the recipient scheme consulted owner_tokens (§7.1)");
        },
      });
      const response = await get(app, { authorization: `Bearer ${TOKEN}` });

      assert.equal(response.statusCode, 500);
      assert.equal(response.json().code, "INTERNAL");
    });
  });
});
