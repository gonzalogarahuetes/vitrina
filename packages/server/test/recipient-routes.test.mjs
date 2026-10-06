/*
 * `POST /v1/albums/{album_id}/recipients` and
 * `POST /v1/recipients/{recipient_id}/revoke` — api-sketch §7.7, §7.8, over
 * the real use-case graph (test/support/pr2-graph.mjs). Hermetic.
 *
 * The last describe block is the reason these routes were built when they
 * were: a recipient created and revoked through the API, then used as a
 * credential, with no row written by hand. PR 4 needed exactly that.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { b64, buildPr2Server, nonCanonical, sha256 } from "./support/pr2-graph.mjs";

const INT4_MAX = 2147483647;
const WRAP_FIELDS = [
  "wrapped",
  "wrap_nonce",
  "kdf_salt",
  "kdf_memory_kib",
  "kdf_iterations",
  "kdf_parallelism",
];

/** A QR body, plus the raw token the client would put in the invite. */
function qrBody(overrides = {}) {
  const token = randomBytes(32);
  return {
    token,
    body: {
      id: randomUUID(),
      kind: "qr",
      label: b64(0x6c, 60), // ciphertext under K_label since 003; opaque here
      token_hash: sha256(token).toString("base64url"),
      ...overrides,
    },
  };
}

/** A passphrase body at 002's floors, so a 001-floored schema fails here. */
function passphraseBody(overrides = {}) {
  const { token, body } = qrBody();
  return {
    token,
    body: {
      ...body,
      kind: "passphrase",
      wrapped: b64(0x77, 48),
      wrap_nonce: b64(0x6e, 24),
      kdf_salt: b64(0x73, 16),
      kdf_memory_kib: 16384,
      kdf_iterations: 2,
      kdf_parallelism: 1,
      ...overrides,
    },
  };
}

const create = (app, headers, albumId, payload) =>
  app.inject({ method: "POST", url: `/v1/albums/${albumId}/recipients`, headers, payload });

const revoke = (app, headers, recipientId) =>
  app.inject({ method: "POST", url: `/v1/recipients/${recipientId}/revoke`, headers });

/** A server, a signed-in owner, and one of their albums. */
async function setup() {
  const server = await buildPr2Server();
  const parent = await server.owner();
  const albumId = await server.album(parent.auth);
  return { ...server, parent, albumId };
}

/** §7.3's 400/404/409 carry `{code, message}` and nothing else (#15). */
function assertBareError(response, status, code) {
  assert.equal(response.statusCode, status, response.body);
  assert.deepEqual(Object.keys(response.json()).sort(), ["code", "message"]);
  assert.equal(response.json().code, code);
}

describe("POST /v1/albums/{album_id}/recipients — §7.7", () => {
  it("creates a QR recipient: 201, the client's id, and no wrap stored", async () => {
    const { app, parent, albumId, recipients } = await setup();
    const { body } = qrBody();

    const response = await create(app, parent.auth, albumId, body);

    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().id, body.id, "the id is the client's — it is inside the wrap AAD");
    assert.match(response.json().created_at, /Z$/);
    assert.deepEqual(Object.keys(response.json()).sort(), ["created_at", "id"]);

    const row = recipients.rows.get(body.id);
    assert.equal(row.kind, "qr");
    assert.equal(row.albumId, albumId, "the album comes from the path");
    assert.equal(row.wrap, undefined, "a QR row carries wrap material");
    assert.equal(Buffer.from(row.label).toString("base64url"), body.label);
    assert.equal(Buffer.from(row.tokenHash).toString("base64url"), body.token_hash);
  });

  it("creates a passphrase recipient with all six wrap fields, integers as numbers", async () => {
    const { app, parent, albumId, recipients } = await setup();
    const { body } = passphraseBody();

    const response = await create(app, parent.auth, albumId, body);

    assert.equal(response.statusCode, 201, response.body);
    const { wrap } = recipients.rows.get(body.id);
    assert.equal(Buffer.from(wrap.wrapped).toString("base64url"), body.wrapped);
    assert.equal(Buffer.from(wrap.wrapNonce).toString("base64url"), body.wrap_nonce);
    assert.equal(Buffer.from(wrap.kdfSalt).toString("base64url"), body.kdf_salt);
    // Each integer in its own slot. A handler that reads the wrong field
    // stores NaN or a swapped value, and the passphrase never derives.
    assert.deepEqual(wrap.params, { memoryKib: 16384, iterations: 2, parallelism: 1 });
  });

  describe("the two CHECKs, mirrored rather than trusted", () => {
    for (const field of WRAP_FIELDS) {
      it(`refuses ${field} on a QR recipient`, async () => {
        // Rejected, not stripped: `additionalProperties: false` only strips,
        // so the schema needs a `not` (§7.7, "forbidden for qr").
        const { app, parent, albumId, recipients } = await setup();
        const { body: full } = passphraseBody();
        const { body } = qrBody({ [field]: full[field] });

        assertBareError(await create(app, parent.auth, albumId, body), 400, "VALIDATION_FAILED");
        assert.equal(recipients.rows.size, 0);
      });

      it(`requires ${field} on a passphrase recipient`, async () => {
        const { app, parent, albumId } = await setup();
        const { body } = passphraseBody();
        delete body[field];

        assertBareError(await create(app, parent.auth, albumId, body), 400, "VALIDATION_FAILED");
      });
    }

    it("refuses a missing or unknown kind", async () => {
      const { app, parent, albumId } = await setup();
      const { body } = qrBody();

      for (const kind of [undefined, "link", "QR"]) {
        const response = await create(app, parent.auth, albumId, { ...body, kind });
        assertBareError(response, 400, "VALIDATION_FAILED");
      }
    });
  });

  describe("every binary field decodes by schema §6's rules", () => {
    it("bounds label in bytes: 41 and 1024 pass, 40 and 1025 do not", async () => {
      const { app, parent, albumId } = await setup();

      for (const [bytes, status] of [
        [40, 400],
        [41, 201],
        [1024, 201],
        [1025, 400],
      ]) {
        const { body } = qrBody({ label: b64(0x6c, bytes) });
        const response = await create(app, parent.auth, albumId, body);
        assert.equal(response.statusCode, status, `${bytes}-byte label: ${response.body}`);
      }
    });

    it("refuses a non-canonical spelling of every field that has one", async () => {
      // §7.7's spare-bits table: token_hash has 4 spellings, kdf_salt 16, and
      // label's count depends on its length — 61 bytes has spare bits.
      const { app, parent, albumId } = await setup();
      const cases = [
        qrBody({ token_hash: nonCanonical(sha256(randomBytes(32)).toString("base64url")) }),
        qrBody({ label: nonCanonical(b64(0x6c, 61)) }),
        passphraseBody({ kdf_salt: nonCanonical(b64(0x73, 16)) }),
      ];

      for (const { body } of cases) {
        assertBareError(await create(app, parent.auth, albumId, body), 400, "VALIDATION_FAILED");
      }
    });

    it("refuses padding, the standard alphabet, hex, and the wrong length", async () => {
      // wrapped and wrap_nonce have no spare bits (48 and 24 divide by three),
      // so these are the spellings that can still be wrong.
      const { app, parent, albumId } = await setup();
      const std = Buffer.alloc(48, 0xfb).toString("base64"); // carries + and /
      const cases = [
        passphraseBody({ wrapped: std }),
        passphraseBody({ wrap_nonce: `${b64(0x6e, 24)}=` }),
        passphraseBody({ wrap_nonce: b64(0x6e, 23) }),
        qrBody({ token_hash: sha256(randomBytes(32)).toString("hex") }),
        qrBody({ token_hash: `${sha256(randomBytes(32)).toString("base64url")}=` }),
      ];

      for (const { body } of cases) {
        assertBareError(await create(app, parent.auth, albumId, body), 400, "VALIDATION_FAILED");
      }
    });
  });

  describe("the KDF integers", () => {
    it("are floored at 002's values, not 001's", async () => {
      const { app, parent, albumId } = await setup();

      for (const below of [
        { kdf_memory_kib: 16383 },
        { kdf_iterations: 1 },
        { kdf_parallelism: 0 },
      ]) {
        const { body } = passphraseBody(below);
        assertBareError(await create(app, parent.auth, albumId, body), 400, "VALIDATION_FAILED");
      }
    });

    it("stop at int4 — a larger value is a 400, not Postgres 22003 as a 500", async () => {
      const { app, parent, albumId } = await setup();

      const atMax = passphraseBody({ kdf_memory_kib: INT4_MAX });
      assert.equal((await create(app, parent.auth, albumId, atMax.body)).statusCode, 201);

      for (const field of ["kdf_memory_kib", "kdf_iterations", "kdf_parallelism"]) {
        const { body } = passphraseBody({ [field]: INT4_MAX + 1 });
        assertBareError(await create(app, parent.auth, albumId, body), 400, "VALIDATION_FAILED");
      }
    });

    it("are integers", async () => {
      const { app, parent, albumId } = await setup();
      const { body } = passphraseBody({ kdf_iterations: 2.5 });
      assertBareError(await create(app, parent.auth, albumId, body), 400, "VALIDATION_FAILED");
    });
  });

  describe("scope — §7.3 step 3", () => {
    it("answers 404 for another owner's album, byte-identical to an absent one", async () => {
      // A 403 would confirm the album exists (brief §9.1).
      const { app, owner, albumId, recipients } = await setup();
      const stranger = await owner();

      const theirs = await create(app, stranger.auth, albumId, qrBody().body);
      const absent = await create(app, stranger.auth, randomUUID(), qrBody().body);

      assertBareError(theirs, 404, "NOT_FOUND");
      assert.equal(theirs.body, absent.body);
      assert.equal(recipients.rows.size, 0, "a recipient was filed on someone else's album");
    });

    it("answers 400, not 500, for a malformed album id", async () => {
      const { app, parent } = await setup();
      const response = await create(app, parent.auth, "not-a-uuid", qrBody().body);
      assertBareError(response, 400, "VALIDATION_FAILED");
    });
  });

  describe("409 — §7.7", () => {
    it("is the same bare 409 for a duplicate id and a duplicate token_hash", async () => {
      // No `details`: naming the column would make this an oracle for "is
      // this hash already in use". The two bodies must be indistinguishable.
      const { app, parent, albumId } = await setup();
      const first = qrBody();
      await create(app, parent.auth, albumId, first.body);

      const sameId = await create(app, parent.auth, albumId, qrBody({ id: first.body.id }).body);
      const sameHash = await create(
        app,
        parent.auth,
        albumId,
        qrBody({ token_hash: first.body.token_hash }).body,
      );

      assertBareError(sameId, 409, "CONFLICT");
      assertBareError(sameHash, 409, "CONFLICT");
      assert.equal(sameId.body, sameHash.body);
    });
  });

  describe("authentication — §7.1, §7.3", () => {
    it("answers 401 with no token", async () => {
      const { app, albumId } = await setup();
      assertBareError(await create(app, {}, albumId, qrBody().body), 401, "UNAUTHENTICATED");
    });

    it("answers 401 to a recipient token — no fallback to the other table", async () => {
      // Both credentials are 32 random bytes in the same header. A route that
      // tried owner_tokens and then recipients is brief §9.1's shared token
      // table rebuilt in code.
      const { app, parent, albumId } = await setup();
      const { token, body } = qrBody();
      await create(app, parent.auth, albumId, body);
      const asRecipient = { authorization: `Bearer ${token.toString("base64url")}` };

      const response = await create(app, asRecipient, albumId, qrBody().body);
      assertBareError(response, 401, "UNAUTHENTICATED");
    });
  });

  it("echoes nothing it was sent in a 400 (#15)", async () => {
    const { app, parent, albumId } = await setup();
    const marker = "Zm9vYmFyYmF6cXV4";
    const { body } = qrBody({ label: marker });

    const response = await create(app, parent.auth, albumId, body);

    assertBareError(response, 400, "VALIDATION_FAILED");
    assert.ok(!response.body.includes(marker));
    assert.ok(!response.body.includes(body.id));
  });

  it("drops a field no schema declares — which is why the route-table walk matters", async () => {
    /*
     * Fastify's removeAdditional strips unknown properties rather than
     * rejecting them (§1.2). So `passphrase` here is never stored, never
     * logged, never reaches a use case — and the guarantee that nothing ever
     * ACCEPTS one is test/route-table.test.mjs's walk over the schema, not
     * this route's status code (#16).
     */
    const { app, parent, albumId, recipients } = await setup();
    const { body } = qrBody({ passphrase: "correct horse battery staple" });

    const response = await create(app, parent.auth, albumId, body);

    assert.equal(response.statusCode, 201, response.body);
    assert.equal(recipients.rows.get(body.id).passphrase, undefined);
  });

  it("does not carry no-store — it returns no wrapping (§11.8)", async () => {
    const { app, parent, albumId } = await setup();
    const response = await create(app, parent.auth, albumId, qrBody().body);
    assert.notEqual(response.headers["cache-control"], "no-store");
  });
});

describe("POST /v1/recipients/{recipient_id}/revoke — §7.8", () => {
  async function withRecipient() {
    const context = await setup();
    const { body } = qrBody();
    await create(context.app, context.parent.auth, context.albumId, body);
    return { ...context, recipientId: body.id };
  }

  it("answers 200 with revoked_at, and deletes nothing", async () => {
    const { app, parent, recipientId, recipients } = await withRecipient();

    const response = await revoke(app, parent.auth, recipientId);

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(Object.keys(response.json()), ["revoked_at"]);
    assert.match(response.json().revoked_at, /Z$/);
    assert.ok(recipients.rows.has(recipientId), "revoke removed the row");
  });

  it("is idempotent: a second call returns the ORIGINAL timestamp with 200", async () => {
    // A client that lost the first response must not see a failure, and the
    // first revocation is the true one.
    const { app, parent, recipientId } = await withRecipient();

    const first = await revoke(app, parent.auth, recipientId);
    const second = await revoke(app, parent.auth, recipientId);

    assert.equal(second.statusCode, 200);
    assert.equal(second.json().revoked_at, first.json().revoked_at);
  });

  it("answers 404 for another owner's recipient, byte-identical to an absent one", async () => {
    const { app, owner, recipientId, recipients } = await withRecipient();
    const stranger = await owner();

    const theirs = await revoke(app, stranger.auth, recipientId);
    const absent = await revoke(app, stranger.auth, randomUUID());

    assertBareError(theirs, 404, "NOT_FOUND");
    assert.equal(theirs.body, absent.body);
    assert.equal(recipients.rows.get(recipientId).revokedAt, null, "a stranger revoked it");
  });

  it("answers 400, not 500, for a malformed recipient id", async () => {
    const { app, parent } = await withRecipient();
    assertBareError(await revoke(app, parent.auth, "not-a-uuid"), 400, "VALIDATION_FAILED");
  });

  it("answers 401 to a recipient token, including the recipient's own", async () => {
    const { app, parent, albumId } = await setup();
    const { token, body } = qrBody();
    await create(app, parent.auth, albumId, body);
    const asRecipient = { authorization: `Bearer ${token.toString("base64url")}` };

    assertBareError(await revoke(app, asRecipient, body.id), 401, "UNAUTHENTICATED");
  });

  it("answers 400 before auth when sent as empty JSON — §7.8's wire contract", async () => {
    // Same framework measurement as /logout's: no body, no parser, so an
    // empty JSON body is the parser's 400, ahead of the 401 a missing token
    // would otherwise get.
    const { app, recipientId, recipients } = await withRecipient();

    const response = await app.inject({
      method: "POST",
      url: `/v1/recipients/${recipientId}/revoke`,
      headers: { "content-type": "application/json" },
    });

    assertBareError(response, 400, "VALIDATION_FAILED");
    assert.equal(recipients.rows.get(recipientId).revokedAt, null);
  });
});

describe("create → use → revoke, through the API only", () => {
  /*
   * The done-when for PR 2's late half. Until these routes existed nothing
   * could create a recipient except a direct insert, so §9.4's "identical
   * response shape for both caller kinds" was tested only against rows tests
   * wrote by hand.
   */
  it("a created recipient can read its album, and a revoked one gets 403", async () => {
    const { app, parent, albumId } = await setup();
    const { token, body } = passphraseBody();
    const asRecipient = { authorization: `Bearer ${token.toString("base64url")}` };
    const details = () =>
      app.inject({ method: "GET", url: `/v1/albums/${albumId}`, headers: asRecipient });

    assert.equal((await create(app, parent.auth, albumId, body)).statusCode, 201);

    const before = await details();
    const asOwner = await app.inject({
      method: "GET",
      url: `/v1/albums/${albumId}`,
      headers: parent.auth,
    });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.body, asOwner.body, "§9.4: one shape for both caller kinds");

    assert.equal((await revoke(app, parent.auth, body.id)).statusCode, 200);

    // §7.3 step 4: scope first, then revocation — their own album is 403.
    assertBareError(await details(), 403, "ACCESS_REVOKED");
  });
});
