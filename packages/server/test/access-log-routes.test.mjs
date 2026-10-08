// The owner's read of the log — api-sketch §11.7, over the real graph with a
// fake repository. The SQL is infra/access-log-repository.test.mjs's; this is
// scope, the wire shape, and the query string's closed allowlist.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { b64, buildPr2Server, sha256 } from "./support/pr2-graph.mjs";

const LABEL = Buffer.alloc(60, 0x6c);
const OPENED = new Date("2026-10-03T09:01:00.123Z");
const REVOKED = new Date("2026-10-05T00:00:00.000Z");
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function fakeAccessLogs() {
  const logs = {
    recorded: [],
    queries: [],
    async record(event) {
      logs.recorded.push(event);
    },
    async summarise() {
      return [
        { recipientId: randomUUID(), label: LABEL, revokedAt: REVOKED, albumOpens: 2, mediaOpened: 1, lastOpenedAt: OPENED },
        { recipientId: randomUUID(), label: LABEL, revokedAt: null, albumOpens: 0, mediaOpened: 0, lastOpenedAt: null },
      ];
    },
    async listEntries(query) {
      logs.queries.push(query);
      return {
        entries: [
          { id: 8812, recipientId: randomUUID(), mediaId: randomUUID(), event: "asset_viewed", occurredAt: OPENED },
          { id: 8811, recipientId: randomUUID(), mediaId: null, event: "album_opened", occurredAt: OPENED },
        ],
        nextBefore: 8811,
      };
    },
  };
  return logs;
}

async function setup() {
  const accessLogs = fakeAccessLogs();
  const server = await buildPr2Server({ accessLogs });
  const parent = await server.owner();
  const albumId = await server.album(parent.auth);
  return { ...server, accessLogs, parent, albumId };
}

async function recipientAuth({ app, parent }, albumId) {
  const token = randomBytes(32);
  const created = await app.inject({
    method: "POST",
    url: `/v1/albums/${albumId}/recipients`,
    headers: parent.auth,
    payload: { id: randomUUID(), kind: "qr", label: b64(0x6c, 60), token_hash: sha256(token).toString("base64url") },
  });
  assert.equal(created.statusCode, 201, created.body);
  return { authorization: `Bearer ${token.toString("base64url")}` };
}

const summary = (app, albumId, headers) =>
  app.inject({ method: "GET", url: `/v1/albums/${albumId}/access-log`, headers });
const entries = (app, albumId, headers, query = "") =>
  app.inject({ method: "GET", url: `/v1/albums/${albumId}/access-log/entries${query}`, headers });

function assertBareError(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().code, code);
}

describe("GET /v1/albums/{album_id}/access-log — §11.7", () => {
  it("returns every recipient in §11.7's shape: base64url label, RFC 3339 or null", async () => {
    const ctx = await setup();
    const response = await summary(ctx.app, ctx.albumId, ctx.parent.auth);

    assert.equal(response.statusCode, 200, response.body);
    const [revoked, silent] = response.json().recipients;
    assert.deepEqual(Object.keys(revoked).sort(), [
      "album_opens", "label", "last_opened_at", "media_opened", "recipient_id", "revoked_at",
    ]);
    assert.equal(revoked.label, LABEL.toString("base64url"));
    // A Date serialised as a string is `Sat Oct 03 2026 …`, not RFC 3339.
    assert.match(revoked.last_opened_at, RFC3339);
    assert.equal(revoked.last_opened_at, "2026-10-03T09:01:00Z");
    assert.match(revoked.revoked_at, RFC3339);
    assert.deepEqual([revoked.album_opens, revoked.media_opened], [2, 1]);
    assert.deepEqual([silent.revoked_at, silent.last_opened_at, silent.album_opens], [null, null, 0]);
  });

  it("carries no-store — label is ciphertext (§11.3)", async () => {
    const ctx = await setup();
    assert.equal((await summary(ctx.app, ctx.albumId, ctx.parent.auth)).headers["cache-control"], "no-store");
  });

  it("another owner's album, or an absent one, is 404", async () => {
    const ctx = await setup();
    const stranger = await ctx.owner();

    assertBareError(await summary(ctx.app, ctx.albumId, stranger.auth), 404, "NOT_FOUND");
    assertBareError(await summary(ctx.app, randomUUID(), ctx.parent.auth), 404, "NOT_FOUND");
  });

  it("a recipient's token is 401 — owner scheme only", async () => {
    const ctx = await setup();
    assertBareError(await summary(ctx.app, ctx.albumId, await recipientAuth(ctx, ctx.albumId)), 401, "UNAUTHENTICATED");
  });

  it("reading the log writes nothing to it", async () => {
    const ctx = await setup();
    await summary(ctx.app, ctx.albumId, ctx.parent.auth);
    await entries(ctx.app, ctx.albumId, ctx.parent.auth);

    assert.deepEqual(ctx.accessLogs.recorded, []);
  });
});

describe("GET /v1/albums/{album_id}/access-log/entries — §11.7", () => {
  it("returns entries and next_before in §11.7's shape", async () => {
    const ctx = await setup();
    const response = await entries(ctx.app, ctx.albumId, ctx.parent.auth);

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(Object.keys(body).sort(), ["entries", "next_before"]);
    assert.equal(body.next_before, 8811);
    assert.deepEqual(Object.keys(body.entries[0]).sort(), ["event", "id", "media_id", "occurred_at", "recipient_id"]);
    assert.equal(body.entries[0].id, 8812);
    assert.match(body.entries[0].occurred_at, RFC3339);
    assert.equal(body.entries[1].media_id, null, "album_opened has no media");
  });

  it("limit defaults to 100, and no filter is passed when none was given", async () => {
    const ctx = await setup();
    await entries(ctx.app, ctx.albumId, ctx.parent.auth);

    assert.deepEqual(ctx.accessLogs.queries, [{ albumId: ctx.albumId, limit: 100 }]);
  });

  it("passes recipient_id, media_id, limit and before through, as their port names", async () => {
    const ctx = await setup();
    const recipientId = randomUUID();
    const mediaId = randomUUID();

    const response = await entries(
      ctx.app, ctx.albumId, ctx.parent.auth,
      `?recipient_id=${recipientId}&media_id=${mediaId}&limit=7&before=8812`,
    );

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(ctx.accessLogs.queries, [{ albumId: ctx.albumId, recipientId, mediaId, limit: 7, before: 8812 }]);
  });

  const invalid = [
    ["?limit=0", "limit below 1"],
    ["?limit=501", "limit above 500"],
    ["?limit=ten", "limit not a number"],
    ["?before=0", "a cursor of 0"],
    ["?before=99999999999999999999", "a cursor past a safe integer"],
    ["?recipient_id=not-a-uuid", "a filter that is not a uuid"],
  ];
  for (const [query, why] of invalid) {
    it(`${query} → 400, the store never asked — ${why}`, async () => {
      const ctx = await setup();
      const response = await entries(ctx.app, ctx.albumId, ctx.parent.auth, query);

      assertBareError(response, 400, "VALIDATION_FAILED");
      const value = query.split("=")[1];
      assert.ok(!response.body.includes(value), "the submitted value reached the body (#15)");
      assert.deepEqual(ctx.accessLogs.queries, []);
    });
  }

  it("a parameter off the allowlist is stripped, not rejected — and never reaches the port", async () => {
    // Measured 8 October 2026: Fastify's Ajv runs with removeAdditional, so a
    // closed querystring DROPS unknown names (as bodies do here) rather than 400.
    const ctx = await setup();
    const response = await entries(ctx.app, ctx.albumId, ctx.parent.auth, "?token=abc&limit=5");

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(ctx.accessLogs.queries, [{ albumId: ctx.albumId, limit: 5 }]);
  });

  it("another owner's album is 404, and the repository is never asked", async () => {
    const ctx = await setup();
    const stranger = await ctx.owner();

    assertBareError(await entries(ctx.app, ctx.albumId, stranger.auth), 404, "NOT_FOUND");
    assert.deepEqual(ctx.accessLogs.queries, []);
  });

  it("a recipient's token is 401", async () => {
    const ctx = await setup();
    assertBareError(await entries(ctx.app, ctx.albumId, await recipientAuth(ctx, ctx.albumId)), 401, "UNAUTHENTICATED");
  });
});
