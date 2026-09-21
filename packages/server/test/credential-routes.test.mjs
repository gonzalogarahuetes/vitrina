/*
 * The four PR 2b routes, end to end over the REAL use-case graph with an
 * in-memory repository — api-sketch §7.5, §8.1, §8.2, §8.3, §4.3.
 * buildUseCases is imported rather than reimplemented, so these assert the
 * wiring production uses instead of a copy of it kept in step by hand.
 * Hermetic: app.inject, no Docker, no Postgres.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, it } from "node:test";

import { OWNER_KDF_V1 } from "@vitrina/shared";

import { buildServer } from "../dist/adapters/driving/http/server.js";
import { buildUseCases } from "../dist/composition-root.js";
import { createCredentialHasher } from "../dist/adapters/driven/hashing/credential-hasher.js";
import { createTokenHasher } from "../dist/adapters/driven/hashing/token-hasher.js";
import { ApplicationError } from "../dist/application/errors.js";

const CLIENT_ORIGIN = "http://localhost:5173";
const SECRET = Buffer.alloc(32, 0x11);

const b64 = (fill, bytes) => Buffer.alloc(bytes, fill).toString("base64url");

/** A well-formed signup body; every binary field a distinct value. */
const signupBody = (email, overrides = {}) => ({
  email,
  proof: b64(0x21, 32),
  kdf_salt: b64(0x41, 16),
  kdf_memory_kib: OWNER_KDF_V1.memoryKib,
  kdf_iterations: OWNER_KDF_V1.iterations,
  kdf_parallelism: OWNER_KDF_V1.parallelism,
  wrapped_master: b64(0x42, 48),
  wrap_nonce: b64(0x43, 24),
  ...overrides,
});

/** The port, in a Map. Enough for the routes; the real one has its own tests. */
function inMemoryOwners() {
  const owners = new Map(); // email -> {id, authHash, createdAt, passwordKey}
  const byId = new Map();
  const tokens = new Map(); // hex(tokenHash) -> {ownerId, expiresAt, revokedAt}

  return {
    owners,
    tokens,
    async createWithPasswordKey(owner) {
      if (owners.has(owner.email)) {
        // The real adapter raises this from the UNIQUE; a look-alike with the
        // right `code` but the wrong prototype is a 500, because the envelope
        // matches on instanceof. Which is correct, and worth knowing.
        throw new ApplicationError("DUPLICATE_ADDRESS");
      }
      const row = { id: randomUUID(), createdAt: new Date("2026-09-21T09:00:00.000Z"), ...owner };
      owners.set(owner.email, row);
      byId.set(row.id, row);
      return { id: row.id, createdAt: row.createdAt };
    },
    async findCredentialByEmail(email) {
      const row = owners.get(email);
      return row ? { id: row.id, authHash: row.authHash } : null;
    },
    async findKdfByEmail(email) {
      const row = owners.get(email);
      return row ? { kdfSalt: row.passwordKey.kdfSalt, params: row.passwordKey.params } : null;
    },
    async findPasswordKeyByOwnerId(ownerId) {
      return byId.get(ownerId)?.passwordKey ?? null;
    },
    async insertToken(token) {
      tokens.set(Buffer.from(token.tokenHash).toString("hex"), {
        ownerId: token.ownerId,
        expiresAt: token.expiresAt,
        revokedAt: null,
      });
    },
    async findTokenByHash(tokenHash) {
      return tokens.get(Buffer.from(tokenHash).toString("hex")) ?? null;
    },
  };
}

/** A server over the real graph. `logLines` collects pino output when asked. */
async function buildTestServer({ captureLogs = false } = {}) {
  const owners = inMemoryOwners();
  const logLines = [];

  const useCases = buildUseCases(
    {
      owners,
      credentialHasher: createCredentialHasher(SECRET),
      tokenHasher: createTokenHasher(),
      clock: { now: () => new Date("2026-09-21T09:00:00.000Z") },
    },
    { kdfV1: OWNER_KDF_V1, dummyAuthHash: Buffer.alloc(32, 0x7f) },
  );

  const app = await buildServer({
    config: { clientOrigin: CLIENT_ORIGIN },
    useCases,
    logger: captureLogs
      ? { level: "trace", stream: { write: (line) => logLines.push(line) } }
      : false,
  });
  await app.ready();
  return { app, owners, logLines };
}

/** Signs up and returns the bearer token, as a client would hold it. */
async function signUp(app, email, overrides = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/signup",
    payload: signupBody(email, overrides),
  });
  return response;
}

describe("the credential routes", () => {
  describe("POST /v1/signup — §8.1 floors, not the chosen values", () => {
    it("accepts parameters ABOVE the v1 values", async () => {
      // The case nobody writes by instinct, and the one that matters: a schema
      // pinned to 65536/3/1 passes the below-floor test and fails this one,
      // rejecting every account created after Phase 2 raises the default.
      const { app } = await buildTestServer();
      const response = await signUp(app, "high@x.es", {
        kdf_memory_kib: 131072,
        kdf_iterations: 4,
        kdf_parallelism: 2,
      });

      assert.equal(response.statusCode, 201, response.body);
    });

    const belowFloor = [
      ["memory", { kdf_memory_kib: 16383 }],
      ["iterations", { kdf_iterations: 1 }],
      ["parallelism", { kdf_parallelism: 0 }],
    ];
    for (const [name, override] of belowFloor) {
      it(`rejects ${name} below its floor`, async () => {
        const { app } = await buildTestServer();
        const response = await signUp(app, `low-${name}@x.es`, override);

        assert.equal(response.statusCode, 400);
        assert.equal(response.json().code, "VALIDATION_FAILED");
        // §7.5: a sub-floor parameter is a client build choosing its own work
        // factor wrongly, not user input, so there is nothing for details.
        assert.equal(response.json().details, undefined);
      });
    }
  });

  describe("POST /v1/signup — the response", () => {
    it("returns the id, timestamp and a session, and no wrapping", async () => {
      const { app } = await buildTestServer();
      const body = (await signUp(app, "ana@x.es")).json();

      assert.deepEqual(Object.keys(body).sort(), ["created_at", "expires_at", "id", "token"]);
      assert.equal(body.token.length, 43);
    });

    it("dates are RFC 3339 UTC with a trailing Z, not loose ISO 8601", async () => {
      const { app } = await buildTestServer();
      const body = (await signUp(app, "dates@x.es")).json();

      // §7.5: "ISO 8601" admits week dates, ordinal dates and offset-less
      // local times — a format two implementations can disagree about.
      assert.match(body.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.match(body.expires_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it("expires two weeks out (§7.5)", async () => {
      const { app } = await buildTestServer();
      const body = (await signUp(app, "window@x.es")).json();

      assert.equal(body.expires_at, "2026-10-05T09:00:00Z");
    });

    it("a duplicate address is 409 — §4.3 carves signup out deliberately", async () => {
      const { app } = await buildTestServer();
      await signUp(app, "twice@x.es");
      const second = await signUp(app, "twice@x.es");

      assert.equal(second.statusCode, 409);
      assert.equal(second.json().code, "CONFLICT");
    });
  });

  describe("POST /v1/login/params — §8.1 and §4.3", () => {
    it("an unknown address gets the v1 parameters, so a decoy matches real rows", async () => {
      const { app } = await buildTestServer();
      const response = await app.inject({
        method: "POST",
        url: "/v1/login/params",
        payload: { email: "nobody@x.es" },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().kdf_memory_kib, OWNER_KDF_V1.memoryKib);
      assert.equal(response.json().kdf_iterations, OWNER_KDF_V1.iterations);
      assert.equal(response.json().kdf_parallelism, OWNER_KDF_V1.parallelism);
    });

    it("a fresh signup writes the same three integers the decoy carries", async () => {
      // The one comparison that catches the constant and the stored rows
      // drifting apart (§6.2).
      const { app } = await buildTestServer();
      await signUp(app, "real@x.es");

      const real = await app.inject({ method: "POST", url: "/v1/login/params", payload: { email: "real@x.es" } });
      const decoy = await app.inject({ method: "POST", url: "/v1/login/params", payload: { email: "absent@x.es" } });

      const { kdf_salt: _realSalt, ...realParams } = real.json();
      const { kdf_salt: _decoySalt, ...decoyParams } = decoy.json();
      assert.deepEqual(realParams, decoyParams);
    });

    it("is indistinguishable in status and shape (§4.3)", async () => {
      const { app } = await buildTestServer();
      await signUp(app, "known@x.es");

      const known = await app.inject({ method: "POST", url: "/v1/login/params", payload: { email: "known@x.es" } });
      const unknown = await app.inject({ method: "POST", url: "/v1/login/params", payload: { email: "unknown@x.es" } });

      assert.equal(known.statusCode, unknown.statusCode);
      assert.deepEqual(Object.keys(known.json()).sort(), Object.keys(unknown.json()).sort());
      assert.equal(known.json().kdf_salt.length, unknown.json().kdf_salt.length);
    });

    it("the decoy is stable for one address", async () => {
      const { app } = await buildTestServer();
      const first = await app.inject({ method: "POST", url: "/v1/login/params", payload: { email: "same@x.es" } });
      const second = await app.inject({ method: "POST", url: "/v1/login/params", payload: { email: "same@x.es" } });

      // A varying salt is itself an oracle (§4.3).
      assert.equal(first.json().kdf_salt, second.json().kdf_salt);
    });
  });

  describe("§8.2 — one normalisation, before every lookup", () => {
    it("a differently-spelled address reaches the same account on both routes", async () => {
      const { app } = await buildTestServer();
      await signUp(app, "Ana@X.es");

      const params = await app.inject({
        method: "POST",
        url: "/v1/login/params",
        payload: { email: "  ana@X.ES  " },
      });
      assert.equal(params.json().kdf_salt, b64(0x41, 16), "a decoy here means the lookup saw the as-typed form");

      const login = await app.inject({
        method: "POST",
        url: "/v1/login",
        payload: { email: "\tANA@x.es ", proof: b64(0x21, 32) },
      });
      assert.equal(login.statusCode, 200, login.body);
    });

    it("two spellings that normalise apart are two accounts", async () => {
      const { app } = await buildTestServer();
      assert.equal((await signUp(app, "ana@x.es")).statusCode, 201);
      assert.equal((await signUp(app, "a.na@x.es")).statusCode, 201);
    });

    it("an address empty after normalisation is 400 on all three routes", async () => {
      const { app } = await buildTestServer();
      const bodies = [];

      bodies.push(await signUp(app, "   "));
      bodies.push(await app.inject({ method: "POST", url: "/v1/login/params", payload: { email: "   " } }));
      bodies.push(
        await app.inject({ method: "POST", url: "/v1/login", payload: { email: " ", proof: b64(0x21, 32) } }),
      );

      for (const response of bodies) {
        assert.equal(response.statusCode, 400);
        assert.deepEqual(response.json(), {
          code: "VALIDATION_FAILED",
          message: "Request failed schema validation.",
        });
      }
    });
  });

  describe("POST /v1/login — §4.3", () => {
    it("a correct proof returns a token and an expiry, and nothing else", async () => {
      const { app } = await buildTestServer();
      await signUp(app, "in@x.es");

      const response = await app.inject({
        method: "POST",
        url: "/v1/login",
        payload: { email: "in@x.es", proof: b64(0x21, 32) },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(Object.keys(response.json()).sort(), ["expires_at", "token"]);
    });

    it("a wrong proof and an unknown address are byte-identical answers", async () => {
      const { app } = await buildTestServer();
      await signUp(app, "known@x.es");

      const wrongProof = await app.inject({
        method: "POST",
        url: "/v1/login",
        payload: { email: "known@x.es", proof: b64(0x99, 32) },
      });
      const unknownAddress = await app.inject({
        method: "POST",
        url: "/v1/login",
        payload: { email: "absent@x.es", proof: b64(0x21, 32) },
      });

      assert.equal(wrongProof.statusCode, 401);
      assert.equal(unknownAddress.statusCode, wrongProof.statusCode);
      assert.equal(unknownAddress.body, wrongProof.body);
      assert.equal(wrongProof.json().code, "INVALID_CREDENTIALS");
      assert.equal(wrongProof.json().details, undefined);
    });

    it("a malformed proof is 400 — before any lookup", async () => {
      const { app } = await buildTestServer();
      const response = await app.inject({
        method: "POST",
        url: "/v1/login",
        payload: { email: "who@x.es", proof: "not-base64url!!" },
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "VALIDATION_FAILED");
    });

    it("a non-canonical 43-character spelling is refused (schema §6)", async () => {
      // Four distinct strings decode to the same 32 bytes; only one is
      // canonical, and the re-encode check is what rejects the other three.
      const canonical = b64(0x21, 32);
      const nonCanonical = canonical.slice(0, 42) + (canonical.at(-1) === "B" ? "C" : "B");
      assert.notEqual(canonical, nonCanonical);

      const { app } = await buildTestServer();
      await signUp(app, "canon@x.es");
      const response = await app.inject({
        method: "POST",
        url: "/v1/login",
        payload: { email: "canon@x.es", proof: nonCanonical },
      });

      assert.equal(response.statusCode, 400);
    });
  });

  describe("GET /v1/owner/key — §8.3", () => {
    it("returns the caller's own row and no one else's", async () => {
      // Trivially true by construction — no id in the path — and asserted
      // anyway, because it is the test that fails if someone adds ?owner_id.
      const { app } = await buildTestServer();
      const first = (await signUp(app, "one@x.es", { wrapped_master: b64(0x01, 48) })).json();
      const second = (await signUp(app, "two@x.es", { wrapped_master: b64(0x02, 48) })).json();

      const forFirst = await app.inject({
        method: "GET",
        url: "/v1/owner/key",
        headers: { authorization: `Bearer ${first.token}` },
      });
      const forSecond = await app.inject({
        method: "GET",
        url: "/v1/owner/key",
        headers: { authorization: `Bearer ${second.token}` },
      });

      assert.equal(forFirst.json().wrapped_master, b64(0x01, 48));
      assert.equal(forSecond.json().wrapped_master, b64(0x02, 48));
    });

    it("returns everything needed to unwrap K_master except the password", async () => {
      const { app } = await buildTestServer();
      const session = (await signUp(app, "key@x.es")).json();

      const response = await app.inject({
        method: "GET",
        url: "/v1/owner/key",
        headers: { authorization: `Bearer ${session.token}` },
      });

      assert.deepEqual(Object.keys(response.json()).sort(), [
        "kdf_iterations",
        "kdf_memory_kib",
        "kdf_parallelism",
        "kdf_salt",
        "wrap_nonce",
        "wrapped_master",
      ]);
    });

    const unauthenticated = [
      ["no header", {}],
      ["not a Bearer", { authorization: "Basic abc" }],
      ["a token of the wrong length", { authorization: `Bearer ${b64(0x01, 16)}` }],
      ["a well-formed token nobody minted", { authorization: `Bearer ${b64(0xab, 32)}` }],
    ];
    for (const [name, headers] of unauthenticated) {
      it(`${name} is 401 with WWW-Authenticate: Bearer`, async () => {
        const { app } = await buildTestServer();
        const response = await app.inject({ method: "GET", url: "/v1/owner/key", headers });

        assert.equal(response.statusCode, 401);
        assert.equal(response.json().code, "UNAUTHENTICATED");
        // No realm — it would name the deployment (§7.3).
        assert.equal(response.headers["www-authenticate"], "Bearer");
      });
    }

    it("a revoked token is 401, not 403", async () => {
      // An owner logs in again; a revoked recipient can do nothing at all, and
      // the codes differ so the client renders the right sentence (§7.3).
      const { app, owners } = await buildTestServer();
      const session = (await signUp(app, "revoked@x.es")).json();
      for (const token of owners.tokens.values()) token.revokedAt = new Date();

      const response = await app.inject({
        method: "GET",
        url: "/v1/owner/key",
        headers: { authorization: `Bearer ${session.token}` },
      });

      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, "UNAUTHENTICATED");
    });

    it("an expired token is 401", async () => {
      const { app, owners } = await buildTestServer();
      const session = (await signUp(app, "expired@x.es")).json();
      for (const token of owners.tokens.values()) token.expiresAt = new Date("2020-01-01T00:00:00Z");

      const response = await app.inject({
        method: "GET",
        url: "/v1/owner/key",
        headers: { authorization: `Bearer ${session.token}` },
      });

      assert.equal(response.statusCode, 401);
    });
  });

  describe("Cache-Control: no-store", () => {
    it("is on every credential route and on /owner/key", async () => {
      // §7.5 states it as one blanket rule because that is the form nobody has
      // to remember per route; here it is one hook, asserted per route.
      const { app } = await buildTestServer();
      const session = (await signUp(app, "cache@x.es")).json();

      const responses = [
        await signUp(app, "cache2@x.es"),
        await app.inject({ method: "POST", url: "/v1/login/params", payload: { email: "cache@x.es" } }),
        await app.inject({
          method: "POST",
          url: "/v1/login",
          payload: { email: "cache@x.es", proof: b64(0x21, 32) },
        }),
        await app.inject({
          method: "GET",
          url: "/v1/owner/key",
          headers: { authorization: `Bearer ${session.token}` },
        }),
      ];

      for (const response of responses) {
        assert.equal(response.headers["cache-control"], "no-store");
      }
    });

    it("is not imposed on routes outside the credential plugin", async () => {
      // The hook is encapsulated; /health is not a credential route.
      const { app } = await buildTestServer();
      const response = await app.inject({ method: "GET", url: "/health" });

      assert.equal(response.headers["cache-control"], undefined);
    });
  });

  describe("§7.6 — the IP limiter", () => {
    it("answers 429 through the envelope, with Retry-After", async () => {
      // @fastify/rate-limit's errorResponseBuilder would bypass
      // setErrorHandler and leave §1.2's 429 row inert while looking live.
      const { app } = await buildTestServer();
      let last;
      for (let i = 0; i < 11; i++) {
        last = await app.inject({ method: "POST", url: "/v1/login/params", payload: { email: `x${i}@x.es` } });
      }

      assert.equal(last.statusCode, 429);
      assert.deepEqual(last.json(), { code: "RATE_LIMITED", message: "Rate limited." });
      assert.ok(Number(last.headers["retry-after"]) > 0);
    });
  });

  describe("§7.5 — no request body reaches a log", () => {
    it("neither the proof nor the wrapping appears in any line", async () => {
      // /signup is the better subject: its body carries a proof AND wrap
      // material, so one test covers more per assertion. Scoped to the
      // validation and success paths, not INTERNAL (§1.2).
      const { app, logLines } = await buildTestServer({ captureLogs: true });
      const proof = b64(0x21, 32);
      const wrapped = b64(0x42, 48);

      await signUp(app, "logged@x.es");
      await signUp(app, "logged@x.es"); // the 409 path, which logs a cause
      await signUp(app, "bad@x.es", { kdf_iterations: 1 }); // the validation path

      assert.ok(logLines.length > 0, "nothing was logged, so this asserts nothing");
      for (const line of logLines) {
        assert.ok(!line.includes(proof), `the proof reached a log line: ${line}`);
        assert.ok(!line.includes(wrapped), `the wrapping reached a log line: ${line}`);
        assert.ok(!line.includes("logged@x.es"), `the address reached a log line: ${line}`);
      }
    });
  });
});

before(() => {
  // A guard on the fixtures themselves: these lengths are what the schemas
  // enforce, and a wrong one here would make every case above vacuous.
  assert.equal(b64(0x21, 32).length, 43);
  assert.equal(b64(0x41, 16).length, 22);
  assert.equal(b64(0x42, 48).length, 64);
  assert.equal(b64(0x43, 24).length, 32);
});
