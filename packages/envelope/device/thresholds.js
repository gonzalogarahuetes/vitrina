// Fill these in BEFORE the device is in your hand. The page refuses to run
// while any value is null, so a result cannot be rationalised into a
// threshold chosen after seeing it.
export const THRESHOLDS = {
  /** §6.2: above this, v1's Argon2id parameters must come down — a spec change. */
  argon2MaxMs: 3000,
  /** Below this, they are too low for the device class and should go up. */
  argon2MinMs: 500,
  /** How many Argon2id runs to time. The first pays allocation; report each. */
  argon2Runs: 5,

  /** Criterion 3: the 3 MB round trip must complete within this. */
  roundTrip3MbMaxMs: 2000,

  /** V.2: all assets decrypted and rendered, total wall clock. */
  albumMaxMs: 15000,
  /** V.2 passes only if every asset renders; a lower count is the result. */
  albumMinAssets: 20,

  /** §10.1: the number Phase 1's first complaint is about. No pass/fail yet. */
  thumbGridMaxMs: 3000,
};

export function unsetThresholds() {
  return Object.entries(THRESHOLDS)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
}
