/*
 * §11.5's two budgets, over HTTP — the request budget for every authenticated
 * route except the ciphertext ones, the byte budget for those, and the 16 KiB
 * floor every ciphertext-route request pays, errors included.
 *
 * Written against §9.5 because it is the ciphertext route that exists today;
 * §11.2 and §11.3 join through the route-table walk (byte-budget-routes).
 * Each budget is set small through the PROPOSED `limits` seam so the numbers
 * are reachable in a handful of requests; the floor is §11.5's constant and
 * is not configurable here, on purpose.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildLimiterServer, FLOOR } from "./support/limiter-graph.mjs";

const AT = Date.parse("2026-10-07T09:00:00.000Z");
const plenty = { requestsPerMinute: 10_000, bytesPerHour: 1e9, now: () => AT };

const metadata = (app, auth, albumId, options = {}) =>
  app.inject({ method: "GET", url: `/v1/albums/${albumId}/metadata`, headers: auth, ...options });

const details = (app, auth, albumId) =>
  app.inject({ method: "GET", url: `/v1/albums/${albumId}`, headers: auth });

function assertRateLimited(response) {
  assert.equal(response.statusCode, 429, response.body);
  // The body is the envelope and nothing else — the assertion that catches a
  // limiter building its own (§11.5, §1.2's 429 row).
  assert.deepEqual(response.json(), { code: "RATE_LIMITED", message: "Rate limited." });
  assert.ok(Number(response.headers["retry-after"]) > 0);
}

describe("§11.5 — the floor", () => {
  it("charges a sub-floor response exactly the floor, with no refund", async () => {
    const { app, albums, media, recipients } = await buildLimiterServer({
      limits: { ...plenty, bytesPerHour: 4 * FLOOR },
    });
    const album = albums.add();
    media.addReady(album);
    const auth = recipients.grant(album);

    for (let i = 0; i < 4; i++) {
      const response = await metadata(app, auth, album);
      assert.equal(response.statusCode, 200, response.body);
      // Non-vacuous only while the body is under the floor.
      assert.ok(response.rawPayload.length < FLOOR, `body is ${response.rawPayload.length} bytes`);
    }

    // `max(0, size − floor)`: without the max, each 300-byte response refunds
    // most of its floor and this request is served.
    assertRateLimited(await metadata(app, auth, album));
  });

  it("charges a 403 the floor — a revoked recipient on their own album", async () => {
    const { app, albums, recipients } = await buildLimiterServer({
      limits: { ...plenty, bytesPerHour: 4 * FLOOR },
    });
    const album = albums.add();
    const auth = recipients.grant(album, { revokedAt: new Date(AT) });

    for (let i = 0; i < 4; i++) {
      assert.equal((await metadata(app, auth, album)).statusCode, 403);
    }

    assertRateLimited(await metadata(app, auth, album));
  });

  it("charges a 404 the floor — a recipient asking about another album", async () => {
    const { app, albums, recipients } = await buildLimiterServer({
      limits: { ...plenty, bytesPerHour: 4 * FLOOR },
    });
    const own = albums.add();
    const other = albums.add();
    const auth = recipients.grant(own);

    for (let i = 0; i < 4; i++) {
      assert.equal((await metadata(app, auth, other)).statusCode, 404);
    }

    assertRateLimited(await metadata(app, auth, other));
  });

  it("charges an over-floor response its full size", async () => {
    // Ten 4096-byte envelopes: a JSON body between 3 and 4 floors, so one
    // fits the budget and a second request's floor does not — unless only the
    // floor was charged for the first.
    const { app, albums, media, recipients } = await buildLimiterServer({
      limits: { ...plenty, bytesPerHour: 4 * FLOOR },
    });
    const album = albums.add();
    for (let i = 0; i < 10; i++) media.addReady(album, 4096);
    const auth = recipients.grant(album);

    const first = await metadata(app, auth, album);
    assert.equal(first.statusCode, 200, first.body);
    const size = first.rawPayload.length;
    assert.ok(size > 3 * FLOOR && size <= 4 * FLOOR, `body is ${size} bytes`);

    assertRateLimited(await metadata(app, auth, album));
  });
});

describe("§11.5 — keyed on the token hash", () => {
  it("two tokens from one address do not share a budget", async () => {
    const { app, albums, media, recipients } = await buildLimiterServer({
      limits: { ...plenty, bytesPerHour: FLOOR },
    });
    const album = albums.add();
    media.addReady(album);
    const maria = recipients.grant(album);
    const abuelo = recipients.grant(album);

    assert.equal((await metadata(app, maria, album)).statusCode, 200);
    assertRateLimited(await metadata(app, maria, album));
    assert.equal((await metadata(app, abuelo, album)).statusCode, 200);
  });

  it("one token from two addresses does", async () => {
    // Mobile data changes a device's address mid-session (§11.5).
    const { app, albums, media, recipients } = await buildLimiterServer({
      limits: { ...plenty, bytesPerHour: FLOOR },
    });
    const album = albums.add();
    media.addReady(album);
    const auth = recipients.grant(album);

    const first = await metadata(app, auth, album, { remoteAddress: "10.0.0.1" });
    assert.equal(first.statusCode, 200);
    assertRateLimited(await metadata(app, auth, album, { remoteAddress: "10.0.0.2" }));
  });
});

describe("§11.5 — the two budgets are disjoint", () => {
  it("a non-ciphertext route charges no bytes", async () => {
    const { app, albums, media, recipients } = await buildLimiterServer({
      limits: { ...plenty, bytesPerHour: FLOOR },
    });
    const album = albums.add();
    media.addReady(album);
    const auth = recipients.grant(album);

    for (let i = 0; i < 5; i++) {
      assert.equal((await details(app, auth, album)).statusCode, 200);
    }

    // The whole byte budget is still there.
    assert.equal((await metadata(app, auth, album)).statusCode, 200);
  });

  it("a ciphertext route is not request-counted, and the rest are", async () => {
    // A grid opens one thumbnail per photo; album size must not set the
    // request budget (§11.5's correction).
    const { app, albums, media, recipients } = await buildLimiterServer({
      limits: { ...plenty, requestsPerMinute: 3 },
    });
    const album = albums.add();
    media.addReady(album);
    const auth = recipients.grant(album);

    for (let i = 0; i < 5; i++) {
      assert.equal((await metadata(app, auth, album)).statusCode, 200, `metadata ${i}`);
    }

    for (let i = 0; i < 3; i++) {
      assert.equal((await details(app, auth, album)).statusCode, 200, `details ${i}`);
    }
    assertRateLimited(await details(app, auth, album));
  });
});
