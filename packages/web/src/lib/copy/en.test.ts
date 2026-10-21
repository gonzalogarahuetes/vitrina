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
    const owner = strings().filter(([slot]) => /^(unlock|signin|wait|session|signed-out|credential)/.test(slot));
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

describe("credential.paused (flows §0, a 429 on a credential route)", () => {
  const text = en["credential.paused"]("about 12 minutes");

  it("names this network as what is paused", () => {
    expect(text).toMatch(/\bthis network\b/i);
  });

  it("never names the account, and never suggests attempts are counted", () => {
    expect(text).not.toMatch(/\baccount\b/i);
    expect(text).not.toMatch(OWNER_ATTEMPTS);
    expect(text).not.toMatch(/\byour (email|address|password)\b/i);
  });

  it("counts down in plain words, never to zero", async () => {
    const { pauseLeft } = await import("./en");
    expect(pauseLeft(900_000)).toBe("about 15 minutes");
    expect(pauseLeft(61_000)).toBe("about 2 minutes");
    expect(pauseLeft(60_000)).toBe("about 1 minute");
    expect(pauseLeft(45_000)).toBe("45 seconds");
    expect(pauseLeft(1)).toBe("1 second");
    expect(pauseLeft(0)).toBe("1 second");
    expect(pauseLeft(-5_000)).toBe("1 second");
  });
});

describe("the owner's album copy (flows §3.4, §3.6, §3.7)", () => {
  const album = () => strings().filter(([slot]) => /^(album\.|upload\.|media\.|remove\.)/.test(slot));

  it("nothing says a photo is uploaded or done: only the server's ready is (api-sketch §9.7)", () => {
    expect(album().length).toBeGreaterThan(25);
    expect(album().filter(([, s]) => /\b(uploaded|upload complete|done|finished uploading)\b/i.test(s) && !/didn't finish uploading|never finished uploading/i.test(s))).toEqual([]);
  });

  it("failures give no reason, because the server sends none (api-sketch §9.8)", () => {
    for (const s of [en["upload.failed"], en["upload.failed.gone"], en["upload.stalled"]("about 2 hours", "14:05")]) {
      expect(s).not.toMatch(/\bbecause\b|\berror\b|\bstorage\b|\bnetwork\b|\bconnection\b|\bserver (was|is) (down|busy)\b/i);
    }
  });

  it("stalled states how long and offers removal", () => {
    const s = en["upload.stalled"]("about 2 hours", "14:05");
    expect(s).toContain("about 2 hours");
    expect(s).toContain("14:05");
    expect(s).toMatch(/\bremove\b/i);
  });

  it("remove.unopened conveys exactly the computed statement, with opened and nothing stronger", () => {
    expect(en["remove.unopened"]).toBe("No one has opened this album since you added it.");
  });

  it("no removal copy says a photo was not opened: thumbnails never log (api-sketch §11.6)", () => {
    for (const [slot, s] of album().filter(([slot]) => slot.startsWith("remove."))) {
      expect(s, slot).not.toMatch(/(no one|nobody|not been|hasn't been|never been) (has )?(opened|seen|viewed) (this|the) photo|photo (was|has) not been (opened|seen|viewed)/i);
    }
  });

  it("remove.opened stops future access and never implies what was retrieved is withdrawn (brief §8)", () => {
    expect(en["remove.opened"]).toMatch(/from now on/i);
    expect(en["remove.opened"]).not.toMatch(/withdraw|take(s)? back|recall|deleted from (their|every)|removed from (their|every)|everywhere/i);
  });

  it("remove.pending never promises erasure, says it is under way, or implies anything runs after the screen closes", () => {
    for (const n of [1, 3]) {
      const s = en["remove.pending"](n);
      expect(s).toMatch(/hidden from everyone/i);
      expect(s).toMatch(/hasn't been erased|haven't been erased/i);
      expect(s).not.toMatch(/under ?way|in progress|being erased|will be|soon|shortly|automatically|in the background|later|eventually/i);
    }
  });

  it("upload.downscale says a viewing-size copy is sent and claims nothing about copying", () => {
    expect(en["upload.downscale"]).toMatch(/viewing-size copy/i);
    expect(en["upload.downscale"]).not.toMatch(/cop(y|ied) (it|them)|can't|cannot|prevent|stop/i);
  });

  it("stuckFor and stuckSince read as plain words", async () => {
    const { stuckFor, stuckSince } = await import("./en");
    expect(stuckFor(30_000)).toBe("about a minute");
    expect(stuckFor(10 * 60_000)).toBe("about 10 minutes");
    expect(stuckFor(2 * 3600_000)).toBe("about 2 hours");
    expect(stuckFor(36 * 3600_000)).toBe("about 2 days");
    const now = new Date(2026, 9, 15, 18, 0);
    expect(stuckSince(new Date(2026, 9, 15, 14, 5), now)).toBe("14:05");
    expect(stuckSince(new Date(2026, 9, 13, 14, 5), now)).toMatch(/^Tue 13 Oct,? 14:05$/);
  });
});
