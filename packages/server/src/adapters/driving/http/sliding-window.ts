/*
 * The weighted sliding window behind every limiter — api-sketch §7.6, §11.5.
 *
 * Three callers, known shapes: `admit(key, 1)` for the IP and token request
 * budgets; `admit(key, FLOOR)` and later `charge(key, rest)` for the byte
 * budget. A weighted window at cost 1 IS a hit counter — one mechanism, not
 * an abstraction over two.
 *
 * No Fastify, no ApiError: this answers allowed or refused, and the wrappers
 * turn a refusal into a header and the envelope. That keeps the arithmetic —
 * where the Retry-After bug was — reachable by a unit test.
 *
 * ONE FUNCTION, SEPARATE COUNTERS. Every call to `makeSlidingWindow` owns its
 * own map. A shared function is not a shared counter: hoisting the map to
 * module scope would merge the IP, token and byte budgets into one, and
 * sliding-window.test.mjs asserts it does not.
 *
 * IN-PROCESS STATE, like the limiters built on it: correct on one instance,
 * silently halved in strength on two (§7.6, §11.5).
 */

export type Admission =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export type SlidingWindow = {
  /**
   * Records `cost` only if it fits: `live total + cost ≤ max`. A refusal
   * records NOTHING — recording it lengthens the lockout for exactly the
   * client that obeys Retry-After (§7.6, retry-after.test.mjs).
   */
  admit(key: string, cost: number): Admission;
  /**
   * Records `cost` unconditionally, and may take the total past `max`. The
   * byte budget's top-up: the response is already committed, so it cannot be
   * refused, but it must count.
   */
  charge(key: string, cost: number): void;
};

export type SlidingWindowOptions = {
  /** The budget per key per window — requests, or bytes. */
  readonly max: number;
  readonly windowMs: number;
  /**
   * The largest cost any caller will ever `admit`, declared at construction
   * so a cost that could never fit fails at BOOT, loudly, rather than as a
   * Retry-After no wait can honour. 1 for the request budgets; FLOOR for the
   * byte budget. `admit` still throws if exceeded — the check a future caller
   * introduces without revisiting this one.
   */
  readonly maxAdmitCost?: number;
  /** Not the Clock port: adapter-local bookkeeping, as rate-limit.ts says. */
  readonly now?: () => number;
};

type Entry = { readonly at: number; readonly cost: number };

/** Sweep whole idle keys past this many, as the IP limiter always has. */
const SWEEP_ABOVE_KEYS = 10_000;

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`sliding window: ${name} must be a positive integer, got ${value}`);
  }
}

/*
 * Programming errors throw plain `Error`, never `ApiError`: §1.2 sends a plain
 * Error to the unrecognised branch, which logs a stack — the diagnostic a bug
 * needs. An ApiError would answer a status for one.
 *
 * Messages carry numbers only. A key is an address or a token hash and never
 * appears in one.
 */
function validCost(cost: number): void {
  if (!Number.isSafeInteger(cost) || cost < 0) {
    throw new Error(`sliding window: cost must be a non-negative integer, got ${cost}`);
  }
}

export function makeSlidingWindow({
  max,
  windowMs,
  maxAdmitCost = 1,
  now = () => Date.now(),
}: SlidingWindowOptions): SlidingWindow {
  positiveInteger("max", max);
  positiveInteger("windowMs", windowMs);
  positiveInteger("maxAdmitCost", maxAdmitCost);
  if (maxAdmitCost > max) {
    throw new Error(
      `sliding window: maxAdmitCost ${maxAdmitCost} exceeds max ${max} — it could never be admitted`,
    );
  }

  const entries = new Map<string, Entry[]>();

  /** The key's entries still inside the window, as of `at`. */
  function live(key: string, at: number): Entry[] {
    const since = at - windowMs;
    return (entries.get(key) ?? []).filter((entry) => entry.at > since);
  }

  function record(key: string, kept: Entry[], at: number, cost: number): void {
    kept.push({ at, cost });
    entries.set(key, kept);

    if (entries.size > SWEEP_ABOVE_KEYS) {
      const since = at - windowMs;
      for (const [other, list] of entries) {
        if (list.every((entry) => entry.at <= since)) entries.delete(other);
      }
    }
  }

  /**
   * Whole seconds until enough of `kept` has expired for `cost` to fit.
   *
   * Walks from the oldest, subtracting each entry, until `remaining + cost ≤
   * max` — NOT until `remaining ≤ max`. The difference is the over-capacity
   * case: a top-up `charge` can leave the total above `max`, and a walk that
   * forgets the incoming cost stops early and sends the client back to be
   * refused again.
   *
   * Sorted, not assumed sorted: `now()` is wall-clock by default, and a
   * clock step backwards would otherwise make the walk answer from the
   * wrong entry.
   */
  function retryAfterSeconds(kept: readonly Entry[], total: number, cost: number, at: number): number {
    let remaining = total;
    for (const entry of [...kept].sort((a, b) => a.at - b.at)) {
      remaining -= entry.cost;
      if (remaining + cost <= max) {
        // An entry counts while `entry.at > now − windowMs`, so it is gone
        // from `entry.at + windowMs` on.
        return Math.max(1, Math.ceil((entry.at + windowMs - at) / 1000));
      }
    }
    // Unreachable: cost ≤ maxAdmitCost ≤ max, and remaining reaches 0.
    throw new Error("sliding window: no expiry makes room for an admissible cost");
  }

  return {
    admit(key, cost) {
      validCost(cost);
      if (cost > maxAdmitCost) {
        throw new Error(
          `sliding window: admit cost ${cost} exceeds the declared maxAdmitCost ${maxAdmitCost}`,
        );
      }

      const at = now();
      const kept = live(key, at);
      const total = kept.reduce((sum, entry) => sum + entry.cost, 0);

      if (total + cost <= max) {
        record(key, kept, at, cost);
        return { allowed: true };
      }

      // Keep the pruned list; record nothing for the refusal itself.
      entries.set(key, kept);
      return { allowed: false, retryAfterSeconds: retryAfterSeconds(kept, total, cost, at) };
    },

    charge(key, cost) {
      validCost(cost);
      // `max(0, size − FLOOR)` is 0 for every sub-floor response; an entry of
      // 0 changes no total and only costs memory.
      if (cost === 0) return;

      const at = now();
      record(key, live(key, at), at, cost);
    },
  };
}
