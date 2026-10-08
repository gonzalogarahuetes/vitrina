/*
 * The weighted sliding window every limiter shares — api-sketch §7.6, §11.5.
 * Three callers with known shapes: `admit(key, 1)` for the IP and token
 * request budgets, `admit(key, FLOOR)` then `charge(key, rest)` for the byte
 * budget. Unit cost is covered as a Retry-After driver in retry-after.test.mjs;
 * this file is the weighted arithmetic, which is where the next bug lives.
 *
 * Retry-After is asserted as a TIGHT bound, not a value: admitted at
 * `t + retryAfter`, refused one second earlier. That catches an answer that is
 * too short (the bug just fixed) and one that is too long, without pinning
 * the arithmetic that produces it.
 *
 * Costs that could never fit are refused twice: `maxAdmitCost > max` at
 * construction (boot), and `admit` above `maxAdmitCost` at call time — both
 * plain Errors, because they are bugs, not conditions to answer (§1.2).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../dist/adapters/driving/http/error-envelope.js";

const { makeSlidingWindow } = await import("../dist/adapters/driving/http/sliding-window.js").catch(
  () => ({ makeSlidingWindow: null }),
);

const SECOND = 1000;
const WINDOW_MS = 60 * SECOND;
const MAX = 100;

function setup() {
  let at = 0;
  const window = makeSlidingWindow({ max: MAX, windowMs: WINDOW_MS, maxAdmitCost: MAX, now: () => at });
  return {
    window,
    at: (seconds) => {
      at = seconds * SECOND;
    },
  };
}

/**
 * Replays `history` on a fresh window, then probes `admit(key, cost)` at
 * `seconds`. Fresh each time, so probing never disturbs what it measures.
 */
function replay(history, seconds, cost) {
  const { window, at } = setup();
  for (const step of history) {
    at(step.at);
    if (step.admit !== undefined) {
      assert.equal(window.admit("k", step.admit).allowed, true, `history admit at ${step.at}s`);
    } else {
      window.charge("k", step.charge);
    }
  }
  at(seconds);
  return window.admit("k", cost);
}

function assertRetryAfterIsTight(history, refusedAt, cost) {
  const refused = replay(history, refusedAt, cost);
  assert.equal(refused.allowed, false, `admit(${cost}) at ${refusedAt}s should be refused`);
  const wait = refused.retryAfterSeconds;
  assert.ok(Number.isInteger(wait) && wait > 0, `Retry-After ${wait}`);

  assert.equal(
    replay(history, refusedAt + wait, cost).allowed,
    true,
    `told to wait ${wait}s and refused again`,
  );
  assert.equal(
    replay(history, refusedAt + wait - 1, cost).allowed,
    false,
    `told to wait ${wait}s but would have been admitted at ${wait - 1}s`,
  );
}

describe("sliding window, weighted", () => {
  if (makeSlidingWindow === null) {
    it("exists", () => assert.fail("sliding-window.js is not built — every case below is unasserted"));
    return;
  }

  it("admits up to max inclusive, and records nothing it refuses", () => {
    const { window, at } = setup();
    at(0);
    assert.equal(window.admit("k", 60).allowed, true);
    at(1);
    assert.equal(window.admit("k", 40).allowed, true, "60 + 40 = max fits");
    assert.equal(window.admit("k", 1).allowed, false);

    // The refusal above recorded nothing: once the 60 expires, exactly 60
    // fits beside the 40. A recorded refusal would make it 101.
    at(60);
    assert.equal(window.admit("k", 60).allowed, true);
    assert.equal(window.admit("k", 1).allowed, false);
  });

  it("charge records without checking, past max", () => {
    // The byte budget's top-up: the response is already committed, so the
    // charge cannot refuse — but it must count.
    const { window, at } = setup();
    at(0);
    window.charge("k", 250);
    assert.equal(window.admit("k", 1).allowed, false);
  });

  it("Retry-After for a cost that needs several entries to expire", () => {
    // 30 + 30 + 30 = 90; admitting 40 needs 30 freed: the first entry is
    // enough. Admitting 80 needs 70 freed: all three. A walk that answers
    // from the oldest entry alone says 60 − 4 = 56s for both.
    const history = [{ at: 0, admit: 30 }, { at: 1, admit: 30 }, { at: 2, admit: 30 }];
    assertRetryAfterIsTight(history, 4, 40);
    assertRetryAfterIsTight(history, 4, 80);
  });

  it("Retry-After when a top-up has pushed the total past max", () => {
    /*
     * The case with no hit-counting analogue. 10 + 10 + 10 admitted, then a
     * charge of 90: the total is 120, over max by 20. Admitting 10 needs the
     * total to fall to 90, so 30 must expire — all three admits, at 62s.
     * A walk that stops when the total is back UNDER max (ignoring the new
     * cost) stops after 20, at 61s; one that answers from the oldest stops
     * at 60s. Both are refused when the client returns.
     */
    const history = [
      { at: 0, admit: 10 },
      { at: 1, admit: 10 },
      { at: 2, admit: 10 },
      { at: 3, charge: 90 },
    ];
    assertRetryAfterIsTight(history, 4, 10);
  });

  it("Retry-After when the over-capacity charge is itself what must expire", () => {
    // 10 admitted, then a charge of 150: nothing short of the charge expiring
    // makes room, so the walk must pass the small entry and keep going.
    const history = [{ at: 0, admit: 10 }, { at: 5, charge: 150 }];
    assertRetryAfterIsTight(history, 6, 10);
  });

  it("keeps keys apart", () => {
    const { window, at } = setup();
    at(0);
    window.charge("a", 1_000);
    assert.equal(window.admit("b", MAX).allowed, true);
  });

  it("keeps instances apart — a shared function is not a shared counter", () => {
    // The failure this catches is a module-level Map: "we unified the
    // limiters" becoming one budget for IP, token and bytes alike.
    const options = { max: MAX, windowMs: WINDOW_MS, maxAdmitCost: MAX, now: () => 0 };
    const first = makeSlidingWindow(options);
    const second = makeSlidingWindow(options);

    first.charge("k", 1_000);
    assert.equal(second.admit("k", MAX).allowed, true);
  });

  describe("costs that can never fit", () => {
    const isPlainError = (error) => error instanceof Error && !(error instanceof ApiError);

    it("refuses at construction when maxAdmitCost exceeds max", () => {
      // FLOOR > bytesPerHour, caught at boot rather than as a Retry-After no
      // wait could honour.
      assert.throws(
        () => makeSlidingWindow({ max: 10, windowMs: WINDOW_MS, maxAdmitCost: 11 }),
        isPlainError,
      );
    });

    it("refuses a nonsensical max or window at construction", () => {
      for (const options of [
        { max: 0, windowMs: WINDOW_MS },
        { max: 10, windowMs: 0 },
        { max: 1.5, windowMs: WINDOW_MS },
      ]) {
        assert.throws(() => makeSlidingWindow(options), isPlainError, JSON.stringify(options));
      }
    });

    it("throws a plain Error, not an ApiError, for an admit above maxAdmitCost", () => {
      // A future caller that admits more than it declared. An ApiError would
      // answer a status for a bug; a plain Error reaches §1.2's unrecognised
      // branch and logs a stack.
      const window = makeSlidingWindow({ max: MAX, windowMs: WINDOW_MS, maxAdmitCost: 10, now: () => 0 });
      assert.throws(() => window.admit("k", 11), isPlainError);
    });

    it("throws for a negative or fractional cost", () => {
      const { window } = setup();
      for (const cost of [-1, 0.5, Number.NaN]) {
        assert.throws(() => window.admit("k", cost), isPlainError, `admit ${cost}`);
        assert.throws(() => window.charge("k", cost), isPlainError, `charge ${cost}`);
      }
    });
  });
});
