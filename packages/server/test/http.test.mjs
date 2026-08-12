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
   * Range is not a CORS-safelisted request header, and Content-Range /
   * Accept-Ranges are not safelisted response headers. Without these three the
   * PR 4 chunk-fetch route cannot work cross-origin: the browser would hide the
   * headers the client needs to compute the next chunk's byte range (encryption
   * spec §3.3).
   */
  it("permits Range and exposes the range response headers", async () => {
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

    const exposed = String(res.headers["access-control-expose-headers"]).toLowerCase();
    assert.ok(exposed.includes("content-range"), `Content-Range not exposed: ${exposed}`);
    assert.ok(exposed.includes("accept-ranges"), `Accept-Ranges not exposed: ${exposed}`);
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
