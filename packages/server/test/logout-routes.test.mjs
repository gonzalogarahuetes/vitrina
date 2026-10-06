/*
 * `POST /v1/logout` and `POST /v1/logout/all` — api-sketch §7.5, over the
 * real use-case graph (test/support/pr2-graph.mjs). Hermetic: app.inject, no
 * Docker, no Postgres. The repository's half — the owner predicate, the
 * first timestamp kept — is infra/owner-repository.test.mjs's.
 *
 * Every assertion about who is still signed in is made by USING the token
 * afterwards (`GET /v1/albums`), not by reading the store: the property §7.5
 * promises is about what a token can still do.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPr2Server } from "./support/pr2-graph.mjs";

const logout = (app, headers) => app.inject({ method: "POST", url: "/v1/logout", headers });
const logoutAll = (app, headers) => app.inject({ method: "POST", url: "/v1/logout/all", headers });

/** 200 if the session still works, 401 if it does not. */
const probe = async (app, headers) =>
  (await app.inject({ method: "GET", url: "/v1/albums", headers })).statusCode;

describe("POST /v1/logout — §7.5", () => {
  it("answers 204 with no body, and the token stops working", async () => {
    const { app, owner } = await buildPr2Server();
    const { auth } = await owner();

    const response = await logout(app, auth);

    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.body, "");
    assert.equal(await probe(app, auth), 401);
  });

  it("revokes the presented token only — the phone stays signed in", async () => {
    // One owner_tokens row per device is normal (schema §3). The test that
    // fails if logout calls revokeAllTokens.
    const { app, owner } = await buildPr2Server();
    const { auth: laptop, session } = await owner();
    const phone = await session();

    await logout(app, laptop);

    assert.equal(await probe(app, laptop), 401);
    assert.equal(await probe(app, phone), 200, "logging out the laptop signed out the phone");
  });

  it("revokes the bearer's row, not one named in a body", async () => {
    /*
     * §7.5: "A POST /logout {token} shape would need a scope check … and would
     * put a plaintext token in a body." The route declares no body, so one
     * sent anyway is never read. Fails if the handler starts trusting it.
     */
    const { app, owner } = await buildPr2Server();
    const { auth: caller, session } = await owner();
    const other = await session();

    const response = await app.inject({
      method: "POST",
      url: "/v1/logout",
      headers: caller,
      payload: { token: other.authorization.slice("Bearer ".length) },
    });

    assert.equal(response.statusCode, 204, response.body);
    assert.equal(await probe(app, caller), 401, "the bearer token survived");
    assert.equal(await probe(app, other), 200, "a token named in the body was revoked");
  });

  it("answers 401 the second time — §7.3 step 2 rejects the revoked token first", async () => {
    // Correct rather than merely acceptable (§7.5): the handler never runs.
    const { app, owner } = await buildPr2Server();
    const { auth } = await owner();

    await logout(app, auth);
    const second = await logout(app, auth);

    assert.equal(second.statusCode, 401);
    assert.equal(second.json().code, "UNAUTHENTICATED");
  });

  it("answers 401 with no token, and touches no session", async () => {
    const { app, owner } = await buildPr2Server();
    const { auth } = await owner();

    assert.equal((await logout(app, {})).statusCode, 401);
    assert.equal(await probe(app, auth), 200);
  });
});

describe("POST /v1/logout/all — §7.5", () => {
  it("answers 204, and every session ends — the calling one included", async () => {
    // Exempting the caller lets an attacker holding your session survive your
    // own sign-out-everywhere. Fails if the route exempts the bearer's row.
    const { app, owner } = await buildPr2Server();
    const { auth: caller, session } = await owner();
    const phone = await session();
    const tablet = await session();

    const response = await logoutAll(app, caller);

    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.body, "");
    for (const [name, headers] of Object.entries({ caller, phone, tablet })) {
      assert.equal(await probe(app, headers), 401, `${name} survived logout/all`);
    }
  });

  it("ends only the caller's own sessions", async () => {
    const { app, owner } = await buildPr2Server();
    const alice = await owner();
    const bob = await owner();

    await logoutAll(app, alice.auth);

    assert.equal(await probe(app, bob.auth), 200, "logout/all reached another owner");
  });

  it("answers 401 with no token", async () => {
    const { app } = await buildPr2Server();
    assert.equal((await logoutAll(app, {})).statusCode, 401);
  });
});

describe("a body-less POST sent with a JSON content type — §7.5's wire contract", () => {
  /*
   * The sixth framework measurement (§9.7's rule). These routes take no body
   * and register no parser, so `Content-Type: application/json` with an empty
   * body is refused by Fastify's JSON parser — 400 VALIDATION_FAILED — BEFORE
   * authentication runs. That is why 400 can appear on a route whose own
   * error list is 401, and why the response says nothing about whether the
   * caller was signed in. Pinned so a client implementer's bug report has an
   * answer, and so a Fastify upgrade that changes it is noticed.
   */
  for (const [route, send] of [
    ["/v1/logout", logout],
    ["/v1/logout/all", logoutAll],
  ]) {
    it(`${route}: 400 before auth, and the session survives`, async () => {
      const { app, owner } = await buildPr2Server();
      const { auth } = await owner();
      const json = { "content-type": "application/json" };

      const signedIn = await send(app, { ...auth, ...json });
      const anonymous = await send(app, json);

      assert.equal(signedIn.statusCode, 400);
      assert.equal(signedIn.json().code, "VALIDATION_FAILED");
      // Before auth: no token gives the same 400, not a 401.
      assert.equal(anonymous.statusCode, 400);
      assert.equal(anonymous.body, signedIn.body);
      assert.equal(await probe(app, auth), 200, "a rejected logout revoked the session anyway");
    });
  }
});
