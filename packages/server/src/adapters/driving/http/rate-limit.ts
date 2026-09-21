/*
 * The IP limiter for the three unauthenticated routes — api-sketch §7.6.
 * Written here rather than taken from @fastify/rate-limit, whose
 * errorResponseBuilder produces its own body and bypasses setErrorHandler —
 * which would leave §1.2's 429 row inert while looking live (§6.2).
 * It throws an ApiError, so the one envelope answers.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "./error-envelope.js";

/** §7.6's provisional numbers: 10 per 15 minutes per IP. */
export const RATE_LIMIT_MAX = 10;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * IN-PROCESS STATE. Correct on one instance, silently broken on two — PR 5
 * states this as general, and it is true from the moment this exists. Nobody
 * should scale to two instances without noticing (§7.6).
 */
export function makeIpRateLimit(
  max = RATE_LIMIT_MAX,
  windowMs = RATE_LIMIT_WINDOW_MS,
  // Not the Clock port: this is adapter-local bookkeeping, not a domain
  // timestamp, and a test drives it by making requests rather than by
  // moving time.
  now: () => number = () => Date.now(),
) {
  const hits = new Map<string, number[]>();

  return async function ipRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const at = now();
    const since = at - windowMs;

    const recent = (hits.get(request.ip) ?? []).filter((seen) => seen > since);
    recent.push(at);
    hits.set(request.ip, recent);

    // Sweep whole idle keys, so a long-running process does not accumulate one
    // array per address ever seen.
    if (hits.size > 10_000) {
      for (const [ip, times] of hits) {
        if (times.every((seen) => seen <= since)) hits.delete(ip);
      }
    }

    if (recent.length > max) {
      // Exposed in Access-Control-Expose-Headers already (§3.1), so a
      // cross-origin client can read the interval it is asked to wait.
      const oldest = recent[0] ?? at;
      reply.header("Retry-After", Math.max(1, Math.ceil((oldest + windowMs - at) / 1000)));
      throw new ApiError("RATE_LIMITED");
    }
  };
}
