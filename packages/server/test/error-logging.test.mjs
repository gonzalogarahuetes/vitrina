/*
 * What reaches the log, per path — api-sketch §1.2's inward half, and §6.2's
 * owed row.
 *
 * §1.2 sets two rules, not one: the validation path logs a projection, and the
 * INTERNAL path logs the error whole. They are tested together because the way
 * to break the second is to "finish" the first, and a file covering only the
 * projection would not notice.
 *
 * The projection has two halves, because they prove different things and only
 * one of them can be written against real AJV:
 *
 *   1. WIRED — a real schema'd route, a real AJV failure, the real log stream.
 *      Proves the projection is what actually reaches pino.
 *   2. BY CONSTRUCTION — errorEnvelope called directly with a validation entry
 *      carrying everything a future AJV configuration might attach: `data` from
 *      `verbose: true`, a value interpolated into `message`, a hostile custom
 *      `params`. Proves the projection is a whitelist rather than a filter of
 *      the fields AJV happens to emit today.
 *
 * Measured against the previous `{err: error}` implementation: 7 of these 8
 * cases fail, so both halves bite. But they fail for different reasons, and the
 * distinction is the reason half 2 exists.
 *
 * Half 1 fails structurally — there is no `validation` key to read. Its *leak*
 * assertion, `!raw.includes(SUBMITTED)`, passes against the old code, because
 * §1.2's verified table shows today's AJV attaches no submitted value anywhere
 * on the error. So half 1 proves the projection is wired; it cannot prove the
 * projection is what keeps values out, because nothing is trying to put one in.
 * Half 2 is where a value is actually present and has to be dropped.
 *
 * NOT what §6.2's §7.5 row owes: that is a per-route test POSTing a real secret
 * to /login and reading every log line, and it needs PR 2's route. This is the
 * adapter-level half of the same rule.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildServer } from "../dist/adapters/driving/http/server.js";
import {
  ApiError,
  errorEnvelope,
} from "../dist/adapters/driving/http/error-envelope.js";

const CLIENT_ORIGIN = "http://localhost:5173";

/*
 * Two distinct needles, because "no leak" and "still diagnosable" are different
 * assertions and one string cannot test both.
 *
 * SUBMITTED is a value a client sent: it must appear in no log line, by any
 * route, ever. FIELD is a name our own schema declares: it is allowed to appear,
 * and for a `required` failure it is the only thing that makes the line useful.
 */
const SUBMITTED = "S3CRET-passphrase-the-client-sent";
const FIELD = "passphrase";

const ALLOWED_KEYS = ["instancePath", "keyword", "missingProperty", "schemaPath"];

/** The projection's own shape, asserted for every entry of every case. */
function assertProjected(entry) {
  for (const key of Object.keys(entry)) {
    assert.ok(
      ALLOWED_KEYS.includes(key),
      `projection grew the key "${key}"; if that is intended, §1.2 needs it too`,
    );
  }

  assert.equal(typeof entry.instancePath, "string");
  assert.equal(typeof entry.keyword, "string");
  assert.equal(typeof entry.schemaPath, "string");
  // The fields whose safety depends on AJV's configuration rather than on what
  // they are. Absent, not emptied.
  assert.equal(entry.message, undefined);
  assert.equal(entry.params, undefined);
  assert.equal(entry.data, undefined);
}

describe("a validation failure logs a projection, not the error (wired)", () => {
  let app;
  let lines;

  before(async () => {
    lines = [];

    app = await buildServer({
      config: { clientOrigin: CLIENT_ORIGIN },
      useCases: {},
      // A real pino, writing where the test can read it. `level` has to admit
      // warn or the branch under test logs nothing and every assertion below
      // passes vacuously.
      logger: {
        level: "warn",
        stream: {
          write(line) {
            lines.push(JSON.parse(line));
          },
        },
      },
      v1Plugins: [
        async (scope) => {
          scope.post(
            "/login",
            {
              schema: {
                body: {
                  type: "object",
                  required: [FIELD],
                  properties: {
                    // minLength, not `type`: Fastify's AJV defaults include
                    // coerceTypes, so a type mismatch would be coerced into a
                    // pass rather than producing the failure under test.
                    [FIELD]: { type: "string", minLength: 64 },
                  },
                },
              },
            },
            async () => ({ ok: true }),
          );
        },
      ],
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  const post = async (payload) => {
    lines.length = 0;
    const res = await app.inject({
      method: "POST",
      url: "/v1/login",
      payload,
    });
    const logged = lines.filter((l) => l.msg === "schema validation failed");
    return { res, logged, raw: JSON.stringify(lines) };
  };

  it("logs the field path and the rule, and not the submitted value", async () => {
    const { res, logged, raw } = await post({ [FIELD]: SUBMITTED });

    assert.equal(res.statusCode, 400);
    assert.equal(logged.length, 1, `expected one warn line, got: ${raw}`);

    const [entry, ...rest] = logged[0].validation;
    assert.equal(rest.length, 0); // Fastify's AJV defaults are allErrors: false
    assertProjected(entry);

    assert.equal(entry.instancePath, `/${FIELD}`);
    assert.equal(entry.keyword, "minLength");
    assert.ok(entry.schemaPath.includes(FIELD), entry.schemaPath);

    assert.ok(!raw.includes(SUBMITTED), `the log line carried the value: ${raw}`);
    // The error object itself must not be there under any key — pino's `err`
    // serialiser is what used to walk it.
    assert.equal(logged[0].err, undefined);
    assert.equal(logged[0].stack, undefined);
  });

  it("identifies which field was missing on a required failure", async () => {
    const { res, logged, raw } = await post({});

    assert.equal(res.statusCode, 400);

    const [entry] = logged[0].validation;
    assertProjected(entry);

    assert.equal(entry.keyword, "required");
    // The gap that made params.missingProperty the one allowed key: AJV puts
    // the parent object in instancePath ("") and #/required in schemaPath, so
    // without missingProperty this line names no field at all.
    assert.equal(entry.instancePath, "");
    assert.equal(
      entry.missingProperty,
      FIELD,
      `a required failure must still name its field: ${raw}`,
    );
  });

  it("keeps the field name off the wire even though it is in the log", async () => {
    const { res } = await post({ [FIELD]: SUBMITTED });

    // #15 cuts the other way here: safe inward is not safe outward. The
    // response is the constant envelope and names nothing.
    assert.deepEqual(Object.keys(res.json()).sort(), ["code", "message"]);
    assert.equal(res.json().code, "VALIDATION_FAILED");
    assert.ok(!res.body.includes(FIELD), res.body);
    assert.ok(!res.body.includes(SUBMITTED), res.body);
  });
});

/*
 * Half 2. errorEnvelope is called directly, because the point is a validation
 * entry that today's AJV does not produce and a one-line configuration change
 * would: `verbose: true` attaches `data`, a custom keyword owns `params`, a
 * message template can interpolate anything.
 */
describe("a validation failure logs a projection, not the error (by construction)", () => {
  const invoke = (validation) => {
    let logged;
    const request = {
      log: {
        warn: (payload) => {
          logged = payload;
        },
        error: () => {},
      },
    };

    let status;
    let sent;
    const reply = {
      code(c) {
        status = c;
        return this;
      },
      send(b) {
        sent = b;
        return this;
      },
    };

    errorEnvelope({ validation }, request, reply);

    return { logged, status, sent, raw: JSON.stringify(logged) };
  };

  /** Every field a hostile or verbose AJV could hang on one error. */
  const hostile = (over) => ({
    instancePath: `/${FIELD}`,
    keyword: "minLength",
    schemaPath: `#/properties/${FIELD}/minLength`,
    message: `body/${FIELD} must NOT have fewer than 64 characters, got "${SUBMITTED}"`,
    params: { limit: 64, value: SUBMITTED, missingProperty: SUBMITTED },
    data: SUBMITTED, // AJV verbose: true
    parentSchema: { minLength: 64, examples: [SUBMITTED] },
    ...over,
  });

  it("drops data, message and params, whatever they hold", () => {
    const { logged, status, sent, raw } = invoke([hostile()]);

    assert.equal(status, 400);
    assert.equal(sent.code, "VALIDATION_FAILED");

    const [entry] = logged.validation;
    assertProjected(entry);
    assert.ok(!raw.includes(SUBMITTED), `the projection leaked the value: ${raw}`);
  });

  it("does not accept missingProperty from a keyword other than required", () => {
    // The gate: `required` is an AJV builtin and cannot be redefined, so no
    // custom keyword can route a submitted value through the one allowed key.
    const { logged, raw } = invoke([hostile({ keyword: "custom-vitrina-rule" })]);

    assert.equal(logged.validation[0].missingProperty, undefined);
    assert.ok(!raw.includes(SUBMITTED), raw);
  });

  it("drops a non-string missingProperty rather than serialising it", () => {
    const { logged, raw } = invoke([
      hostile({
        keyword: "required",
        params: { missingProperty: { nested: SUBMITTED } },
      }),
    ]);

    assert.equal(logged.validation[0].missingProperty, undefined);
    assert.ok(!raw.includes(SUBMITTED), raw);
  });

  it("keeps missingProperty when required declares a real field name", () => {
    const { logged } = invoke([
      hostile({
        keyword: "required",
        instancePath: "",
        schemaPath: "#/required",
        params: { missingProperty: FIELD },
      }),
    ]);

    assert.equal(logged.validation[0].missingProperty, FIELD);
  });

  it("projects every entry, not just the first", () => {
    // allErrors is false under Fastify's defaults, so this is about the
    // projection's own contract rather than about today's configuration.
    const { logged, raw } = invoke([
      hostile(),
      hostile({ keyword: "required", params: { missingProperty: FIELD } }),
    ]);

    assert.equal(logged.validation.length, 2);
    logged.validation.forEach(assertProjected);
    assert.ok(!raw.includes(SUBMITTED), raw);
  });
});

/*
 * The other half of §1.2, and the branch the projection must NOT have reached:
 * "an unrecognised error is logged whole because a stack is the entire
 * diagnostic value" of one. Projecting here too would look like consistency and
 * would trade a leak that was measured for blind 500s.
 *
 * A NOTE HERE WAS WRONG AND IS CORRECTED, 21 August 2026. It read: "pino's
 * default `err` serialiser emits {type, message, stack} and DROPS error.cause".
 * It does not. Re-measured against pino-std-serializers 7.1.0, whose own source
 * says "We append cause messages and stacks to _err, therefore skipping causes
 * here": the default FLATTENS the chain, joining every cause message into
 * `err.message` with ": " and appending each stack under "caused by:". The
 * chain was in the log all along, unstructured.
 *
 * So `errWithCause` was adopted for structure rather than for presence — see
 * the suite below, and LOG_POLICY in server.ts.
 */
describe("the INTERNAL path stays complete inward", () => {
  const THROWN = "internal-detail-that-must-not-leak";

  let app;
  let lines;

  before(async () => {
    lines = [];
    app = await buildServer({
      config: { clientOrigin: CLIENT_ORIGIN },
      useCases: {},
      logger: {
        level: "warn",
        stream: {
          write(line) {
            lines.push(JSON.parse(line));
          },
        },
      },
      v1Plugins: [
        async (scope) => {
          scope.get("/boom", async () => {
            throw new Error(THROWN);
          });
        },
      ],
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("logs the whole error, stack included, while the wire stays constant", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/boom" });

    assert.equal(res.statusCode, 500);
    assert.ok(!res.body.includes(THROWN), `the wire leaked: ${res.body}`);

    const [line, ...rest] = lines;
    assert.equal(rest.length, 0);
    assert.equal(line.level, 50); // error, not warn: this one is the server's fault

    // The assertion that fails if someone "consistently" projects this branch.
    assert.equal(line.err.message, THROWN);
    assert.ok(
      String(line.err.stack).includes(THROWN),
      "the stack is the entire diagnostic value of an unrecognised error",
    );
  });
});

/*
 * The ApiError branch — api-sketch §1.2, decided 21 August 2026, and the two
 * §6.2 rows it discharges.
 *
 * The rule is cause-based: a warn line when the error carries one, silence when
 * it does not. "A 404 with nothing underneath it is not an event."
 *
 * THESE TESTS CONFIGURE NO SERIALISERS, and that is the point rather than an
 * omission. They pass `{level, stream}` — a destination — and assert a
 * STRUCTURED `err.cause`, which only appears under `errWithCause`. So they fail
 * if LOG_POLICY stops being the adapter's to own, which is the state server.ts
 * was in until today: a caller-supplied logger replaced the policy wholesale, so
 * a test that set its own serialiser would have been asserting its own
 * configuration.
 */
describe("an ApiError logs when it carries a cause, and not otherwise", () => {
  const AUTHORED = "owners.email already taken (pg 23505)";
  // What a driver quotes back at you, and the reason the throw-site rule exists.
  const DRIVER_QUOTED = "victim@example.com";
  const RAW_DRIVER =
    `duplicate key value violates unique constraint "owners_email_key" ` +
    `Key (email)=(${DRIVER_QUOTED}) already exists.`;

  let app;
  let lines;

  before(async () => {
    lines = [];
    app = await buildServer({
      config: { clientOrigin: CLIENT_ORIGIN },
      useCases: {},
      logger: {
        level: "warn",
        stream: {
          write(line) {
            lines.push(JSON.parse(line));
          },
        },
      },
      v1Plugins: [
        async (scope) => {
          scope.get("/absent", async () => {
            throw new ApiError("NOT_FOUND");
          });
          scope.get("/conflict", async () => {
            throw new ApiError("CONFLICT", { cause: new Error(AUTHORED) });
          });
          scope.get("/deep", async () => {
            throw new ApiError("CONFLICT", {
              cause: new Error(AUTHORED, { cause: new Error("connection reset") }),
            });
          });
          // The rule violated on purpose, so the guard's location is asserted
          // rather than assumed. See the last case in this suite.
          scope.get("/unwrapped", async () => {
            throw new ApiError("CONFLICT", { cause: new Error(RAW_DRIVER) });
          });
        },
      ],
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  const get = async (url) => {
    lines.length = 0;
    const res = await app.inject({ method: "GET", url });
    return { res, lines, raw: JSON.stringify(lines) };
  };

  it("says nothing about a 404 with nothing underneath it", async () => {
    const { res, lines: logged } = await get("/v1/absent");

    assert.equal(res.statusCode, 404);
    assert.equal(
      logged.length,
      0,
      `a bare ApiError must be silent, got: ${JSON.stringify(logged)}`,
    );
  });

  it("logs one warn line when the error carries a cause", async () => {
    const { res, lines: logged, raw } = await get("/v1/conflict");

    assert.equal(res.statusCode, 409);
    assert.equal(logged.length, 1, `expected one line, got: ${raw}`);
    // warn, not error: the server recognised this condition and answered it
    // correctly. 50 is reserved for the branch where it did not.
    assert.equal(logged[0].level, 40);
    assert.equal(logged[0].err.type, "ApiError");
  });

  it("keeps the cause chain structured rather than flattened into the message", async () => {
    // The §6.2 row. Under the default `err` serialiser this line's message
    // would be "Conflict, duplicated value.: owners.email already taken (pg
    // 23505)" and there would be no `cause` key at all.
    const { lines: logged } = await get("/v1/conflict");
    const { err } = logged[0];

    assert.equal(err.message, "Conflict, duplicated value.");
    assert.ok(!err.message.includes(AUTHORED), `flattened: ${err.message}`);
    assert.equal(typeof err.cause, "object");
    assert.equal(err.cause.message, AUTHORED);
    assert.ok(String(err.cause.stack).includes(AUTHORED));
  });

  it("walks the chain past the first link", async () => {
    const { lines: logged } = await get("/v1/deep");

    assert.equal(logged[0].err.cause.message, AUTHORED);
    assert.equal(logged[0].err.cause.cause.message, "connection reset");
  });

  it("keeps the cause off the wire whatever it holds", async () => {
    const { res } = await get("/v1/conflict");

    assert.deepEqual(Object.keys(res.json()).sort(), ["code", "message"]);
    assert.equal(res.json().code, "CONFLICT");
    assert.ok(!res.body.includes(AUTHORED), res.body);
  });

  it("does not sanitise the chain — the throw-site rule is the only guard", async () => {
    const { res, raw } = await get("/v1/unwrapped");

    // Asserted as it is, not as one might wish it were. A driver error chained
    // verbatim puts a submitted value in the log, and no handler can tell that
    // value from an authored one. Recorded so nobody reads the branch above as
    // a guarantee it does not make: the rule lives on `ApiError.cause`'s doc
    // comment, and this is the failure it prevents.
    assert.ok(
      raw.includes(DRIVER_QUOTED),
      "if this now passes cleanly, the handler gained a sanitiser and §1.2 needs it",
    );
    // The wire is unaffected either way — that half IS structural.
    assert.ok(!res.body.includes(DRIVER_QUOTED), res.body);
  });
});

/*
 * The merge order in `loggerWithPolicy`, asserted directly rather than only as a
 * side effect of the suite above.
 */
describe("the log policy is the adapter's, not the caller's", () => {
  it("ignores a caller-supplied err serialiser", async () => {
    const lines = [];
    const app = await buildServer({
      config: { clientOrigin: CLIENT_ORIGIN },
      useCases: {},
      logger: {
        level: "warn",
        stream: {
          write(line) {
            lines.push(JSON.parse(line));
          },
        },
        // A caller trying to own what the log may say. LOG_POLICY spreads last.
        serializers: { err: () => ({ hijacked: true }) },
        redact: [],
      },
      v1Plugins: [
        async (scope) => {
          scope.get("/conflict", async () => {
            throw new ApiError("CONFLICT", { cause: new Error("underneath") });
          });
        },
      ],
    });
    await app.ready();

    await app.inject({ method: "GET", url: "/v1/conflict" });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].err.hijacked, undefined);
    assert.equal(lines[0].err.cause.message, "underneath");

    await app.close();
  });
});
