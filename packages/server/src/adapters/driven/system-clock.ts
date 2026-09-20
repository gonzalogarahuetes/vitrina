/*
 * The real clock. The only implementation that reads the wall clock, so it is
 * the only place a test cannot control — which is why nothing above it calls
 * `Date.now()` directly.
 */

import type { Clock } from "../../application/ports/clock.js";

export function createSystemClock(): Clock {
  return { now: () => new Date() };
}
