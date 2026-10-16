/*
 * The owner password policy, brief §12: at least 12 and at most 256
 * characters, no composition rules, and the bundled top-100k blocklist.
 * Characters are Unicode code points of the password as typed (decided
 * 15 October 2026).
 *
 * SIGNUP ONLY. Never at sign-in or unlock: re-checking a floor at login locks
 * out every account created before the floor rose (brief §12; encryption spec
 * §6.6.2's rejecting-client failure). checkPassword has exactly one caller,
 * the signup step in lib/owner/session.ts, and a test asserts that sign-in and
 * unlock accept a password this policy would refuse.
 */

export const MIN_CODE_POINTS = 12;
export const MAX_CODE_POINTS = 256;

export type PolicyResult = "ok" | "too-short" | "too-long" | "common" | "invalid";

export const codePoints = (s: string): number => [...s].length;

/** An unpaired UTF-16 surrogate, which the crate refuses (encryption spec §1). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The blocklist file, one password per line, UTF-8. Entries are compared
 * case-insensitively: both sides are lowercased.
 */
export function parseBlocklist(raw: string): ReadonlySet<string> {
  const set = new Set<string>();
  for (const line of raw.split("\n")) {
    const entry = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (entry !== "") set.add(entry.toLowerCase());
  }
  return set;
}

export function checkPassword(password: string, blocklist: ReadonlySet<string>): PolicyResult {
  if (LONE_SURROGATE.test(password)) return "invalid";
  const n = codePoints(password);
  if (n < MIN_CODE_POINTS) return "too-short";
  if (n > MAX_CODE_POINTS) return "too-long";
  if (blocklist.has(password.toLowerCase())) return "common";
  return "ok";
}
