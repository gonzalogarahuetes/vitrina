/*
 * The framework-4xx test — api-sketch §1.2, recorded there as owed.
 *
 * `setErrorHandler` catches Fastify's own failures as well as ours, and §1.2
 * splits them into two classes rather than one: `error.validation` becomes
 * VALIDATION_FAILED, and a `FastifyError` carrying a 4xx `statusCode` becomes
 * the code registered for *that status*. Only genuinely unrecognised errors
 * become INTERNAL.
 *
 * What this test defends, in §1.2's words: "Collapsing the second row into
 * VALIDATION_FAILED is *worse* than the 500 those errors currently produce — a
 * client that must retry with a smaller body would be told to fix a field, and
 * it would fix nothing." A 500 is the same failure in a quieter form: it tells
 * the client the server broke, when the request did.
 *
 * So the assertion is per-status and not merely "a 4xx came back": each
 * framework error must arrive as the one code §1.1 registers for its status,
 * and the sweep at the end asserts none of them reaches INTERNAL.
 *
 * Hermetic, like http.test.mjs: app.inject(), no Docker, no network, no
 * Postgres, written against dist/ so no TypeScript loader is needed.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildServer } from "../dist/adapters/driving/http/server.js";

const CLIENT_ORIGIN = "http://localhost:5173";

/*
 * Distinctive request content, so "did the request come back" is a real
 * assertion rather than a shape check that happens to pass. The passphrase
 * shape is not decoration: §7.5's /login body is the first place a real secret
 * sits inside a JSON body that a client can malform, and non-negotiable #15
 * exists because that is how key material reaches a response and then a log.
 */
const SECRET_IN_BODY = "correct-horse-battery-staple";
const UNMATCHED_TYPE = "application/vnd.vitrina-must-not-echo+xml";

/*
 * Fastify's own message text for these four errors, as of fastify 5.11. None of
 * it may reach the wire — #15 covers internal exception text as well as request
 * content, and `message` is looked up from `code` precisely so that there is no
 * path from an Error's own message to the response body.
 *
 * Being exact about what this catches, because a test that looks like coverage
 * and is worth nothing is worse than no test: Fastify 5 does NOT interpolate the
 * body or the content-type into these strings, so this needle list does not
 * catch a leak that exists today. It catches the implementation that sends
 * `error.message` through, or that helpfully adds `details: {contentType}` —
 * both of which are the natural way to write this mapping.
 */
const FASTIFY_TEXT = [
  "Request body is too large",
  "Unsupported Media Type",
  "is not valid JSON",
  "Body cannot be empty",
];

/**
 * The configured limit, read off the instance rather than hardcoded: server.ts
 * keeps bodyLimit at Fastify's 1 MiB default only until B.6 settles the upload
 * path, and a test carrying its own copy of that number starts passing for the
 * wrong reason the day it changes.
 */
function bodyLimitOf(app) {
  const limit = app.initialConfig.bodyLimit;

  assert.ok(
    Number.isInteger(limit) && limit > 0 && limit <= 8 * 1024 * 1024,
    `bodyLimit is ${limit}; this test allocates limit+1 bytes to exceed it. ` +
      `If B.6 raised the app-wide limit past 8 MiB, give the fixture route its ` +
      `own small bodyLimit instead — the mapping under test is the same error.`,
  );

  return limit;
}

/*
 * The four framework 4xx the route table can produce once any route accepts a
 * body. `err` records what Fastify raises, so a future Fastify version changing
 * one of these is visible here rather than only as a failing assertion.
 */
const CASES = [
  {
    what: "an oversized body",
    err: "FST_ERR_CTP_BODY_TOO_LARGE",
    status: 413,
    code: "PAYLOAD_TOO_LARGE",
    request: (app) => ({
      headers: { "content-type": "application/json" },
      // One byte over, with a Content-Length that inject sets for us, so
      // Fastify rejects on the pre-check rather than while streaming. Both
      // paths raise the same error; this one does not depend on chunk sizes.
      payload: "a".repeat(bodyLimitOf(app) + 1),
    }),
  },
  {
    what: "a Content-Type no body parser matches",
    err: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
    status: 415,
    code: "UNSUPPORTED_MEDIA_TYPE",
    request: () => ({
      headers: { "content-type": UNMATCHED_TYPE },
      payload: "not-json-and-not-text-plain",
    }),
  },
  {
    what: "a body with no Content-Type at all",
    err: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
    status: 415,
    code: "UNSUPPORTED_MEDIA_TYPE",
    // Same mapping, different client mistake, and the one a hand-rolled fetch()
    // makes most often. Fastify treats "absent" as "unmatched" rather than
    // guessing at application/json.
    request: () => ({ headers: {}, payload: "abc" }),
  },
  {
    what: "a malformed JSON body",
    err: "FST_ERR_CTP_INVALID_JSON_BODY",
    status: 400,
    // §1.2 sends the framework 400 to VALIDATION_FAILED: an unparseable body is
    // the client's to fix, which is what that code means. Note this is the one
    // row where the framework mapping and the schema mapping coincide.
    code: "VALIDATION_FAILED",
    request: () => ({
      headers: { "content-type": "application/json" },
      payload: `{"passphrase": "${SECRET_IN_BODY}"`, // unterminated object
    }),
  },
  {
    what: "an empty body sent as JSON",
    err: "FST_ERR_CTP_EMPTY_JSON_BODY",
    status: 400,
    code: "VALIDATION_FAILED",
    request: () => ({ headers: { "content-type": "application/json" }, payload: "" }),
  },
];

/*
 * A route that accepts a body, registered through the deps.v1Plugins seam.
 *
 * It goes through that seam for the reason server.ts records: a route
 * registered from outside buildServer is created after setErrorHandler has run,
 * so it inherits the envelope in both orderings and a test written that way
 * passes against the very bug it is meant to catch. These errors are raised by
 * the content-type parser on the route's own context, so the same trap applies.
 *
 * No body schema, deliberately. Every failure here happens in the parser,
 * before validation, so the route stays schema-less to keep the framework-4xx
 * path separate from the `error.validation` path §1.2's first row covers.
 * (That path — a schema'd route rejecting a field — has no test yet.)
 */
const fixtureRoute = async (scope) => {
  scope.post("/framework-4xx", async () => ({ ok: true }));
};

describe("framework 4xx map to their registered code, never INTERNAL", () => {
  let app;

  before(async () => {
    app = await buildServer({
      config: { clientOrigin: CLIENT_ORIGIN },
      useCases: {},
      logger: false,
      v1Plugins: [fixtureRoute],
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  const post = (kase) =>
    app.inject({ method: "POST", url: "/v1/framework-4xx", ...kase.request(app) });

  // The fixture is only meaningful if the route exists — otherwise every case
  // below would be measuring setNotFoundHandler.
  it("the fixture route accepts a well-formed body", async () => {
    const res = await post({
      request: () => ({
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ ok: true }),
      }),
    });

    assert.equal(res.statusCode, 200);
  });

  for (const kase of CASES) {
    describe(kase.what, () => {
      it(`is ${kase.status} ${kase.code}, not 500 INTERNAL`, async () => {
        const res = await post(kase);
        const body = res.json();

        assert.equal(
          res.statusCode,
          kase.status,
          `${kase.err} should be ${kase.status}, got ${res.statusCode}: ${res.body}`,
        );
        assert.equal(body.code, kase.code);
      });

      it("uses the one envelope shape", async () => {
        const res = await post(kase);
        const body = res.json();

        // details is absent, not undefined: exactOptionalPropertyTypes
        // distinguishes the two and so does the JSON on the wire.
        assert.deepEqual(Object.keys(body).sort(), ["code", "message"]);
        assert.equal(typeof body.message, "string");
        assert.ok(body.message.length > 0);
        // Fastify's default shape has these; the envelope must not.
        assert.equal(body.error, undefined);
        assert.equal(body.statusCode, undefined);
      });

      it("echoes neither the request nor Fastify's own text", async () => {
        const res = await post(kase);

        assert.ok(
          !res.body.includes(SECRET_IN_BODY),
          `body echoed request content: ${res.body}`,
        );
        assert.ok(
          !res.body.includes(UNMATCHED_TYPE),
          `body echoed the request's Content-Type: ${res.body}`,
        );

        for (const text of FASTIFY_TEXT) {
          assert.ok(
            !res.body.includes(text),
            `body carried Fastify's internal message "${text}": ${res.body}`,
          );
        }
      });
    });
  }

  /*
   * §1.2 stated as one assertion: "no framework error reaches INTERNAL". Kept
   * as its own case, over and above the per-status ones, because this is the
   * line that catches a *new* framework 4xx arriving with no mapping — the
   * failure the missing `?? 400` fallback is meant to surface loudly.
   */
  it("no framework 4xx reaches INTERNAL", async () => {
    for (const kase of CASES) {
      const res = await post(kase);

      assert.notEqual(
        res.json().code,
        "INTERNAL",
        `${kase.what} (${kase.err}) fell through to INTERNAL`,
      );
      assert.ok(
        res.statusCode >= 400 && res.statusCode < 500,
        `${kase.what} (${kase.err}) answered ${res.statusCode}, not a 4xx`,
      );
    }
  });

  /*
   * That `message` is a constant looked up from `code`, not a string derived
   * from what arrived. Two requests that differ in every request-controlled
   * byte, and fail the same way, must produce byte-identical responses — which
   * an interpolated message cannot do, however careful the interpolation.
   */
  it("returns a byte-identical body for two differently-malformed bodies", async () => {
    const one = await post({
      request: () => ({
        headers: { "content-type": "application/json" },
        payload: `{"passphrase": "${SECRET_IN_BODY}"`,
      }),
    });
    const two = await post({
      request: () => ({
        headers: { "content-type": "application/json" },
        payload: "[[[",
      }),
    });

    assert.equal(one.statusCode, two.statusCode);
    assert.equal(one.body, two.body);
  });

  it("returns a byte-identical body for two unmatched Content-Types", async () => {
    const one = await post({
      request: () => ({ headers: { "content-type": UNMATCHED_TYPE }, payload: "x" }),
    });
    const two = await post({
      request: () => ({ headers: { "content-type": "image/heic" }, payload: "x" }),
    });

    assert.equal(one.statusCode, two.statusCode);
    assert.equal(one.body, two.body);
  });
});
