// `GET /v1/recipient` — api-sketch §11.4, over the real use-case graph.
// Discharges §6.2's row: brief §5's watermark has an input, for either kind.
// Recipients come through §7.7's route, so `label` is checked against a post.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { b64, buildPr2Server, sha256 } from "./support/pr2-graph.mjs";

const FIELDS = ["album_id", "created_at", "id", "kind", "label"];

async function setup() {
  const server = await buildPr2Server();
  const parent = await server.owner();
  const albumId = await server.album(parent.auth);
  return { ...server, parent, albumId };
}

/** Created through §7.7; `fill` makes each label distinct. */
async function recipient({ app, parent, albumId }, kind, fill = 0x6c) {
  const token = randomBytes(32);
  const body = {
    id: randomUUID(),
    kind,
    label: b64(fill, 60),
    token_hash: sha256(token).toString("base64url"),
  };
  if (kind === "passphrase") {
    Object.assign(body, {
      wrapped: b64(0x70, 48),
      wrap_nonce: b64(0x71, 24),
      kdf_salt: b64(0x72, 16),
      kdf_memory_kib: 20480,
      kdf_iterations: 5,
      kdf_parallelism: 3,
    });
  }
  const created = await app.inject({
    method: "POST",
    url: `/v1/albums/${albumId}/recipients`,
    headers: parent.auth,
    payload: body,
  });
  assert.equal(created.statusCode, 201, created.body);
  return { body, auth: { authorization: `Bearer ${token.toString("base64url")}` } };
}

const fetchSelf = (app, headers) => app.inject({ method: "GET", url: "/v1/recipient", headers });

function assertBareError(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.deepEqual(Object.keys(response.json()).sort(), ["code", "message"]);
  assert.equal(response.json().code, code);
}

describe("GET /v1/recipient — §11.4", () => {
  for (const kind of ["qr", "passphrase"]) {
    it(`a ${kind} recipient gets its own row, label byte for byte`, async () => {
      const ctx = await setup();
      const { body, auth } = await recipient(ctx, kind);

      const response = await fetchSelf(ctx.app, auth);
      assert.equal(response.statusCode, 200, response.body);
      const self = response.json();

      // Exact bytes: a Buffer serialised as a string is mangled UTF-8, not this.
      assert.equal(self.label, body.label);
      assert.equal(self.id, body.id);
      assert.equal(self.album_id, ctx.albumId);
      assert.equal(self.kind, kind);
      assert.deepEqual(Object.keys(self).sort(), FIELDS);
    });
  }

  it("created_at is the row's, in RFC 3339 with a trailing Z", async () => {
    // additionalProperties: false drops an undeclared field silently.
    const ctx = await setup();
    const { body, auth } = await recipient(ctx, "qr");

    const self = (await fetchSelf(ctx.app, auth)).json();

    assert.match(self.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(Date.parse(self.created_at), ctx.recipients.rows.get(body.id).createdAt.getTime());
  });

  it("two recipients on one album each get their own label", async () => {
    // The id comes from the grant; anything keyed on the album answers both alike.
    const ctx = await setup();
    const maria = await recipient(ctx, "qr", 0x61);
    const abuelo = await recipient(ctx, "passphrase", 0x62);

    assert.equal((await fetchSelf(ctx.app, maria.auth)).json().label, maria.body.label);
    assert.equal((await fetchSelf(ctx.app, abuelo.auth)).json().label, abuelo.body.label);
  });

  it("carries Cache-Control: no-store — label is ciphertext (§11.3)", async () => {
    const ctx = await setup();
    const { auth } = await recipient(ctx, "qr");

    assert.equal((await fetchSelf(ctx.app, auth)).headers["cache-control"], "no-store");
  });

  for (const kind of ["qr", "passphrase"]) {
    it(`a revoked ${kind} recipient gets 403, and no label in the body`, async () => {
      // No album in the path, so no step-3 404: revocation answers for both kinds.
      const ctx = await setup();
      const { body, auth } = await recipient(ctx, kind);
      const revoked = await ctx.app.inject({
        method: "POST",
        url: `/v1/recipients/${body.id}/revoke`,
        headers: ctx.parent.auth,
      });
      assert.equal(revoked.statusCode, 200, revoked.body);

      const response = await fetchSelf(ctx.app, auth);

      assertBareError(response, 403, "ACCESS_REVOKED");
      assert.ok(!response.body.includes(body.label), "label reached a 403");
    });
  }

  it("no token, or an unknown one, is 401", async () => {
    const ctx = await setup();

    assertBareError(await fetchSelf(ctx.app, {}), 401, "UNAUTHENTICATED");
    assertBareError(
      await fetchSelf(ctx.app, { authorization: `Bearer ${randomBytes(32).toString("base64url")}` }),
      401,
      "UNAUTHENTICATED",
    );
  });

  it("an owner's valid session is 401 — recipient scheme only (§7.1)", async () => {
    const ctx = await setup();

    assertBareError(await fetchSelf(ctx.app, ctx.parent.auth), 401, "UNAUTHENTICATED");
  });

  it("a grant whose row is gone is a 500, not a 404 — a broken invariant", async () => {
    // Nothing deletes recipients (§4.2); a 404 would tell the client to stop asking.
    const ctx = await setup();
    const { auth } = await recipient(ctx, "qr");
    ctx.recipients.findDetailsById = async () => null;

    assertBareError(await fetchSelf(ctx.app, auth), 500, "INTERNAL");
  });
});
