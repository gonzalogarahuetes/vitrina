import { describe, expect, it } from "vitest";
import { EXPIRES_KEY, TOKEN_KEY, sessionStore } from "./owner-session";
import { recordingStorage } from "$lib/owner/harness.test-support";

const TOKEN = "A".repeat(43);
const EXPIRES = "2026-10-29T12:00:00Z";

describe("the owner session store (flows §1.1)", () => {
  it("writes exactly two keys, the token and its expiry", () => {
    const st = recordingStorage();
    sessionStore(() => st.storage).write({ token: TOKEN, expiresAt: EXPIRES });
    expect(st.writes).toEqual([
      [TOKEN_KEY, TOKEN],
      [EXPIRES_KEY, EXPIRES],
    ]);
  });

  it("writes nothing else that happens to be on the object", () => {
    const st = recordingStorage();
    const extra = { token: TOKEN, expiresAt: EXPIRES, email: "a@b.c", password: "hunter2hunter2" };
    sessionStore(() => st.storage).write(extra);
    expect([...st.data.keys()]).toEqual([TOKEN_KEY, EXPIRES_KEY]);
    expect(JSON.stringify([...st.data])).not.toContain("hunter2");
  });

  it("refuses to write a malformed session", () => {
    const st = recordingStorage();
    const store = sessionStore(() => st.storage);
    expect(() => store.write({ token: "short", expiresAt: EXPIRES })).toThrow(TypeError);
    expect(() => store.write({ token: TOKEN, expiresAt: "tomorrow" })).toThrow(TypeError);
    expect(() => store.write({ token: TOKEN, expiresAt: "2026-10-29T12:00:00+02:00" })).toThrow(TypeError);
    expect(st.writes).toEqual([]);
  });

  it("reads back what it wrote, and clears both keys", () => {
    const st = recordingStorage();
    const store = sessionStore(() => st.storage);
    expect(store.read()).toBeNull();
    store.write({ token: TOKEN, expiresAt: EXPIRES });
    expect(store.read()).toEqual({ token: TOKEN, expiresAt: EXPIRES });
    store.clear();
    expect(store.read()).toBeNull();
    expect(st.data.size).toBe(0);
  });

  it("a stored value of the wrong shape, or half a session, is cleared and read as none", () => {
    for (const initial of [{ [TOKEN_KEY]: TOKEN }, { [TOKEN_KEY]: "x", [EXPIRES_KEY]: EXPIRES }, { [EXPIRES_KEY]: EXPIRES }]) {
      const st = recordingStorage(initial);
      expect(sessionStore(() => st.storage).read()).toBeNull();
      expect(st.data.size).toBe(0);
    }
  });

  it("storage that throws reads as none and never breaks the page", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const store = sessionStore(() => throwing);
    expect(store.read()).toBeNull();
    expect(() => store.write({ token: TOKEN, expiresAt: EXPIRES })).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });
});
