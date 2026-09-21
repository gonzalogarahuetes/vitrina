/*
 * Now, as a dependency rather than as ambient state.
 *
 * `Date.now()` inside a use case cannot be asserted, only approximated: a test
 * can check that `expires_at` is roughly two weeks away and will be flaky at
 * the boundary. §7.5 fixes the window and §6.2 owes a test that BOTH minting
 * sites produce the same one — which needs a `now` the test chooses, so that
 * "the same" is an equality rather than a tolerance.
 */

export interface Clock {
  /** The current instant. Injected, so a test can hold it still. */
  now(): Date;
}
