/*
 * Which routes the byte budget covers — api-sketch §11.5, §11.3, §11.8.
 *
 * The two sets are defined differently and must not be asserted equal:
 * `no-store` covers every response carrying ciphertext, including a JSON body
 * with one ciphertext field (§9.4, §11.4, the access-log summary); the byte
 * budget covers responses whose SIZE comes from stored ciphertext. So the
 * assertion is SUBSET, in the direction with a failure behind it: a
 * route that charges the byte budget without `no-store` is a ciphertext
 * response that caches. The converse — `no-store` without the flag — is
 * correct and common. The flag is `config.chargesByteBudget`, and it reads the
 * way this assertion does: there is one budget, and a flagged route charges it.
 *
 * Enumeration goes through the `routeObserver` seam: Fastify's `findRoute`
 * does not expose a route's config. A seam installed after the first awaited
 * register sees nothing and every assertion below passes vacuously — hence
 * the count.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { buildLimiterServer } from "./support/limiter-graph.mjs";

const UUID = "00000000-0000-4000-8000-000000000000";

/** §11.5's list. A new entry is a decision, argued here, not a default. */
const CHARGES_BYTE_BUDGET = [
  "GET /v1/albums/:album_id/metadata", // §9.5
  "GET /v1/media/:media_id/asset", // §11.2
  "GET /v1/media/:media_id/thumbnail", // §11.3
];

/** Fill path parameters with a well-formed id, so a request reaches auth. */
const concrete = (url) => url.replace(/:[a-z_]+/g, UUID);

describe("the routes that charge the byte budget", () => {
  let app;
  const routes = [];

  before(async () => {
    ({ app } = await buildLimiterServer({
      routeObserver: (route) => {
        for (const method of [route.method].flat()) {
          routes.push({ method, url: route.url, config: route.config ?? {} });
        }
      },
    }));
  });

  it("sees the whole surface", () => {
    // §11.8: twenty-two routes plus /health. Fewer means the seam was
    // installed late, and everything below is checking an empty list.
    const distinct = new Set(routes.map((r) => `${r.method} ${r.url}`));
    assert.ok(distinct.size >= 23, `only ${distinct.size} routes seen`);
  });

  it("registers no HEAD route (§11.8, exposeHeadRoutes: false)", () => {
    // The enumerative half of the probe below: every route, not three.
    const head = routes.filter((r) => r.method === "HEAD").map((r) => r.url);
    assert.deepEqual(head, []);
  });

  it("are exactly §11.5's three", () => {
    const flagged = routes
      .filter((r) => r.config.chargesByteBudget === true)
      .map((r) => `${r.method} ${r.url}`)
      .sort();

    assert.deepEqual(flagged, [...CHARGES_BYTE_BUDGET].sort());
  });

  it("each answers no-store — charges the byte budget ⊆ no-store", async () => {
    // Unauthenticated on purpose: the hook is per plugin, so it must cover
    // the 401 too, and this needs no fixture for routes that are not built.
    for (const route of routes.filter((r) => r.config.chargesByteBudget === true)) {
      const response = await app.inject({ method: route.method, url: concrete(route.url) });

      assert.equal(response.statusCode, 401, `${route.method} ${route.url}`);
      assert.equal(
        response.headers["cache-control"],
        "no-store",
        `${route.method} ${route.url} charges the byte budget and is cacheable`,
      );
    }
  });
});

describe("§11.8 — methods in use: GET, POST, PUT", () => {
  /*
   * Fastify's `exposeHeadRoutes` defaults to true: every GET gets a HEAD that
   * runs the GET handler and discards the body. Measured 7 October 2026 —
   * `HEAD /v1/albums/{id}/metadata` answers 401, not 404. Once §11.6 lands,
   * a recipient's HEAD there writes `album_opened`, and a HEAD with
   * `Range: bytes=0-…` on §11.2 writes `asset_viewed` and pulls from the
   * store, for a retrieval that delivered nothing. HEAD is also a
   * CORS-safelisted method, so the `methods` list does not keep browsers out.
   */
  it("no route answers HEAD", async () => {
    const { app } = await buildLimiterServer();

    for (const url of [`/v1/albums/${UUID}`, `/v1/albums/${UUID}/metadata`, "/v1/recipient/key"]) {
      const response = await app.inject({ method: "HEAD", url });
      assert.equal(response.statusCode, 404, `HEAD ${url} answered ${response.statusCode}`);
    }
  });
});

describe("the 2xx guard — a flagged route must charge (§11.5)", () => {
  // A route that forgets chargeBytes fails its first success, rather than
  // escaping the budget silently. Not on errors: a 403 paid the floor already.
  async function serverWith(route) {
    const { buildServer } = await import("../dist/adapters/driving/http/server.js");
    const app = await buildServer({
      config: { clientOrigin: "http://localhost:5173" },
      useCases: {},
      logger: false,
      v1Plugins: [async (scope) => scope.get("/probe", { config: { chargesByteBudget: true } }, route)],
    });
    await app.ready();
    return app;
  }

  it("turns an uncharged 2xx into a bare 500", async () => {
    const app = await serverWith(async () => ({ ok: true }));
    const response = await app.inject({ method: "GET", url: "/v1/probe" });

    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(response.json(), { code: "INTERNAL", message: "An unexpected error occurred." });
  });

  it("leaves a flagged route's 4xx alone", async () => {
    const { ApiError } = await import("../dist/adapters/driving/http/error-envelope.js");
    const app = await serverWith(async () => {
      throw new ApiError("NOT_FOUND");
    });

    assert.equal((await app.inject({ method: "GET", url: "/v1/probe" })).statusCode, 404);
  });
});
