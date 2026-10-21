/*
 * `GET /v1/recipient/key` — api-sketch §10.1, over the real use-case graph
 * (test/support/pr2-graph.mjs). Hermetic.
 *
 * Every recipient here is created through §7.7's route, never written into
 * the fake by hand, so what comes back is checked against what a client
 * posted — the round trip the route exists for.
 *
 * Discharges §6.2's four PR 4 rows except the route-table walk's outbound
 * half, which is route-table.test.mjs's.
 *
 * Both kinds since 006 (encryption spec §6.1): a qr recipient fetches K_album
 * wrapped under K_invite, and gets `kind` and no KDF fields. Until then this
 * route answered a qr token `404`, and a revoked one `404` too; both cases
 * are replaced below by the `200` and the `403` that hold now.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { b64, buildPr2Server, sha256 } from "./support/pr2-graph.mjs";

const PASSPHRASE_FIELDS = [
  "id",
  "kdf_iterations",
  "kdf_memory_kib",
  "kdf_parallelism",
  "kdf_salt",
  "kind",
  "wrap_nonce",
  "wrapped",
];

/** No KDF field at all — absent, not null (§10.1). */
const QR_FIELDS = ["id", "kind", "wrap_nonce", "wrapped"];

/** A server, a signed-in owner, and one of their albums. */
async function setup() {
  const server = await buildPr2Server();
  const parent = await server.owner();
  const albumId = await server.album(parent.auth);
  return { ...server, parent, albumId };
}

/**
 * A recipient created through §7.7, returning the body posted and the bearer
 * header its invite would produce. Passphrase rows use parameters above 002's
 * floors and distinct from each other, so a response that swapped two
 * integers, or returned a constant, cannot match. Both kinds post a wrapping.
 */
async function recipient({ app, parent, albumId }, kind, fill = 0x70) {
  const token = randomBytes(32);
  const body = {
    id: randomUUID(),
    kind,
    label: b64(0x6c, 60),
    token_hash: sha256(token).toString("base64url"),
    wrapped: b64(fill, 48),
    wrap_nonce: b64(fill + 1, 24),
  };
  if (kind === "passphrase") {
    Object.assign(body, {
      kdf_salt: b64(fill + 2, 16),
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

const fetchKey = (app, headers, url = "/v1/recipient/key") =>
  app.inject({ method: "GET", url, headers });

const revoke = async ({ app, parent }, recipientId) => {
  const response = await app.inject({
    method: "POST",
    url: `/v1/recipients/${recipientId}/revoke`,
    headers: parent.auth,
  });
  assert.equal(response.statusCode, 200, response.body);
};

/** `{code, message}` and nothing else — no `details` on any §10.1 error. */
function assertBareError(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.deepEqual(Object.keys(response.json()).sort(), ["code", "message"]);
  assert.equal(response.json().code, code);
}

describe("GET /v1/recipient/key — §10.1", () => {
  describe("a passphrase recipient", () => {
    it("gets 200 with exactly §7.7's six wrap fields, its kind and its own id, as posted", async () => {
      const ctx = await setup();
      const { body, auth } = await recipient(ctx, "passphrase");

      const response = await fetchKey(ctx.app, auth);

      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), {
        id: body.id,
        kind: "passphrase",
        kdf_salt: body.kdf_salt,
        kdf_memory_kib: body.kdf_memory_kib,
        kdf_iterations: body.kdf_iterations,
        kdf_parallelism: body.kdf_parallelism,
        wrapped: body.wrapped,
        wrap_nonce: body.wrap_nonce,
      });
    });

    it("gets no label, album_id or created_at (§10.3)", async () => {
      // `label` is §11.4's, where every recipient reads it for the watermark.
      // Exact keys, so any widening fails, not only these three names.
      const ctx = await setup();
      const { auth } = await recipient(ctx, "passphrase");

      const response = await fetchKey(ctx.app, auth);

      assert.deepEqual(Object.keys(response.json()).sort(), PASSPHRASE_FIELDS);
    });

    it("carries Cache-Control: no-store (§8.3's rule)", async () => {
      const ctx = await setup();
      const { auth } = await recipient(ctx, "passphrase");

      const response = await fetchKey(ctx.app, auth);

      assert.equal(response.headers["cache-control"], "no-store");
    });
  });

  describe("a QR recipient (encryption spec §6.1, since 006)", () => {
    it("gets 200 with its kind, its id and the wrapping it posted — and no KDF field", async () => {
      // K_album under K_invite. Exact equality, so a KDF field present as
      // null, or a constant `kind`, fails here.
      const ctx = await setup();
      const { body, auth } = await recipient(ctx, "qr");

      const response = await fetchKey(ctx.app, auth);

      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), {
        id: body.id,
        kind: "qr",
        wrapped: body.wrapped,
        wrap_nonce: body.wrap_nonce,
      });
      assert.deepEqual(Object.keys(response.json()).sort(), QR_FIELDS);
    });

    it("carries Cache-Control: no-store (§8.3's rule)", async () => {
      const ctx = await setup();
      const { auth } = await recipient(ctx, "qr");

      const response = await fetchKey(ctx.app, auth);

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
    });
  });

  describe("the caller's own row, and only that (§6.2)", () => {
    it("a QR and a passphrase recipient on one album each get their own kind and wrapping", async () => {
      // A lookup keyed on album, or a `kind` read from anywhere but the row,
      // answers both the same.
      const ctx = await setup();
      const qr = await recipient(ctx, "qr", 0x30);
      const passphrase = await recipient(ctx, "passphrase", 0x50);

      const a = (await fetchKey(ctx.app, qr.auth)).json();
      const b = (await fetchKey(ctx.app, passphrase.auth)).json();

      assert.deepEqual([a.id, a.kind, a.wrapped], [qr.body.id, "qr", qr.body.wrapped]);
      assert.deepEqual(
        [b.id, b.kind, b.wrapped],
        [passphrase.body.id, "passphrase", passphrase.body.wrapped],
      );
    });


    it("two passphrase recipients on one album each get their own wrapping and id", async () => {
      const ctx = await setup();
      const first = await recipient(ctx, "passphrase", 0x30);
      const second = await recipient(ctx, "passphrase", 0x50);

      const a = (await fetchKey(ctx.app, first.auth)).json();
      const b = (await fetchKey(ctx.app, second.auth)).json();

      assert.equal(a.id, first.body.id);
      assert.equal(a.wrapped, first.body.wrapped);
      assert.equal(b.id, second.body.id);
      assert.equal(b.wrapped, second.body.wrapped);
      assert.notEqual(a.wrapped, b.wrapped);
    });

    for (const query of ["recipient_id", "id"]) {
      it(`ignores ?${query}= naming another recipient`, async () => {
        // The test that fails the day someone adds an id "for admin" or "for
        // debugging". No id in the path is the scope check (§10.1); a query
        // parameter would rebuild the enumeration it removes.
        const ctx = await setup();
        const mine = await recipient(ctx, "passphrase", 0x30);
        const theirs = await recipient(ctx, "passphrase", 0x50);

        const response = await fetchKey(
          ctx.app,
          mine.auth,
          `/v1/recipient/key?${query}=${theirs.body.id}`,
        );

        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().id, mine.body.id);
        assert.equal(response.json().wrapped, mine.body.wrapped);
      });
    }
  });

  describe("§7.3's ladder, recipient branch", () => {
    for (const [kind, fields] of [
      ["passphrase", ["wrapped", "wrap_nonce", "kdf_salt"]],
      ["qr", ["wrapped", "wrap_nonce"]],
    ]) {
      it(`a revoked ${kind} recipient gets 403, and no wrapping anywhere in the body`, async () => {
        /*
         * The case that matters (§10.1): the wrapping is the one piece of
         * ciphertext whose continued availability lets a revoked holder of
         * either kind of invite finish an unwrap they had not started. For qr
         * this is new with 006: before it there was no wrapping to withhold.
         */
        const ctx = await setup();
        const { body, auth } = await recipient(ctx, kind);
        await revoke(ctx, body.id);

        const response = await fetchKey(ctx.app, auth);

        assertBareError(response, 403, "ACCESS_REVOKED");
        for (const field of fields) {
          assert.ok(!response.body.includes(body[field]), `${field} reached a 403`);
        }
      });
    }

    it("an unknown token gets 401", async () => {
      const ctx = await setup();
      const response = await fetchKey(ctx.app, {
        authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
      });

      assertBareError(response, 401, "UNAUTHENTICATED");
    });

    it("no token gets 401", async () => {
      const ctx = await setup();
      assertBareError(await fetchKey(ctx.app, {}), 401, "UNAUTHENTICATED");
    });
  });

  describe("§7.1 — recipient scheme only, no fallback", () => {
    it("an owner's valid session gets 401, and owner_tokens is never consulted", async () => {
      /*
       * Bearer tokens are indistinguishable, so the recipient lookup
       * necessarily runs on an owner's token and misses. What §7.1 forbids is
       * the next step: trying the other table. Patched after setup, because
       * signup and album creation legitimately use it.
       */
      const ctx = await setup();
      let ownerLookups = 0;
      const original = ctx.owners.findTokenByHash;
      ctx.owners.findTokenByHash = async (...args) => {
        ownerLookups += 1;
        return original(...args);
      };

      const response = await fetchKey(ctx.app, ctx.parent.auth);

      assertBareError(response, 401, "UNAUTHENTICATED");
      assert.equal(ownerLookups, 0, "the recipient route fell back to owner_tokens");
    });
  });
});

describe("every response carrying a wrapped blob is no-store (§8.3, §6.2)", () => {
  /*
   * One row per wrapped-blob route. A fourth route added without the header
   * is a one-line addition here, and a missing line is easier to notice than
   * a missing test file.
   */
  const routes = [
    ["GET /v1/owner/key (§8.3)", (ctx) => fetchKey(ctx.app, ctx.parent.auth, "/v1/owner/key")],
    ["GET /v1/albums (§9.2)", (ctx) => fetchKey(ctx.app, ctx.parent.auth, "/v1/albums")],
    [
      "GET /v1/recipient/key (§10.1), passphrase",
      async (ctx) => fetchKey(ctx.app, (await recipient(ctx, "passphrase")).auth),
    ],
    [
      "GET /v1/recipient/key (§10.1), qr",
      async (ctx) => fetchKey(ctx.app, (await recipient(ctx, "qr")).auth),
    ],
  ];

  for (const [name, call] of routes) {
    it(name, async () => {
      const ctx = await setup();
      const response = await call(ctx);

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
    });
  }
});
