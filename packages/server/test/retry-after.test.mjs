/*
 * `Retry-After` tells the truth — api-sketch §7.6, §11.5. One property, run
 * against the shared core and EVERY limiter built on it: a client that waits
 * the interval it was given is served. Written against a bug — the IP limiter
 * recorded the refused hit and computed the interval from the oldest one, so
 * the obedient retry was refused again — and kept per limiter, because a
 * wrapper can reintroduce it around a correct core.
 *
 * Driven at the function, not over HTTP: the property is about the clock,
 * and a fifteen-minute window is not a test anyone runs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeIpRateLimit } from "../dist/adapters/driving/http/rate-limit.js";
import { makeTokenLimiter } from "../dist/adapters/driving/http/token-limiter.js";

// Dynamic, so a missing core fails its own suite and not the IP limiter's.
const { makeSlidingWindow } = await import("../dist/adapters/driving/http/sliding-window.js").catch(
  () => ({ makeSlidingWindow: null }),
);
import { ApiError } from "../dist/adapters/driving/http/error-envelope.js";

const SECOND = 1000;
const MAX = 3;
const WINDOW_MS = 60 * SECOND;

/**
 * Each driver turns a limiter into `hit(key) → { limited, retryAfter }` over a
 * clock the test moves. `null` is a limiter that does not exist yet: it fails
 * loudly rather than skipping, so the property cannot be forgotten for it.
 */
const DRIVERS = {
  // The shared core at cost 1 — a weighted window with unit cost is a hit
  // counter. Weighted cases live in sliding-window.test.mjs.
  "sliding-window core, cost 1": makeSlidingWindow && (({ max, windowMs, now }) => {
    const window = makeSlidingWindow({ max, windowMs, now });
    return async (key) => {
      const verdict = window.admit(key, 1);
      return verdict.allowed
        ? { limited: false }
        : { limited: true, retryAfter: verdict.retryAfterSeconds };
    };
  }),

  "§7.6 IP limiter": ({ max, windowMs, now }) => {
    const limit = makeIpRateLimit(max, windowMs, now);
    return async (key) => {
      const headers = {};
      const reply = {
        header(name, value) {
          headers[name.toLowerCase()] = value;
          return reply;
        },
      };
      try {
        await limit({ ip: key }, reply);
        return { limited: false };
      } catch (error) {
        if (error instanceof ApiError && error.code === "RATE_LIMITED") {
          return { limited: true, retryAfter: Number(headers["retry-after"]) };
        }
        throw error;
      }
    };
  },

  // §11.5's request budget, through the wrapper the auth hooks call. Its
  // window is fixed at a minute, which is WINDOW_MS here.
  "§11.5 token limiter, request budget": ({ max, windowMs, now }) => {
    assert.equal(windowMs, 60 * SECOND, "the request window is fixed at one minute");
    const limiter = makeTokenLimiter({ requestsPerMinute: max, now });
    return async (key) => {
      const headers = {};
      const reply = { header: (name, value) => ((headers[name.toLowerCase()] = value), reply) };
      const request = { routeOptions: { config: {} } };
      try {
        limiter.admit(request, reply, Buffer.from(key));
        return { limited: false };
      } catch (error) {
        if (error instanceof ApiError && error.code === "RATE_LIMITED") {
          return { limited: true, retryAfter: Number(headers["retry-after"]) };
        }
        throw error;
      }
    };
  },
};

function clock() {
  let at = 0;
  return {
    now: () => at,
    set: (ms) => {
      at = ms;
    },
  };
}

for (const [name, driver] of Object.entries(DRIVERS)) {
  describe(name, () => {
    if (driver === null) {
      it("is wired into this file", () => {
        assert.fail(`${name} has no driver — the Retry-After property is unasserted for it`);
      });
      return;
    }

    it("serves the request made after Retry-After seconds", async () => {
      const time = clock();
      const hit = driver({ max: MAX, windowMs: WINDOW_MS, now: time.now });

      for (let i = 0; i < MAX; i++) {
        time.set(i * SECOND);
        assert.equal((await hit("k")).limited, false, `hit ${i} is inside the budget`);
      }

      const rejectedAt = MAX * SECOND;
      time.set(rejectedAt);
      const rejected = await hit("k");
      assert.equal(rejected.limited, true);
      assert.ok(Number.isInteger(rejected.retryAfter) && rejected.retryAfter > 0);

      time.set(rejectedAt + rejected.retryAfter * SECOND);
      assert.equal(
        (await hit("k")).limited,
        false,
        "a client that waited exactly the interval it was given was refused again",
      );
    });

    it("does not lengthen the lockout for retries made inside it", async () => {
      // The asymmetry: recording refused hits punishes the client that obeys
      // Retry-After and does nothing to one that ignores it.
      const time = clock();
      const hit = driver({ max: MAX, windowMs: WINDOW_MS, now: time.now });

      for (let i = 0; i < MAX; i++) {
        time.set(i * SECOND);
        await hit("k");
      }

      const rejectedAt = MAX * SECOND;
      time.set(rejectedAt);
      const { retryAfter } = await hit("k");

      for (const at of [10, 20, 40]) {
        time.set(at * SECOND);
        assert.equal((await hit("k")).limited, true, `a retry at ${at}s is inside the lockout`);
      }

      time.set(rejectedAt + retryAfter * SECOND);
      assert.equal((await hit("k")).limited, false, "early retries extended the lockout");
    });

    it("keeps keys apart", async () => {
      const time = clock();
      const hit = driver({ max: MAX, windowMs: WINDOW_MS, now: time.now });

      for (let i = 0; i <= MAX; i++) await hit("a");

      assert.equal((await hit("b")).limited, false);
    });
  });
}
