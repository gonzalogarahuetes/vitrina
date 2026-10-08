/*
 * The IP limiter for the three unauthenticated routes — api-sketch §7.6.
 * Written here rather than taken from @fastify/rate-limit, whose
 * errorResponseBuilder produces its own body and bypasses setErrorHandler —
 * which would leave §1.2's 429 row inert while looking live (§6.2).
 * It throws an ApiError, so the one envelope answers.
 *
 * The window itself is sliding-window.ts, shared with §11.5's token limiter.
 * This file only takes the key from the request and turns a refusal into a
 * header and the envelope.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "./error-envelope.js";
import { makeSlidingWindow } from "./sliding-window.js";

/** §7.6's provisional numbers: 10 per 15 minutes per IP. */
export const RATE_LIMIT_MAX = 10;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * IN-PROCESS STATE. Correct on one instance, silently broken on two — PR 5
 * states this as general, and it is true from the moment this exists. Nobody
 * should scale to two instances without noticing (§7.6).
 *
 * Each call owns its own window: the three credential routes share one
 * because credentials.ts calls this once.
 */
export function makeIpRateLimit(
  max = RATE_LIMIT_MAX,
  windowMs = RATE_LIMIT_WINDOW_MS,
  // Not the Clock port: this is adapter-local bookkeeping, not a domain
  // timestamp, and a test drives it by making requests rather than by
  // moving time.
  now: () => number = () => Date.now(),
) {
  const window = makeSlidingWindow({ max, windowMs, now });

  return async function ipRateLimit(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const verdict = window.admit(request.ip, 1);
    if (verdict.allowed) return;

    // Exposed in Access-Control-Expose-Headers already (§3.1), so a
    // cross-origin client can read the interval it is asked to wait.
    reply.header("Retry-After", verdict.retryAfterSeconds);
    throw new ApiError("RATE_LIMITED");
  };
}
