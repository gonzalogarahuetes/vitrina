/*
 * Hermetic HTTP adapter tests: no Docker, no network, no Postgres.
 *
 * The CI workflow keeps `checks` free of infrastructure on purpose ("a red
 * checks means the code is wrong, never that a container was slow"), so these
 * use app.inject() and touch nothing outside the process.
 *
 * Written against dist/ rather than src/ so no TypeScript loader or extra
 * dependency is needed — `pnpm test` compiles first. Node's built-in runner,
 * matching the root's existing `node --test infra/object-store.test.mjs`.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildServer } from "../dist/adapters/driving/http/server.js";

const CLIENT_ORIGIN = "http://localhost:5173";

let app;

before(async () => {
  // The payoff of config-as-a-parameter: no environment variables to set, and
  // importing the adapter has no side effects.
  app = await buildServer({
    config: { clientOrigin: CLIENT_ORIGIN },
    useCases: {},
    logger: false,
  });
  await app.ready();
});

after(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("returns 200 and {status:'ok'}", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });

  it("is unversioned — track-b-plan §3 B.6 exempts it from /v1", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/v1/health" })).statusCode, 404);
  });
});

describe("error envelope", () => {
  /*
   * The regression test for non-negotiable #15: "No error response ever echoes
   * request content." Fastify's default not-found body is
   * {"message":"Route GET:/no-such-route not found",...}, which both echoes the
   * request and is a second error shape. setNotFoundHandler is what prevents it.
   */
  it("does not echo the requested path on an unknown route", async () => {
    const secret = "a-path-that-must-not-come-back";
    const res = await app.inject({ method: "GET", url: `/${secret}` });

    assert.equal(res.statusCode, 404);
    assert.ok(
      !res.body.includes(secret),
      `404 body echoed the request path: ${res.body}`,
    );
  });

  it("uses the one envelope shape, with a code and a static message", async () => {
    const res = await app.inject({ method: "GET", url: "/no-such-route" });
    const body = res.json();

    assert.deepEqual(Object.keys(body).sort(), ["code", "message"]);
    assert.equal(body.code, "NOT_FOUND");
    assert.equal(typeof body.message, "string");
    // Fastify's default shape has these; the envelope must not.
    assert.equal(body.error, undefined);
    assert.equal(body.statusCode, undefined);
  });
});

/*
 * The regression test for the handler-ordering bug.
 *
 * `await app.register(fn, {prefix:"/v1"})` loads that plugin immediately, and
 * the child context snapshots the parent's error handler at creation. If
 * setErrorHandler runs *after* it, a throwing /v1 route returns Fastify's own
 * body — {"statusCode":500,"error":"Internal Server Error","message":"<thrown
 * Error.message>"} — a second error shape carrying internal exception text.
 * That is non-negotiable #15, and nothing revealed it while /v1 held no routes.
 *
 * WHY THIS GOES THROUGH deps.v1Plugins AND MUST NOT BE "SIMPLIFIED" TO A ROUTE
 * REGISTERED OUT HERE: a route added to the returned instance is created after
 * buildServer's setErrorHandler has already run, so it inherits the envelope in
 * BOTH orderings. Measured — the outside-registered version of this test passes
 * against the buggy code. It would look like coverage and be worth nothing.
 *
 * Its own app: a throwing route has no business in the shared fixture.
 */
describe("error envelope reaches versioned routes", () => {
  // Distinctive, so "did internal detail reach the wire" is a real assertion
  // rather than a shape check that happens to pass.
  const THROWN = "internal-detail-that-must-not-leak";

  let v1App;

  before(async () => {
    v1App = await buildServer({
      config: { clientOrigin: CLIENT_ORIGIN },
      useCases: {},
      logger: false,
      v1Plugins: [
        async (scope) => {
          scope.get("/boom", async () => {
            throw new Error(THROWN);
          });
        },
      ],
    });
    await v1App.ready();
  });

  after(async () => {
    await v1App.close();
  });

  it("a throwing /v1 route returns exactly {code, message}", async () => {
    const res = await v1App.inject({ method: "GET", url: "/v1/boom" });
    const body = res.json();

    assert.equal(res.statusCode, 500);
    assert.deepEqual(Object.keys(body).sort(), ["code", "message"]);
    assert.equal(body.code, "INTERNAL");
    // Fastify's default shape has these; the envelope must not.
    assert.equal(body.error, undefined);
    assert.equal(body.statusCode, undefined);
  });

  it("does not leak the thrown exception's message", async () => {
    const res = await v1App.inject({ method: "GET", url: "/v1/boom" });

    assert.ok(
      !res.body.includes(THROWN),
      `500 body echoed internal exception text: ${res.body}`,
    );
    // The constant from the code -> message table, never the thrown string.
    assert.equal(res.json().message, "An unexpected error occurred.");
  });
});

describe("CORS", () => {
  it("echoes exactly the allowlisted origin, never a wildcard", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: CLIENT_ORIGIN },
    });

    assert.equal(res.headers["access-control-allow-origin"], CLIENT_ORIGIN);
    assert.notEqual(res.headers["access-control-allow-origin"], "*");
  });

  it("does not allow an origin that is not the allowlisted one", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example" },
    });

    assert.notEqual(res.headers["access-control-allow-origin"], "https://evil.example");
    assert.notEqual(res.headers["access-control-allow-origin"], "*");
  });

  /*
   * Content-Range, Accept-Ranges and Retry-After are none of them safelisted
   * RESPONSE headers, so without exposedHeaders the browser hides them from the
   * client entirely — and PR 5's chunk-fetch route cannot then compute the next
   * chunk's byte range (encryption spec §3.3), nor can a client back off for the
   * interval a 429 asked for (api-sketch §7.6).
   *
   * Range itself IS safelisted for single byte ranges — the forms PR 5 accepts.
   * It is asserted here anyway because it is listed explicitly rather than left
   * to that subtlety. Authorization is the header that actually forces every
   * authenticated cross-origin request to preflight (api-sketch §3.1).
   */
  it("permits Range and exposes the range and retry response headers", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: CLIENT_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "range",
      },
    });

    assert.ok(res.statusCode < 300, `preflight failed: ${res.statusCode}`);

    const allowed = String(res.headers["access-control-allow-headers"]).toLowerCase();
    assert.ok(allowed.includes("range"), `Range not allowed: ${allowed}`);
    // Non-wildcard per the Fetch standard: `*` would not cover it.
    assert.ok(allowed.includes("authorization"), `Authorization not allowed: ${allowed}`);

    const exposed = String(res.headers["access-control-expose-headers"]).toLowerCase();
    assert.ok(exposed.includes("content-range"), `Content-Range not exposed: ${exposed}`);
    assert.ok(exposed.includes("accept-ranges"), `Accept-Ranges not exposed: ${exposed}`);
    assert.ok(exposed.includes("retry-after"), `Retry-After not exposed: ${exposed}`);
  });

  it("caches the preflight, so every ranged GET is not preceded by an OPTIONS", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { origin: CLIENT_ORIGIN, "access-control-request-method": "GET" },
    });

    assert.ok(Number(res.headers["access-control-max-age"]) > 0);
  });
});
