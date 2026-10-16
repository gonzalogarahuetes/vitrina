/*
 * Words the copy must never use, checked over every English string. Brief §3's
 * never-claim list, and the owner rules: the password cannot be "erased"
 * (api-sketch §8.4), nothing counts attempts (flows §3.1), and signup.taken
 * must not claim that account existence is private (brief §11).
 */
import { describe, expect, it } from "vitest";
import { en } from "./en";

function strings(): [string, string][] {
  const out: [string, string][] = [];
  for (const [slot, value] of Object.entries(en)) {
    if (typeof value === "string") out.push([slot, value]);
    else if (Array.isArray(value)) value.forEach((v, i) => out.push([`${slot}[${i}]`, String(v)]));
    else if (typeof value === "function") {
      const f = value as (...a: unknown[]) => unknown;
      for (const args of [[1], [3], [true], [false], ["María", "6 Aug 2026"], ["Thu 29 Oct, 12:00"]]) {
        const r = f(...args);
        for (const s of Array.isArray(r) ? r : [r]) out.push([slot, String(s)]);
      }
    }
  }
  return out;
}

const NEVER_ANYWHERE: [RegExp, string][] = [
  [/\bprevent(s|ed)?\b.*screenshot|screenshots? (are|is) (blocked|impossible|prevented)/i, "brief §3: screenshots are never prevented"],
  [/\bDRM\b|uncopyable|can(no|')t be copied/i, "brief §3: never uncopyable or DRM"],
  [/\b(protected|secure|safe forever|private forever)\b/i, "brief §3: no protection claims"],
  [/\b(erase[ds]?|wipe[ds]?|deleted from memory|forgotten by)\b.*password|password.*\b(erase[ds]?|wipe[ds]?)\b/i, "api-sketch §8.4: the password cannot be erased"],
];

const OWNER_ATTEMPTS = /\battempts?\b|\btries\b|\bremaining\b|\block(ed)? out\b|\bwill lock\b|\btoo many\b/i;

describe("the copy", () => {
  for (const [pattern, rule] of NEVER_ANYWHERE) {
    it(`never: ${rule}`, () => {
      expect(strings().filter(([, s]) => pattern.test(s))).toEqual([]);
    });
  }

  it("unlock, sign-in and the rate-limit wait never suggest that attempts are counted", () => {
    const owner = strings().filter(([slot]) => /^(unlock|signin|wait|session|signed-out)/.test(slot));
    expect(owner.length).toBeGreaterThan(10);
    expect(owner.filter(([, s]) => OWNER_ATTEMPTS.test(s))).toEqual([]);
  });

  it("signup.taken does not claim that whether an account exists is private", () => {
    expect(en["signup.taken"]).not.toMatch(/privac|private|confidential|secret|can.t (tell|say)|won.t say|no way to know/i);
  });

  it("signin.failed and signin.unavailable never say which half was wrong, or that an account exists", () => {
    for (const s of [en["signin.failed"], en["signin.unavailable"]]) {
      expect(s).not.toMatch(/no account|not registered|doesn't exist|unknown (email|address)|wrong password|incorrect password/i);
    }
    expect(en["signin.unavailable"]).not.toBe(en["signin.failed"]);
    expect(en["signin.unavailable"]).not.toBe(en["derive.failed.owner"]);
  });

  it("signup.loss says every album is lost and nothing recovers them", () => {
    expect(en["signup.loss"]).toMatch(/every album/i);
    expect(en["signup.loss"]).toMatch(/no reset/i);
  });

  it("the unlock screen names no address", () => {
    expect(en["unlock.prompt"]).toBe("Unlock");
  });
});
