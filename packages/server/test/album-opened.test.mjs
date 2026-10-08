// `album_opened` — api-sketch §11.6. §9.5's fetch IS the open, so it logs;
// §9.4's does not, and the contrast is the design. Discharges §6.2's row for
// the album half; asset-routes.test.mjs has the asset half.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { b64, buildPr2Server, sha256 } from "./support/pr2-graph.mjs";

function fakeAccessLogs() {
  const logs = {
    rows: [],
    failWith: null,
    async record(event) {
      if (logs.failWith) throw logs.failWith;
      logs.rows.push(event);
    },
  };
  return logs;
}

/** §9.4 and §9.5 need a media port; `failWith` breaks §9.5's read. */
function fakeMedia() {
  const media = {
    failWith: null,
    async findById() {
      return null;
    },
    async listByAlbum() {
      return [];
    },
    async listReadyEnvelopes() {
      if (media.failWith) throw media.failWith;
      return [{ mediaId: randomUUID(), envelope: Buffer.alloc(120, 0x33) }];
    },
  };
  return media;
}

async function setup({ captureLogs = false } = {}) {
  const accessLogs = fakeAccessLogs();
  const media = fakeMedia();
  const logLines = [];
  const server = await buildPr2Server({
    media,
    accessLogs,
    logger: captureLogs ? { level: "trace", stream: { write: (line) => logLines.push(JSON.parse(line)) } } : false,
  });
  const parent = await server.owner();
  const albumId = await server.album(parent.auth);
  return { ...server, accessLogs, media, logLines, parent, albumId };
}

async function recipient({ app, parent }, albumId, { revoked = false } = {}) {
  const token = randomBytes(32);
  const id = randomUUID();
  const created = await app.inject({
    method: "POST",
    url: `/v1/albums/${albumId}/recipients`,
    headers: parent.auth,
    payload: { id, kind: "qr", label: b64(0x6c, 60), token_hash: sha256(token).toString("base64url") },
  });
  assert.equal(created.statusCode, 201, created.body);
  if (revoked) {
    const response = await app.inject({ method: "POST", url: `/v1/recipients/${id}/revoke`, headers: parent.auth });
    assert.equal(response.statusCode, 200, response.body);
  }
  return { id, auth: { authorization: `Bearer ${token.toString("base64url")}` } };
}

const metadata = (app, albumId, headers) =>
  app.inject({ method: "GET", url: `/v1/albums/${albumId}/metadata`, headers });
const details = (app, albumId, headers) =>
  app.inject({ method: "GET", url: `/v1/albums/${albumId}`, headers });

describe("§11.6 — album_opened", () => {
  it("a recipient's §9.5 fetch writes one row, media_id absent", async () => {
    const ctx = await setup();
    const maria = await recipient(ctx, ctx.albumId);

    assert.equal((await metadata(ctx.app, ctx.albumId, maria.auth)).statusCode, 200);

    assert.deepEqual(ctx.accessLogs.rows, [{ event: "album_opened", recipientId: maria.id }]);
  });

  it("two fetches are two rows — every fetch is an open", async () => {
    const ctx = await setup();
    const { auth } = await recipient(ctx, ctx.albumId);

    await metadata(ctx.app, ctx.albumId, auth);
    await metadata(ctx.app, ctx.albumId, auth);

    assert.equal(ctx.accessLogs.rows.length, 2);
  });

  it("§9.4 does not log — a details fetch is not an open", async () => {
    const ctx = await setup();
    const { auth } = await recipient(ctx, ctx.albumId);

    assert.equal((await details(ctx.app, ctx.albumId, auth)).statusCode, 200);

    assert.deepEqual(ctx.accessLogs.rows, []);
  });

  it("an owner's §9.5 fetch writes nothing", async () => {
    const ctx = await setup();

    assert.equal((await metadata(ctx.app, ctx.albumId, ctx.parent.auth)).statusCode, 200);

    assert.deepEqual(ctx.accessLogs.rows, []);
  });

  it("no 4xx writes: revoked on their own album, or another album", async () => {
    const ctx = await setup();
    const revoked = await recipient(ctx, ctx.albumId, { revoked: true });
    const live = await recipient(ctx, ctx.albumId);
    const other = await ctx.album(ctx.parent.auth);

    assert.equal((await metadata(ctx.app, ctx.albumId, revoked.auth)).statusCode, 403);
    assert.equal((await metadata(ctx.app, other, live.auth)).statusCode, 404);

    assert.deepEqual(ctx.accessLogs.rows, []);
  });

  it("a 500 reading the envelopes writes nothing — the row follows the read", async () => {
    // Written only once the response is certain; a failed read is not an open.
    const ctx = await setup();
    const { auth } = await recipient(ctx, ctx.albumId);
    ctx.media.failWith = new Error("database went away");

    assert.equal((await metadata(ctx.app, ctx.albumId, auth)).statusCode, 500);

    assert.deepEqual(ctx.accessLogs.rows, []);
  });

  it("a failed write still serves the 200, and logs one error line", async () => {
    const ctx = await setup({ captureLogs: true });
    const { auth } = await recipient(ctx, ctx.albumId);
    ctx.accessLogs.failWith = new Error("access_log insert failed (pg 57P01)");

    const response = await metadata(ctx.app, ctx.albumId, auth);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().metadata.length, 1);
    const errors = ctx.logLines.filter((line) => line.level >= 50);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.equal(errors[0].msg, "access_log write failed");
  });
});
