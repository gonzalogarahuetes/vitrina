// §11.5's limiter for every authenticated route — keyed on the token HASH,
// never the token or the address. Two disjoint budgets: requests per minute
// for most routes, bytes per hour for the three that serve stored ciphertext.

import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "./error-envelope.js";
import { makeSlidingWindow } from "./sliding-window.js";

/** Every ciphertext-route request pays at least this, errors included. */
export const BYTE_FLOOR = 16 * 1024;

// §11.5's provisional numbers; Phase 2 tunes them against real traffic.
export const REQUESTS_PER_MINUTE = 300;
export const BYTES_PER_HOUR = 500 * 1024 * 1024;

export type TokenLimits = {
  readonly requestsPerMinute?: number;
  readonly bytesPerHour?: number;
  /** Not the Clock port: adapter-local bookkeeping, as rate-limit.ts says. */
  readonly now?: () => number;
};

export type TokenLimiter = {
  /** After §7.3 step 1 resolved a row. Throws RATE_LIMITED with Retry-After. */
  admit(request: FastifyRequest, reply: FastifyReply, tokenHash: Uint8Array): void;
  /** The top-up, `max(0, size − floor)`. Never refuses: the response is committed. */
  chargeBytes(request: FastifyRequest, size: number): void;
  /** Whether `chargeBytes` ran — what the 2xx guard in buildServer reads. */
  isCharged(request: FastifyRequest): boolean;
};

/**
 * IN-PROCESS STATE: one instance per process, built once in buildServer and
 * shared by every plugin. Two instances double the limit with no error (§11.5).
 */
export function makeTokenLimiter(limits: TokenLimits = {}): TokenLimiter {
  const now = limits.now ?? (() => Date.now());
  const requests = makeSlidingWindow({
    max: limits.requestsPerMinute ?? REQUESTS_PER_MINUTE,
    windowMs: 60 * 1000,
    now,
  });
  // `maxAdmitCost` makes FLOOR > bytesPerHour a boot failure, not a 429 forever.
  const bytes = makeSlidingWindow({
    max: limits.bytesPerHour ?? BYTES_PER_HOUR,
    windowMs: 60 * 60 * 1000,
    maxAdmitCost: BYTE_FLOOR,
    now,
  });

  // Per request, so nothing is parked on FastifyRequest and nothing outlives it.
  const admitted = new WeakMap<FastifyRequest, { key: string; charged: boolean }>();

  return {
    admit(request, reply, tokenHash) {
      // Hex, because a Map compares Uint8Array by IDENTITY: every request
      // would get a fresh budget, a limiter that never limits. Still the hash.
      const key = Buffer.from(tokenHash).toString("hex");

      // The floor here, not at the route, so a 403 or 404 has still paid.
      const verdict =
        request.routeOptions.config.chargesByteBudget === true
          ? bytes.admit(key, BYTE_FLOOR)
          : requests.admit(key, 1);

      if (!verdict.allowed) {
        reply.header("Retry-After", verdict.retryAfterSeconds);
        throw new ApiError("RATE_LIMITED");
      }
      admitted.set(request, { key, charged: false });
    },

    chargeBytes(request, size) {
      const entry = admitted.get(request);
      // A plain Error: a route charging without admission is a wiring bug (§1.2).
      if (entry === undefined) throw new Error("chargeBytes on a request the limiter never admitted");
      bytes.charge(entry.key, Math.max(0, size - BYTE_FLOOR));
      entry.charged = true;
    },

    isCharged(request) {
      return admitted.get(request)?.charged === true;
    },
  };
}

/** What the three ciphertext handlers call before sending (§11.5). */
export function chargeBytes(request: FastifyRequest, size: number): void {
  request.server.tokenLimiter.chargeBytes(request, size);
}
